#!/usr/bin/env python3
# ============================================================
# audiosep_code/export_onnx.py
#
# AudioSep ss_model → ONNX 변환 + ONNX Runtime 속도 측정 (1회 실행)
#
# 실행 방법:
#   pip install onnxruntime
#   python export_onnx.py
#
# 출력:
#   audiosep_ss.onnx
# ============================================================

import os
import sys
import time

AUDIOSEP_PATH       = os.environ.get("AUDIOSEP_PATH", "../AudioSep")
AUDIOSEP_CONFIG     = os.environ.get(
    "AUDIOSEP_CONFIG",
    os.path.join(AUDIOSEP_PATH, "config", "audiosep_base.yaml"),
)
AUDIOSEP_CHECKPOINT = os.environ.get(
    "AUDIOSEP_CHECKPOINT",
    os.path.join(AUDIOSEP_PATH, "checkpoint", "audiosep_base_4M_steps.ckpt"),
)
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

if os.path.isdir(AUDIOSEP_PATH):
    sys.path.insert(0, AUDIOSEP_PATH)
    os.chdir(AUDIOSEP_PATH)

import numpy as np
import torch
from pipeline import build_audiosep

sys.stdout.reconfigure(line_buffering=True)


# ── 1. 모델 로딩 ───────────────────────────────────────────

print("[1/4] AudioSep 모델 로딩 중...")
model = build_audiosep(
    config_yaml=AUDIOSEP_CONFIG,
    checkpoint_path=AUDIOSEP_CHECKPOINT,
    device="cpu",
)
model.eval()
torch.set_num_threads(os.cpu_count() or 4)
print(f"      완료  (CPU 스레드={torch.get_num_threads()})")


# ── 2. 입력 shape 확인 ────────────────────────────────────

print("[2/4] 입력 shape 확인 중...")
with torch.no_grad():
    test_cond = model.query_encoder.get_query_embed(
        modality="text", text=["test"], device="cpu"
    )
COND_DIM = test_cond.shape[-1]
SR_32K   = 32_000
BUF_LEN  = SR_32K   # BUFFER_SEC=1.0

print(f"      mixture   : (1, 1, {BUF_LEN})")
print(f"      condition : (1, {COND_DIM})")

dummy_mix  = torch.zeros(1, 1, BUF_LEN)
dummy_cond = torch.zeros(1, COND_DIM)


# ── 3. ONNX 내보내기 ───────────────────────────────────────

class _SsWrapper(torch.nn.Module):
    def __init__(self, ss_model):
        super().__init__()
        self.m = ss_model
    def forward(self, mixture, condition):
        return self.m({"mixture": mixture, "condition": condition})["waveform"]

wrapper = _SsWrapper(model.ss_model).eval()

ONNX_PATH = os.path.join(OUT_DIR, "audiosep_ss.onnx")
print(f"[3/4] ONNX 내보내는 중 → {ONNX_PATH}")

import warnings
with torch.no_grad(), warnings.catch_warnings():
    warnings.simplefilter("ignore")
    torch.onnx.export(
        wrapper,
        (dummy_mix, dummy_cond),
        ONNX_PATH,
        input_names=["mixture", "condition"],
        output_names=["waveform"],
        do_constant_folding=True,
    )
print("      완료")


# ── 4. ONNX Runtime 테스트 + 속도 비교 ────────────────────

print("[4/4] ONNX Runtime 테스트 추론...")
try:
    import onnxruntime as ort
except ImportError:
    print("[ERROR] onnxruntime 미설치\n        pip install onnxruntime")
    sys.exit(1)

sess_opts = ort.SessionOptions()
sess_opts.inter_op_num_threads = os.cpu_count() or 4
sess_opts.intra_op_num_threads = os.cpu_count() or 4

available_providers = ort.get_available_providers()
print(f"      사용 가능한 provider: {available_providers}")
provider = "DmlExecutionProvider" if "DmlExecutionProvider" in available_providers else "CPUExecutionProvider"
print(f"      선택: {provider}")
sess = ort.InferenceSession(ONNX_PATH, sess_opts, providers=[provider, "CPUExecutionProvider"])

np_mix  = np.zeros((1, 1, BUF_LEN), dtype=np.float32)
np_cond = np.zeros((1, COND_DIM),   dtype=np.float32)

# 워밍업
sess.run(None, {"mixture": np_mix, "condition": np_cond})

# ONNX Runtime 속도 측정 (5회 평균)
N = 5
t0 = time.perf_counter()
for _ in range(N):
    sess.run(None, {"mixture": np_mix, "condition": np_cond})
ort_ms = (time.perf_counter() - t0) / N * 1000

# PyTorch CPU 속도 측정 (5회 평균)
with torch.no_grad():
    wrapper(dummy_mix, dummy_cond)  # 워밍업
t0 = time.perf_counter()
with torch.no_grad():
    for _ in range(N):
        wrapper(dummy_mix, dummy_cond)
pt_ms = (time.perf_counter() - t0) / N * 1000

print(f"""
============================================================
결과
  PyTorch CPU   : {pt_ms:6.0f} ms / 청크
  ONNX Runtime  : {ort_ms:6.0f} ms / 청크
  속도 향상     : {pt_ms/ort_ms:.1f}x

  버퍼 1초 기준 실시간 처리 가능 여부
  PyTorch  : {'✓' if pt_ms < 1000 else '✗ (지연 ' + f'{pt_ms:.0f}ms)'})
  ORT      : {'✓' if ort_ms < 1000 else '✗ (지연 ' + f'{ort_ms:.0f}ms)'})

  저장: {ONNX_PATH}

다음 단계: server.py 에서 ONNX Runtime 추론으로 교체
============================================================
""")
