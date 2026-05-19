import asyncio
import websockets
import numpy as np


# ============================================================
# 가짜 AudioSep
# ============================================================

def fake_audiosep(audio):

    fft = np.fft.rfft(audio)

    cutoff = 3000

    fft[cutoff:] = 0

    separated = np.fft.irfft(fft)

    return separated.astype(np.float32)


# ============================================================
# websocket handler
# ============================================================

async def handler(websocket):

    print("클라이언트 연결됨")

    async for message in websocket:

        audio = np.frombuffer(

            message,
            dtype=np.float32

        )

        x = fake_audiosep(audio)

        await websocket.send(

            x.tobytes()

        )


# ============================================================
# 서버 시작
# ============================================================

async def main():

    async with websockets.serve(

        handler,
        "0.0.0.0",
        8765

    ):

        print("서버 실행 중")

        await asyncio.Future()


asyncio.run(main())