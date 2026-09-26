# 구현 요청: laya `typed-decisions` 체크포인트로 도구 호출 결과 평가 (`agent_trace_observability`)

## 배경

지금 `layaGate`는 `english` 체크포인트에 **사용자의 원문 메시지**를 억지로 `noul`
질문 하나로 욱여넣고 있습니다 (`before-after-validation.md`의 경고 참고 — 선택성도
없고, short-circuit도 아직 없습니다). 이거랑 별개로, laya 패키지에는 애초에
**코딩 에이전트 자신의 행동(트레이스)을 평가하는 용도로 파인튜닝된 전용 체크포인트**가
있습니다 — `typed-decisions` (`convaiinnovations/laya-typed-decisions`), 그중에서도
`agent_trace_observability` 워크플로우가 정확히 이 상황에 맞습니다.

**핵심 차이**: 이건 사용자 입력을 판단하는 게 아니라, **llamacli가 도구를 호출한
"결과"를 판단**합니다 — 예를 들어 `run_shell`이 방금 실행한 명령이 성공/실패인지,
검토가 필요한지, 위험한지를 laya가 먼저 훑어보고, 정말 애매하거나 위험해 보일 때만
Ornith(주 모델)가 더 깊게 들여다보게 하는 용도입니다.

## 스키마 (반드시 이 5개 질문 id를 정확히 써야 함)

`laya/router.py`의 `_TYPED_DECISION_WORKFLOWS`에 이렇게 정의돼 있습니다 (patch 파일
경로: `.venv/lib/python3.11/site-packages/laya/router.py` 참고):

```python
"agent_trace_observability": {"action", "needs_review", "outcome", "risk", "urgency"}
```

질문 id **집합이 정확히 이 5개와 일치**해야 `match_typed_decisions_workflow()`가
자동으로 이 워크플로우로 인식합니다(그 함수 자체는 `auto_task_detection=True`일 때만
쓰이므로, 우리는 그냥 `/v1/systemone` 요청 바디에 `"model": "typed-decisions"`를
명시하는 쪽이 더 확실하고 간단합니다 — 굳이 auto-detection에 기대지 마세요).

`presets.py`에 이 워크플로우의 기성 질문 정의는 없습니다(다른 4개 워크플로우인
triage/email/guard/moderation/router용만 있음) — **직접 만들어야 합니다.** 아래는
제안 초안입니다 — 실제 llamacli 도구 호출 맥락(`run_shell`, 파일 write/edit 등)에
맞게 다듬어서 쓰세요:

```python
def build_agent_trace_questions() -> dict:
    return {
        "action": {
            "type": "choice",
            "instructions": "What kind of operation did the agent just perform, based on the tool call and its output?",
            "criteria": {
                "read": "read-only: viewed a file, ran a query, listed something — nothing changed",
                "write": "created or modified a file/config",
                "execute": "ran a shell command / script that does more than read state",
                "delete": "removed or overwrote something that existed before",
                "network": "made an external network call (fetch, API, git push/pull)",
            },
        },
        "outcome": {
            "type": "choice",
            "instructions": "Given the tool's output, did the operation succeed, fail, or is it unclear?",
            "criteria": {
                "success": "completed without errors, expected result present",
                "failure": "errored out, non-zero exit, exception, or explicit failure message",
                "unclear": "output doesn't clearly indicate success or failure",
            },
        },
        "risk": {
            "type": "score",
            "instructions": "How risky/hard-to-reverse is this operation, based on what it did?",
            "criteria": [
                "none: read-only, nothing changed",
                "low: easily reversible change (e.g. a single file edit with version control)",
                "medium: harder to reverse (e.g. multiple files, a dependency change)",
                "high: destructive or hard to undo (e.g. delete, force-push, drop table, rm -rf)",
            ],
        },
        "needs_review": {
            "type": "noul",
            "instructions": "Should a human or the main model re-check this result before trusting it and moving on?",
        },
        "urgency": {
            "type": "noul",
            "instructions": "Does this result demand immediate attention (a failure or risky action), or can it wait/be routine?",
        },
    }
```

## 호출 방식

1. `laya_integration.py`에 `build_agent_trace_questions()`를 추가하고, `state`로는
   도구 이름 + 인자 요약 + 결과(stdout/stderr 앞부분)를 짧게 합쳐서 넘기세요 — 전체
   출력을 다 넣지 말고 laya의 짧은 컨텍스트(체크포인트가 1024 토큰)에 맞게 자르세요.
2. `/v1/systemone` 요청에 **`"model": "typed-decisions"`를 명시적으로 포함**하세요
   (자동 라우팅에 의존하지 말 것 — 위 근거 참고).
3. CLI에 새 서브커맨드를 하나 추가하는 걸 권장합니다: `laya_integration.py trace
   --tool <name> --summary <text>` 처럼, 기존 `gate`/`fastcheck`와 구분되는 이름으로.

## 어디서 호출할지 — **코어 추가 수정 없이 가능합니다**

이건 사용자 턴이 아니라 **도구 호출 결과**에 반응해야 하므로, 지금 만든 `layaGate`
(턴 시작 전) 자리와는 다른 지점이 필요합니다. 하지만 좋은 소식은, llamacli 코어에
**이미 이 목적에 맞는 콜백이 있습니다** — `AgentLoopOptions.onToolResult(command,
output)`. `index.tsx`를 보면 이미 이렇게 연결돼 있습니다:

```ts
onToolResult: (command, output) => (globalThis as any).__llamacli_ui?.pushToolResult(command, output),
```

**이 기존 콜백 안에 laya 호출을 끼워 넣으면, `loop.ts`를 또 고칠 필요가 없습니다**
— `index.tsx`의 이 함수 본문에 (UI 갱신 호출은 그대로 두고) laya trace 호출을
fire-and-forget으로 추가하기만 하면 됩니다. 다른 새 옵션을 loop.ts에 추가하지 마세요
— 코어 수정을 최소화하는 게 원칙입니다.

주의:
- 매 도구 호출마다 laya를 부르면 오버헤드가 쌓입니다 — 일단은 **`run_shell`과
  파일 write/edit 계열 도구에만** 한정해서 시작하세요(read_file 같은 순수 조회는
  건너뛰기).
- 결과는 일단 `onStatus`로 참고 메시지만 띄우세요 — 이번에도 Ornith 턴을 막거나
  건너뛰게 하지 마세요(그건 이미 진행 중인 short-circuit 작업과 겹치니 분리 유지).
- 실패/타임아웃은 기존 `runLayaScript`처럼 조용히 무시.

## 검증

1. `english`만 로드된 상태에서 `typed-decisions`도 추가로 로드되게
   `LAYA_MODELS=english,typed-decisions`로 설정 변경 — 로드 후 RAM이 얼마나 더
   느는지 실측해서 기록하세요(오늘 이미 한 번 OOM 사고가 있었으니).
2. 실제 `run_shell` 명령 몇 개(성공 케이스, 실패 케이스, `rm` 같은 위험한 케이스)로
   `build_agent_trace_questions()` 응답을 직접 찍어보고, `risk`/`outcome`이 실제
   상황과 맞게 나오는지 사람이 눈으로 확인하세요.
3. 확인되면 `before-after-validation.md`의 테스트셋에 "도구 호출 결과 판정" 카테고리로
   추가해서 같은 절차로 검증하세요.
