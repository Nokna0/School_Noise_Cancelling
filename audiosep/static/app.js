// ============================================================
// audiosep/static/app.js
//
// AudioSep + ALE 하이브리드 소음 제거 클라이언트
//
// ── 3가지 동작 모드 ─────────────────────────────────────────
//   1. "audiosep" — 서버의 AudioSep 이 텍스트 쿼리로 추출한 참조 신호
//                   x 를 NLMS 로 학습·차감. 텍스트 기반 표적 제거.
//   2. "ale"      — 입력 자신의 Δ 지연 버전을 참조로 NLMS 가
//                   자기예측. 주기적 소음만 제거. 서버 안 씀.
//   3. "cascade"  — AudioSep 으로 표적 제거 후 ALE 로 잔여 주기 성분
//                   추가 정리. 두 접근을 직렬 결합. (기본값)
//
// ── 비동기 처리 (Solution A 버퍼링 재생) ────────────────────
//   AudioSep 모드들은 서버 왕복이 필요해서 onaudioprocess 콜백 안에서
//   동기 출력 불가. 따라서 모든 모드에서 e 를 AudioBufferSource 로
//   _playbackTime 클록에 예약해 끊김 없이 재생한다.
// ============================================================


// ── UI 요소 ────────────────────────────────────────────────

const startBtn    = document.getElementById("startBtn");
const bypassBtn   = document.getElementById("bypassBtn");
const queryInput  = document.getElementById("queryInput");
const sendQueryBtn= document.getElementById("sendQueryBtn");
const muSlider    = document.getElementById("muSlider");
const muLabel     = document.getElementById("muLabel");
const deltaSlider = document.getElementById("deltaSlider");
const deltaLabel  = document.getElementById("deltaLabel");
const gainSlider  = document.getElementById("gainSlider");
const gainLabel   = document.getElementById("gainLabel");
const modeRadios  = document.querySelectorAll('input[name="mode"]');
const statusEl    = document.getElementById("status");

const inputCanvas  = document.getElementById("inputCanvas");
const noiseCanvas  = document.getElementById("noiseCanvas");
const outputCanvas = document.getElementById("outputCanvas");
const inputCtx     = inputCanvas.getContext("2d");
const noiseCtx     = noiseCanvas.getContext("2d");
const outputCtx    = outputCanvas.getContext("2d");

inputCanvas.width  = noiseCanvas.width  = outputCanvas.width  = 900;
inputCanvas.height = noiseCanvas.height = outputCanvas.height = 160;


// ── 상수 ───────────────────────────────────────────────────

const SAMPLE_RATE   = 16000;
const CHUNK_SIZE    = 1024;
const NLMS_TAPS     = 128;       // AudioSep 모드 NLMS 탭 수
const ALE_TAPS      = 128;       // ALE 모드 NLMS 탭 수
const HISTORY_SIZE  = 2048;      // ALE 순환 버퍼 (Δ_max + ALE_TAPS 커버)


// ── 상태 ───────────────────────────────────────────────────

let mode    = "cascade";                              // 'audiosep' | 'ale' | 'cascade'
let mu      = parseFloat(muSlider.value);
let delta   = parseInt(deltaSlider.value, 10);
let outGain = parseFloat(gainSlider.value);
let bypass  = false;                                  // true: 원본 d 출력 (A/B 비교)

// NLMS (AudioSep 참조용)
let w_nlms    = new Float32Array(NLMS_TAPS);
let xHistNlms = new Float32Array(NLMS_TAPS);

// ALE (자기예측용)
let w_ale     = new Float32Array(ALE_TAPS);
let history   = new Float32Array(HISTORY_SIZE);
let histIdx   = 0;

// 서버 응답 대기 큐 (AudioSep 모드)
let delayQueue = [];


// ── 오디오 노드 (GC 방지 모듈 스코프) ─────────────────────

let _audioContext = null;
let _processor    = null;
let _playbackTime = 0;            // Solution A: 스케줄 클록


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
function sendMu() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "mu", value: mu }));
    }
}
function sendMode() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "mode", value: mode }));
    }
}


// ── 라벨 갱신 ──────────────────────────────────────────────

function updateMuLabel()    { muLabel.textContent    = mu.toFixed(3); }
function updateDeltaLabel() {
    const ms = (delta / SAMPLE_RATE * 1000).toFixed(1);
    deltaLabel.textContent = `${delta} (≈${ms}ms)`;
}
function updateGainLabel()  { gainLabel.textContent  = `${outGain.toFixed(1)}×`; }

updateMuLabel(); updateDeltaLabel(); updateGainLabel();


// ── 슬라이더 / 토글 이벤트 ────────────────────────────────

muSlider.oninput    = () => { mu = parseFloat(muSlider.value); updateMuLabel(); sendMu(); };
deltaSlider.oninput = () => { delta = parseInt(deltaSlider.value, 10); updateDeltaLabel(); w_ale.fill(0); };
gainSlider.oninput  = () => { outGain = parseFloat(gainSlider.value); updateGainLabel(); };

sendQueryBtn.onclick = () => { sendQuery(); setStatus(`쿼리: "${queryInput.value}"`); };

modeRadios.forEach((r) => {
    r.onchange = () => {
        if (r.checked) {
            mode = r.value;
            // 모드 바뀌면 두 필터 모두 리셋 (학습된 가중치는 모드 의존적)
            w_nlms.fill(0);  w_ale.fill(0);
            sendMode();
        }
    };
});

