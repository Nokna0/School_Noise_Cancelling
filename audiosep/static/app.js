/**
 * app.js
 * ------
 * 실시간 노이즈 캔슬링 프론트엔드.
 *
 * 전체 파이프라인:
 *   마이크 → ScriptProcessor(1024샘플) → WebSocket → server.py(FFT 필터)
 *           ↓                                              ↓
 *   delayQueue(원본 d[n])             ←──────────── 참조 신호 x[n] 수신
 *           ↓
 *   NLMS 적응 필터 → 오디오 출력 + 파형 시각화
 *
 * 노이즈 캔슬링 원리 (적응 필터):
 *   d[n] = 원하는 신호 + 노이즈       (마이크에서 직접 수신)
 *   x[n] = 참조 노이즈 신호           (서버 FFT 필터 출력, 노이즈 추정치)
 *   y[n] = NLMS 필터 출력            (x를 이용해 d 안의 노이즈를 모델링)
 *   e[n] = d[n] - y[n]              (오차 = 노이즈가 제거된 클린 신호)
 */

const startBtn = document.getElementById("startBtn");

const canvas = document.getElementById("waveCanvas");
const ctx = canvas.getContext("2d");

canvas.width = 900;
canvas.height = 300;


// ============================================================
// NLMS 설정
// ============================================================

/**
 * FILTER_LENGTH: 적응 필터의 탭(tap) 수.
 *   값이 클수록 더 복잡한 노이즈 패턴을 모델링할 수 있지만
 *   계산량이 늘고 수렴이 느려진다.
 */
const FILTER_LENGTH = 128;

/**
 * mu (학습률, step size):
 *   필터 가중치를 얼마나 빠르게 갱신할지 결정한다.
 *   - 값이 클수록 수렴 속도가 빠르지만 불안정해질 수 있다.
 *   - 값이 작을수록 안정적이지만 수렴이 느리다.
 *   - NLMS에서의 안정 조건: 0 < mu < 2
 */
const mu = 0.05;

/** 적응 필터 가중치 벡터 w (길이 FILTER_LENGTH, 초기값 0) */
let w = new Float32Array(FILTER_LENGTH);

/** 참조 신호의 과거 샘플 버퍼 (슬라이딩 윈도우) */
let x_history = new Float32Array(FILTER_LENGTH);


// ============================================================
// Delay Queue (지연 큐)
// ============================================================

/**
 * 원본 마이크 신호(d)를 임시 저장하는 큐.
 *
 * 서버와의 통신에는 네트워크 지연이 있으므로, 마이크 청크를 바로
 * NLMS에 사용할 수 없다. 청크를 전송한 순서대로 쌓아두고,
 * 서버 응답이 도착할 때 FIFO로 꺼내어 사용한다.
 */
let delayQueue = [];


// ============================================================
// WebSocket 연결
// ============================================================

/**
 * server.py 에 연결하는 WebSocket.
 * 마이크 청크를 보내면 FFT 필터링된 참조 신호를 돌려받는다.
 */
const socket = new WebSocket(
    "ws://localhost:8765"
);

/** 수신 데이터를 ArrayBuffer로 처리 (Float32Array 변환 목적) */
socket.binaryType = "arraybuffer";


// ============================================================
// 시작 버튼 이벤트
// ============================================================

