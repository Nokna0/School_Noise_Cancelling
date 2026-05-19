"""
server.py
---------
WebSocket 기반 실시간 오디오 처리 서버.

역할:
    브라우저 마이크에서 수신한 오디오 청크에 FFT 저역통과 필터를 적용하고
    결과를 다시 브라우저로 반환한다. 브라우저 측 NLMS 적응 필터와 함께
    노이즈 캔슬링 파이프라인을 구성한다.

전체 파이프라인:
    [마이크 입력] ──WebSocket──► [server.py: FFT 필터] ──WebSocket──► [app.js: NLMS 필터] ──► [스피커 출력]

프로토콜:
    - 수신: Float32 PCM 바이너리 (청크 크기 = 1024 샘플, 16 kHz)
    - 송신: FFT 필터 적용 후 Float32 PCM 바이너리 (동일 크기)

실행:
    python server.py
    → localhost:8765 에서 WebSocket 서버 대기
"""

import asyncio
import websockets
import numpy as np


# ============================================================
# 가짜 AudioSep (FFT 기반 저역통과 필터)
# ============================================================

def fake_audiosep(audio):
    """
    FFT 저역통과 필터로 고주파 노이즈 성분을 제거한다.

    실제 AudioSep은 딥러닝 기반 음원 분리 모델이지만,
    여기서는 구현 복잡도를 낮추기 위해 FFT 필터로 대체한다.
    이 함수의 출력이 NLMS 적응 필터의 '참조 신호(reference)'로 사용된다.

    동작 원리:
        1. rfft  : 실수 신호 → 주파수 도메인 (복소 스펙트럼)
        2. 마스킹 : cutoff 인덱스 이상의 주파수 성분을 0으로 제거
        3. irfft : 주파수 도메인 → 다시 시간 도메인으로 복원

    매개변수:
        audio (np.ndarray): float32 PCM 샘플 배열 (1024 샘플 단위)

    반환값:
        np.ndarray: 고주파 제거 후 float32 PCM 배열 (동일 길이)

    참고:
        cutoff=3000 은 FFT 빈(bin) 인덱스 기준이다.
        16kHz 샘플레이트, 1024 샘플 청크일 때 실제 주파수:
            f = cutoff * (sampleRate / N) = 3000 * (16000 / 1024) ≈ 46.9 kHz
        → 가청 범위(20 Hz ~ 20 kHz)를 훨씬 초과하므로 사실상 거의 필터링 없음.
        실험 목적에 맞게 cutoff 값을 조정해야 한다.
    """
    fft = np.fft.rfft(audio)    # 실수 입력의 FFT → 절반 크기 복소 스펙트럼

    cutoff = 3000               # 이 인덱스 이상의 주파수 빈을 0으로 제거
    fft[cutoff:] = 0            # 저역통과 마스킹 (고주파 노이즈 제거)

    separated = np.fft.irfft(fft)   # 역FFT → 시간 도메인 복원

    return separated.astype(np.float32)


# ============================================================
# WebSocket 핸들러 (클라이언트 1개당 1개 코루틴)
# ============================================================

async def handler(websocket):
    """
    WebSocket 클라이언트 연결을 처리하는 비동기 핸들러.

    클라이언트가 연결될 때마다 asyncio가 새 코루틴으로 호출한다.
    메시지 수신 → FFT 필터 적용 → 결과 송신 루프를 반복한다.

    매개변수:
        websocket: websockets 라이브러리가 제공하는 연결 객체.
                   send / recv 메서드로 데이터를 주고받는다.
    """
    print("클라이언트 연결됨")

    async for message in websocket:     # 클라이언트가 보낸 메시지를 순서대로 처리

        # 수신한 바이너리 데이터를 float32 배열로 해석
        audio = np.frombuffer(
            message,
            dtype=np.float32
        )

        # FFT 저역통과 필터 적용 (노이즈 참조 신호 생성)
        x = fake_audiosep(audio)

        # 처리 결과를 바이너리로 직렬화하여 클라이언트에 반환
        await websocket.send(
            x.tobytes()
        )


# ============================================================
# 서버 진입점
# ============================================================

async def main():
    """
    WebSocket 서버를 0.0.0.0:8765 에서 시작하고 무한 대기한다.

    0.0.0.0 으로 바인딩하면 localhost뿐 아니라 같은 네트워크의
    다른 기기에서도 접속할 수 있다. 로컬 전용이라면 "127.0.0.1" 로 변경 가능.
    """
    async with websockets.serve(
        handler,
        "0.0.0.0",  # 모든 네트워크 인터페이스에서 수신
        8765        # WebSocket 포트
    ):
        print("서버 실행 중 (ws://0.0.0.0:8765)")

        # 서버가 종료되지 않도록 영구 대기
        await asyncio.Future()


asyncio.run(main())
