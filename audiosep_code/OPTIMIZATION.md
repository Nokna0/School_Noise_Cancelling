# AudioSep 실시간 추론 최적화 과정

## 환경

| 항목 | 내용 |
|---|---|
| 기기 | Samsung Galaxy Book 4 Pro |
| CPU | Intel Core Ultra 7 115H (6P + 8E + 2LP, 22스레드) |
| GPU | Intel Arc iGPU (Xe-LPX, DirectX 12 지원) |
| NPU | Intel AI Boost |
| Python | 3.11 |
| PyTorch | 2.12.0+cpu (CPU-only 빌드, CUDA 없음) |
| 목표 | AudioSep 분리 추론을 64ms 청크 처리 속도(실시간)에 근접시키기 |

---

## 문제 정의

이 프로젝트는 마이크 입력에서 특정 소음을 실시간으로 제거하는 시스템이다.  
서버는 WebSocket으로 64ms(1024샘플 @ 16kHz) 청크를 수신하고, AudioSep으로 소음 참조 신호를 추출해 클라이언트에 돌려준다.

AudioSep은 CLAP 텍스트 인코더 + ResUNet 분리 네트워크로 구성된 딥러닝 모델이다.  
CUDA GPU 없이 PyTorch CPU 추론으로는 1초 버퍼 기준 **~950ms** 가 소요되어, 실시간 처리 한계에 걸려 있었다.  
latest-wins 백프레셔 설계 덕분에 시스템이 멈추지는 않지만, AudioSep 참조 신호 갱신 주기가 느려 소음 제거 반응이 지연된다.

---

## 시도한 최적화 방법

### 1. Intel Extension for PyTorch (IPEX)

**방법**: `ipex.optimize(model)` 한 줄로 CPU 추론을 가속.

**결과**: 실패.  
IPEX는 설치된 PyTorch 버전과 정확히 일치하는 버전이 필요한데, PyTorch 2.12.0에 맞는 IPEX 패키지가 PyPI에 존재하지 않아 설치가 불가능했다.

---

### 2. torch.compile

**방법**: `torch.compile(model, backend="inductor")` 로 JIT 컴파일 적용.

**결과**: 실패.  
`inductor` 백엔드는 Triton을 필요로 하는데, Windows 환경에서는 Triton이 미지원된다.

---

### 3. torch.set_num_threads + BUFFER_SEC 축소 (적용)

**방법**:
```python
torch.set_num_threads(os.cpu_count())  # 22스레드 풀 활용
```
```python
BUFFER_SEC = 1.0  # 2.0초 → 1.0초 롤링 버퍼
```

**결과**: 부분적으로 적용.  
스레드 수 조정은 PyTorch가 기본으로 절반 코어만 쓰는 것을 전체로 늘린다.  
BUFFER_SEC를 절반으로 줄이면 AudioSep 입력 샘플 수가 절반이 되어 추론 시간이 단축된다 (분리 품질은 소폭 저하).  
두 조치 합산으로 ~950ms 수준.

---

### 4. OpenVINO (Intel 공식 추론 프레임워크)

**방법**: `ov.convert_model(model)` 로 PyTorch 모델을 OpenVINO IR로 변환, NPU/GPU/CPU에서 실행.

**시도 1 — ONNX 경유 변환**  
ONNX opset 18에서 `Col2Im-18` 연산자를 OpenVINO가 지원하지 않아 변환 실패.

**시도 2 — PyTorch 직접 변환**  
변환 자체는 성공 (`audiosep_ss.xml` 생성)했으나, 세 디바이스 모두 컴파일 실패:

| 디바이스 | 실패 원인 |
|---|---|
| NPU | `torch.clamp(min=1e-10)` 이 `Clamp(min=1e-10, max=0)` 으로 잘못 변환 (OpenVINO 버그). NPU 컴파일러가 min > max 인 Clamp를 거부. |
| GPU | ISTFT 레이어 출력의 dynamic rank로 인해 `rank().is_static()` 검사 실패 |
| CPU | 동일한 dynamic rank Squeeze 연산자 미지원 |

**결과**: 전면 실패. AudioSep 모델의 dynamic shape(ISTFT)와 OpenVINO의 Clamp 변환 버그가 근본 원인이다.

---

### 5. ONNX Runtime (CPU)

**방법**: `torch.onnx.export` 로 ONNX 파일 생성 후 `onnxruntime` CPU 추론.

```
PyTorch CPU  :  954 ms
ONNX Runtime : 1183 ms  (0.8×)
```

**결과**: 실패. PyTorch보다 오히려 느렸다. ONNX Runtime CPU는 PyTorch의 이미 잘 최적화된 MKL/OpenMP 스레드 활용을 이기지 못했다.

---

### 6. ONNX Runtime + DirectML ✅ (최종 채택)

**방법**: `onnxruntime-directml` 패키지를 사용해 Intel Arc iGPU의 DirectX 12(DirectML) 백엔드로 추론.

```bash
pip uninstall onnxruntime
pip install onnxruntime-directml
```

```python
provider = "DmlExecutionProvider"
sess = ort.InferenceSession("audiosep_ss.onnx", providers=[provider, "CPUExecutionProvider"])
```

**결과**:

```
PyTorch CPU  :  727 ms / 청크
ONNX Runtime :   45 ms / 청크
속도 향상    :  16×
```

**성공 이유**:  
- DirectML은 OpenVINO와 달리 ONNX 그래프를 그대로 DirectX 12 셰이더로 변환하므로 dynamic shape나 특정 연산자 변환 문제를 우회한다.  
- Intel Arc iGPU는 ML 전용 가속기(CUDA 없음)이지만 행렬 연산에서 CPU 대비 압도적으로 빠르다.  
- ONNX 내보내기 자체는 PyTorch 2.12에서 opset 18로 성공적으로 동작한다.

---

## 최종 아키텍처

```
서버 시작 시:
  ① ONNX Runtime (DmlExecutionProvider) 세션 로드  ← ss_model 전용
  ② PyTorch 모델 로드                              ← CLAP 텍스트 인코더 전용

추론 시:
  텍스트 쿼리 → [PyTorch CLAP 인코더] → condition 벡터 (캐시됨)
  마이크 PCM  → [업샘플 16k→32k] → mixture 텐서
  (mixture, condition) → [ONNX Runtime / DirectML / iGPU] → 분리된 소음 신호
  소음 신호 → [다운샘플 32k→16k] → 클라이언트 전송
```

| 단계 | 소요 시간 |
|---|---|
| CLAP 텍스트 인코더 (쿼리 변경 시만 실행, 결과 캐시) | ~수백 ms (1회) |
| AudioSep 분리 추론 (ONNX Runtime + DirectML) | **~45 ms** |
| 업/다운샘플 | < 5 ms |

45ms는 64ms 청크 주기보다 짧으므로 **실시간 처리가 가능**하다.

---

## 관련 파일

| 파일 | 역할 |
|---|---|
| `audiosep_code/export_onnx.py` | ONNX 변환 + 속도 측정 스크립트 (BUFFER_SEC 변경 시 재실행) |
| `audiosep_code/audiosep_ss.onnx` | 변환된 분리 네트워크 (gitignore 대상) |
| `audiosep_code/server.py` | WebSocket 서버, ORT 세션 관리 |
