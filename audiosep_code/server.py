# ============================================================
# audiosep/server.py
#
# AudioSep + 예측 기반 ALE 하이브리드 파이프라인의 서버측.
#
# 역할:
#   클라이언트로부터 마이크 PCM 청크 d 를 받고,
#   사용자가 지정한 텍스트 쿼리 (예: "vacuum cleaner") 에 해당하는
#   소음 성분 x 를 AudioSep 으로 추출해서 돌려준다.
#
# 클라이언트는 받은 x 를 NLMS 의 참조 신호로 사용하고,
# 필요에 따라 ALE(자기예측)와 캐스케이드로 더 깎아낸다.
#
# ── WebSocket 프로토콜 ──────────────────────────────────────
#   클라이언트 → 서버
#     • 바이너리 : float32 PCM 청크 d (16 kHz mono)
#     • 텍스트   : JSON {"type":"query","text":"..."}      쿼리 변경
#                  JSON {"type":"mu","value":0.05}         μ 로깅용
#                  JSON {"type":"mode","value":"cascade"}  모드 로깅용
#
#   서버 → 클라이언트
#     • 바이너리 : [uint32 seq(LE)] + float32 PCM 참조 신호 x
#                  seq 는 이 x 가 대응하는 청크의 수신 순번.
#                  (서버가 따라가지 못해 건너뛴 청크는 응답이 오지 않으며,
#                   클라이언트는 seq 로 정렬을 맞추고 오래된 청크는 버린다.)
#
# ── 실시간 처리 트릭 ────────────────────────────────────────
#   AudioSep 은 transformer 기반이라 64 ms (1024 샘플) 청크 하나만 줘선
#   분리 품질이 형편없다. 따라서 서버에서 BUFFER_SEC 짜리 롤링 버퍼를
#   유지하고, 매번 버퍼 전체를 AudioSep 에 넣어 마지막 청크 길이만큼만
#   잘라 응답한다. 첫 몇 초는 워밍업으로 컨텍스트가 모자라 잡음이 클 수
#   있지만 그 후엔 안정적이다.
#
#   ── 백프레셔 (latest-wins) ──
#   AudioSep 추론은 64 ms 보다 느릴 수 있다(특히 CPU). 매 청크마다
#   추론을 직렬로 돌리면 백로그와 지연이 무한정 쌓인다. 그래서:
#     • 추론은 run_in_executor 로 워커 스레드에서 돌려 이벤트 루프를
#       막지 않는다(ping/pong 유지 → 연결 안 끊김).
#     • 처리 슬롯은 "가장 최신 버퍼 하나"만 유지한다. 워커가 바쁜 동안
#       들어온 청크들은 덮어써지고, 워커는 끝나면 항상 최신 것만 집어
#       추론한다. 중간 청크들은 응답이 생략되어 지연이 항상 유한하다.
#
# ── 환경변수 ─────────────────────────────────────────────────
#   AUDIOSEP_PATH        : AudioSep 레포 클론 위치  (필수)
#   AUDIOSEP_CHECKPOINT  : .ckpt 파일 경로          (필수)
#   AUDIOSEP_CONFIG      : config yaml 경로         (선택)
#   AUDIOSEP_DEVICE      : 'cuda' | 'cpu'           (자동 감지)
# ============================================================

import asyncio
import json
import os
import sys

import numpy as np
import websockets


# ── AudioSep 경로 셋업 ─────────────────────────────────────

AUDIOSEP_PATH       = os.environ.get("AUDIOSEP_PATH", "../AudioSep")
AUDIOSEP_CONFIG     = os.environ.get(
    "AUDIOSEP_CONFIG",
    os.path.join(AUDIOSEP_PATH, "config", "audiosep_base.yaml"),
)
AUDIOSEP_CHECKPOINT = os.environ.get(
    "AUDIOSEP_CHECKPOINT",
    os.path.join(AUDIOSEP_PATH, "checkpoint", "audiosep_base_4M_steps.ckpt"),
)

if os.path.isdir(AUDIOSEP_PATH):
    sys.path.insert(0, AUDIOSEP_PATH)

import torch                                        # noqa: E402
import scipy.signal                                 # noqa: E402

try:
    from pipeline import build_audiosep             # noqa: E402  (AudioSep 레포 루트의 pipeline.py)
except ImportError as ex:
    print("[ERROR] AudioSep 을 import 하지 못했어.")
    print(f"        AUDIOSEP_PATH={AUDIOSEP_PATH!r} 가 올바른지 확인해줘.")
    print(f"        원본 에러: {ex}")
    sys.exit(1)


# ── 상수 ───────────────────────────────────────────────────

SR_CLIENT   = 16_000     # 클라이언트 sample rate (Web Audio 설정과 일치)
SR_AUDIOSEP = 32_000     # AudioSep 학습 시 sample rate
BUFFER_SEC  = 2.0        # 롤링 버퍼 크기 (컨텍스트 길수록 분리 품질↑, 메모리↑)
BUFFER_LEN  = int(BUFFER_SEC * SR_CLIENT)

DEVICE = os.environ.get(
    "AUDIOSEP_DEVICE",
    "cuda" if torch.cuda.is_available() else "cpu",
)


# ── 모델 로딩 (서버 시작 시 1회) ───────────────────────────

print(f"[INFO] AudioSep 로딩 중  device={DEVICE}")
print(f"       config     = {AUDIOSEP_CONFIG}")
print(f"       checkpoint = {AUDIOSEP_CHECKPOINT}")

model = build_audiosep(
    config_yaml     = AUDIOSEP_CONFIG,
    checkpoint_path = AUDIOSEP_CHECKPOINT,
    device          = DEVICE,
)
model.eval()
print("[INFO] 모델 로딩 완료")


