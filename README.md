# AudioSep + ALE 하이브리드 실시간 소음 제거

3학년 1학기 과학과제연구 — 노이즈 캔슬링

---

## 프로젝트 개요

마이크로 들어오는 혼합 소리에서 **두 가지 보완적인 기법**을 결합해 소음을 실시간으로 제거하는 하이브리드 시스템입니다.

| 기법 | 원리 | 강점 | 약점 |
|------|------|------|------|
| **AudioSep** | 텍스트 쿼리 → CLAP 임베딩 → 트랜스포머 기반 음원 분리 | 텍스트로 표적 지정 가능 (청소기, 팬 소음 등) | 딥러닝 모델·서버 필요, 짧은 컨텍스트에서 품질 저하 |
| **ALE** (Adaptive Line Enhancer) | 입력 신호의 지연 버전을 참조로 NLMS 자기예측 | 브라우저에서 완전 동작, 주기 소음에 강함 | 비주기 소음·음성에는 무력 |

**Cascade 모드**가 기본으로, 두 단계를 직렬 결합해 서로의 약점을 보완합니다.

---

## 작동 원리

### 신호 흐름 (Cascade 모드)

```
마이크 d[n]
   │
   ├─────────────────────────────────────────────► 딜레이 큐
   │  WebSocket (float32 PCM @ 16 kHz)                 │
   ▼                                                    │ seq 맞춤 대기
[서버 / AudioSep]                                       │
  2초 롤링 버퍼 → AudioSep(d_buf, query) → x[n]         │
                                                        │
                                         ┌──────────────┘
                                         ▼
                            [Stage 1: NLMS(d, x)]
                              y₁ = w₁ · x     (AudioSep 추정 소음)
                              e₁ = d  - y₁
                                         │
                                         ▼
                            [Stage 2: ALE(e₁)]
                              y₂ = w₂ · e₁_delayed  (잔여 주기 성분)
                              e₂ = e₁ - y₂   ← 최종 출력
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                         스피커 출력           파형 시각화
                                           (d / y_total / e₂)
```

### Stage 1 — AudioSep + NLMS : 텍스트로 소음 표적 지정

서버는 클라이언트가 보낸 마이크 청크(64 ms)를 **롤링 버퍼**에 누적한 뒤, 사용자가 입력한 텍스트 쿼리(예: `"vacuum cleaner"`, `"fan noise"`)와 함께 AudioSep에 통과시켜 표적 소음 파형 `x[n]`을 추출합니다.

> 64 ms 단독으로는 트랜스포머 분리 품질이 크게 떨어집니다. 더 긴 컨텍스트(1초)를 입력해야 AudioSep이 제대로 동작하므로 롤링 버퍼가 필수입니다.  
> 서버는 버퍼 전체를 넣고 추론한 뒤, 마지막 64 ms만 잘라 응답합니다.

클라이언트는 받은 `x`를 **NLMS 필터의 참조 신호**로 사용해 `d` 안의 표적 소음 성분을 적응적으로 학습·차감합니다. AudioSep 결과가 완벽하지 않더라도 NLMS가 게인·위상 오차를 자동 보정합니다.

**NLMS 업데이트 수식:**

```
y[n]    = wᵀ · x(n)                  (필터 출력 = 추정 소음)
e[n]    = d[n] - y[n]                (잔차 = 소음 제거 후 신호)
w[n+1]  = w[n] + μ · e[n] · x(n) / (‖x(n)‖² + ε)   (가중치 갱신)
```

### Stage 2 — ALE : 잔여 주기 성분 정리

Stage 1 출력 `e₁`에는 AudioSep이 못 잡은 **주기 소음**(전원 훔, 형광등, 팬 등)이 남을 수 있습니다. ALE는 신호 자신의 지연 버전을 참조로 자기예측해 이를 추가 제거합니다.

```
x_ale[i] = e₁[n - Δ - i]          (e₁ 자신의 지연 버전)
y₂[n]    = Σ w₂[i] · x_ale[i]    (예측된 주기 성분)
e₂[n]    = e₁[n] - y₂[n]         (최종 출력)
```

