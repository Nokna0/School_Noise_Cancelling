// ============================================================
// audiosep/static/app.js
// ------------------------------------------------------------
// 브라우저에서 마이크 입력을 받아 WebSocket 서버로 보내고,
// 서버가 돌려준 "잡음 추정 신호 x" 와 함께 NLMS(정규화 LMS)
// 적응 필터를 돌려, "잡음이 제거된 신호 e" 를 다시 스피커로
// 재생하면서 캔버스에 파형을 그려 주는 데모 코드.
//
// 신호 흐름:
//   마이크 ──► (a) 원 신호 d ──► WebSocket ──► 서버
//                                                 │
//                                                 ▼ fake_audiosep
//                                          잡음 추정치 x
//                                                 │
//                                                 ▼
//   d 와 x 가 클라이언트에서 NLMS 에 함께 들어가
//   y = w·x (잡음 모델), e = d - y (정제된 신호) 를 만든다.
//   e 를 스피커로 재생하고 캔버스에 그린다.
//
// NLMS 의 핵심 식:
//   y[n]   = Σ w[i] · x[n-i]
//   e[n]   = d[n] - y[n]
//   w[i] += μ · e[n] · x[n-i] / (||x||² + ε)
// ============================================================


// ── HTML 요소 가져오기 ──────────────────────────────────────
// index.html 에 정의된 "시작" 버튼과 캔버스를 잡는다.
const startBtn = document.getElementById("startBtn");

const canvas = document.getElementById("waveCanvas");

// 2D 그리기 컨텍스트. 이후 stroke / lineTo 등 호출 시 사용한다.
const ctx = canvas.getContext("2d");

// 내부 해상도(픽셀 수). CSS 의 width/height 와는 다른 개념.
// 두 값이 다르면 그림이 늘어나거나 줄어들어 보인다.
canvas.width = 900;
canvas.height = 300;


// ============================================================
// NLMS 설정
// ------------------------------------------------------------
// FILTER_LENGTH : 적응 필터의 탭(tap) 개수.
//                 클수록 더 복잡한 잡음 모델을 표현할 수 있지만
//                 계산량이 늘고 수렴도 느려진다.
// mu            : 학습률(step size). 너무 크면 발산, 너무 작으면
//                 수렴이 느림. 0~2 범위에서 보통 0.01~0.5 권장.
// w             : 현재 추정 중인 필터 계수. 매 샘플마다 갱신된다.
// x_history     : 최근 FILTER_LENGTH 개의 참조 신호 샘플 버퍼
//                 (FIR 필터의 지연선 역할).
// ============================================================

const FILTER_LENGTH = 128;

const mu = 0.05;

let w = new Float32Array(FILTER_LENGTH);          // 초기값 0

let x_history = new Float32Array(FILTER_LENGTH);  // 초기값 0


// ============================================================
// Delay Queue
// ------------------------------------------------------------
// 마이크에서 캡쳐한 d 청크를 보낸 뒤, 서버가 같은 청크에 대한
// 응답 x 를 돌려줄 때까지 d 를 그대로 보관해 둔다.
// 응답이 도착하면 가장 오래된 d 와 짝지어 NLMS 에 넣는다.
// (서버 왕복 시간이 0 이 아니므로 d 와 x 의 짝을 맞춰 줘야 한다.)
// ============================================================

let delayQueue = [];


// ============================================================
// websocket 연결
// ------------------------------------------------------------
// 같은 머신의 server.py(8765 포트)에 접속한다.
// binaryType 을 "arraybuffer" 로 설정해야 받는 메시지를
// 그대로 Float32Array 로 해석할 수 있다.
// ============================================================

const socket = new WebSocket(

    "ws://localhost:8765"

);

socket.binaryType = "arraybuffer";


// ============================================================
// 시작 버튼
// ------------------------------------------------------------
// 1) 마이크 권한 요청 (HTTPS 또는 localhost 에서만 동작)
// 2) AudioContext 생성 (샘플레이트 16 kHz 로 고정)
// 3) ScriptProcessorNode 로 1024 샘플마다 콜백 받기
// 4) onaudioprocess 에서 청크를 그대로 서버로 전송
// 5) socket.onmessage 에서 NLMS → 재생 → 그리기
// ============================================================

