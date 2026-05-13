// 이 코드는 main.js와 분리된 독립적인 오디오 스레드에서 샘플 단위로 실행됩니다.
class LMSProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.filterLength = 256; // 적응형 필터 탭(Tap) 길이
        this.weights = new Float32Array(this.filterLength); // w(n)
        this.xBuffer = new Float32Array(this.filterLength); // x(n) 버퍼
        this.mu = 0.01; // Step-size
        this.refBuffer = null; // AudioSep에서 받은 참조 신호 x(n)
        this.refIndex = 0;

        // main.js로부터 데이터(x(n) 버퍼 업데이트, mu 값 변경)를 받는 리스너
        this.port.onmessage = (event) => {
            if (event.data.type === 'UPDATE_MU') {
                this.mu = event.data.payload;
            } else if (event.data.type === 'UPDATE_REFERENCE') {
                this.refBuffer = new Float32Array(event.data.payload);
                this.refIndex = 0;
            }
        };
    }

    // 128 샘플(Chunk)마다 시스템이 자동으로 호출하는 콜백 함수
    process(inputs, outputs, parameters) {
        const input = inputs[0];  // d(n) (마이크 입력)
        const output = outputs[0]; // e(n) (최종 스피커 출력)

        if (!input || input.length === 0) return true;

        const inputChannel = input[0];
        const outputChannel = output[0];

        // 샘플 단위로 LMS 알고리즘 연산
        for (let i = 0; i < inputChannel.length; i++) {
            const d_n = inputChannel[i]; // 현재 입력된 혼합 신호 샘플
            
            // 참조 신호가 있으면 xBuffer를 시프트하고 새 샘플 삽입
            if (this.refBuffer) {
                for (let j = this.filterLength - 1; j > 0; j--) {
                    this.xBuffer[j] = this.xBuffer[j - 1];
                }
                this.xBuffer[0] = this.refBuffer[this.refIndex % this.refBuffer.length];
                this.refIndex++;
            }

            // 1. 추정된 잡음 계산: y(n) = w^T(n) * x(n)
            let y_n = 0;
            for (let j = 0; j < this.filterLength; j++) {
                y_n += this.weights[j] * this.xBuffer[j];
            }

            // 2. 오차 신호 (깨끗해진 소리) 계산: e(n) = d(n) - y(n)
            const e_n = d_n - y_n;
            outputChannel[i] = e_n; // 스피커로 출력

            // 3. 필터 가중치 업데이트 (LMS): w(n+1) = w(n) + mu * e(n) * x(n)
            for (let j = 0; j < this.filterLength; j++) {
                this.weights[j] = this.weights[j] + this.mu * e_n * this.xBuffer[j];
            }
            
        }

        // true를 반환해야 AudioWorklet이 죽지 않고 계속 오디오를 처리합니다.
        return true; 
    }
}

// 이 프로세서를 'lms-processor'라는 이름으로 시스템에 등록
registerProcessor('lms-processor', LMSProcessor);

