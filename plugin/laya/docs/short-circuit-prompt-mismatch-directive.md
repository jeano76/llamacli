# 긴급 수정: short-circuit 판정이 잘못된 질문을 근거로 내려지고 있음

## 발견된 문제

`cmd_gate()`(`scripts/laya_integration.py`)가 short-circuit 여부를 판단할 때 쓰는
질문 자체가 **yes/no로 답할 수 없는 개방형 요청**입니다:

```python
prompt = args.prompt or cfg.get("question", DEFAULT_GATE_PROMPT)
questions = {"decision": _make_question(prompt, cfg)}   # 기본 type="noul"
```

`DEFAULT_GATE_PROMPT`(66번째 줄):
> "...give ONE crisp recommendation on what to do next -- and flag anything risky.
> Be direct; no preamble."

이건 "추천을 하나 말해달라"는 요청이지 참/거짓 질문이 아닙니다. 그런데
`_make_question()`이 기본 `type="noul"`(참/거짓 확률)로 이걸 그대로 laya에 보내서,
**yes/no로 답할 수 없는 질문에 억지로 확률 답을 뽑아내고** 있습니다.

`short_circuit_verdict()`는 그 답변이 `{yes,no,proceed,flag,no_action}` 중 하나이고
신뢰도 ≥0.7이면 short-circuit을 허용하는데 — **질문 자체가 "이 요청을 빨리 처리해도
되나?"와 무관하니, 이 판정은 실제 사용자 요청의 난이도/위험도와 아무 상관 없이
내려질 수 있습니다.** 배선(Node가 stdout을 파싱하는 것)을 아무리 잘 만들어도, 근거
자체가 무의미하면 소용없습니다.

## 이미 올바른 프롬프트가 같은 파일에 존재합니다 (그냥 안 쓰이고 있음)

72번째 줄, `DEFAULT_Noul_PROMPT`:
> "...is this a genuinely quick judgment that you can answer right now without a
> full slow reasoning turn? Answer yes/no."

이건 정확히 "short-circuit 해도 되는가"를 직접 묻는, `noul` 타입에 딱 맞는 질문입니다.

## 수정 요청

1. `cmd_gate()`가 short-circuit 판정용 질문을 만들 때 **`DEFAULT_GATE_PROMPT`
   대신 `DEFAULT_Noul_PROMPT`를 쓰도록 변경**하세요.
   - 단, `DEFAULT_GATE_PROMPT`(추천 문구)는 **화면에 보여주는 "laya suggestion"
     문구용으로는 여전히 유용**할 수 있습니다 — 완전히 지우지 말고, "판정용 질문"과
     "사용자에게 보여줄 조언 문구"를 **역할을 분리**하는 방향으로 다듬으세요.
     (예: short-circuit 여부는 `DEFAULT_Noul_PROMPT`로 별도 질문해서 판정하고,
     화면에 보여줄 조언은 지금처럼 `DEFAULT_GATE_PROMPT`로 따로 받거나, 혹은
     하나의 요청에 질문 두 개(`decision`=noul 판정용, `advice`=choice/score 등
     조언용)를 같이 넣는 것도 가능 — `/v1/systemone`은 여러 질문을 한 번에 받을
     수 있습니다.)
2. 수정 후 실제로 짧고 명확한 yes/no성 입력("이 파일 존재해?" 같은 것)과 복잡한
   입력("이 버그 원인 찾아서 고쳐줘" 같은 것)을 각각 넣어서, **전자는 높은
   신뢰도로 short-circuit 허용, 후자는 낮은 신뢰도나 allow-list 밖 답으로 거부**
   되는지 직접 재현해서 확인하세요 — "판정이 실제로 난이도를 반영하는지"를 눈으로
   검증하기 전엔 Phase 1을 완료로 보지 마세요.
3. 검증되면 이어서 Node 쪽 배선(stdout 파싱 → loop.ts에서 Ornith 스킵)을
   진행하세요.
