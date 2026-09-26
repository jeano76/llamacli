# laya 통합 — 앞으로 남은 작업 (로드맵)

오늘 세션에서 만든 것(layaGate advisory 게이트, `run_shell` agent-trace, 각종 버그
수정, 정밀 재검증)을 기반으로, **원래 목적("의사결정을 위한 고속 응답")을 실제로
달성하기 위해 남은 작업**을 정리합니다. 우선순위 순서입니다.

## 1순위 — Phase 1: 진짜 short-circuit 구현 (핵심, 아직 미착수)

**이게 없으면 원래 목적 자체가 달성되지 않습니다.** 지금 있는 `layaGate`는 매 턴
laya에게 advisory 의견만 물어보고 **Ornith를 항상 그대로 실행**합니다 — 그래서
지금 상태로는 속도가 빨라지기는커녕 매 턴 laya 호출 시간(~0.5초)만큼 오히려
느려집니다.

- laya 응답의 `answer_confidence`(또는 `act_probability`)가 설정된 임계값
  (`config.laya.confidenceThreshold`, `actProbabilityThreshold` — 이미 config
  스키마엔 있음, 실제 사용 로직만 없음)을 넘으면 **Ornith 호출 자체를 건너뛰고**
  laya의 답으로 턴을 끝내는 로직 추가.
- 임계값 미달이면 지금처럼 laya 의견을 참고 정보로 얹어서 Ornith를 정상 실행.
- **안전장치 필수**: short-circuit이 잘못 발동해서 틀린 답을 그대로 내놓는 게
  가장 위험한 실패 모드입니다 — 임계값을 보수적으로 잡고, allow-list 방식(off by
  default)을 유지하세요 (검토 문서에서 이미 합의된 원칙).
- 구현 후 `before-after-validation.md`의 원래 A/B 속도 비교를 **이번엔 진짜로**
  실행해서, 실제 세션에서 short-circuit이 몇 %나 발동하는지, 그 비율에서의 실제
  체감 속도 개선을 숫자로 내세요.

## 2순위 — 알려진 버그 2개

- **`LAYA_MODELS`가 `_load_config()`에 병합 안 됨**: `start_laya()`가 서버를
  새로 띄울 때만 `LAYA_MODELS` 환경변수를 적용하고, 이미 떠 있는 서버에
  `cmd_gate`/`cmd_trace`가 붙을 땐 이 값이 무시됩니다 — config에 명시한 모델
  목록과 실제 라우팅 후보가 어긋날 수 있습니다.
- **"type hardcode" (#1)**: 이미 **버그가 아님**으로 결론 — laya가 두种命名 convention을
  동시에 쓰며, agent_trace_observability 워크플로우에서는 `typed-decisions`가
  정확한 id-set이므로 `_make_agent_trace_question()`의 `"type":"typed-decisions"`는
  의도된 동작. 상세는 `laya-integration-phase0-2-asis.md` **부록 B** 참고.
  → 별도 수정 작업 불필요 (추적 용으로 남김).

## 3순위 — `layaGate`를 선택적 호출로 전환

지금은 게이트가 켜져 있으면 **사용자 입력 내용과 무관하게 매 턴 무조건** laya를
부릅니다. laya가 부적합한 질문(자유서술형, 복잡한 추론 요청)에도 억지로 노이즈성
답을 받아옵니다. 원래 검토 문서 1번 항목의 취지대로, 다음 중 하나로 좁히는 게
좋습니다:
- 사용자 입력이 laya의 3가지 질문 타입(choice/noul/score)에 자연스럽게 맞는
  경우만 호출 (간단한 휴리스틱: 길이, 물음표 존재, 특정 패턴 등)
- 아니면 이걸 자동 판단하지 말고, `/fastcheck` 같은 명시적 커맨드로만 쓰게
  하고 자동 게이트는 끄는 쪽으로 재고

## 4순위 — 최종 결과 문서 정리

- `docs/laya-integration-phase0-2-asis.md`를 오늘 정밀 재검증 결과(결정론성
  확인됨, risk/needs_review 가설은 미확정 — "hypothesis, under-sampled"로
  표현)까지 반영해서 최신화.
- Phase 0(게이트 advisory 자체의 지연시간 영향)을 실제로 측정한 결과가
  최종 문서에 명시적으로 들어있는지 확인 — 애매하면 다시 측정.

## 그 외 — 검토는 됐지만 구현 안 된 것 (skill-integration-review.md 기준)

- **GPU/CPU/auto 모드 설정** (§7) — 지금은 CPU 고정. 우선순위 낮음(지금 구조로도
  동작은 함).
- **laya 미설치 환경 자동 온보딩** (§6) — 사용자 동의 없는 자동 설치는 배제
  원칙만 확정, 실제 온보딩 흐름은 미구현. 다른 프로젝트에 이 기능을 배포하려면
  필요.
- **`.llamacli/skills/laya-fast-decision.md`의 다른 프로젝트 배포** — 지금은
  프로젝트별 수동 복사가 필요. 여러 프로젝트에서 쓸 계획이면 공유 방법 고민
  필요(전역 스킬 디렉토리 등).

## 참고 — 오늘 발견된 인프라 이슈 (laya 기능과 별개, 알아만 두세요)

- llama-server의 `--cache-ram`을 9216MiB로 올린 게 오늘 낮 OOM 완화엔 도움됐지만,
  laya(4.9GB)까지 동시에 뜬 상태에서 llama-server RSS가 17GB까지 커지며 순간적으로
  생성 속도가 40 t/s → 1 t/s까지 떨어진 적이 있었습니다(스왑 재포화와 겹침). 이건
  laya 통합 자체의 버그는 아니지만, **여러 무거운 프로세스가 이 머신 하나를 공유하는
  구조적 한계**이니 laya가 상시 가동되는 쪽으로 가면 이 자원 경합을 별도로 살펴봐야
  합니다.