**왜 잘 동작하는가**:  
주기 소음은 자기상관이 길어 Δ 샘플 전 과거로부터 예측이 가능합니다. 반면 음성은 자기상관이 짧아 Δ를 충분히 크게 잡으면 예측 불가능해집니다. ALE는 이 성질을 이용해 주기 성분만 자연스럽게 골라 제거합니다.

### 3가지 동작 모드

| 모드 | Stage 1 (AudioSep + NLMS) | Stage 2 (ALE) | 적합한 상황 |
|------|--------------------------|---------------|-------------|
| `audiosep` | ✅ | ❌ | 텍스트로 정확히 짚을 수 있는 소음 |
| `ale` | ❌ (서버 불필요) | ✅ | 주기 소음만, 오프라인·경량 환경 |
| `cascade` (기본) | ✅ | ✅ | 일반 환경, 두 약점 보완 |

---

## 시스템 아키텍처

### 서버 (`audiosep_code/server.py`)

- **WebSocket** (`ws://localhost:8765`): 마이크 PCM 청크와 쿼리 JSON을 수신
- **롤링 버퍼**: 최근 1초(16,000 샘플)를 유지해 AudioSep에 컨텍스트 제공
- **latest-wins 백프레셔**: 추론이 64 ms보다 느릴 때 가장 최신 프레임만 처리해 지연 상한을 유지
- **run_in_executor**: AudioSep 추론을 워커 스레드로 분리해 asyncio 이벤트 루프 블로킹 방지
- **seq 헤더**: 응답 앞 4 바이트(uint32 LE)가 청크 순번 — 클라이언트가 이를 기반으로 매칭하고 오래된 응답은 폐기
- **CLAP 텍스트 임베딩 캐시**: 쿼리가 같으면 재계산하지 않음

### 클라이언트 (`audiosep_code/static/app.js`)

- **Web Audio API + ScriptProcessor**: 64 ms(1024 샘플 @ 16 kHz) 단위로 마이크 수집
- **NLMS 필터 (128탭)**: 서버에서 받은 `x`를 참조해 소음 적응 차감
- **ALE 필터 (128탭)**: 지연 Δ를 두고 잔여 주기 성분 자기예측 제거
- **pending Map**: `seq → d` 맵으로 청크 순서 정합성 유지
- **Canvas 파형 시각화**: 입력 / 제거된 소음 / 출력 3채널 실시간 표시

---

## 최적화 과정

### 문제

AudioSep(CLAP + ResUNet)의 PyTorch CPU 추론 시간이 1초 버퍼 기준 **~950 ms**로, 64 ms 청크 주기를 크게 초과했습니다.

### 시도한 방법들

| 방법 | 결과 | 실패 원인 |
|------|------|-----------|
| Intel Extension for PyTorch (IPEX) | 실패 | PyTorch 2.12.0에 맞는 IPEX 패키지 없음 |
| `torch.compile` (inductor) | 실패 | Windows에서 Triton 미지원 |
| `torch.set_num_threads` + BUFFER_SEC 축소 | 부분 개선 | ~950 ms 수준, 실시간 미달 |
| OpenVINO (NPU/GPU/CPU) | 실패 | `Col2Im` 미지원, `Clamp` 변환 버그, dynamic rank 문제 |
| ONNX Runtime CPU | 실패 | PyTorch MKL/OpenMP 대비 오히려 느림 (1183 ms) |
| **ONNX Runtime + DirectML** ✅ | **성공** | Intel Arc iGPU로 **16배 속도 향상** |

### 최종 아키텍처 (ONNX Runtime + DirectML)

