"""
AudioSep 배치 품질 테스트
사용법: python test_batch.py input.wav "fan noise" output.wav
"""
import sys, os

AUDIOSEP_PATH = os.environ.get("AUDIOSEP_PATH", "../AudioSep")
AUDIOSEP_CHECKPOINT = os.environ.get(
    "AUDIOSEP_CHECKPOINT",
    os.path.join(AUDIOSEP_PATH, "checkpoint", "audiosep_base_4M_steps.ckpt"),
)

if os.path.isdir(AUDIOSEP_PATH):
    sys.path.insert(0, AUDIOSEP_PATH)
    os.chdir(AUDIOSEP_PATH)

import torch
import numpy as np
import scipy.io.wavfile as wav
import scipy.signal
from pipeline import build_audiosep

if len(sys.argv) < 4:
    print("사용법: python test_batch.py input.wav '쿼리' output.wav")
    print("예시:   python test_batch.py test.wav 'fan noise' result.wav")
    sys.exit(1)

input_file  = sys.argv[1]
query       = sys.argv[2]
output_file = sys.argv[3]

print(f"입력:  {input_file}")
print(f"쿼리:  {query}")
print(f"출력:  {output_file}")
print("모델 로딩 중...")

model = build_audiosep(
    config_yaml=os.path.join(AUDIOSEP_PATH, "config", "audiosep_base.yaml"),
    checkpoint_path=AUDIOSEP_CHECKPOINT,
    device="cpu",
)
model.eval()
torch.set_num_threads(os.cpu_count() or 4)
print("로딩 완료\n추론 중...")

sr, data = wav.read(input_file)
if data.dtype == np.int16:
    audio = data.astype(np.float32) / 32768.0
elif data.dtype == np.int32:
    audio = data.astype(np.float32) / 2147483648.0
else:
    audio = data.astype(np.float32)

if audio.ndim == 2:
    audio = audio.mean(axis=1)

# 16kHz → 32kHz
audio_32k = scipy.signal.resample_poly(audio, 2, 1).astype(np.float32)
if sr != 16000:
    audio_32k = scipy.signal.resample_poly(audio, 32000, sr).astype(np.float32)

with torch.no_grad():
    cond = model.query_encoder.get_query_embed(modality="text", text=[query], device="cpu")
    x = torch.from_numpy(audio_32k).reshape(1, 1, -1)
    sep_32k = model.ss_model({"mixture": x, "condition": cond})["waveform"].squeeze().numpy()

sep_16k = scipy.signal.resample_poly(sep_32k, 1, 2).astype(np.float32)
sep_16k = sep_16k[:len(audio)]

# 추출된 소음
out_int16 = np.clip(sep_16k * 32768, -32768, 32767).astype(np.int16)
wav.write(output_file, 16000, out_int16)
print(f"추출된 소음 → {output_file}")

# 소음 제거 후 (원본 - 소음)
clean = audio[:len(sep_16k)] - sep_16k
clean_file = output_file.replace(".wav", "_clean.wav")
clean_int16 = np.clip(clean * 32768, -32768, 32767).astype(np.int16)
wav.write(clean_file, 16000, clean_int16)
print(f"소음 제거 후  → {clean_file}")
