# ============================================================
# audiosep/server.py
#
# 4-모듈 구조에서 Module 2 (AI 참조 신호 추출) 를 담당한다.
#
# WebSocket 프로토콜:
#   클라이언트 → 서버
#     • 바이너리 : float32 PCM 청크 d(n)
#     • 텍스트   : JSON {"type":"query","text":"..."} 쿼리 업데이트
#                  JSON {"type":"mu","value":0.05}    μ 정보 (로깅용)
#
#   서버 → 클라이언트
#     • 바이너리 : float32 PCM 참조 신호 x(n) (d 와 동일 길이)
#
# fake_audiosep:
#   실제 AudioSep 모델을 붙이기 전의 임시 구현.
#   저역통과 필터(LPF)로 타겟 잡음 성분을 흉내낸다.
#   query 파라미터를 받아 두어, 추후 모델 교체 시 인터페이스 유지.
# ============================================================

import asyncio
import json
import websockets
import numpy as np


# ============================================================
# Module 2: 참조 신호 추출 (fake — 실제 AudioSep 교체 예정)
# ============================================================

def fake_audiosep(audio: np.ndarray, query: str = "") -> np.ndarray:
    """
    audio : float32 ndarray, 16 kHz mono PCM
    query : 타겟 소음 설명 텍스트 (예: "vacuum cleaner")
            지금은 사용하지 않지만 AudioSep 교체 시 그대로 전달한다.
    반환  : 같은 길이의 float32 참조 신호 x(n)
    """
    fft    = np.fft.rfft(audio)
    cutoff = 3000          # 이 빈 이상의 고주파 제거 (LPF 역할)
    fft[cutoff:] = 0
    x = np.fft.irfft(fft)
    return x.astype(np.float32)


# ============================================================
# WebSocket 핸들러 (클라이언트 1명마다 실행)
# ============================================================

async def handler(websocket):

    print("클라이언트 연결됨")

    current_query = ""   # 타겟 소음 텍스트 (Module 2 에 전달)
    current_mu    = 0.05 # 클라이언트 μ 로깅용

    async for message in websocket:

        if isinstance(message, str):
            # ── 제어 메시지 (JSON) ──────────────────────────
            try:
                data = json.loads(message)
                msg_type = data.get("type", "")

                if msg_type == "query":
                    current_query = data.get("text", "")
                    print(f"  쿼리 업데이트 : {current_query!r}")

                elif msg_type == "mu":
                    current_mu = float(data.get("value", 0.05))
                    print(f"  μ 업데이트   : {current_mu:.4f}")

            except (json.JSONDecodeError, ValueError):
                pass

        else:
            # ── 오디오 청크 (바이너리) ───────────────────────
            audio = np.frombuffer(message, dtype=np.float32)
            x     = fake_audiosep(audio, current_query)
            await websocket.send(x.tobytes())


# ============================================================
# 서버 시작
# ============================================================

async def main():

    async with websockets.serve(handler, "0.0.0.0", 8765):
        print("서버 실행 중  ws://localhost:8765")
        await asyncio.Future()


asyncio.run(main())