startBtn.onclick = async () => {

    /** 브라우저에서 마이크 권한을 요청하고 스트림을 획득 */
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true
    });

    /**
     * 16 kHz 샘플레이트로 AudioContext 생성.
     * 낮은 샘플레이트를 사용하면 처리 데이터량이 줄어 지연이 감소한다.
     */
    const audioContext = new AudioContext({
        sampleRate: 16000
    });

    /** 마이크 스트림을 AudioContext 에 연결하는 소스 노드 */
    const source = audioContext.createMediaStreamSource(
        stream
    );

    /**
     * ScriptProcessor 노드: 오디오 데이터를 JavaScript로 직접 처리.
     * 인자: (버퍼 크기=1024, 입력 채널 수=1, 출력 채널 수=1)
     *
     * 참고: ScriptProcessor는 구형 API이나 Web Audio API의
     *       AudioWorklet 이전 방식으로 여전히 널리 쓰인다.
     */
    const processor = audioContext.createScriptProcessor(
        1024,   // bufferSize: 한 번에 처리할 샘플 수
        1,      // inputChannels: 모노 입력
        1       // outputChannels: 모노 출력
    );

    source.connect(processor);
    processor.connect(audioContext.destination);


    // ========================================================
    // 실시간 오디오 캡처 (마이크 → 서버 전송)
    // ========================================================

    processor.onaudioprocess = (event) => {

        /** 마이크에서 가져온 원본 샘플 배열 (Float32, 길이 1024) */
        const input = event.inputBuffer.getChannelData(0);

        /** 복사본 생성 (원본 버퍼는 콜백 이후 재사용될 수 있으므로) */
        const d = new Float32Array(input);

        /**
         * NLMS 처리를 위해 원본 신호를 큐에 저장.
         * 서버 응답이 오면 이 청크와 쌍을 맞춰 사용한다.
         */
        delayQueue.push(d);

        /** Float32 바이너리를 WebSocket으로 서버에 전송 */
        socket.send(d.buffer);
    };


    // ========================================================
    // 서버 응답 처리 (참조 신호 수신 → NLMS → 출력)
    // ========================================================

    socket.onmessage = (msg) => {

        /** 서버가 반환한 FFT 필터링된 참조 신호 x[n] */
        const x = new Float32Array(msg.data);

        /** 전송 순서와 동일한 원본 신호 d[n]을 큐에서 꺼냄 */
        const d = delayQueue.shift();

        /** 큐가 비어 있으면 동기화 불일치 — 건너뜀 */
        if (!d) return;

        /** NLMS 적응 필터 적용: e[n] = d[n] - y[n] (클린 신호) */
        const e = nlms(d, x);

        /** 클린 신호를 스피커로 출력 */
        playAudio(
            audioContext,
            e
        );

        /** 클린 신호 파형을 canvas에 시각화 */
        drawWave(e);
    };
};


// ============================================================
// NLMS (Normalized Least Mean Squares) 적응 필터
// ============================================================

/**
 * NLMS 알고리즘으로 참조 신호를 이용해 노이즈를 제거한다.
 *
 * 알고리즘 개요 (샘플 n마다 반복):
 *   1. x_history 슬라이딩 윈도우에 x[n] 추가 (FIFO)
 *   2. 필터 출력 계산: y[n] = w^T · x_history  (내적)
 *   3. 오차 계산:     e[n] = d[n] - y[n]
 *   4. 전력 정규화:   norm = ||x_history||²  + ε
 *   5. 가중치 갱신:   w = w + (mu / norm) * e[n] * x_history
 *
 * 정규화(norm)의 역할:
 *   LMS 대비 입력 신호의 전력에 상관없이 수렴 속도를 일정하게 유지한다.
 *   ε(1e-6)은 norm이 0이 되는 상황(무음)에서의 나눗셈 방지 항이다.
 *
 * @param {Float32Array} d - 원본 마이크 신호 (desired signal)
 * @param {Float32Array} x - 서버 FFT 필터 출력 (reference signal)
 * @returns {Float32Array} e - 노이즈 제거된 클린 신호 (error signal)
 */
