# llamacli

An AI coding agent CLI that talks to a local llama.cpp backend directly and is
fully compatible with the OpenAI Chat Completions API. See
[`PROMPT.md`](./PROMPT.md) for the full design background and requirements.

> 로컬 llama.cpp를 직접 호출하며 OpenAI Chat Completions API와 호환되는 AI 코딩 에이전트
> CLI입니다. 설계 배경과 전체 요구사항은 [`PROMPT.md`](./PROMPT.md)를 참고하세요.

## Structure

```
src/
  backend/      llama.cpp process management + OpenAI-compatible HTTP client
  agent/        Tool-call loop (wired into compaction + self-healing)
  compaction/   Checkpoint write/resume, context summarization (PROMPT.md §2)
  hermes/       Self-healing circuit breaker, failure log, self-improvement
                proposal loop (§3)
  skills/       Lazy skill loading + always-on rule loading, reuses existing
                CLI conventions (§5); skills/builtin/ ships architecture,
                planning, implementation, review, testing, static-analysis,
                and security skills that are always loaded
  tools/        read_file / write_file / edit_file / run_shell + ANSI-colored
                diff rendering + browser_* (remote CDP control)
  tui/          Ink-based bottom-anchored UI: input box, status bar, spinner,
                slash popup (§6)
.llamacli/
  config.yaml   Backend/model/compaction settings
  rules/        Always-applied project rules
  skills/       Trigger-based, lazily-loaded skill docs
  state/        Runtime checkpoint (git-ignored)
```

> ## 구조
>
> ```
> src/
>   backend/      llama.cpp 프로세스 관리 + OpenAI 호환 HTTP 클라이언트
>   agent/        도구 호출 루프 (컴팩션·자가치유 연동)
>   compaction/   체크포인트 기록/재개, 컨텍스트 요약 (PROMPT.md §2)
>   hermes/       자가 치유 회로차단기, 실패 로그, 자가 개선 제안 루프 (§3)
>   skills/       skill 지연 로딩 + rule 상시 로딩, 기존 CLI 컨벤션 재사용 (§5);
>                 skills/builtin/에 아키텍처·기획·구현·리뷰·테스트·정적분석·보안
>                 스킬이 있어 프로젝트 상태와 무관하게 항상 로드됨
>   tools/        read_file / write_file / edit_file / run_shell 도구 + ANSI 컬러 diff 렌더링 + browser_* (원격 CDP 제어)
>   tui/          Ink 기반 하단 고정 UI: 입력창, 상태바, 스피너, 슬래시 팝업 (§6)
> .llamacli/
>   config.yaml   백엔드/모델/컴팩션 설정
>   rules/        항상 적용되는 프로젝트 규칙
>   skills/       트리거 기반 지연 로딩 skill 문서
>   state/        런타임 체크포인트 (git ignore 대상)
> ```

## Getting started

```bash
npm install
# set llama.modelPath in .llamacli/config.yaml to a real .gguf path
npm run dev
npm test        # unit tests (node:test via tsx, no extra dependency)
npm run typecheck
```

> ## 시작하기
>
> ```bash
> npm install
> # .llamacli/config.yaml 의 llama.modelPath 를 실제 .gguf 경로로 설정
> npm run dev
> npm test        # 유닛테스트 (node:test, tsx로 구동, 별도 의존성 없음)
> npm run typecheck
> ```

## Built-in skills

`src/skills/builtin/` ships a fixed skill set that's always loaded regardless
of what a project provides — the "senior engineer fundamentals" PROMPT.md §4
calls for, made concrete and triggerable: `architecture-design`, `planning`,
`implementation`, `code-review`, `whitebox-testing`, `blackbox-testing`,
`static-analysis`, `security`. Each is a normal skill file (trigger +
guidance body) using llamacli's own format, so a project can override or add
to them the same way as any other `.llamacli/skills/*.md` file.

> ## 빌트인 스킬
>
> `src/skills/builtin/`은 프로젝트 상태와 무관하게 항상 로드되는 고정 스킬 세트를
> 제공한다 — PROMPT.md §4가 요구하는 "우수 아키텍처 개발자의 기본기"를 트리거
> 가능한 형태로 구체화한 것: `architecture-design`, `planning`, `implementation`,
> `code-review`, `whitebox-testing`, `blackbox-testing`, `static-analysis`,
> `security`. 각각 일반 skill 파일(trigger + 본문)이며 llamacli 자체 포맷을 쓰므로,
> 프로젝트에서 다른 `.llamacli/skills/*.md` 파일과 똑같은 방식으로 덮어쓰거나
> 추가할 수 있다.

