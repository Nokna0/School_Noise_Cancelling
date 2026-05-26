# AudioSep + ALE 하이브리드 소음 캔슬러
3학년 1학기 과학과제연구 — 노이즈 캔슬링

마이크로 들어오는 혼합 소리에서 **두 가지 보완적인 접근**으로 소음을 실시간 제거합니다.

| 접근 | 원리 | 강점 | 약점 |
|------|------|------|------|
| **AudioSep** (Audio-AGI) | 텍스트 쿼리 → CLAP 임베딩 → 트랜스포머 분리기가 표적 음원만 추출 | 텍스트로 의미적 표적 지정 가능 (목소리, 청소기 등) | 모델·GPU·서버 필요, 컨텍스트 짧으면 품질 저하 |
| **ALE** (Adaptive Line Enhancer) | 입력 자신의 Δ 지연 버전을 참조로 NLMS 자기예측 | 가볍고 로컬 (브라우저 100줄), 주기 소음에 강함 | 비주기 소음·음성에 무력, 텍스트 표적 불가 |

**Cascade 모드** 가 기본값으로, 두 단계를 직렬 결합해 서로의 약점을 보완합니다.

---

## 작동 원리

### 신호 흐름 (Cascade 모드)

```
마이크 d[n]
   │
   ├──────────────────────────────────────────────────────► 딜레이 큐
   │  (WebSocket)                                                │
   ▼                                                             │
[Server / AudioSep]                                              │ (짝 맞추기 대기)
   2초 롤링 버퍼 ─► AudioSep(d_buf, query) ─► x[n]                │
                                                                 │
                                                  ┌──────────────┘
                                                  ▼
                                     [Stage 1: NLMS(d, x)]
                                       y₁ = w₁ · x  (AudioSep 추정 잡음)
                                       e₁ = d - y₁
                                                  │
                                                  ▼
                                     [Stage 2: ALE(e₁)]
                                       y₂ = w₂ · e₁_delayed  (잔여 주기 성분)
                                       e₂ = e₁ - y₂   ← 최종 출력
                                                  │
                                       ┌──────────┴──────────┐
                                       ▼                     ▼
                                  스피커 출력            파형 시각화
                              (Solution A 버퍼링)   (d / y_total / e₂)
```

### Stage 1: AudioSep + NLMS — 텍스트로 표적 지정

서버는 클라이언트가 보낸 마이크 청크를 **2초 롤링 버퍼**에 누적한 뒤,
사용자 텍스트 쿼리(예: `"vacuum cleaner"`, `"60Hz hum"`)와 함께 AudioSep 에 통과시켜
표적 소음의 추정 파형 `x[n]` 을 돌려줍니다.

> 64ms 청크 단독으론 트랜스포머 분리 품질이 안 나와서 롤링 버퍼가 필수.
> 응답으로는 가장 최근 64ms 만 잘라 반환 → 끊김 없이 이어붙임.

클라이언트는 받은 `x` 를 **NLMS 적응 필터의 참조 신호** 로 써서 `d` 안의 표적 성분을 학습·차감합니다.
AudioSep 결과가 정확하지 않더라도 NLMS 가 게인·위상 오차를 자동 보정합니다.

### Stage 2: ALE — 잔여 주기 성분 정리

Stage 1 출력 `e₁` 에는 **AudioSep 이 못 잡은 주기 소음**(전원 hum, 형광등, 팬 등)이
남아 있을 수 있습니다. ALE 가 자기예측으로 이걸 추가 제거합니다.

```
x_ale[i] = e₁[n - Δ - i]            ← e₁ 자신의 지연 버전
y₂[n]    = Σ w₂[i] · x_ale[i]       ← 예측된 주기 성분
e₂[n]    = e₁[n] - y₂[n]            ← 최종 출력
```

**왜 잘 동작하는가**: 주기 소음은 자기상관이 길어 예측 가능, 음성은 짧아 예측 불가.
따라서 ALE 는 자연스럽게 주기 성분만 골라 제거합니다.

### 3가지 동작 모드

| 모드 | Stage 1 (AudioSep) | Stage 2 (ALE) | 용도 |
|------|--------------------|---------------|------|
| `audiosep` | ✅ | ❌ | 텍스트로 정확히 짚을 수 있는 소음 |
| `ale` | ❌ (서버 안 씀) | ✅ | 주기 소음만, 서버 없이 동작 |
| `cascade` (기본) | ✅ | ✅ | 가장 일반적, 두 약점 보완 |