# ── 텍스트 임베딩 캐시 ─────────────────────────────────────
# CLAP 텍스트 인코더는 비싸므로 쿼리당 한 번만 계산하고 재사용.

_text_embed_cache: dict[str, torch.Tensor] = {}

def get_text_embedding(query: str) -> torch.Tensor:
    if query in _text_embed_cache:
        return _text_embed_cache[query]
    with torch.no_grad():
        emb = model.query_encoder.get_query_embed(
            modality="text",
            text=[query],
            device=DEVICE,
        )
    _text_embed_cache[query] = emb
    return emb


# ── AudioSep 분리 함수 ─────────────────────────────────────

def audiosep_separate(audio_16k: np.ndarray, query: str) -> np.ndarray:
    """
    audio_16k : float32 mono PCM @ 16 kHz
    query     : 타겟 소음 텍스트
    반환       : float32 mono PCM @ 16 kHz, 입력과 같은 길이
    """
    # ① 16k → 32k 업샘플 (AudioSep 네이티브 SR)
    audio_32k = scipy.signal.resample_poly(audio_16k, up=2, down=1).astype(np.float32)

    # ② [batch=1, channels=1, samples] 텐서로 변환
    x = torch.from_numpy(audio_32k).to(DEVICE).reshape(1, 1, -1)

    # ③ 추론
    with torch.no_grad():
        cond = get_text_embedding(query)
        sep_32k = model.ss_model({
            "mixture":   x,
            "condition": cond,
        })["waveform"].squeeze().cpu().numpy().astype(np.float32)

    # ④ 32k → 16k 다운샘플
    sep_16k = scipy.signal.resample_poly(sep_32k, up=1, down=2).astype(np.float32)

    # ⑤ 길이 정확히 맞추기 (리샘플 시 ±1 샘플 차이 생길 수 있음)
    if len(sep_16k) > len(audio_16k):
        sep_16k = sep_16k[: len(audio_16k)]
    elif len(sep_16k) < len(audio_16k):
        sep_16k = np.pad(sep_16k, (0, len(audio_16k) - len(sep_16k)))

    return sep_16k


# ============================================================
# WebSocket 핸들러 (클라이언트 1명당 1 인스턴스)
# ============================================================

async def handler(websocket):

    print("[INFO] 클라이언트 연결됨")

    loop = asyncio.get_running_loop()

    # 클라이언트별 상태
    current_query = ""
    current_mu    = 0.05   # 로깅용 (실제 NLMS 적응은 클라이언트에서 수행)
    current_mode  = "cascade"
    rolling_buf   = np.zeros(BUFFER_LEN, dtype=np.float32)

    # ── latest-wins 처리 슬롯 ──
    #   pending 에는 "가장 최근 버퍼 한 개"만 들어간다. 워커가 추론하는
    #   동안 새 청크가 오면 덮어쓰여, 워커는 항상 최신 것만 처리한다.
    pending  = {"buf": None, "seq": 0, "n": 0}
    has_work = asyncio.Event()
    recv_seq = 0

    async def worker():
        while True:
            await has_work.wait()
            has_work.clear()

            buf = pending["buf"]
            seq = pending["seq"]
            n   = pending["n"]
            if buf is None:
                continue

            if not current_query:
                # 쿼리 없으면 0 으로 응답 (NLMS 학습 안 됨 → bypass 효과)
                x = np.zeros(n, dtype=np.float32)
            else:
                # 추론은 워커 스레드에서 → 이벤트 루프 안 막힘
                sep_buf = await loop.run_in_executor(
                    None, audiosep_separate, buf, current_query)
                x = sep_buf[-n:].copy()

            header = int(seq).to_bytes(4, "little")   # uint32 LE
            try:
                await websocket.send(header + x.tobytes())
            except websockets.exceptions.ConnectionClosed:
                break

    worker_task = asyncio.create_task(worker())

    try:
        async for message in websocket:

            if isinstance(message, str):
                # ── 제어 메시지 (JSON) ───────────────────────
                try:
                    data = json.loads(message)
                    msg_type = data.get("type", "")

                    if msg_type == "query":
                        current_query = data.get("text", "")
                        print(f"  쿼리 업데이트 : {current_query!r}")

                    elif msg_type == "mu":
                        current_mu = float(data.get("value", 0.05))
                        print(f"  μ 업데이트   : {current_mu:.4f}")

                    elif msg_type == "mode":
                        current_mode = str(data.get("value", "cascade"))
                        print(f"  모드 업데이트 : {current_mode}")

                except (json.JSONDecodeError, ValueError):
                    pass

            else:
                # ── 오디오 청크 (바이너리) ───────────────────
                chunk = np.frombuffer(message, dtype=np.float32)
                n = len(chunk)
                recv_seq += 1

                # 롤링 버퍼: 가장 오래된 n 샘플 버리고 뒤에 새 청크 붙임.
                # concat 은 새 배열을 만들므로, 워커가 들고 있는 이전 버퍼는
                # 안전하게 보존된다(스레드 경합 없음).
                rolling_buf = np.concatenate([rolling_buf[n:], chunk])

                # 최신 프레임으로 슬롯 갱신 후 워커 깨우기
                pending["buf"] = rolling_buf
                pending["seq"] = recv_seq
                pending["n"]   = n
                has_work.set()

    except websockets.exceptions.ConnectionClosed:
        print("[INFO] 클라이언트 연결 종료")
    finally:
        worker_task.cancel()


# ============================================================
# 서버 시작
# ============================================================

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765, max_size=None):
        print("[INFO] 서버 실행 중  ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