## Testing

Every module with real logic (not just glue/IO) has a `*.test.ts` next to it,
run with `npm test` (Node's built-in `node:test` + `node:assert`, executed
via `tsx` — no test framework dependency needed). Currently covered:
`tools/diff.ts`, `tools/browser.ts` (target-selection/error paths, via a fake
HTTP server — full CDP round-trips were verified manually against real
headless Chrome, see below), `hermes/selfHeal.ts`, `hermes/selfImprove.ts`
(with a fake `ModelBackend`), `compaction/compactor.ts`,
`compaction/checkpoint.ts`, and `skills/loader.ts`. The agent loop and TUI are
integration-level (tool-call loop, streaming, slash commands) and were
verified by scripting real keystrokes through a pty against a real running
llama-server — see the git history for those sessions — rather than unit
tests, since mocking Ink's terminal rendering buys little over driving the
real thing.

> ## 테스트
>
> 실질적인 로직이 있는 모듈에는 (glue/IO 코드 제외) 전부 옆에 `*.test.ts`가 있고
> `npm test`로 실행된다(Node 내장 `node:test` + `node:assert`, `tsx`로 구동 —
> 별도 테스트 프레임워크 의존성 없음). 현재 커버리지: `tools/diff.ts`,
> `tools/browser.ts`(타겟 선택/에러 경로는 fake HTTP 서버로 — 실제 CDP 왕복은
> 실제 headless Chrome으로 수동 검증, 아래 참고), `hermes/selfHeal.ts`,
> `hermes/selfImprove.ts`(fake `ModelBackend` 사용), `compaction/compactor.ts`,
> `compaction/checkpoint.ts`, `skills/loader.ts`. 에이전트 루프와 TUI는
> 통합 테스트 성격(도구 호출 루프, 스트리밍, 슬래시 명령)이라 실제 llama-server를
> 대상으로 pty로 실제 키 입력을 흘려보내며 검증했다(git 히스토리 참고) — Ink 터미널
> 렌더링을 모킹하는 것보다 실제로 구동해보는 쪽이 더 실질적이라고 판단.

## Implementation status

All four previously-known TODOs here are now resolved:

- ✅ Checkpoint `pendingToolCall` collection — compaction is now also checked
  between individual tool calls within a batch (not just between turns). If
  it fires mid-batch, the about-to-run call is recorded as `pendingToolCall`
  and the rest of that batch is abandoned (the assistant message that
  requested it gets summarized away, so there's no valid tool_call_id left
  to answer anyway) — the resume prompt has the model reissue it next turn.
- ✅ Log height overflow — `App.tsx` now flattens log entries into rendered
  rows *before* slicing to `logHeight`, so a multi-line diff entry can no
  longer push the visible tail off-screen.
- ✅ Real tokenizer — `estimateTokens` uses the backend's `/tokenize`
  endpoint (llama.cpp-specific) when available, falling back to the
  character-count approximation for backends that don't have it (verified
  against a real llama-server: exact token counts match). `AgentLoop` now
  has an `onContextUsage` callback wired straight to the StatusBar gauge.
- ✅ `resumeIfCheckpointExists()` used to only inject a system message and
  then sit idle — it didn't actually drive a turn, so "resume automatically,
  no user input required" (PROMPT.md §2.4) wasn't really true. It now runs
  the turn itself, and clears the checkpoint *before* starting it (so a
  fresh checkpoint written by a compaction during that very turn survives).
  Also fixed `clearCheckpoint()`, which was overwriting the file with an
  empty string instead of deleting it — `readCheckpoint()` would then throw
  a `SyntaxError` instead of cleanly returning `null`.

All four are covered by unit tests (`src/agent/loop.test.ts`,
`src/compaction/checkpoint.test.ts`, `src/compaction/compactor.test.ts`).

