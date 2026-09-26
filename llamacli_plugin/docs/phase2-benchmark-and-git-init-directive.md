# Phase 2 벤치마크 재촉 + 버전관리 공백 해결

## 1. Phase 2 A/B 벤치마크 결과가 필요합니다

`notes.md` `[18:18]`에 "Phase 2: `before-after-validation.md`의 실제 A/B 벤치마크를
라이브 laya 서버로 돌려서 short-circuit 발동률(%)과 속도 개선폭을 측정한다"고
기록해둔 뒤, 이후 노트가 전부 이미 끝난 agent-trace 타입 버그 재확인(`[18:46]`,
`[19:04]`, `[19:07]`, `[19:30]` — 전부 동일한 결론 반복)으로 흘러가서 벤치마크
자체는 1시간 넘게 진전이 없습니다.

- 지금 Phase 2가 막혀 있는 이유가 뭔지 먼저 확인하세요 (라이브 서버 상태, 스크립트
  버그, 테스트 케이스 설계 문제 등).
- 막힌 게 없다면 지금 바로 `before-after-validation.md`의 A/B 벤치마크를 실행해서
  다음을 숫자로 내주세요:
  - 실제 세션에서 short-circuit이 몇 %나 발동하는지
  - 그 비율에서 체감 속도가 실제로 얼마나 개선되는지 (before/after 응답 시간 비교)
- 같은 결론(agent-trace 타입 버그)을 반복 재확인하는 건 이제 그만하세요 — 이미
  4번 동일하게 확인됐고 더 검증할 게 없습니다.

## 2. 버전관리 공백 — 지금 고친 것들이 전부 디스크에만 있고 사라질 위험

`/home/jeano/llamacli_plugin`가 git 저장소가 아니라서(`.git` 없음), 오늘 고친
아래 항목들이 **전부 커밋되지 않은 디스크 상태로만 존재**합니다:
- `scripts/laya_integration.py`의 short-circuit 프롬프트 수정
- `scripts/laya_integration.py`의 agent-trace 질문 타입 수정
- 그 외 오늘 수정한 모든 스크립트

프로세스가 재시작되거나, 파일이 실수로 덮어써지거나, 디스크 문제가 생기면 이
수정사항들은 전부 그냥 사라집니다. 다음을 진행하세요:

1. `/home/jeano/llamacli_plugin`에서 `git init`
2. `.gitignore`를 만들어 `.venv/`, `__pycache__/`, `.llamacli/state/backups/`
   등 재생성 가능한 파일은 제외
3. 지금까지의 작업 상태를 첫 커밋으로 남기기
4. 이후로는 의미 있는 수정 단위마다 커밋하는 습관으로 전환

Phase 2 벤치마크 결과가 나오면 그 결과도 커밋 메시지나 별도 문서에 남겨서
재현 가능하게 해주세요.
