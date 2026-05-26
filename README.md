# Realtime AudioSep + NLMS 노이즈 캔슬러
3학년 1학기 과학과제연구 — 노이즈 캔슬링

마이크로 들어오는 혼합 소리에서 **특정 소음만 골라 실시간으로 제거**하는 데모 프로젝트입니다.  
브라우저(클라이언트) + Python WebSocket 서버(서버)의 두 파트가 협력하여 동작합니다.

---

## 작동 원리

### 핵심 아이디어

소음을 제거하려면 두 가지 신호가 필요합니다.

| 신호 | 이름 | 설명 |
|------|------|------|
| **d(n)** | 혼합 신호 (Desired) | 마이크가 잡아낸 "음성 + 소음" |
| **x(n)** | 참조 신호 (Reference) | AI가 d(n)에서 뽑아낸 "소음만" |

NLMS 필터가 x(n)를 보면서 d(n) 속의 소음 성분을 학습·예측하고,  
그 예측값을 빼면 **e(n) = 음성만 남은 깨끗한 신호**가 됩니다.

### 신호 흐름

```
마이크
  │
  ▼
d(n) ──────────────────────────────────────► 딜레이 큐
  │                                                │
  │  (WebSocket 전송)                              │ (짝 맞추기 대기)
  ▼                                                │
[서버 / Module 2]                                  │
  fake_audiosep(d, query)                          │
  → 참조 신호 x(n) 생성                            │
  │                                                │
  └────────────────────────────────────────►  NLMS (Module 3)
                                                   │
                                       y(n) = w · x(n)   ← 예측 잡음
                                       e(n) = d(n) - y(n) ← 깨끗한 신호
                                       w 갱신 (학습)
                                                   │
                                    ┌──────────────┴──────────────┐
                                    ▼                             ▼
                               스피커 출력                   파형 시각화
                           (끊김 없는 재생)           (흰색=d, 빨간색=e)
```

---

## 4개 핵심 모듈

### Module 1 — 오디오 수집 & 딜레이 (`captureAudio`)

마이크 입력을 **1024 샘플(≈ 64ms) 단위 청크**로 쪼갭니다.  
각 청크는 두 갈래로 분배됩니다.

- 한 갈래 → WebSocket으로 서버에 전송
- 다른 갈래 → **딜레이 큐(Delay Queue)** 에 보관

서버가 AI 연산을 마치고 x(n)을 돌려주기까지 시간이 걸리므로,  
그동안 d(n)을 큐에 가둬 두어 나중에 정확한 짝을 맞춥니다.

### Module 2 — AI 참조 신호 추출 (`server.py`)

서버가 d(n) 청크와 사용자가 입력한 **텍스트 쿼리** ("vacuum cleaner" 등)를 받아  
타겟 소음에 해당하는 참조 신호 x(n)을 만들어 돌려줍니다.

