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

The following are known remaining TODOs:

- Checkpoint `pendingToolCall` collection — the current architecture only
  checks for compaction between turns, so this is always `null`. Supporting
  mid-turn interruption would need a compaction check inside the tool-call
  loop too.
- The log's `log.slice(-logHeight)` cuts by entry count, but a multi-line
  diff entry expands into several rendered lines, so the screen can slightly
  overflow `logHeight`.
- The StatusBar's context gauge isn't wired to a real tokenizer yet — it
  still uses `estimateTokens` (a character-count approximation). Needs the
  actual llama.cpp `/tokenize` endpoint plus a path from AgentLoop → UI for
  live usage.

> ## 구현 상태
>
> 이 저장소는 PROMPT.md의 뼈대(스캐폴드)이며, 다음은 TODO로 남아 있다:
>
> - 체크포인트의 `pendingToolCall` 수집 (현재 아키텍처는 턴 사이에서만 컴팩션을 체크하므로
>   항상 null — 턴 도중 중단을 지원하려면 도구 실행 루프 안에서도 컴팩션 체크가 필요)
> - 로그의 `log.slice(-logHeight)`는 항목(entry) 개수 기준으로 잘라내는데, 여러 줄짜리
>   diff 항목은 렌더링 시 줄 단위로 펼쳐지므로 화면이 `logHeight`보다 살짝 넘칠 수 있음
> - StatusBar의 컨텍스트 게이지가 아직 `estimateTokens`(문자 수 기반 추정치)에 연결되지 않음 —
>   실제 토크나이저(llama.cpp `/tokenize`) 연동과 함께 AgentLoop → UI로 사용량을 전달해야 함

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
