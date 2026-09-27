# GLiNER2.5-Decide vs laya — 향후 고려사항

2026-09-27 조사 결과 정리. 지금 당장 교체를 결정하는 문서가 아니라, 나중에
laya 교체/병행 검토 시 참고할 근거와 미해결 질문을 남겨두는 목적.

## 배경

"GLiNER 오픈소스가 laya보다 성능이 좋다"는 주장을 조사한 결과 확인:

- 정확히는 범용 GLiNER(NER 모델)가 아니라 파생 변형인
  **GLiNER2.5-Decide**(340M, Apache-2.0, fastino.ai)가 laya와 비교
  가능한 대상임 — 일반 GLiNER는 개체명 인식용이라 laya가 하는
  choice/score/yes-no 판정 작업과 무관함.
- fastino.ai 자체 "Fast Decisions" 벤치마크(17개 데이터셋)에서
  GLiNER2.5-Decide 60.1% vs laya 46.6% (13.5%p 차이).

## 핵심 리스크 — 검증되지 않은 수치

- 이 60.1% vs 46.6% 비교는 **GLiNER 제작사 자신의 벤치마크**이고,
  제3자가 재현/검증한 적이 없음.
- 별도로 존재하는 독립 벤치마크(`sysone-bench`, 외부 저자, laya vs
  Jev vs Qwen2.5-1.5B)에는 **GLiNER가 아예 포함되어 있지 않음** —
  즉 laya와 GLiNER를 실제로 같은 조건에서 비교한 독립 자료가 현재
  존재하지 않음.
- `sysone-bench` 자체도 "one author, wide CIs", 영어 전용, 수동
  라벨링이라 한계가 있음 (laya 쪽 신뢰도 참고용으로만 볼 것).

## 비교표

| | laya | GLiNER2.5-Decide |
|---|---|---|
| 정확도(벤더 자체 발표) | 46.6% | 60.1% |
| 독립 검증 | 있음(제한적, GLiNER 미포함) | 없음 |
| 파라미터 크기 | 421M | 340M |
| 지연시간(벤더 발표, GPU) | ~32.8ms | ~38-43ms |
| 라이선스 | Apache-2.0 | Apache-2.0 |
| REST 서버 | `laya-serve` 완제품 있음 | **없음** — 라이브러리만 제공 |
| API 형태 | `/v1/systemone`에 {qid: 타입별 질문} | `model.classify_text(text, {label:[options]})` — 구조적으로 유사 |

## 통합 시 예상 비용

1. **서버 직접 구현 필요**: GLiNER2.5-Decide는 `from gliner2 import
   AutoExtractor`로 파이썬에서 직접 호출하는 라이브러리만 제공.
   REST Inference Provider가 없음(HuggingFace 페이지에 명시). laya의
   `laya-serve`처럼 바로 띄울 수 있는 서버가 없어서, llamacli_plugin의
   `/v1/systemone` HTTP 연동 방식을 유지하려면 FastAPI/Flask로
   직접 감싸야 함.
2. **스키마 이전은 비교적 용이**: `classify_text(text, {"intent":[...],
   "urgency":["0".."5"], "needs_human":["yes","no"]})` 형태가 laya의
   `typed-decisions`(action/outcome/risk/needs_review/urgency,
   choice|score|noul) 구조와 개념적으로 유사해서, 질문 스키마 자체를
   옮기는 작업은 어렵지 않아 보임.
3. **multilingual 지원 범위 미확인**: laya는 100+ 언어 지원을 명시하는데,
   GLiNER2.5-Decide의 다국어 성능은 이번 조사에서 확인 안 됨 —
   llamacli_plugin이 한국어 입력도 다루는 만큼 이 부분 별도 확인 필요.

## 권장 다음 단계 (즉시 교체 X)

1. **자체 소규모 벤치마크**: laya와 GLiNER2.5-Decide를 로컬에 나란히
   놓고, `_retest_laya_phase2.py`/`_measure_short_circuit.py`에서 이미
   쓰던 것과 같은 테스트 케이스(A-dangerous-clear / B-safe-ambiguous
   등)로 동일 입력에 대해 직접 비교. 이게 지금 존재하는 어떤 벤치마크보다
   이 프로젝트의 실제 사용 패턴에 더 신뢰할 만한 근거가 됨.
2. 그 결과가 실제로 laya보다 유의미하게 낫다고 나오면, FastAPI 래핑
   서버 프로토타입을 만들어서 `/v1/systemone`과 동일한 인터페이스로
   노출시키는 작업으로 넘어갈 것.
3. 그 전까지는 laya 유지 — 지금 laya 쪽에서 진행 중인 install/boot
   안정화 작업(`docs/fastcheck-on-boot-bugs-directive.md` 등)을
   먼저 마무리하는 게 우선순위.

## 미해결 질문

- GLiNER2.5-Decide의 한국어/다국어 정확도는 어느 정도인가?
- `sysone-bench`에 GLiNER를 추가해서 laya·Jev·GLiNER 3자 비교를
  직접 만들어볼 가치가 있는가?
- FastAPI 래핑 시 예상 추가 지연시간(HTTP 오버헤드)이 GLiNER의
  정확도 이득을 상쇄할 정도인가?
