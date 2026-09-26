---
trigger: a quick yes/no, multiple-choice, or urgency/risk-style judgment call would help decide what to do next, before spending a full slow reasoning turn on it
---

# laya fast decision (System 1 sidekick)

이 머신은 `laya`라는 작고 추론 없는 CPU 모델을 함께 실행 중입니다
(`convaiinnovations/laya`, ModernBERT-large 421M, **CPU 모드**). HTTP로
`http://127.0.0.1:8000`에 노출되어 있고, 좁고 정형화된 질문(`choice` 다지선다 / `score`
등급·순서 / `noul` 참/거짓)에 확률·신뢰도를 즉시 반환합니다. 실측 응답시간 ~0.5초에
대비해 주 모델 Ornith의 full 추론 턴은 수십 초~90초입니다. **권고용 단축 경로**로만
쓰고, 결코 결정의 유일한 근거로 쓰지 마세요.

## 언제 쓰면 좋은가

진짜 급한 분류/트리지 판단이고, 이게 없으면 한 턴 전체를 천천히 돌려야 하는 상황에 한정:
- 이 에러·출력이 그냥 노이즈인지, 진짜 고칠 것인지
- 앞으로 진행하기 전에 긴급도/위험도로 플래그로 띄울 필요가 있는지
- 짧은 옵션 목록 중 지금 상황에 가장 맞는 것이 무엇인지

**절대** 진짜 추론·코드이해·결과가 따르는 판단엔 쓰지 마세요 (파괴적 명령 실행 여부,
고치가 옳은지, 보통 당신이 직접 살필 일을 laya가 대신 결정하게 하지马). 정답이 이미 결정 돼
있거나 확률이 명확할 때만 유익합니다. 답을 "추가 데이터 점"으로만 취급하세요.

## 호출 방법

shell 도구로 **항상 `--no-check`와 함께** 실행하세요 (붙이면, 꺼져 있는 laya 서버가
대화형 `y/N` 설치 프롬프트를 띄워 아무도 대답하지 않은 채 무한 정지됩니다 — 대화창엔
터미널이 붙어 있지 않습니다):

```bash
python3 /home/jeano/llamacli/llamacli_plugin/scripts/laya_integration.py fastcheck \
  --text "<짧고 독립적인 yes/no 또는 다지선다 질문>" \
  --no-check
```

- 종료코드 0 + stdout에 답 출력 = laya가 응답했습니다. 선택 항목(확률 포함)이나 0–1 스코어,
  그리고 내부에서 어떤 체크포인트가 왜 답했는지가 함께 나옵니다.
- 종료코드 1 (서버 안 떠 있거나 연결 실패/타임아웃) = laya를 지금 쓸 수 없습니다. 당연한
  것이고 보고·재시도할 오류가 아닙니다. 조용히 Ornith로 우회해 직접 생각하고 계속하세요.
- 내부적으로 최대 ~3초(설정 `timeoutSeconds`)로 고정되어 한 턴을 실질적으로 막지 않습니다.

### 정형 문답 프롬프트 제어 (config.yaml)

`--text` 대신 config의 기본 질문 구성을 바꾸고 싶으면 `scripts/laya_integration.py gate`
명령을 쓰세요. config의 `laya:` 섹션이 질문 구조를 결정합니다:

- `questionType`: `noul`(기본, 참/거짓 확률) / `choice`(다지선다, `labels` 목록 필요) /
  `score`(등급·순서, `criteria` 순번). laya는 `choice`에 `labels`와 함께 받는 것을 거부하므로
  `choice`일 때만 `labels:`를 채우세요.
- `criteria`: `score`/`choice` 순서 목록 (예: `- 매우 불만족 - 만족`).
- `labels`: `choice` 다지선다 보기를 나열 (예: `- 옵션 A - 옵션 B - 옵션 C`).
- `baseUrl`, `timeoutSeconds`.

> 참고: `gate`는 기본값이 **off**인 단축 경로(short-circuit)를 포함합니다. 이 경로가 켜지면,
> laya의 확률(`act_probability ≥ actProbabilityThreshold`)과 신뢰도(`confidence ≥
> confidenceThreshold`)가 **둘 다** 충족될 때만 "Ornith 없이 laya 판단으로 충분"이라며 즉시
> 결론을 내고 Ornith 호출을 생략합니다. 둘 다 충족되지 않으면 "진행 가능하나 Ornith로 정밀
> 확인 권장" 권고를 내고 Ornith를 돌립니다. 단축 경로는 신뢰도가 낮은 애매 케이스에서 품질이
> 무너질 수 있으므로 allow-list(임계값 충족 시만) 원칙입니다.

