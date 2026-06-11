// ============================================================
// audiosep/static/app.js
//
// AudioSep + ALE 하이브리드 소음 제거 클라이언트 (cascade 고정)
// ============================================================


// ── UI 요소 ────────────────────────────────────────────────

const startBtn   = document.getElementById("startBtn");
const queryInput = document.getElementById("queryInput");
const statusEl   = document.getElementById("status");

const inputCanvas  = document.getElementById("inputCanvas");
const noiseCanvas  = document.getElementById("noiseCanvas");
const outputCanvas = document.getElementById("outputCanvas");
const inputCtx     = inputCanvas.getContext("2d");
const noiseCtx     = noiseCanvas.getContext("2d");
const outputCtx    = outputCanvas.getContext("2d");

function resizeCanvases() {
    [inputCanvas, noiseCanvas, outputCanvas].forEach(c => {
        const w = c.offsetWidth;
        const h = c.offsetHeight;
        if (w > 0) c.width  = w;
        if (h > 0) c.height = h;
    });
}
resizeCanvases();
requestAnimationFrame(resizeCanvases);
window.addEventListener("resize", resizeCanvases);


// ── 상수 ───────────────────────────────────────────────────

const SAMPLE_RATE  = 16000;
const CHUNK_SIZE   = 1024;
const NLMS_TAPS    = 128;
const ALE_TAPS     = 128;
const HISTORY_SIZE = 2048;


// ── 상태 ───────────────────────────────────────────────────

const mode    = "audiosep";
const mu      = 0.01;
const delta   = 50;
const outGain = 1.0;
const bypass  = false;

// NLMS (AudioSep 참조용)
let w_nlms    = new Float32Array(NLMS_TAPS);
let xHistNlms = new Float32Array(NLMS_TAPS);

// ALE (자기예측용)
let w_ale   = new Float32Array(ALE_TAPS);
let history = new Float32Array(HISTORY_SIZE);
let histIdx = 0;

// 서버 응답 대기 맵: seq → 보낸 청크 d
let sendSeq = 0;
const pending = new Map();


// ── 오디오 노드 ────────────────────────────────────────────

let _audioContext = null;
let _processor    = null;
let _playbackTime = 0;


// ── WebSocket ──────────────────────────────────────────────

const socket = new WebSocket("ws://localhost:8765");
socket.binaryType = "arraybuffer";

socket.onopen  = () => { setStatus("서버 연결됨"); sendQuery(); sendMode(); };
socket.onerror = () => setStatus("서버 연결 실패 (ALE 모드만 동작)");
socket.onclose = () => setStatus("서버 연결 끊김");

function sendQuery() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "query", text: queryInput.value }));
    }
}
function sendMode() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "mode", value: mode }));
    }
}


// ── 쿼리 입력 (Enter 로 적용) ─────────────────────────────

queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendQuery();
        setStatus(`쿼리: "${queryInput.value}"`);
    }
});


// ── 시작 ───────────────────────────────────────────────────

startBtn.onclick = async () => {

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl:  false,
        }
    });

    _audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    _playbackTime = _audioContext.currentTime;

    const source = _audioContext.createMediaStreamSource(stream);
    _processor   = _audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);

    source.connect(_processor);
    _processor.connect(_audioContext.destination);

    captureAudio();
    socket.onmessage = onServerReply;

    startBtn.disabled = true;
    setStatus(`녹음·필터링 중 (mode=${mode})`);
};


// ============================================================
// 마이크 수집
// ============================================================

function captureAudio() {

    _processor.onaudioprocess = (event) => {

        const input = event.inputBuffer.getChannelData(0);
        const d     = new Float32Array(input);

        if (mode === "ale") {
            const { e, y } = ale(d);
            schedulePlay(bypass ? d : e);
            drawWave(d, y, e);
        } else {
            plotSignal(inputCtx, inputCanvas, d, waveColors.input);
            if (socket.readyState === WebSocket.OPEN) {
                const seq = ++sendSeq;
                pending.set(seq, d);
                socket.send(d.buffer);
            } else {
                schedulePlay(d);
            }
        }

        const out = event.outputBuffer.getChannelData(0);
        out.fill(0);
    };
}


// ============================================================
// 서버 응답
// ============================================================

