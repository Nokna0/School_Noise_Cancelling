"""
마이크 녹음 스크립트
실행: python record.py
Enter 누르면 녹음 시작, 다시 Enter 누르면 저장
"""
import sys, os, threading
import numpy as np
import sounddevice as sd
import scipy.io.wavfile as wav

SR = 16000
OUTPUT = os.path.join(os.path.dirname(__file__), "recording.wav")

print("=" * 40)
print("녹음 준비 완료")
print("Enter 를 누르면 녹음 시작")
print("=" * 40)
input()

chunks = []
stop_event = threading.Event()

def callback(indata, frames, time, status):
    chunks.append(indata.copy())

print("● 녹음 중... (Enter 누르면 종료)")
with sd.InputStream(samplerate=SR, channels=1, dtype="float32", callback=callback):
    input()

print("■ 녹음 종료, 저장 중...")
audio = np.concatenate(chunks, axis=0).flatten()
out_int16 = np.clip(audio * 32768, -32768, 32767).astype(np.int16)
wav.write(OUTPUT, SR, out_int16)

duration = len(audio) / SR
print(f"저장 완료 → {OUTPUT}  ({duration:.1f}초)")
