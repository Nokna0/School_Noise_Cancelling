# School Noise Cancelling

3학년 1학기 과학과제연구 — 실시간 적응 필터 기반 노이즈 캔슬링

---

## 프로젝트 개요

마이크로 입력된 소리에서 노이즈를 실시간으로 제거하는 시스템이다.  
**NLMS(Normalized Least Mean Squares)** 적응 필터를 직접 구현하여, 피드포워드(Feedforward) 방식의 능동 소음 제어(Active Noise Control) 파이프라인을 구성한다.

### 핵심 아이디어

```
[마이크 원본 신호 d]  ──────────────────────────────────────────► [NLMS 필터]
                     └──► [서버: FFT 저역통과 필터] ──► [참조 신호 x] ──► [NLMS 필터]
                                                                              │
                                                                              ▼
                                                                     e = d - y (클린 신호)
```

1. 마이크 신호 `d[n]` = 목소리 + 노이즈
2. 서버에서 FFT 필터로 노이즈 추정치 `x[n]` 생성
3. NLMS 필터가 `x[n]`을 이용해 `d[n]` 속 노이즈를 모델링 → 출력 `y[n]`
4. 오차 신호 `e[n] = d[n] - y[n]`이 노이즈가 제거된 클린 오디오

---

## 디렉터리 구조

```
School_Noise_Cancelling/
│
├── audiosep/                   # 실시간 노이즈 캔슬링 웹 앱
│   ├── server.py               # WebSocket 서버 (Python, FFT 필터)
│   ├── requirements.txt        # Python 의존성
│   └── static/
│       ├── index.html          # 메인 UI
│       ├── app.js              # NLMS 적응 필터 + 오디오 처리 (JavaScript)
│       └── style.css           # 다크 테마 스타일
│
├── tools/                      # 독립 실행 보조 도구 (HTML 단일 파일)
│   ├── sine_wave_generator.html    # 사인파 WAV 파일 생성기
│   ├── noise_generator.html        # White/Pink/Brown 등 노이즈 WAV 생성기
│   ├── audio_editor.html           # 오디오 파일 편집기 (트림, 페이드, 정규화 등)
│   └── audio_mixer.html            # 오디오 믹서
│
├── noise_create.py             # 사인파·노이즈 생성 실험 (초기 탐색 코드)
├── noise_test.py               # numpy 기초 실험
└── noise_description.py        # 설계 노트 (주석으로만 구성)
```

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 백엔드 | Python 3, asyncio, websockets, NumPy |
| 프론트엔드 | Vanilla JS, Web Audio API, Canvas API, WebSocket |
| 알고리즘 | NLMS 적응 필터, FFT 저역통과 필터 |

---

## 설치 및 실행

### 요구 사항

- Python 3.8 이상
- 최신 Chromium 계열 브라우저 (Web Audio API 지원)

### 1. 의존성 설치

```bash
cd audiosep
pip install -r requirements.txt
```

> `requirements.txt` 에는 `websockets`, `numpy`, `soundfile`, `torch` 가 포함된다.  
> 현재 구현에서는 `websockets` 와 `numpy` 만 실제로 사용된다.

### 2. 서버 실행

```bash
python audiosep/server.py
# → 서버 실행 중 (ws://0.0.0.0:8765)
```

### 3. 웹 UI 열기

`audiosep/static/index.html` 을 브라우저에서 직접 열거나, 간단한 HTTP 서버로 제공한다.

```bash
# Python 내장 HTTP 서버 예시
cd audiosep/static
python -m http.server 8080
# → http://localhost:8080 접속
```

### 4. 노이즈 캔슬링 시작

1. 브라우저에서 **시작** 버튼 클릭
2. 마이크 접근 권한 허용
3. 마이크에 소리를 입력하면 실시간으로 파형이 표시되고 클린 오디오가 출력됨

---

## 알고리즘 상세

### NLMS (Normalized Least Mean Squares)

```
매 샘플 n마다:
  1. x_history 갱신: 참조 신호 슬라이딩 윈도우에 x[n] 추가
  2. 필터 출력:  y[n] = Σ w[i] · x_history[i]   (i = 0 ~ L-1)
  3. 오차 계산:  e[n] = d[n] - y[n]
  4. 전력 정규화: norm = Σ x_history[i]² + ε
  5. 가중치 갱신: w[i] ← w[i] + (μ / norm) · e[n] · x_history[i]
```

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| `FILTER_LENGTH` (L) | 128 | 필터 탭 수 |
| `mu` (μ) | 0.05 | 학습률 (0 < μ < 2 조건) |
| `ε` | 1e-6 | 0 나눗셈 방지 항 |

### FFT 저역통과 필터 (서버)

서버의 `fake_audiosep` 함수는 실제 AudioSep 딥러닝 모델 대신 사용하는 간단한 주파수 도메인 필터다.  
FFT 후 `cutoff` 인덱스 이상의 고주파 성분을 0으로 만들고 역FFT한다.

---

## 보조 도구 (tools/)

브라우저에서 HTML 파일을 직접 열어 사용한다. 서버 불필요.

| 도구 | 설명 |
|------|------|
| `sine_wave_generator.html` | 주파수·진폭·길이를 설정하여 사인파 WAV 파일 생성 |
| `noise_generator.html` | White / Pink / Brown / Blue / Violet 노이즈 WAV 생성 |
| `audio_editor.html` | WAV 파일 로드 후 트림·삭제·무음·반전·페이드·정규화·게인 편집, WAV 다운로드 |
| `audio_mixer.html` | 여러 오디오 트랙을 믹싱 |

---

## 개발 과정

| 단계 | 내용 |
|------|------|
| 1단계 | numpy로 사인파·노이즈 생성 실험 (`noise_test.py`, `noise_create.py`) |
| 2단계 | NLMS 적응 필터 설계 및 파이프라인 구상 (`noise_description.py`) |
| 3단계 | WebSocket 기반 실시간 오디오 스트리밍 서버 구현 (`server.py`) |
| 4단계 | 브라우저에서 NLMS 알고리즘 구현 및 파형 시각화 (`app.js`) |
| 5단계 | 보조 도구 제작 (신호 생성기, 오디오 에디터) |

---

## 알려진 한계 및 향후 과제

- `fake_audiosep` 의 `cutoff` 값이 실제 노이즈 특성과 맞지 않아 필터 효과가 제한적이다.
- ScriptProcessor API는 deprecated 상태로, AudioWorklet 으로 교체가 권장된다.
- 실제 AudioSep 또는 딥러닝 기반 음원 분리 모델로 서버 처리를 교체하면 성능이 향상될 것으로 예상된다.
- `noise_create.py` 의 `noise()` 함수 버그 수정 필요 (매개변수 누락, `random()` → `np.random.rand(N)`).