```
서버 시작 시:
  ① ONNX Runtime (DmlExecutionProvider) 세션 로드  ← ss_model(ResUNet) 전용
  ② PyTorch 모델 로드                              ← CLAP 텍스트 인코더 전용

추론 시:
  텍스트 쿼리 → [PyTorch CLAP 인코더] → condition 벡터 (캐시됨)
  마이크 PCM  → [업샘플 16k→32k] → mixture 텐서
  (mixture, condition) → [ONNX Runtime / DirectML / Intel Arc iGPU] → 분리 소음 신호
  소음 신호   → [다운샘플 32k→16k] → 클라이언트 전송
```

| 단계 | 소요 시간 |
|------|-----------|
| CLAP 텍스트 인코더 (쿼리 변경 시 1회, 결과 캐시) | ~수백 ms (1회) |
| AudioSep 분리 추론 (ONNX Runtime + DirectML) | **~45 ms** |
| 업/다운샘플 | < 5 ms |

45 ms < 64 ms 청크 주기 → **실시간 처리 가능**

> 상세 내용은 [audiosep_code/OPTIMIZATION.md](audiosep_code/OPTIMIZATION.md) 참고

---

## 파일 구조

```
School_Noise_Cancelling/
│
├── audiosep_code/
│   ├── server.py            # AudioSep 추론 서버 (WebSocket, ONNX Runtime)
│   ├── export_onnx.py       # AudioSep → ONNX 변환 + 속도 측정 스크립트
│   ├── OPTIMIZATION.md      # 추론 최적화 과정 기록
│   └── static/
│       ├── index.html       # UI 레이아웃
│       ├── app.js           # WebSocket + NLMS + ALE + 파형 시각화
│       └── style.css        # 스타일
│
├── tools/                   # 별도 오디오 유틸리티
│   ├── sine_wave_generator.html   # 사인파 생성기
│   ├── noise_generator.html       # 잡음 생성기
│   ├── audio_mixer.html           # 오디오 믹서
│   └── audio_editor.html          # 오디오 에디터
│
├── noise_create.py          # 테스트용 소음 파일 생성
├── noise_description.py     # 소음 파일 분석
├── noise_test.py            # 소음 제거 성능 테스트
└── README.md
```

---

## 실행 방법

### 사전 준비

#### 1. AudioSep 레포 클론 + 체크포인트 다운로드

```bash
git clone https://github.com/Audio-AGI/AudioSep.git
cd AudioSep
pip install -r requirements.txt
```

체크포인트 파일 `audiosep_base_4M_steps.ckpt`를 AudioSep 공식 저장소 안내에 따라  
Zenodo 또는 HuggingFace Hub에서 받아 `AudioSep/checkpoint/` 폴더에 넣습니다.

#### 2. 본 프로젝트 의존성 설치

```bash
cd School_Noise_Cancelling
pip install websockets numpy scipy torch
```

**ONNX Runtime DirectML (Intel iGPU 가속, Windows 전용)**:
```bash
pip install onnxruntime-directml
```

CUDA GPU가 있는 경우:
```bash
pip install onnxruntime-gpu
```

CPU만 사용하는 경우:
```bash
pip install onnxruntime
```

#### 3. ONNX 모델 내보내기 (최초 1회, DirectML 사용 시 필수)

```bash
$env:AUDIOSEP_PATH       = "C:\path\to\AudioSep"
$env:AUDIOSEP_CHECKPOINT = "C:\path\to\AudioSep\checkpoint\audiosep_base_4M_steps.ckpt"

python audiosep_code/export_onnx.py
# → audiosep_code/audiosep_ss.onnx 생성
# → PyTorch CPU vs ONNX Runtime 속도 비교 출력
```

---

### 서버 실행

```bash
$env:AUDIOSEP_PATH       = "C:\path\to\AudioSep"
$env:AUDIOSEP_CHECKPOINT = "C:\path\to\AudioSep\checkpoint\audiosep_base_4M_steps.ckpt"

python audiosep_code/server.py
# [INFO] AudioSep 로딩 중  device=cpu
# [INFO] ONNX Runtime 로드 완료  provider=DmlExecutionProvider
# [INFO] 모델 로딩 완료
# [INFO] 서버 실행 중  ws://localhost:8765
```

