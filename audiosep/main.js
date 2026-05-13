let audioContext;
let mediaStream;
let sourceNode;
let lmsNode;
let currentRefData = null;

document.getElementById('startBtn').addEventListener('click', async () => {
    // 1. 오디오 컨텍스트 생성 (웹 오디오의 심장부)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    try {
        // 2. 마이크 권한 요청 및 입력 스트림 가져오기 (d(n))
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // 3. 별도 스레드에서 돌아갈 AudioWorklet (LMS 필터) 불러오기
        await audioContext.audioWorklet.addModule('lms-processor.js');
        lmsNode = new AudioWorkletNode(audioContext, 'lms-processor');

        // 4. 노드 연결: 마이크 -> LMS 필터 -> 스피커(출력)
        sourceNode.connect(lmsNode);
        lmsNode.connect(audioContext.destination);

        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        console.log("실시간 오디오 스트리밍 시작");

    } catch (err) {
        console.error("마이크 접근 실패:", err);
    }
});

// 2단계: 텍스트 쿼리를 서버로 보내고, x(n)을 받아 AudioWorklet으로 전달
document.getElementById('updateQueryBtn').addEventListener('click', async () => {
    const query = document.getElementById('query').value;
    if (!query.trim()) return alert("쿼리를 입력하세요.");

    console.log(`서버(AudioSep)에 '${query}'에 대한 x(n)을 요청합니다...`);

    /* const response = await fetch('http://localhost:5000/get_reference', {
        method: 'POST',
        body: JSON.stringify({ text_query: query }),
        headers: { 'Content-Type': 'application/json' }
    });
    const referenceData = await response.json();
    currentRefData = new Float32Array(referenceData.x_n);
    if (lmsNode) {
        lmsNode.port.postMessage({ type: 'UPDATE_REFERENCE', payload: Array.from(currentRefData) });
    }
    */
});

// Step-size 변경 이벤트
document.getElementById('stepSize').addEventListener('input', (e) => {
    const mu = parseFloat(e.target.value);
    document.getElementById('muValue').innerText = mu;
    if (lmsNode) {
        lmsNode.port.postMessage({ type: 'UPDATE_MU', payload: mu });
    }
});

document.getElementById('stopBtn').addEventListener('click', () => {
    if (audioContext) audioContext.close();
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    audioContext = null;
    mediaStream = null;
    sourceNode = null;
    lmsNode = null;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
});

// ── 파일 처리 모드 ──────────────────────────────────────────────────────────

document.getElementById('processFileBtn').addEventListener('click', async () => {
    const file = document.getElementById('audioFile').files[0];
    if (!file) return alert("처리할 오디오 파일을 선택하세요.");

    const statusEl = document.getElementById('processStatus');
    const downloadLink = document.getElementById('downloadLink');
    statusEl.textContent = "파일 읽는 중...";
    downloadLink.style.display = 'none';
    document.getElementById('processFileBtn').disabled = true;

    try {
        // 1. 파일 디코딩
        const arrayBuffer = await file.arrayBuffer();
        const tempCtx = new AudioContext();
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
        await tempCtx.close();

        statusEl.textContent = "LMS 필터 처리 중...";

        // 2. 모노 변환
        const monoBuffer = toMono(audioBuffer);

        // 3. OfflineAudioContext로 비실시간 처리
        const offlineCtx = new OfflineAudioContext(1, monoBuffer.length, monoBuffer.sampleRate);
        await offlineCtx.audioWorklet.addModule('lms-processor.js');

        const offlineLms = new AudioWorkletNode(offlineCtx, 'lms-processor');
        offlineLms.port.postMessage({ type: 'UPDATE_MU', payload: parseFloat(document.getElementById('stepSize').value) });
        if (currentRefData) {
            offlineLms.port.postMessage({ type: 'UPDATE_REFERENCE', payload: Array.from(currentRefData) });
        }

        const source = offlineCtx.createBufferSource();
        source.buffer = monoBuffer;
        source.connect(offlineLms);
        offlineLms.connect(offlineCtx.destination);
        source.start();

        // 4. 렌더링 후 WAV 다운로드
        const rendered = await offlineCtx.startRendering();
        const wavBlob = new Blob([audioBufferToWav(rendered)], { type: 'audio/wav' });
        const url = URL.createObjectURL(wavBlob);

        const baseName = file.name.replace(/\.[^.]+$/, '');
        downloadLink.href = url;
        downloadLink.download = `filtered_${baseName}.wav`;
        downloadLink.textContent = `결과 다운로드 (filtered_${baseName}.wav)`;
        downloadLink.style.display = 'inline';
        statusEl.textContent = "처리 완료!";

    } catch (err) {
        statusEl.textContent = "오류: " + err.message;
        console.error(err);
    } finally {
        document.getElementById('processFileBtn').disabled = false;
    }
});

function toMono(audioBuffer) {
    const data = new Float32Array(audioBuffer.length);
    for (let i = 0; i < audioBuffer.length; i++) {
        let sum = 0;
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            sum += audioBuffer.getChannelData(ch)[i];
        }
        data[i] = sum / audioBuffer.numberOfChannels;
    }
    const mono = new AudioBuffer({ numberOfChannels: 1, length: audioBuffer.length, sampleRate: audioBuffer.sampleRate });
    mono.getChannelData(0).set(data);
    return mono;
}

function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const dataSize = buffer.length * numCh * 2; // 16-bit
    const ab = new ArrayBuffer(44 + dataSize);
    const v = new DataView(ab);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * numCh * 2, true); v.setUint16(32, numCh * 2, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < buffer.length; i++) {
        for (let ch = 0; ch < numCh; ch++) {
            const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
            v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            off += 2;
        }
    }
    return ab;
}