function nlms(d, x) {

    /** 출력 배열 초기화 (클린 신호 e[n]) */
    const e = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        // ── Step 1: 참조 신호 히스토리 업데이트 (슬라이딩 윈도우) ──
        // x_history[0]이 가장 최신 샘플, x_history[FILTER_LENGTH-1]이 가장 오래된 샘플
        for (
            let i = FILTER_LENGTH - 1;
            i > 0;
            i--
        ) {
            x_history[i] = x_history[i - 1];   // 오래된 방향으로 한 칸씩 밀어내기
        }
        x_history[0] = x[n];                    // 최신 샘플 삽입

        // ── Step 2: 필터 출력 y[n] = w · x_history (내적) ──
        let y = 0;
        for (
            let i = 0;
            i < FILTER_LENGTH;
            i++
        ) {
            y += w[i] * x_history[i];
        }

        // ── Step 3: 오차(클린 신호) 계산 ──
        e[n] = d[n] - y;

        // ── Step 4: 입력 전력 계산 (정규화 분모) ──
        // ε = 1e-6 을 더해 무음 구간에서 분모가 0이 되는 것을 방지
        let norm = 1e-6;
        for (
            let i = 0;
            i < FILTER_LENGTH;
            i++
        ) {
            norm += x_history[i] * x_history[i];   // ||x_history||²
        }

        // ── Step 5: 가중치 갱신 (NLMS 핵심) ──
        // w[i] += (mu / norm) * e[n] * x_history[i]
        for (
            let i = 0;
            i < FILTER_LENGTH;
            i++
        ) {
            w[i] += (
                mu
                * e[n]
                * x_history[i]
            ) / norm;
        }
    }

    return e;
}


// ============================================================
// 오디오 출력
// ============================================================

/**
 * 클린 신호(Float32 배열)를 AudioContext를 통해 스피커로 재생한다.
 *
 * @param {AudioContext} audioContext - 기존 AudioContext 인스턴스
 * @param {Float32Array} signal - 재생할 오디오 샘플 배열
 */
function playAudio(audioContext, signal) {

    /** 단일 채널, signal.length 샘플 크기의 AudioBuffer 생성 */
    const buffer = audioContext.createBuffer(
        1,              // 채널 수 (모노)
        signal.length,  // 샘플 수
        16000           // 샘플레이트 (AudioContext 와 동일하게 설정)
    );

    /** 샘플 데이터를 채널 0에 복사 */
    buffer.copyToChannel(
        signal,
        0
    );

    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContext.destination);
    src.start();    // 즉시 재생
}


// ============================================================
// 파형 시각화
// ============================================================

/**
 * 클린 신호의 파형을 canvas에 그린다.
 *
 * 매 청크(1024 샘플)마다 호출되어 실시간으로 파형을 갱신한다.
 * canvas 너비(900px)에 맞게 신호를 다운샘플링하여 한 픽셀당 한 샘플을 그린다.
 *
 * @param {Float32Array} signal - 시각화할 오디오 샘플 배열
 */
function drawWave(signal) {

    /** 이전 프레임 지우기 */
    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );

    ctx.beginPath();

    /**
     * step: 신호 배열 인덱스를 캔버스 픽셀에 매핑하는 비율.
     * signal.length(1024) > canvas.width(900) 이면 일부 샘플이 생략된다.
     */
    const step = signal.length / canvas.width;

    for (
        let i = 0;
        i < canvas.width;
        i++
    ) {
        /** 이 픽셀에 해당하는 신호 샘플 값 (-1 ~ +1) */
        const v = signal[
            Math.floor(i * step)
        ];

        /**
         * v를 캔버스 y 좌표로 변환.
         * v = 0  → canvas.height / 2 (수평 중앙선)
         * v = +1 → 중앙선 위로 100px
         * v = -1 → 중앙선 아래로 100px
         */
        const y = (
            canvas.height / 2
            + v * 100
        );

        if (i === 0) {
            ctx.moveTo(i, y);   // 첫 점: 이동만
        } else {
            ctx.lineTo(i, y);   // 나머지: 선으로 연결
        }
    }

    ctx.strokeStyle = "lime";   // 파형 색상 (밝은 녹색)
    ctx.stroke();
}
