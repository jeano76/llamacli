# llamacli

로컬 llama.cpp를 직접 호출하며 OpenAI Chat Completions API와 호환되는 AI 코딩 에이전트
CLI. 설계 배경과 전체 요구사항은 [`PROMPT.md`](./PROMPT.md) 참고.

## 구조

```
src/
  backend/      llama.cpp 프로세스 관리 + OpenAI 호환 HTTP 클라이언트
  agent/        도구 호출 루프 (컴팩션·자가치유 연동)
  compaction/   체크포인트 기록/재개, 컨텍스트 요약 (PROMPT.md §2)
  hermes/       자가 치유 회로차단기, 실패 로그, 자가 개선 제안 루프 (§3)
  skills/       skill 지연 로딩 + rule 상시 로딩 (§5)
  tools/        read_file / write_file / edit_file / run_shell 도구 + ANSI 컬러 diff 렌더링
  tui/          Ink 기반 하단 고정 UI: 입력창, 상태바, 스피너, 슬래시 팝업 (§6)
.llamacli/
  config.yaml   백엔드/모델/컴팩션 설정
  rules/        항상 적용되는 프로젝트 규칙
  skills/       트리거 기반 지연 로딩 skill 문서
  state/        런타임 체크포인트 (git ignore 대상)
```

## 시작하기

```bash
npm install
# .llamacli/config.yaml 의 llama.modelPath 를 실제 .gguf 경로로 설정
npm run dev
```

## 구현 상태

이 저장소는 PROMPT.md의 뼈대(스캐폴드)이며, 다음은 TODO로 남아 있다:

- 체크포인트의 `pendingToolCall` 수집 (현재 아키텍처는 턴 사이에서만 컴팩션을 체크하므로
  항상 null — 턴 도중 중단을 지원하려면 도구 실행 루프 안에서도 컴팩션 체크가 필요)
- 로그의 `log.slice(-logHeight)`는 항목(entry) 개수 기준으로 잘라내는데, 여러 줄짜리
  diff 항목은 렌더링 시 줄 단위로 펼쳐지므로 화면이 `logHeight`보다 살짝 넘칠 수 있음
- StatusBar의 컨텍스트 게이지가 아직 `estimateTokens`(문자 수 기반 추정치)에 연결되지 않음 —
  실제 토크나이저(llama.cpp `/tokenize`) 연동과 함께 AgentLoop → UI로 사용량을 전달해야 함

## 헤르메스 자가 개선 제안 루프

동일한 도구가 같은 실패 패턴으로 2회 이상 반복되면(`src/hermes/selfImprove.ts`), 모델에게
이를 방지할 rule 초안(markdown)을 작성하게 한다. **절대 자동으로 적용하지 않는다** —
제안은 항상 사용자가 직접 확인 후 별도 명령으로 승인해야 한다:

- `/improve` — 지금까지 쌓인 실패 로그를 분석해 제안을 보여준다(파일 변경 없음).
- `/improve-apply` — 직전 `/improve` 제안을 `.llamacli/rules/hermes-proposed-<timestamp>.md`
  로 저장한다. 기존 rule 파일을 덮어쓰지 않고 항상 새 파일로 저장되므로, 잘못된 제안을
  승인해도 기존 rule이 파괴되지 않는다.
- `/quit` — 세션 종료 시 미검토 실패 로그가 있으면 즉시 종료하지 않고 자동으로 제안을
  분석해 보여준다. 확인 후 `/quit`을 한 번 더 누르면 종료된다(적용은 별도로 `/improve-apply`
  가 필요 — 종료 자체가 rule을 쓰지는 않는다).