## 실패 시 대응 (degrade-to-Ornith)

- laya가_down_이거나 응답이 없으면 **Ornith로만 진행하고 laya는 스킵**하세요. 스킬 전체가
  실패하지 않도록 — 이것이 이 설계의 철학입니다. health probe → 실패 → graceful skip(laya가
  없어도 완전히 동작).
- `confidence`가 낮은 애모한 케이스는 laya를 그대로 신뢰하지 마세요. 초기는 log-only로 시작:
  "신뢰도 낮음, 확인 필요" 힌트만 Ornith에게 주고 최종 판단은 주 모델이 하도록 합니다.

## 왜 CPU 모드인가 (7항 검토 반영)

오늘의 OOM 사고는 laya를 GPU 대신 CPU로 띄웠을 때 발생했습니다. 그런데 실측(부록 A)에 따르면
진짜 제약은 RAM이 아니라 **VRAM**입니다: Ornith가 8GB 중 7.4GB를 독점하고, 시스템 RAM은
여유(~16.9GB)지만 swap(8GB)는 포화 상태입니다. 결론 — 리스킬 게이트는 RAM이 아니라
**SwapFree 기준**으로 잡아야 합니다. laya를 CPU로 두면 Ornith의 VRAM은 건드리지 않으면서도
swap 포화 상태에서 laya의 RAM 식이 swap 압박을 재점화할 수 있으므로(과거 OOM 시나리오와 유사),
`gate`는 SwapFree 체크로 안전장치를 걸고, 응답 지연 시 timeout로 Ornith로 우회합니다.

## 설치/기동 없어도 동작 (6항 검토 반영)

이 스킬은 **설치·기동을 시도하지 않습니다.** `--no-check`는 "답하거나 조용히 실패한다"는
의미입니다. laya 자체를 이 환경에 설치하는 것(venv 생성, `uv pip install laya[serve]`,
HuggingFace 체크포인트 다운로드, GPU VRAM 부족 시 CPU 폴백)은 스킬 범위가 아니라 별도 절차로,
기본값은 안전한 쪽——설치를 **사용자에게 명시적으로 묻고 동의한 뒤** 프로젝트별 venv에 설치하는
방향(6-1 온보딩 메뉴의 (A)/(B)/(C) 선택지)입니다. 사전 동의 없는 자동 설치(b)는 디스크/네트워
크 사용량이 커서 배제합니다.

laya가 이 환경에 있는지 확인만 하고 싶으면:

```bash
python3 /home/jeano/llamacli/llamacli_plugin/scripts/laya_integration.py status
# -> {"enabled": true, "installed": false, "running": false, ...} (JSON, 읽기 전용·안전)
```

## Notes

- 이 스킬은 llamacli 코어 코드를 건드리지 않습니다. laya는 독립 스크립트에 대한 평범한 shell
  호출로, laya가 없을 때 항상 no-op으로 격리됩니다.
- `status`는 `{enabled, installed, running, swapFreeKb, ramFreeKb}` 등을 JSON로 출력합니다.

## 부록: 검토 항목 매핑 (1~8항)

| 항목 | 이 스킬에서의 구현 |
|---|---|
| 1 호출 시점 | a(권고 merge)/c(`/fastcheck` 명시 커맨드) + b 단축 경로(`gate`, off-by-default allow-list). `fastcheck`는 c, `gate`는 a+b |
| 2 자원 | lazy: 필요할 때만 올림. SwapFree 게이트(게이트 스크립트의 swap 체크), timeout로 Ornith 우회 |
| 3 대응 | laya 다운/타임아웃 → Ornith 진행만. low-confidence는 log-only + Ornith에 힌트 |
| 4 적용처 | 툴 호출 전 위험도 분류, 긴급우 우선순위, 커밋/diff 사소 변경 필터, 응답 형식(choice/score/noul) 예측 — fastcheck/gate로 모두 호출 가능 |
| 5 스위치 | `.llamacli/config.yaml`의 `laya:` 섹션 (`enabled`, off이면 health probe조차 안 함). 시작 시 1회 읽기 |
| 6 부재 대응 | 스킬은 설치 시도 안 함. 감지·동의·설치·기동은 별도 절차(프로젝트별 venv, 사전 동의 기본값) |
| 7 GPU/CPU | CPU 고정 (기본값). SwapFree 기준 게이트로 swap 포화 재현 방지. gpu/auto는 추후 검토 |