startBtn.onclick = async () => {

    // 사용자에게 마이크 접근 허가를 요청. 거부 시 예외.
    const stream = await navigator.mediaDevices.getUserMedia({

        audio: true

    });

    // 서버와 같은 샘플레이트(16 kHz)로 맞춰서 리샘플링 비용을 줄인다.
    const audioContext = new AudioContext({

        sampleRate: 16000

    });

    // 마이크 스트림을 AudioContext 의 노드 그래프에 연결.
    const source = audioContext.createMediaStreamSource(

        stream

    );

    // ScriptProcessor: 1024 샘플마다 onaudioprocess 콜백을 호출.
    //  (1, 1) = 입력 채널 1개, 출력 채널 1개 → mono.
    //  최신 브라우저에서는 deprecated 지만 단순 데모로는 충분.
    const processor = audioContext.createScriptProcessor(

        1024,
        1,
        1

    );

    // source → processor → destination(스피커) 그래프 구성.
    // destination 으로 잇지 않으면 일부 브라우저에서
    // ScriptProcessor 콜백이 호출되지 않는다.
    source.connect(processor);
    processor.connect(audioContext.destination);


    // ========================================================
    // 실시간 처리
    // --------------------------------------------------------
    // 마이크에서 1024 샘플이 채워질 때마다 호출된다.
    // 입력 d 를 큐에 저장하고, 같은 데이터를 그대로 서버에 전송.
    // (서버는 이 d 로부터 잡음 후보 x 를 만들어 돌려준다.)
    // ========================================================

    processor.onaudioprocess = (event) => {

        // 첫 번째(유일한) 입력 채널의 샘플 배열.
        const input = event.inputBuffer.getChannelData(0);

        // 콜백이 반환되면 input 메모리는 재사용되므로 복사본을 만든다.
        const d = new Float32Array(input);

        // 서버 응답과 짝지을 수 있도록 큐에 넣어 둔다.
        delayQueue.push(d);

        // 원본 d 청크를 그대로 서버로 전송 (Float32 PCM 바이트).
        socket.send(d.buffer);
    };


    // ========================================================
    // 서버 응답
    // --------------------------------------------------------
    // 서버에서 x(잡음 추정치) 가 도착하면 큐에서 d 를 꺼내
    // 둘을 NLMS 에 넣어 정제된 신호 e 를 만든다.
    // ========================================================

    socket.onmessage = (msg) => {

        // 바이너리 메시지를 float32 배열로 해석.
        const x = new Float32Array(msg.data);

        // 같은 시점에 보낸 원 신호 d 를 큐에서 꺼낸다 (FIFO).
        const d = delayQueue.shift();

        if (!d) return;   // 짝이 없으면 처리 불가 (시작 직후 등)

        // NLMS: e = d - w·x, 그리고 w 도 함께 갱신.
        const e = nlms(d, x);

        // 정제된 신호 e 를 곧바로 스피커로 재생.
        playAudio(

            audioContext,
            e

        );

        // 캔버스에 e 의 파형을 그린다.
        drawWave(e);
    };
};


// ============================================================
// NLMS
// ------------------------------------------------------------
// 정규화 LMS(Normalized Least Mean Square) 적응 필터.
//
// 인자:
//   d : 원 신호(desired). 잡음이 섞인 마이크 입력.
//   x : 참조 신호(reference). 잡음 추정치.
// 반환:
//   e : 오차 신호 = d - 추정잡음. 잡음이 제거된 결과.
//
// 동작 요약:
//   샘플마다
//     1) x_history 를 한 칸 밀고 가장 최근 x[n] 을 넣는다.
//     2) y = Σ w[i] · x_history[i]    (현재 필터 출력)
//     3) e = d[n] - y                  (잔차 = 원하는 신호)
//     4) norm = ε + Σ x_history[i]²   (입력 에너지로 정규화)
//     5) w[i] += μ · e · x_history[i] / norm  (계수 갱신)
// ============================================================