> ## 구현 상태
>
> 이전까지 남아있던 TODO 4개는 모두 해결됨:
>
> - ✅ 체크포인트 `pendingToolCall` 수집 — 이제 배치 내 개별 도구 호출 사이에도 컴팩션을
>   체크한다(턴 사이뿐 아니라). 중간에 발동하면 지금 실행하려던 호출을 `pendingToolCall`로
>   기록하고 나머지 배치는 포기한다(그 호출을 요청한 assistant 메시지 자체가 요약되어
>   사라지므로 응답할 tool_call_id가 더 이상 유효하지 않기 때문) — 재개 프롬프트가 다음
>   턴에 모델이 다시 호출하도록 유도한다.
> - ✅ 로그 높이 초과 — `App.tsx`가 이제 `logHeight`로 자르기 *전에* 로그 항목을 렌더링
>   행 단위로 먼저 펼쳐서, 여러 줄짜리 diff 항목이 더 이상 최신 내용을 화면 밖으로 밀어내지
>   않는다.
> - ✅ 실제 토크나이저 — `estimateTokens`가 백엔드의 `/tokenize`(llama.cpp 전용) 엔드포인트를
>   쓰되, 없는 백엔드는 문자 수 근사치로 폴백한다(실제 llama-server로 검증: 토큰 수 정확히
>   일치). `AgentLoop`에 `onContextUsage` 콜백을 추가해 StatusBar 게이지에 바로 연결.
> - ✅ `resumeIfCheckpointExists()`가 기존에는 system 메시지만 주입하고 그냥 대기했음 —
>   실제로 턴을 진행시키지 않아서 "사용자 재입력 없이 자동 재개"(PROMPT.md §2.4)가 사실이
>   아니었음. 이제 직접 턴을 실행하며, 체크포인트는 턴 시작 *전에* 지운다(그 턴 도중 새
>   컴팩션이 발생해 새 체크포인트가 써지면 그게 지워지지 않도록). 덤으로 `clearCheckpoint()`가
>   파일을 삭제하는 대신 빈 문자열로 덮어써서 `readCheckpoint()`가 `SyntaxError`를 던지던
>   버그도 수정.
>
> 4가지 전부 유닛테스트로 커버됨(`src/agent/loop.test.ts`,
> `src/compaction/checkpoint.test.ts`, `src/compaction/compactor.test.ts`).

## Skill / Rule — reusing existing AI CLI conventions

`src/skills/loader.ts` reuses whatever rule/skill files another AI coding CLI
has already left in the project, and only generates llamacli's own defaults
when none exist. Every source that's found gets loaded and merged — it's not
"pick one," it's "load everything present":