> CPU 추론만 사용하는 경우(ONNX 파일 없을 때) 한 청크 처리에 ~700–950 ms 소요되어 끊김이 심합니다.  
> **DirectML 또는 CUDA GPU 권장.**

---

### 클라이언트 실행

```bash
python -m http.server 8080 --directory audiosep_code/static
```

브라우저에서 `http://localhost:8080` 접속.

> 마이크 접근은 `localhost` 또는 `https://` 환경에서만 허용됩니다.

---

### 사용 방법

1. 페이지를 열면 상태 표시가 **"서버 연결됨"** 으로 바뀝니다.
2. **타겟 쿼리** 입력란에 제거할 소음을 영어로 입력합니다.  
   예시: `vacuum cleaner`, `fan noise`, `60Hz hum`, `keyboard typing`, `air conditioner`
3. **Enter** 키를 눌러 쿼리를 적용합니다.
4. **[시작]** 버튼 클릭 → 마이크 권한 허용 → 처리 시작.
5. 3개의 파형이 실시간으로 표시됩니다.
   - **① 입력 d**: 마이크 원본 (음성 + 소음)
   - **② 제거된 소음 y**: 필터가 추정·차감한 소음 성분
   - **③ 출력 e**: 소음 제거 후 신호

> ⚠️ **헤드폰 권장**: 스피커 사용 시 출력→마이크 피드백이 ALE를 발산시킬 수 있습니다.

---

## 환경변수 요약

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUDIOSEP_PATH` | `../AudioSep` | AudioSep 레포 클론 경로 (필수) |
| `AUDIOSEP_CHECKPOINT` | `../AudioSep/checkpoint/audiosep_base_4M_steps.ckpt` | 모델 가중치 경로 (필수) |
| `AUDIOSEP_CONFIG` | `<PATH>/config/audiosep_base.yaml` | config yaml 경로 (선택) |
| `AUDIOSEP_DEVICE` | 자동 감지 (`cuda` 우선) | 추론 디바이스 지정 |

---

## 알고 있는 한계

| 항목 | 원인 / 대응 |
|------|-------------|
| Cascade 모드 첫 1~2초 잡음 | 서버 롤링 버퍼가 0으로 초기화되어 컨텍스트 부족. 잠시 기다리면 안정화됨. |
| CPU 추론 시 끊김 | AudioSep 모델이 무거움. ONNX + DirectML 또는 CUDA GPU 사용 권장. |
| 음성 일부 제거 (ALE) | Δ(딜레이)가 너무 작으면 음성의 단시간 자기상관도 학습. Δ = 50~200 범위 권장. |
| 모드 전환 후 ~1초 거친 출력 | 가중치 리셋 후 재수렴 필요. μ를 잠시 크게 올렸다 내리면 빠름. |
| ALE 단독 모드의 비주기 소음 | ALE는 구조적으로 비주기 소음(사람 목소리, 음악 등) 제거 불가. Cascade 모드 사용 권장. |

---

## 기술 스택

| 파트 | 기술 |
|------|------|
| 클라이언트 | Web Audio API, WebSocket, Canvas 2D |
| 서버 | Python 3.11, `websockets`, `numpy`, `scipy`, `torch` |
| AI 음원 분리 | [AudioSep](https://github.com/Audio-AGI/AudioSep) — CLAP 텍스트 인코더 + ResUNet |
| 추론 가속 | ONNX Runtime + DirectML (Intel Arc iGPU) |
| 적응 필터 | NLMS (Normalized LMS) — AudioSep 참조용 + ALE 자기예측용 |

---

## 모델 가중치

모델 가중치(`.ckpt`, `.onnx`)는 크기 문제로 Git에 포함되지 않습니다.

- **AudioSep 원본 가중치**: [AudioSep 공식 README](https://github.com/Audio-AGI/AudioSep)의 안내에 따라 Zenodo / HuggingFace Hub에서 다운로드
- **ONNX 파일**: `export_onnx.py`를 실행하면 로컬에서 직접 생성 가능
