// ============================================================
// audiosep/static/app.js
//
// 4-모듈 구조
//   Module 1 – 오디오 수집 & 딜레이  : captureAudio()
//   Module 2 – AI 참조 신호 추출     : 서버(server.py) 담당
//   Module 3 – 시간 동기화 & NLMS   : nlms()
//   Module 4 – 제어 & 출력          : UI 이벤트, playAudio(), drawWave()
//
// Solution A (버퍼링 재생):
//   _playbackTime 을 스케줄 클록으로 사용해 청크를 연속으로 예약.
//   src.start(startTime) 으로 각 청크가 이전 청크 끝나는 순간
//   정확히 이어지도록 보장 → 끊김·튐 없는 재생.
// ============================================================


// ── Module 4: UI 요소 ──────────────────────────────────────

const startBtn     = document.getElementById("startBtn");
const queryInput   = document.getElementById("queryInput");
const sendQueryBtn = document.getElementById("sendQueryBtn");
const muSlider     = document.getElementById("muSlider");
const muLabel      = document.getElementById("muLabel");
const statusEl     = document.getElementById("status");

const canvas = document.getElementById("waveCanvas");
const ctx    = canvas.getContext("2d");

canvas.width  = 900;
canvas.height = 300;


// ── Module 3: NLMS 설정 ────────────────────────────────────

const FILTER_LENGTH = 128;
let mu        = parseFloat(muSlider.value);   // 학습률, UI에서 실시간 갱신
let w         = new Float32Array(FILTER_LENGTH);
let x_history = new Float32Array(FILTER_LENGTH);


// ── Module 1: 딜레이 큐 ────────────────────────────────────
// 서버 왕복 지연 동안 원본 d 청크를 순서대로 보관.

let delayQueue = [];


// ── Module 4: GC 방지용 오디오 노드 참조 ──────────────────
// onclick 스코프 안에만 두면 브라우저 GC 가 ScriptProcessorNode 를
// 회수해 콜백이 멈추는 알려진 버그가 있어 모듈 스코프에 보관한다.

let _audioContext = null;
let _processor    = null;
let _playbackTime = 0;    // Solution A: 스케줄 재생 클록


// ── WebSocket 연결 ─────────────────────────────────────────

const socket = new WebSocket("ws://localhost:8765");
socket.binaryType = "arraybuffer";

socket.onopen = () => {
    setStatus("서버 연결됨");
    sendQuery();   // 초기 쿼리 전송
};

socket.onerror = () => setStatus("서버 연결 실패");
socket.onclose = () => setStatus("서버 연결 끊김");


// ── Module 4: μ 슬라이더 ──────────────────────────────────

muSlider.oninput = () => {
    mu = parseFloat(muSlider.value);
    muLabel.textContent = mu.toFixed(3);
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "mu", value: mu }));
    }
};


// ── Module 4: 쿼리 전송 (Module 2 → 서버) ─────────────────

function sendQuery() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "query", text: queryInput.value }));
    }
}

sendQueryBtn.onclick = () => {
    sendQuery();
    setStatus(`쿼리: "${queryInput.value}"`);
};


// ── Module 4: 시작 버튼 ────────────────────────────────────

startBtn.onclick = async () => {

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    _audioContext = new AudioContext({ sampleRate: 16000 });
    _playbackTime = _audioContext.currentTime;

    const source = _audioContext.createMediaStreamSource(stream);
    _processor   = _audioContext.createScriptProcessor(1024, 1, 1);

    source.connect(_processor);
    _processor.connect(_audioContext.destination);

    startBtn.disabled     = true;
    sendQueryBtn.disabled = false;
    setStatus("녹음 중…");

    // Module 1: 오디오 수집 & 딜레이
    captureAudio();

    // Module 3: 서버 응답 수신 → 시간 동기화 + NLMS
    socket.onmessage = (msg) => {

        // JSON 제어 메시지(서버 → 클라이언트)는 무시
        if (typeof msg.data === "string") return;

        const x = new Float32Array(msg.data);
        const d = delayQueue.shift();
        if (!d) return;

        const e = nlms(d, x);

        // Module 4: Solution A 버퍼링 재생
        playAudio(e);

        // Module 4: 파형 시각화
        drawWave(d, e);
    };
};


// ============================================================
// Module 1: 오디오 수집 & 딜레이
// ============================================================

function captureAudio() {

    _processor.onaudioprocess = (event) => {

        const input = event.inputBuffer.getChannelData(0);
        const d     = new Float32Array(input);   // 복사본 (메모리 재사용 방지)

        delayQueue.push(d);   // 서버 응답 도착 때까지 보관

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(d.buffer);
        }
    };
}


// ============================================================
// Module 3: NLMS  (Normalized Least Mean Square)
//
//   y[n]   = Σ w[i] · x_history[i]
//   e[n]   = d[n] - y[n]
//   w[i]  += (μ · e[n] / norm) · x_history[i]
//   norm   = ε + Σ x_history[i]²
// ============================================================

function nlms(d, x) {

    const e = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        // 참조 신호 이력 갱신 (최신 샘플을 앞에 삽입)
        for (let i = FILTER_LENGTH - 1; i > 0; i--) {
            x_history[i] = x_history[i - 1];
        }
        x_history[0] = x[n];

        // 필터 출력 y 와 입력 에너지 norm 을 한 루프에서 계산
        let y    = 0;
        let norm = 1e-6;

        for (let i = 0; i < FILTER_LENGTH; i++) {
            y    += w[i] * x_history[i];
            norm += x_history[i] * x_history[i];
        }

        e[n] = d[n] - y;

        // 계수 갱신
        const step = mu * e[n] / norm;
        for (let i = 0; i < FILTER_LENGTH; i++) {
            w[i] += step * x_history[i];
        }
    }

    return e;
}


// ============================================================
// Module 4: Solution A – 버퍼링 재생
//
// 각 청크를 _playbackTime 클록에 예약(src.start)해서
// 청크끼리 끊김 없이 이어지도록 보장한다.
// currentTime 보다 뒤처지면 즉시 재생으로 리셋.
// ============================================================

function playAudio(signal) {

    const buffer = _audioContext.createBuffer(1, signal.length, 16000);
    buffer.copyToChannel(signal, 0);

    const src = _audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(_audioContext.destination);

    const now       = _audioContext.currentTime;
    const startTime = Math.max(now, _playbackTime);

    src.start(startTime);

    _playbackTime = startTime + buffer.duration;
}


// ============================================================
// Module 4: 파형 시각화
//
//   d (흰색 반투명) – 원본 마이크 입력, 항상 일정 크기
//   e (빨간색)      – NLMS 출력, 필터 수렴 시 줄어듦
// ============================================================

function drawWave(d, e) {

    const half = canvas.height / 2;
    const amp  = half * 0.9;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    function plotSignal(signal, color, alpha) {

        const step = signal.length / canvas.width;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;

        for (let i = 0; i < canvas.width; i++) {
            const v    = signal[Math.floor(i * step)];
            const rawY = half + v * amp;
            const y    = Math.max(0, Math.min(canvas.height, rawY));
            if (i === 0) ctx.moveTo(i, y);
            else         ctx.lineTo(i, y);
        }

        ctx.stroke();
    }

    plotSignal(d, "white", 0.75);   // 원본
    plotSignal(e, "red",   1.0);    // 필터 출력

    ctx.globalAlpha = 1.0;
}


// ── 헬퍼 ──────────────────────────────────────────────────

function setStatus(text) {
    statusEl.textContent = text;
}