현재는 **임시 구현(fake_audiosep)**으로, 단순 저역통과 필터(LPF)를 사용합니다.  
추후 실제 [AudioSep](https://github.com/Audio-AGI/AudioSep) 모델로 교체 예정입니다.

```
WebSocket 프로토콜
  클라이언트 → 서버
    바이너리   : float32 PCM 청크 d(n)
    텍스트 JSON: {"type":"query","text":"vacuum cleaner"}
                 {"type":"mu","value":0.05}

  서버 → 클라이언트
    바이너리   : float32 PCM 참조 신호 x(n)
```

### Module 3 — 시간 동기화 & NLMS (`nlms`)

서버에서 x(n)이 도착하면 딜레이 큐에서 **짝이 맞는 d(n)** 을 꺼내  
NLMS(Normalized Least Mean Square) 적응 필터를 실행합니다.

**NLMS 수식:**

```
y[n]    = Σ  w[i] · x[n-i]             ← 현재 필터가 예측한 잡음
e[n]    = d[n] - y[n]                  ← 오차 = 깨끗한 신호
norm    = ε + Σ x[n-i]²                ← 입력 에너지 (발산 방지)
w[i]   += (μ / norm) · e[n] · x[n-i]  ← 가중치 갱신
```

- **μ (학습률)**: 클수록 빠르게 수렴하지만 불안정, 작으면 안정적이지만 느림 (기본값 0.05)
- **필터 탭 수**: 128개 (FILTER_LENGTH)
- 필터가 수렴할수록 e(n)의 진폭이 줄어드는 것이 정상 동작입니다

### Module 4 — 제어 & 출력 (`index.html` + UI 코드)

**오디오 출력 (Solution A — 버퍼링 재생)**  
매 청크를 `_playbackTime` 클록에 예약(`src.start(startTime)`)하여  
청크들이 정확히 이어지도록 보장합니다. 끊김이나 튐 현상이 없습니다.

**파형 시각화**
- 흰색 반투명선: 원본 신호 d(n) — 소리를 내면 항상 반응
- 빨간색 선: 필터 출력 e(n) — 노이즈 제거가 잘 될수록 진폭이 줄어듦

**UI 컨트롤**
- 타겟 소음 텍스트 입력 → [적용] → 서버로 쿼리 전송
- μ 슬라이더 → 실시간으로 학습률 변경 및 서버에 알림

---

## 파일 구조

```
School_Noise_Cancelling/
│
├── audiosep/
│   ├── server.py            # Module 2: WebSocket 서버 + fake_audiosep
│   ├── requirements.txt     # Python 의존성
│   └── static/
│       ├── index.html       # Module 4: UI 레이아웃
│       ├── app.js           # Module 1, 3, 4: 클라이언트 로직
│       └── style.css        # 스타일
│
└── tools/                   # 별도 오디오 유틸리티 (믹서, 에디터 등)
```

---

## 실행 방법

### 1. 의존성 설치

```bash
pip install -r audiosep/requirements.txt
```

### 2. 서버 실행

```bash
python audiosep/server.py
# 출력: 서버 실행 중  ws://localhost:8765
```

### 3. 브라우저에서 열기

`audiosep/static/index.html` 을 브라우저로 열거나,  
간단한 HTTP 서버를 이용합니다.

```bash
# Python 내장 HTTP 서버 예시
python -m http.server 8080 --directory audiosep/static
# → http://localhost:8080 접속
```

> 마이크 접근은 `localhost` 또는 `https://` 환경에서만 허용됩니다.

### 4. 사용

1. 페이지가 열리면 연결 상태가 **"서버 연결됨"** 으로 바뀝니다.
2. 타겟 소음 이름을 입력하고 **[적용]** 을 클릭합니다 (예: `vacuum cleaner`).
3. **[시작]** 버튼을 클릭하면 마이크 권한을 요청합니다.
4. 소리를 내면 파형이 실시간으로 그려집니다.
   - 흰색 선이 크게 움직이면 마이크가 소리를 잡고 있는 것
   - 빨간선이 점점 작아지면 NLMS 필터가 해당 소음을 학습·제거하고 있는 것
5. μ 슬라이더로 학습 속도를 조절할 수 있습니다.

---

## 향후 개선 계획

`server.py`의 `fake_audiosep` 함수를 실제 AudioSep 모델로 교체하면  
텍스트 쿼리 기반의 정밀한 음원 분리가 가능해집니다.

```python
# 교체 예시 (인터페이스는 그대로 유지)
def fake_audiosep(audio: np.ndarray, query: str = "") -> np.ndarray:
    # TODO: AudioSep 모델 호출
    # return audiosep_model.separate(audio, query)
    ...
```

---

## 기술 스택

| 파트 | 기술 |
|------|------|
| 클라이언트 | Web Audio API, WebSocket, Canvas 2D |
| 서버 | Python, `websockets`, `numpy` |
| 적응 필터 | NLMS (Normalized LMS) |
| 음원 분리 (예정) | AudioSep (딥러닝 텍스트-쿼리 기반) |
