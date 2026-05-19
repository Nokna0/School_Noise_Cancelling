const startBtn = document.getElementById("startBtn");

const canvas = document.getElementById("waveCanvas");

const ctx = canvas.getContext("2d");

canvas.width = 900;
canvas.height = 300;


// ============================================================
// NLMS 설정
// ============================================================

const FILTER_LENGTH = 128;

const mu = 0.05;

let w = new Float32Array(FILTER_LENGTH);

let x_history = new Float32Array(FILTER_LENGTH);


// ============================================================
// Delay Queue
// ============================================================

let delayQueue = [];


// ============================================================
// websocket 연결
// ============================================================

const socket = new WebSocket(

    "ws://localhost:8765"

);

socket.binaryType = "arraybuffer";


// ============================================================
// 시작 버튼
// ============================================================

startBtn.onclick = async () => {

    const stream = await navigator.mediaDevices.getUserMedia({

        audio: true

    });

    const audioContext = new AudioContext({

        sampleRate: 16000

    });

    const source = audioContext.createMediaStreamSource(

        stream

    );

    const processor = audioContext.createScriptProcessor(

        1024,
        1,
        1

    );

    source.connect(processor);

    processor.connect(audioContext.destination);


    // ========================================================
    // 실시간 처리
    // ========================================================

    processor.onaudioprocess = (event) => {

        const input = event.inputBuffer.getChannelData(0);

        const d = new Float32Array(input);

        delayQueue.push(d);

        socket.send(d.buffer);
    };


    // ========================================================
    // 서버 응답
    // ========================================================

    socket.onmessage = (msg) => {

        const x = new Float32Array(msg.data);

        const d = delayQueue.shift();

        if (!d) return;

        const e = nlms(d, x);

        playAudio(

            audioContext,
            e

        );

        drawWave(e);
    };
};


// ============================================================
// NLMS
// ============================================================

function nlms(d, x) {

    const e = new Float32Array(d.length);

    for (let n = 0; n < d.length; n++) {

        for (

            let i = FILTER_LENGTH - 1;
            i > 0;
            i--

        ) {

            x_history[i] = x_history[i - 1];
        }

        x_history[0] = x[n];

        let y = 0;

        for (

            let i = 0;
            i < FILTER_LENGTH;
            i++

        ) {

            y += w[i] * x_history[i];
        }

        e[n] = d[n] - y;

        let norm = 1e-6;

        for (

            let i = 0;
            i < FILTER_LENGTH;
            i++

        ) {

            norm += x_history[i] * x_history[i];
        }

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

function playAudio(audioContext, signal) {

    const buffer = audioContext.createBuffer(

        1,
        signal.length,
        16000

    );

    buffer.copyToChannel(

        signal,
        0

    );

    const src = audioContext.createBufferSource();

    src.buffer = buffer;

    src.connect(audioContext.destination);

    src.start();
}


// ============================================================
// 그래프
// ============================================================

function drawWave(signal) {

    ctx.clearRect(

        0,
        0,
        canvas.width,
        canvas.height

    );

    ctx.beginPath();

    const step = signal.length / canvas.width;

    for (

        let i = 0;
        i < canvas.width;
        i++

    ) {

        const v = signal[

            Math.floor(i * step)

        ];

        const y = (

            canvas.height / 2
            + v * 100

        );

        if (i === 0) {

            ctx.moveTo(i, y);

        } else {

            ctx.lineTo(i, y);
        }
    }

    ctx.strokeStyle = "lime";

    ctx.stroke();
}