**Rules (always injected into the system prompt)** — all of the following are
searched, in no particular order:
- `.llamacli/rules/` (llamacli's own)
- `.clinerules` (Cline)
- `CLAUDE.md` (Claude Code)
- `GEMINI.md` (Gemini CLI)
- `.cursorrules` (Cursor)
- `.windsurfrules` (Windsurf)
- `AGENTS.md` (a convention several CLIs are converging on)
- `.github/copilot-instructions.md` (GitHub Copilot)

If none of these exist, `.llamacli/rules/00-core.md` is auto-generated as
llamacli's own default rule.

**Skills (lazily loaded on trigger match)**:
- `.llamacli/skills/*.md` (llamacli's own format, `trigger:` frontmatter)
- `.claude/skills/<name>/SKILL.md` (Claude Code's format, `name`/`description`
  frontmatter)

If neither exists, `.llamacli/skills/write-tests.md` is auto-generated as
llamacli's own default skill.

> ## Skill / Rule — 기존 AI CLI 컨벤션 재사용
>
> `src/skills/loader.ts`는 다른 AI 코딩 CLI가 이미 프로젝트에 남겨둔 rule/skill 파일이
> 있으면 그것을 그대로 쓰고, 아무것도 없을 때만 llamacli 자체 기본값을 자동 생성한다
> (모든 발견된 소스는 합쳐서 로드됨 — 하나만 쓰는 게 아니라 프로젝트에 있는 만큼 전부 반영):
>
> **Rule (항상 시스템 프롬프트에 주입)** — 다음을 순서 무관하게 전부 탐색:
> - `.llamacli/rules/` (llamacli 자체)
> - `.clinerules` (Cline)
> - `CLAUDE.md` (Claude Code)
> - `GEMINI.md` (Gemini CLI)
> - `.cursorrules` (Cursor)
> - `.windsurfrules` (Windsurf)
> - `AGENTS.md` (여러 CLI가 채택 중인 범용 컨벤션)
> - `.github/copilot-instructions.md` (GitHub Copilot)
>
> 위 중 하나도 없으면 `.llamacli/rules/00-core.md`를 llamacli 자체 기본 rule로 자동 생성한다.
>
> **Skill (트리거 매칭 시 지연 로딩)**:
> - `.llamacli/skills/*.md` (llamacli 자체 포맷, `trigger:` frontmatter)
> - `.claude/skills/<name>/SKILL.md` (Claude Code 포맷, `name`/`description` frontmatter)
>
> 둘 다 없으면 `.llamacli/skills/write-tests.md`를 자체 기본 skill로 자동 생성한다.

## Hermes self-improvement proposal loop

When the same tool fails with the same pattern 2+ times
(`src/hermes/selfImprove.ts`), the model is asked to draft a rule that would
prevent it. **It is never applied automatically** — a proposal always
requires the user to review it and approve with a separate command:

- `/improve` — analyzes the accumulated failure log and shows a proposal (no
  files are touched).
- `/improve-apply` — saves the last `/improve` proposal to
  `.llamacli/rules/hermes-proposed-<timestamp>.md`. It's always written as a
  new file, never overwriting an existing rule, so approving a bad proposal
  can't destroy prior rules.
- `/quit` — if there's an unreviewed failure log at session end, quitting
  doesn't happen immediately; the proposal is analyzed and shown first.
  Pressing `/quit` again confirms the exit (applying still requires the
  separate `/improve-apply` — quitting itself never writes a rule).

> ## 헤르메스 자가 개선 제안 루프
>
> 동일한 도구가 같은 실패 패턴으로 2회 이상 반복되면(`src/hermes/selfImprove.ts`), 모델에게
> 이를 방지할 rule 초안(markdown)을 작성하게 한다. **절대 자동으로 적용하지 않는다** —
> 제안은 항상 사용자가 직접 확인 후 별도 명령으로 승인해야 한다:
>
> - `/improve` — 지금까지 쌓인 실패 로그를 분석해 제안을 보여준다(파일 변경 없음).
> - `/improve-apply` — 직전 `/improve` 제안을 `.llamacli/rules/hermes-proposed-<timestamp>.md`
>   로 저장한다. 기존 rule 파일을 덮어쓰지 않고 항상 새 파일로 저장되므로, 잘못된 제안을
>   승인해도 기존 rule이 파괴되지 않는다.
> - `/quit` — 세션 종료 시 미검토 실패 로그가 있으면 즉시 종료하지 않고 자동으로 제안을
>   분석해 보여준다. 확인 후 `/quit`을 한 번 더 누르면 종료된다(적용은 별도로 `/improve-apply`
>   가 필요 — 종료 자체가 rule을 쓰지는 않는다).

## Remote browser control (Chrome DevTools Protocol)

`src/tools/browser.ts` attaches to a browser the user already has running with
`--remote-debugging-port=<port>` (default `9222`, set in `.llamacli/config.yaml`
under `browser:`). It **never launches or manages a browser process itself** —
only connects to one that's already listening, over Node's built-in
`WebSocket` (no extra dependency). Four tools are exposed to the model:

- `browser_list_tabs` — list open page tabs (id/title/url).
- `browser_navigate` — navigate a tab to a URL and wait for load.
- `browser_eval` — evaluate JS in the page, returns the value.
- `browser_screenshot` — capture a PNG to `.llamacli/state/screenshots/`.

Verified end-to-end against a real headless Chrome instance: navigate,
evaluate (both string and non-string return values), and a real screenshot
that renders correctly.

> ## 브라우저 원격 제어 (Chrome DevTools Protocol)
>
> `src/tools/browser.ts`는 사용자가 이미 `--remote-debugging-port=<port>`
> (기본 `9222`, `.llamacli/config.yaml`의 `browser:`에서 설정)로 띄워둔 브라우저에
> 붙는다. **절대 브라우저 프로세스를 직접 실행하거나 관리하지 않으며**, 이미 떠 있는
> 브라우저에만 Node 내장 `WebSocket`(별도 의존성 없음)으로 연결한다. 모델에게 4개
> 도구를 노출한다:
>
> - `browser_list_tabs` — 열린 탭 목록(id/title/url) 조회
> - `browser_navigate` — 탭을 특정 URL로 이동, 로드 완료까지 대기
> - `browser_eval` — 페이지에서 JS 표현식 실행 후 값 반환
> - `browser_screenshot` — PNG 스크린샷을 `.llamacli/state/screenshots/`에 저장
>
> 실제 headless Chrome으로 end-to-end 검증 완료: navigate, eval(문자열/비문자열
> 반환값 모두), 실제로 렌더링되는 스크린샷까지 확인.