function nlms(d, x) {

    // 결과 오차 신호를 저장할 같은 길이의 버퍼.
    const e = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        // (1) x_history 를 오른쪽으로 한 칸씩 이동
        //     → 인덱스 0 자리에 새 샘플을 넣을 공간을 만든다.
        for (

            let i = FILTER_LENGTH - 1;
            i > 0;
            i--

        ) {

            x_history[i] = x_history[i - 1];
        }

        // (1') 가장 최근 참조 샘플을 0번 자리에 넣는다.
        x_history[0] = x[n];

        // (2) 필터 출력 y = w · x_history (FIR 합)
        let y = 0;

        for (

            let i = 0;
            i < FILTER_LENGTH;
            i++

        ) {

            y += w[i] * x_history[i];
        }

        // (3) 오차 = 원 신호 - 필터가 추정한 잡음
        //     이 값이 곧 "잡음이 빠진 정제 신호" 가 된다.
        e[n] = d[n] - y;

        // (4) 입력 에너지(norm). ε(=1e-6) 은 0 으로 나누는 것을 방지.
        let norm = 1e-6;

        for (

            let i = 0;
            i < FILTER_LENGTH;
            i++

        ) {

            norm += x_history[i] * x_history[i];
        }

        // (5) 계수 갱신: μ·e·x / ||x||²
        //     큰 입력이 들어와도 발산하지 않도록 norm 으로 나눠 준다.
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
// ------------------------------------------------------------
// 주어진 float32 배열을 그대로 1채널, 16 kHz AudioBuffer 에 담아
// 스피커로 즉시 재생한다. 매 청크가 도착할 때마다 호출된다.
// ============================================================

function playAudio(audioContext, signal) {

    // (채널 수, 샘플 수, 샘플레이트) 로 빈 버퍼 생성.
    const buffer = audioContext.createBuffer(

        1,
        signal.length,
        16000

    );

    // signal 데이터를 0번(유일한) 채널에 복사.
    buffer.copyToChannel(

        signal,
        0

    );

    // 일회용 BufferSource 를 만들어 destination 으로 보낸다.
    const src = audioContext.createBufferSource();

    src.buffer = buffer;

    src.connect(audioContext.destination);

    src.start();    // 지금 즉시 재생
}


// ============================================================
// 그래프
// ------------------------------------------------------------
// 캔버스 한 폭에 입력 signal 을 가로로 다운샘플링해 그린다.
// 진폭 1.0 이 화면 중앙에서 위/아래로 100px 만큼 그려진다.
// ============================================================

function drawWave(signal) {

    // 이전 프레임 지우기.
    ctx.clearRect(

        0,
        0,
        canvas.width,
        canvas.height

    );

    ctx.beginPath();

    // 신호 길이와 캔버스 너비가 다르므로,
    // 픽셀 한 칸당 몇 개의 샘플을 건너뛸지를 계산.
    const step = signal.length / canvas.width;

    for (

        let i = 0;
        i < canvas.width;
        i++

    ) {

        // 픽셀 i 에 대응되는 샘플 값.
        // 보간하지 않고 인접 샘플 하나만 골라 쓴다(빠르지만 거칠다).
        const v = signal[

            Math.floor(i * step)

        ];

        // 화면 좌표 y: 중앙(canvas.height/2) 을 기준으로
        // 진폭 v 에 100 을 곱해 위/아래로 벌려 그린다.
        const y = (

            canvas.height / 2
            + v * 100

        );

        // 첫 픽셀에서는 펜을 옮기기만 하고, 이후엔 선을 잇는다.
        if (i === 0) {

            ctx.moveTo(i, y);

        } else {

            ctx.lineTo(i, y);
        }
    }

    // 형광 라임색으로 한 번에 그리기.
    ctx.strokeStyle = "lime";

    ctx.stroke();
}
