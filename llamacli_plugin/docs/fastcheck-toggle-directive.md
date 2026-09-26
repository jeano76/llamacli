# 방향 승인 + 추가 요구사항: /fastcheck에 on/off 토글 기능

## 승인된 것

현재 진행 중인 코어 수정 계획을 **승인합니다**. 그대로 진행하세요:
1. `AgentLoopOptions`에 `layaGate?: () => Promise<void>` 추가, `send()` 시작 시 자동 호출
   (matches loop.ts:476 부근 — 이미 파악해둔 위치)
2. `index.tsx`에서 config+apiKey로 gate 콜백 구성해서 주입
3. `SlashMenu.tsx`에 `/fastcheck` 등록 + `index.tsx`의 `onSlashCommand` 분기 추가

## 추가 요구사항: `/fastcheck`가 laya 게이트 자체를 on/off 할 수 있어야 함

지금 `laya_integration.py fastcheck`는 **1회성 질문 응답**용으로만 설계돼 있습니다
(`--text "..."`로 즉석 질문). 이제 `/fastcheck` 슬래시 커맨드는 그 기능에 더해
**laya 자동 게이트(매 턴 자동 호출) 자체를 켜고 끄는 스위치** 역할도 겸해야 합니다.

### 원하는 동작

- `/fastcheck on` → `.llamacli/config.yaml`의 `laya.enabled`를 `true`로 저장. 이후
  턴부터 `layaGate` 콜백이 실제로 laya를 호출하기 시작.
- `/fastcheck off` → `laya.enabled`를 `false`로 저장. 이후 `layaGate`는 즉시 no-op
  (health check조차 시도 안 함 — 검토 문서 5번 항목에서 이미 합의된 원칙 그대로).
- `/fastcheck status` → 현재 on/off 상태 + `laya_integration.py status`의 결과(installed/
  running/자원)를 화면에 보여줌. (이미 있는 `cmd_status`를 그대로 재사용하면 됩니다.)
- `/fastcheck <질문 텍스트>` → 기존처럼 1회성 즉석 질문 (`cmd_fastcheck`와 동일 경로,
  on/off 상태와 무관하게 항상 동작 — 수동으로 물어보는 건 게이트가 꺼져 있어도 되게).
- `/fastcheck` (인자 없음) → 사용법 안내만 출력 (`on`/`off`/`status`/`<질문>` 중 선택하라고),
  실수로 아무것도 안 건드리게.

### 구현 메모

- `laya_integration.py`에 `enable`/`disable` 서브커맨드를 추가하는 게 제일 깔끔합니다
  (`build_parser()`에 `p_en`/`p_dis` 추가, `_save_config`는 이미 있으니 재사용). 굳이
  `index.tsx`에서 직접 YAML을 만지지 말고, 이 파이썬 스크립트 쪽에 위임하세요 — config
  읽기/쓰기 로직이 이미 거기 있고 중복을 피할 수 있습니다.
- `/fastcheck` 뒤에 붙는 인자를 어떻게 파싱할지(`on`/`off`/`status`/그 외=질문)는
  `index.tsx`의 `onSlashCommand` 분기에서 첫 단어로 구분하면 됩니다.
- on/off 토글은 **런타임 중 즉시 반영**되어야 합니다 (재시작 없이) — `layaGate` 콜백이
  매번 config를 다시 읽거나, 최소한 이 세션 동안의 in-memory 플래그를 토글하는 식으로.
  검토 문서 5번 항목에서 "런타임 토글 필요한지"를 미결로 남겨뒀었는데, 이번 요구사항으로
  **필요하다**로 확정됩니다 — 문서도 그렇게 업데이트해주세요.
- `/fastcheck on` 했는데 laya가 설치조차 안 돼 있으면 어떻게 할지도 정하세요 — 이전
  검토(6번 항목)의 결론대로 자동 설치는 하지 말고, "laya가 설치되어 있지 않습니다.
  `python3 scripts/laya_integration.py onboard`로 먼저 설치하세요" 같은 안내만 띄우고
  `enabled`는 그대로 `true`로 저장해도 되는지(다음 턴에 조용히 no-op) 아니면 설치
  전까지는 `false`로 막아둘지 — 판단해서 진행하고, 어느 쪽으로 했는지 notes에 남기세요.

## 검증

기존처럼 typecheck/빌드/스모크테스트 다 통과시키고, 추가로 `/fastcheck on` → 턴 실행
→ laya가 실제로 개입했는지(로그나 상태 메시지로 확인) → `/fastcheck off` → 다음 턴에서
laya가 전혀 호출 안 되는지까지 실제로 한 번 돌려서 확인해주세요.