function onServerReply(msg) {

    if (typeof msg.data === "string") return;
    if (mode === "ale") return;

    const seq = new DataView(msg.data).getUint32(0, true);
    const x   = new Float32Array(msg.data, 4);

    // 건너뛴 청크를 순서대로 원음으로 채워 갭 제거
    for (const [k, rawD] of pending.entries()) {
        if (k < seq) schedulePlay(rawD);
    }

    const d = pending.get(seq);
    for (const k of pending.keys()) {
        if (k <= seq) pending.delete(k);
    }
    if (!d) return;

    let e, y;

    if (mode === "audiosep") {
        ({ e, y } = nlms(d, x));
    } else if (mode === "cascade") {
        const stage1 = nlms(d, x);
        const stage2 = ale(stage1.e);
        e = stage2.e;
        y = new Float32Array(d.length);
        for (let i = 0; i < d.length; i++) y[i] = d[i] - e[i];
    } else {
        e = d;
        y = new Float32Array(d.length);
    }

    schedulePlay(bypass ? d : e);
    drawWave(d, y, e);
}


// ============================================================
// NLMS
// ============================================================

function nlms(d, x) {

    const e    = new Float32Array(d.length);
    const yOut = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        for (let i = NLMS_TAPS - 1; i > 0; i--) xHistNlms[i] = xHistNlms[i - 1];
        xHistNlms[0] = x[n];

        let y    = 0;
        let norm = 1e-6;
        for (let i = 0; i < NLMS_TAPS; i++) {
            y    += w_nlms[i] * xHistNlms[i];
            norm += xHistNlms[i] * xHistNlms[i];
        }

        yOut[n] = y;
        e[n]    = d[n] - y;

        const step = mu * e[n] / norm;
        for (let i = 0; i < NLMS_TAPS; i++) {
            w_nlms[i] += step * xHistNlms[i];
        }
    }

    return { e, y: yOut };
}


// ============================================================
// ALE
// ============================================================

function ale(d) {

    const e    = new Float32Array(d.length);
    const yOut = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        history[histIdx] = d[n];

        let y    = 0;
        let norm = 1e-6;

        for (let i = 0; i < ALE_TAPS; i++) {
            const idx = ((histIdx - delta - i) % HISTORY_SIZE + HISTORY_SIZE) % HISTORY_SIZE;
            const xi  = history[idx];
            y    += w_ale[i] * xi;
            norm += xi * xi;
        }

        yOut[n] = y;
        e[n]    = d[n] - y;

        const step = mu * e[n] / norm;
        for (let i = 0; i < ALE_TAPS; i++) {
            const idx = ((histIdx - delta - i) % HISTORY_SIZE + HISTORY_SIZE) % HISTORY_SIZE;
            w_ale[i] += step * history[idx];
        }

        histIdx = (histIdx + 1) % HISTORY_SIZE;
    }

    return { e, y: yOut };
}


// ============================================================
// 버퍼링 재생
// ============================================================

function schedulePlay(signal) {

    const buffer = _audioContext.createBuffer(1, signal.length, SAMPLE_RATE);
    const ch     = buffer.getChannelData(0);
    for (let i = 0; i < signal.length; i++) ch[i] = signal[i] * outGain;

    const src = _audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(_audioContext.destination);

    const now       = _audioContext.currentTime;
    // _playbackTime이 200ms 이상 밀렸으면 리셋해서 버퍼 누적 방지
    if (_playbackTime < now - 0.2) _playbackTime = now;
    const startTime = Math.max(now, _playbackTime);
    src.start(startTime);
    _playbackTime = startTime + buffer.duration;
}


// ============================================================
// 파형 시각화
// ============================================================

const waveColors = {
    input:  getComputedStyle(document.documentElement).getPropertyValue("--wave-input").trim()  || "#ffffff",
    noise:  getComputedStyle(document.documentElement).getPropertyValue("--wave-noise").trim()  || "#ff6666",
    output: getComputedStyle(document.documentElement).getPropertyValue("--wave-output").trim() || "#66ff66",
};

function drawWave(d, y, e) {
    plotSignal(inputCtx,  inputCanvas,  d, waveColors.input);
    plotSignal(noiseCtx,  noiseCanvas,  y, waveColors.noise);
    plotSignal(outputCtx, outputCanvas, e, waveColors.output);
}

function plotSignal(context, cvs, signal, color) {

    const half = cvs.height / 2;
    const amp  = half * 0.9;
    const step = signal.length / cvs.width;

    context.clearRect(0, 0, cvs.width, cvs.height);
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 1.5;

    for (let i = 0; i < cvs.width; i++) {
        const v    = signal[Math.floor(i * step)];
        const yPix = Math.max(0, Math.min(cvs.height, half + v * amp));
        if (i === 0) context.moveTo(i, yPix);
        else         context.lineTo(i, yPix);
    }

    context.stroke();
}


// ── 헬퍼 ──────────────────────────────────────────────────

function setStatus(text) { statusEl.textContent = text; }

setStatus("대기 중 — [시작] 을 누르세요");
