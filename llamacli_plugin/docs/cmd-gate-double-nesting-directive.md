# cmd_gate() 질문 이중 중첩 버그 수정

## 발견된 문제

`scripts/_measure_short_circuit.py` 하네스 작업 중 발견됨: `cmd_gate()` 622번째
줄이 `_make_question(DEFAULT_Noul_PROMPT, cfg)`가 이미 반환하는
`{qid: question}` 형태의 dict를 **한 번 더** `{qid: ...}`로 감싸고 있습니다.

이번 측정(`_measure_short_circuit.py`)은 `_make_question()`의 반환값을 직접
써서(cmd_gate를 거치지 않고) 재현했기 때문에 영향을 안 받았지만, 실제
`cmd_gate` CLI 경로를 그대로 타면 `/v1/systemone`에 보내는 `questions` 필드가
`{"decision": {"decision": {...실제 질문...}}}`처럼 한 겹 더 감싸진 형태로
나가서, 서버가 요청 스키마를 못 알아보고 **HTTP 422**를 반환할 가능성이
높습니다.

## 요청

1. `cmd_gate()` 622번째 줄 주변을 확인해서, `_make_question()`의 반환값을
   그대로 `questions`에 쓰도록 이중 중첩을 제거하세요.
2. 수정 후 실제로 `cmd_gate` CLI 경로(하네스가 아니라 진짜 커맨드)를 직접
   호출해서 `/v1/systemone`이 422 없이 정상 응답하는지 재현 테스트하세요 —
   `_measure_short_circuit.py`를 통한 측정은 이 경로를 안 탔으므로 이번엔
   반드시 `cmd_gate` 자체를 직접 실행해서 확인해야 합니다.
3. 수정되면 git에 커밋하세요 (이미 git 저장소로 초기화돼 있습니다).