bypassBtn.onclick = () => {
    bypass = !bypass;
    bypassBtn.textContent = bypass
        ? "B: 원본 듣는 중 (눌러서 필터로)"
        : "A: 필터 적용 중 (눌러서 원본으로)";
    bypassBtn.classList.toggle("bypass-on", bypass);
};


// ── 시작 ───────────────────────────────────────────────────

startBtn.onclick = async () => {

    // 브라우저 기본 마이크 처리(노이즈 서프레션 등)는 ALE 가 보는 신호를
    // 미리 정리해 버려서 효과를 가릴 수 있다. 모두 끈다.
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

    startBtn.disabled  = true;
    bypassBtn.disabled = false;
    bypassBtn.textContent = "A: 필터 적용 중 (눌러서 원본으로)";
    setStatus(`녹음·필터링 중 (mode=${mode})`);
};


// ============================================================
// 마이크 수집: 모든 모드에서 d 를 큐에 보관.
//   - ale 모드: 큐에서 즉시 꺼내 처리 (서버 안 거침)
//   - audiosep / cascade: 서버 응답 도착할 때 큐에서 꺼냄
// ============================================================

function captureAudio() {

    _processor.onaudioprocess = (event) => {

        const input = event.inputBuffer.getChannelData(0);
        const d     = new Float32Array(input);    // 복사본

        if (mode === "ale") {
            // 서버 안 쓰는 모드: 즉시 처리·재생
            const { e, y } = ale(d);
            schedulePlay(bypass ? d : e);
            drawWave(d, y, e);
        } else {
            // AudioSep 가 관여하는 모드: 서버에 보내고 응답 대기
            delayQueue.push(d);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(d.buffer);
            } else {
                // 서버 끊겼을 때: 원본 그대로 흘려서 침묵 방지
                schedulePlay(d);
                delayQueue.shift();
            }
        }

        // 출력 노드는 무음 (실제 재생은 schedulePlay 가 담당)
        const out = event.outputBuffer.getChannelData(0);
        out.fill(0);
    };
}


// ============================================================
// 서버 응답: AudioSep 이 추출한 x 가 도착했을 때 호출됨.
//   mode 에 따라 NLMS 만 / NLMS + ALE 캐스케이드 분기.
// ============================================================

function onServerReply(msg) {

    if (typeof msg.data === "string") return;   // 제어 메시지 무시

    const x = new Float32Array(msg.data);
    const d = delayQueue.shift();
    if (!d) return;

    let e, y;

    if (mode === "audiosep") {
        ({ e, y } = nlms(d, x));
    }
    else if (mode === "cascade") {
        // 1차: AudioSep 참조로 표적 소음 제거
        const stage1 = nlms(d, x);
        // 2차: 1차 출력에 ALE 적용 → 잔여 주기 성분 추가 정리
        const stage2 = ale(stage1.e);
        e = stage2.e;
        // 시각화용 y 는 "d 에서 실제로 빼진 총량" = d - e
        y = new Float32Array(d.length);
        for (let i = 0; i < d.length; i++) y[i] = d[i] - e[i];
    }
    else {
        // 보호용: 알 수 없는 모드면 그냥 패스
        e = d;
        y = new Float32Array(d.length);
    }

    schedulePlay(bypass ? d : e);
    drawWave(d, y, e);
}


// ============================================================
// NLMS: AudioSep 의 x 를 참조로 d 의 노이즈 성분 학습·차감
// ============================================================

function nlms(d, x) {

    const e    = new Float32Array(d.length);
    const yOut = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        // x 이력 갱신 (최신 샘플이 인덱스 0)
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
// ALE: 입력 자신의 Δ 지연 버전을 참조로 자기예측
//   y = 예측된 주기 성분, e = 예측 불가 성분 (음성)
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
// Solution A: 버퍼링 재생 (모든 모드에서 사용)
//   매 청크를 _playbackTime 클록에 예약해 끊김 없이 이어붙임.
//   currentTime 보다 뒤처지면 즉시 재생으로 리셋.
// ============================================================

function schedulePlay(signal) {

    const buffer = _audioContext.createBuffer(1, signal.length, SAMPLE_RATE);
    const ch     = buffer.getChannelData(0);
    for (let i = 0; i < signal.length; i++) ch[i] = signal[i] * outGain;

    const src = _audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(_audioContext.destination);

    const now       = _audioContext.currentTime;
    const startTime = Math.max(now, _playbackTime);
    src.start(startTime);
    _playbackTime = startTime + buffer.duration;
}


// ============================================================
// 파형 시각화 — 모든 모드 공통
// ============================================================

function drawWave(d, y, e) {
    plotSignal(inputCtx,  inputCanvas,  d, "white");
    plotSignal(noiseCtx,  noiseCanvas,  y, "red");
    plotSignal(outputCtx, outputCanvas, e, "lime");
}

function plotSignal(context, cvs, signal, color) {

    const half = cvs.height / 2;
    const amp  = half * 0.9;
    const step = signal.length / cvs.width;

    context.clearRect(0, 0, cvs.width, cvs.height);
    context.beginPath();
    context.strokeStyle = color;

    for (let i = 0; i < cvs.width; i++) {
        const v = signal[Math.floor(i * step)];
        const yPix = Math.max(0, Math.min(cvs.height, half + v * amp));
        if (i === 0) context.moveTo(i, yPix);
        else         context.lineTo(i, yPix);
    }

    context.stroke();
}


// ── 헬퍼 ──────────────────────────────────────────────────

function setStatus(text) { statusEl.textContent = text; }

setStatus("대기 중 — [시작] 을 누르세요");