UI 라디오 버튼으로 실시간 전환.

---

## 파일 구조

```
School_Noise_Cancelling/
│
├── audiosep/
│   ├── server.py            # AudioSep 추론 서버 (WebSocket)
│   ├── requirements.txt     # Python 의존성
│   └── static/
│       ├── index.html       # UI 레이아웃
│       ├── app.js           # WebSocket + NLMS + ALE + 모드 분기
│       └── style.css        # 스타일
│
└── tools/                   # 별도 오디오 유틸리티 (믹서, 에디터, 사인파/잡음 생성기)
```

---

## 실행 방법

### 1. AudioSep 레포 클론 + 체크포인트 다운로드

```bash
# 적당한 위치에 AudioSep 클론
git clone https://github.com/Audio-AGI/AudioSep.git
cd AudioSep
pip install -r requirements.txt

# 체크포인트 다운로드 (audiosep_base_4M_steps.ckpt)
# → README 의 안내 따라 Zenodo / HuggingFace 등에서 받아 checkpoint/ 폴더에 둠
```

### 2. 본 프로젝트 의존성 설치

```bash
cd School_Noise_Cancelling
pip install -r audiosep/requirements.txt
```

PyTorch 는 GPU 유무에 따라 다른 휠을 받아야 함 — `requirements.txt` 주석 참고.

### 3. 서버 실행

```bash
# AudioSep 경로 환경변수 지정 (필수)
$env:AUDIOSEP_PATH       = "C:\path\to\AudioSep"
$env:AUDIOSEP_CHECKPOINT = "C:\path\to\AudioSep\checkpoint\audiosep_base_4M_steps.ckpt"

python audiosep/server.py
# → [INFO] AudioSep 로딩 중  device=cuda
# → [INFO] 모델 로딩 완료
# → [INFO] 서버 실행 중  ws://localhost:8765
```

> CPU 만 있어도 동작하지만 한 청크 처리에 수백 ms 걸려 끊김 심함. **GPU 권장.**

### 4. 클라이언트 (브라우저)

```bash
# 별도 터미널에서
python -m http.server 8080 --directory audiosep/static
# → http://localhost:8080 접속
```

마이크 접근은 `localhost` 또는 `https://` 환경에서만 허용됨.

### 5. 사용

1. 페이지가 열리면 상태 표시가 **"서버 연결됨"** 으로 바뀐다.
2. **모드** 선택 (기본 `Cascade`).
3. **타겟 쿼리** 입력 후 **[적용]** (예: `vacuum cleaner`, `fan noise`, `60Hz hum`).
4. **[시작]** 클릭 → 마이크 권한 허용 → 처리 시작.
5. **[A/B 비교]** 버튼으로 원본 ↔ 필터 적용 토글하며 효과 청취 확인.
6. μ / Δ / 출력 게인 슬라이더로 튜닝.

> ⚠️ **헤드폰 권장**: 스피커로 들으면 출력 → 마이크 피드백이 ALE 를 발산시킬 수 있음.

---

## 알고 있는 한계

| 항목 | 원인 / 대응 |
|------|-------------|
| Cascade 모드 첫 1~2초 잡음 | 서버 롤링 버퍼가 0으로 시작 → 컨텍스트 모자람. 잠시 기다리면 안정화. |
| CPU 추론 시 끊김 | AudioSep 이 무거움. GPU 사용 권장. 끊김 줄이려면 `BUFFER_SEC` 축소. |
| 음성도 일부 제거됨 (ALE) | Δ 가 너무 작으면 음성의 단시간 자기상관까지 학습. Δ 50~200 사이 권장. |
| 모드 전환 직후 1초 정도 거친 출력 | 가중치 리셋 후 재수렴 필요. μ 크게 잠깐 올렸다 내리면 빠름. |

---

## 기술 스택

| 파트 | 기술 |
|------|------|
| 클라이언트 | Web Audio API, WebSocket, Canvas 2D |
| 서버 | Python, `websockets`, `numpy`, `scipy`, `torch` |
| AI 분리 | [AudioSep](https://github.com/Audio-AGI/AudioSep) (CLAP + ResUNet) |
| 적응 필터 | NLMS (Normalized LMS) ×2 — AudioSep 참조용 + ALE 자기예측용 |
