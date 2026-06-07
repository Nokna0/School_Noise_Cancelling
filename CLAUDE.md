# School Noise Cancelling — Claude 작업 지침

## 프로젝트 개요

AudioSep + NLMS/ALE 하이브리드 실시간 소음 제거 시스템.

- **서버** (`audiosep_code/server.py`): WebSocket으로 마이크 청크를 받아 AudioSep으로 소음 참조 신호를 추출해 반환.
- **클라이언트** (`audiosep_code/static/app.js`): 참조 신호를 NLMS 필터에 넣어 소음을 차감. ALE(자기예측)와 cascade 모드 지원.

## Git — 업로드 금지 파일

**.gitignore에 이미 설정되어 있으며, 아래 파일들은 절대 커밋하지 않는다.**

| 종류 | 패턴 | 이유 |
|---|---|---|
| 모델 가중치 | `*.ckpt`, `*.pt`, `*.pth`, `*.bin`, `*.safetensors`, `*.onnx`, `checkpoint/` | 수백 MB~수 GB, Git LFS 없이는 레포가 망가짐 |
| 대용량 데이터 | `*.npy`, `*.npz`, `*.h5`, `*.gz`, `*.zip`, `*.tar*` | 바이너리 diff 불가, 용량 낭비 |
| 오디오/미디어 | `*.wav`, `*.mp3`, `*.flac`, `*.mp4` 등 | 용량 대비 Git 관리 가치 없음 |
| 환경변수/시크릿 | `.env`, `*.key`, `*.pem`, `secrets.json` | 키 유출 방지 |
| Python 캐시 | `__pycache__/`, `*.pyc` | 재생성 가능한 산출물 |
| 가상환경 | `.venv/`, `venv/` | 재설치 가능 |

### 새 파일을 커밋하기 전 확인 절차

커밋 전에 아래를 반드시 확인한다:

```bash
git status --short          # 예상 밖 파일이 staged 되어 있지 않은지
git diff --stat --cached    # 실제로 올라갈 내용 미리 보기
```

위 카테고리에 해당하는 파일이 나타나면 `.gitignore`에 추가하고 커밋에서 제외한다.

### 모델 가중치 공유 방법

가중치 파일은 Git 대신 아래 방법으로 공유한다:

- Google Drive / OneDrive 링크를 README에 명시
- 또는 HuggingFace Hub 등 모델 저장소 사용

## 실행 방법

```bash
# 환경변수 설정 (필요 시)
set AUDIOSEP_PATH=../AudioSep
set AUDIOSEP_CHECKPOINT=../AudioSep/checkpoint/audiosep_base_4M_steps.ckpt

# 서버 실행
cd audiosep_code
python server.py
```

브라우저에서 `audiosep_code/static/index.html`을 열면 됩니다.

## 핵심 설계 결정

- **latest-wins 백프레셔**: AudioSep 추론이 64ms 청크보다 느릴 경우 백로그 대신 가장 최신 프레임만 처리해 지연 상한을 유지.
- **seq 헤더**: 서버 응답 앞 4바이트(uint32 LE)가 청크 순번. 클라이언트는 seq 기반으로 매칭하고 오래된 응답은 폐기.
- **run_in_executor**: AudioSep 추론을 워커 스레드로 빼 asyncio 이벤트 루프 블로킹을 방지.
