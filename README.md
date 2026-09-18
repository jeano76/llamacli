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

### Installing the `llamacli` command globally

```bash
npm run build   # compiles to dist/ (bin points here, so build before linking)
npm link        # symlinks `llamacli` into your global npm bin (npm prefix)
llamacli         # now runs from any directory
```

Each project gets its own `.llamacli/config.yaml`/`rules/`/`skills/` based on
its current working directory — the global command is just the entry point;
per-project state still lives in that project. Verified running both inside
this repo and from an unrelated directory (`cwd` in the status bar reflects
wherever you launched it from, and it auto-generates its own default rule
file there if the project has no rule/skill convention yet — see the
Skill/Rule section above). To undo: `npm unlink -g llamacli` (from anywhere)
or `npm rm --global llamacli`.

> ## 시작하기
>
> ```bash
> npm install
> # .llamacli/config.yaml 의 llama.modelPath 를 실제 .gguf 경로로 설정
> npm run dev
> npm test        # 유닛테스트 (node:test, tsx로 구동, 별도 의존성 없음)
> npm run typecheck
> ```
>
> ### `llamacli` 명령을 전역으로 설치하기
>
> ```bash
> npm run build   # dist/로 컴파일 (bin이 dist를 가리키므로 link 전에 반드시 빌드)
> npm link        # 전역 npm bin(prefix)에 `llamacli`를 심볼릭 링크로 등록
> llamacli         # 이제 어느 디렉토리에서든 실행 가능
> ```
>
> 프로젝트마다 실행 시점의 작업 디렉토리를 기준으로 각자의
> `.llamacli/config.yaml`/`rules`/`skills`를 갖는다 — 전역 명령은 진입점일 뿐,
> 프로젝트별 상태는 그대로 해당 프로젝트에 남는다. 이 저장소 내부와 무관한 디렉토리
> (`/tmp`) 양쪽에서 실행해 검증함(상태바의 cwd가 실행한 위치를 정확히 반영하고,
> 프로젝트에 rule/skill 컨벤션이 없으면 그 자리에 자체 기본 rule을 자동 생성함 —
> 위 Skill/Rule 섹션 참고). 되돌리려면: 아무 위치에서나 `npm unlink -g llamacli`
> 또는 `npm rm --global llamacli`.

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

### Crash fix: backend/compaction network failures no longer kill the process

Found via a screen recording: running `llamacli` in a directory with no
`.llamacli/config.yaml` falls back to a default backend URL nothing is
listening on. The resulting `ECONNREFUSED` was an uncaught exception that
crashed the whole Node process instead of staying inside the TUI.
`AgentLoop` now catches both the main chat request and the compaction
summary request, turning either failure into a `[error]`/`[compaction
failed]` status line instead of a crash (the compaction checkpoint is
written to disk *before* the summary request, so nothing is lost even if
the summary call fails). `index.tsx`'s `onSubmit` and
`resumeIfCheckpointExists()` call sites also got a defensive try/catch on
top, as a second line of defense. Reproduced and verified fixed with the
exact error from the recording, via a real pty run of the built global
command. Covered by `src/agent/loop.test.ts`.

### Layout fix: the slash menu overflowed the fixed-height screen and left ghosting behind

Found via a second screen recording: opening the slash menu on a fresh
launch left a stray character visible below the app's own status bar,
outside the box it should be confined to. Root cause — `App.tsx`'s outer
`Box` is pinned to a fixed `height={rows}`, but `logHeight` was computed as
a constant (`rows - 6`) that never accounted for the slash menu's own rows
(a rounded border top+bottom plus one line per item, ~10 rows). With the
menu open, total content exceeded `rows`, which scrolled the real terminal;
when the menu closed and content shrank back down, that scroll didn't
cleanly undo, leaving stale content on screen (exactly the "no ghosting on
popup close" requirement PROMPT.md §6 calls for). Fixed by shrinking
`logHeight` by the menu's actual height while it's open, and adding
`overflow="hidden"` to the outer `Box` itself as a defensive backstop so
total content can never exceed the terminal height even if this math is
ever slightly off again.

### Backend auto-detection: stopped guessing a dead default port

The same recording also showed a real message never reaching any model:
with no `.llamacli/config.yaml`, the CLI fell back to a hardcoded default
backend URL (127.0.0.1:8081) that's usually nothing — even on a machine
that had a real server running on a different port the whole time.
`loadConfig()` now follows the same pattern already used for rules/skills
(§5): when no config exists yet, it probes common local ports (see
`src/backend/detect.ts` — llama-server's typical 8080, the old default
8081, Ollama's 11434) for a real OpenAI-compatible `/v1/models` responder,
and if it finds one, generates `.llamacli/config.yaml` pointing at it
automatically, with a `[setup]` status message announcing what it found.
If nothing answers, it still writes a placeholder config and says so
clearly, instead of silently guessing. Verified end-to-end: run from a
directory with zero prior configuration, it found this machine's actual
running server and connected to it with no manual setup. Covered by
`src/backend/detect.test.ts` and `src/config.test.ts`.

### Input-line wrap fix: the same ghosting bug, triggered by a long typed line

A third recording showed the leftover-character ghosting still happening
even after the slash-menu fix above — this time with the menu never
opened. Root cause: the input row's `<Text>{input}</Text>` had no width
constraint, so once typed text got wider than the terminal, Ink wrapped it
onto multiple rows instead of clipping it. That's the exact same
"total content exceeds the fixed layout height" overflow as the menu case,
just triggered by a long line instead of a popup — and shrinking back down
(backspacing, or wrapping back to one line) left the same stale content
behind. Fixed by measuring the input with real terminal display width
(`string-width` — Hangul and other wide characters are 2 columns, not 1,
so a naive `.length`-based cut would still overflow) and always rendering
only the tail that fits in one row, prefixed with `…` when truncated,
exactly like a normal single-line terminal input. The input row is also now
pinned to `height={1}` with `overflow="hidden"` as a backstop. Verified: a
210-character line no longer wraps past one row, no matter how long it
gets or how it's edited. Covered by `src/tui/textWidth.test.ts`.

(While investigating, also removed the unused `uuid` dependency, which had
an open moderate-severity advisory — it was never actually imported
anywhere in the codebase.)

### Real root cause found: the terminal cursor was never moved to the input line

The user reported it plainly: typed characters weren't landing in the
prompt area — they appeared at the bottom-left of the screen. Captured the
*raw* bytes Ink writes (not just the visible rendering) and found the
actual cause behind all three ghosting reports above: **Ink never
repositions the real terminal cursor after a render.** Every frame, Ink
writes the whole UI top-to-bottom and finishes with the cursor sitting on a
blank line just below the last row (StatusBar) — never back up at the
input line where the user is actually typing. Desktop input methods
(fcitx/ibus for Hangul and other CJK input) anchor their composition popup
to the *real* cursor position, not to anything Ink renders — so composed
characters appeared to land at the bottom-left the whole time, exactly as
described, regardless of the earlier overflow/ghosting fixes.

Also found in the same raw capture: `StatusBar` had the identical
unconstrained-width bug as the input line and slash menu — a long
cwd/model combination wrapped it onto a second row, which was throwing off
the fixed row-distance the cursor fix depends on. Extracted the truncation
logic into a shared `src/tui/textWidth.ts` and applied it to `StatusBar`
too (`src/tui/StatusBar.tsx`'s `statusBarFieldWidth`), so it's now
guaranteed to stay exactly one row.

The first attempted fix: after every render, move the cursor 2 rows up
(past the blank trailer and the now-single-row StatusBar) and to the exact
column after the visible input text (`\x1b[2A\x1b[<col>G\x1b[?25h`). This
verified correctly in a synthetic pty test — but a follow-up recording on a
**real** GNOME Terminal session showed it landing one row too low, visibly
overlapping the StatusBar's cwd text. The "N rows up from wherever Ink's
writer happens to end" assumption isn't portable across terminals/Ink's
internal write patterns, so guessing a fixed offset was the wrong strategy
regardless of how carefully the offset was measured in one environment.

**Replaced with a terminal-agnostic fix**: instead of moving the real
cursor, render an explicit cursor as part of Ink's own output — an
inverse-video space appended right after the visible input text
(`<Text inverse> </Text>`). Wherever Ink actually draws that character *is*
the input position, by construction, in every terminal, with no guessing
about rows Ink might or might not have left below it. Verified in raw
output: typing "hello" now ends the input row with exactly
`hello\x1b[7m \x1b[27m` — the inverse-video block sits directly after the
typed text. This doesn't fix IME composition-popup anchoring (a deeper,
terminal/IME-level limitation outside an app's control), but it does give
an always-correct answer to "where is my typing going," which is what was
actually being asked. Also verified correct immediately after a live
terminal resize (SIGWINCH). Covered by `src/tui/StatusBar.test.ts` and
`src/tui/textWidth.test.ts`.

### Alternate screen buffer: fixing the *actual* foundational issue

A follow-up report described it precisely: "the prompt starts from the
bottom-left shell corner, and typed characters land below the input box."
That pointed at something more fundamental than a cursor-offset bug — Ink
was never switching to a dedicated screen, so it drew starting from
whatever row the shell's cursor happened to be on (wherever the terminal's
scrollback was at launch), not the top of the visible viewport. Without a
stable origin, *any* absolute-position math is unreliable, and even
relative math (as the previous fix used) has no fixed ground truth to
measure from.

Fixed properly this time: `index.tsx` now switches to the terminal's
**alternate screen buffer** (`\x1b[?1049h`, the same mechanism vim/htop/less
use) before rendering, and restores the original screen on every exit path
(`/quit`, Ctrl-C, uncaught errors, normal process exit) via a single
`process.on("exit", ...)` handler plus signal handlers. This guarantees row
1 is always a fixed, known origin. Combined with the app's total rendered
height now being provably constant every frame (the menu/input/status-bar
overflow bugs are all fixed above), the input row's position is fully
*computable* from the app's own layout math — no longer something to
observe-and-guess from wherever Ink's writer ends up. Replaced the
inverse-video fake cursor with real **absolute** positioning
(`\x1b[<row>;<col>H`) derived directly from that layout math.

Verified end-to-end via raw output: typing "hi" in a 40-row terminal
produces exactly `\x1b[36;6H\x1b[?25h` — row 36 matches
`logHeight(34) + divider(1) + 1` and column 6 matches
`padding(1) + spinner(1) + space(1) + width("hi")=2 + 1`, computed
independently and landing exactly on the formula. Re-verified after a live
resize to 25×90: `\x1b[21;10H` again matches the recomputed formula exactly.
Also confirmed `/quit` correctly emits `\x1b[?1049l` to restore the
original shell screen with nothing left behind.

### The real culprit for THIS bug: the slash menu shifting everything below it

A fifth report zoomed into the actual pixels and found a stray "셀"
character sitting directly on the input box's border line. Root cause:
`logHeight` shrank by the menu's height only while it was open, so opening
it shifted the input box and status bar rows down by ~10 rows in a single
frame, and closing it shifted them back up — and Ink's incremental diffing
didn't always fully clear content at the position it shifted *away from*,
leaving fragments behind exactly where observed.

First attempt: render the menu as a `position="absolute"` overlay so it
wouldn't affect the log box's height at all. This does **not** work in Ink
4.x — `position: absolute` only sets the Yoga position type, not an actual
offset (there's no top/left/right/bottom style in Ink's `Styles` type at
all, confirmed by reading `node_modules/ink/build/styles.js`). Using
`marginTop` as a substitute offset pushed the menu's rendered output past
the `overflow: hidden` boundary instead of being clipped by it, scrolling
the real terminal — confirmed by direct byte capture showing the menu
rendered far below the visible screen, past the status bar.

**Final fix**: reserve the menu's full height (`SLASH_MENU_ITEMS.length +
2`) *permanently* in the layout, whether it's open or not — opening/closing
it is now purely a content change (render `<SlashMenu>` or nothing) inside
a box whose size never changes, so nothing below it can ever need to move.
This costs a visible empty gap between the log area and the input box when
the menu is closed, which is a real trade-off, but it's the one approach
that makes the "no ghosting, ever" guarantee unconditional rather than
dependent on Ink behaving a particular way.

Verified via raw cursor-position bytes: the input box's cursor row (e.g.
`\x1b[38;...H`) is now byte-for-byte identical before opening the menu,
while it's open, and after closing it — only the column changes, tracking
typed characters. Confirmed the post-close frame is completely clean with
no leftover content anywhere.

### Also fixed: the prompt input wasn't actually inside its own border

Separately reported directly: "the input box is the area inside the drawn
line box" — pointing out that the visible bordered rectangle was pure
decoration (an empty `<Box borderStyle="single" />` divider) while the
actual typed text rendered in an unbordered row below it, not inside the
box at all. Merged them into one real bordered `Box` that contains the
spinner and input text as children, so the border now visibly encloses
where you're typing, matching what it looks like it should do.

### One more spot the same overflow bug was hiding: unwrapped log lines

Reported as garbled text in an actual response (`...입니다!m월 %d일 %A\""}`
appearing glued onto the answer). Traced it by reproducing the exact
question against the real model directly — its actual streamed content was
completely clean, ruling out a model-quality issue. The real cause:
`logHeight`'s row budget always treated every log entry (a tool call's
JSON arguments, a long assistant paragraph, a status message) as exactly
one terminal row, but nothing constrained their width — a long line (very
common for `run_shell` tool-call arguments) wraps in Ink on its own,
unaccounted for, so the actual row count temporarily exceeded the budget.
The exact same "total content exceeds the fixed layout height" bug class
already fixed for the input line, status bar, and slash menu — this was
the last place it was still hiding.

Fixed with a general-purpose `wrapToWidth()` (`src/tui/textWidth.ts`,
alongside the existing `tailToWidth()`) that wraps *every* log line kind
(not just diffs, which already had their own line-splitting) to the real
terminal width using display-width-aware wrapping, so `logHeight`'s
per-entry accounting is always accurate. Verified against a real model
response in a narrow (70-column) terminal with several long, retried
`run_shell` tool-call lines that wrap across multiple rows — the final
answer rendered completely cleanly with no fragments mixed in. Covered by
`src/tui/textWidth.test.ts`.

### Compaction crash: a strict backend rejected the summary request

Reported live, mid-session: `[compaction failed] chat failed: 400
{"error":{"message":"Cannot continue an assistant message that contains
tool calls."}}`. Root cause: `runCompaction`'s `toSummarize =
messages.slice(0, -6)` cuts by a fixed count, with no regard for tool-call
turn boundaries — if the cut lands right after an assistant message with
`tool_calls` whose matching `tool`-role response ended up in the kept tail
instead, the summary request (a plain, non-tool completion call) ends with
a dangling tool call. At least one real backend rejects that outright.

Fixed with `sanitizeForSummary()`: every `tool_calls`/`tool`-role message
going into the summary request is converted to plain describable text
(e.g. `[called tool run_shell with {"command":"date"}]`) instead of trying
to align the slice to turn boundaries, which would be fragile since it
depends on exact message-count patterns. That surfaced a second real
constraint from the same backend while testing directly against it — "2 or
more assistant messages at the end of the list" — since converting a
tool-call message to role:"assistant" can land it right after another
assistant message; fixed by merging any run of consecutive same-role
messages produced by the conversion. Verified against the real backend
with the exact production message-count pattern that failed. Covered by
`src/compaction/compactor.test.ts`.

### Unclear whether the agent had stopped or was still working

Follow-up report, quoting the compaction-failure output above: "진행중인지
멈춘건지 모르겠네" (can't tell if this is still running or stopped). Real
gap: when compaction interrupts a tool-call batch mid-turn (whether the
compaction itself succeeded or failed), the turn just ends — the only
message shown was whatever `compact()` logged, which on failure doesn't
say the turn is over. From the outside that's indistinguishable from a
hang.

Also found while looking into it: the checkpoint left behind by a
mid-session compaction was previously only ever picked back up by
`resumeIfCheckpointExists()`, which only runs once at process startup —
typing a new message in the *same* running session silently dropped the
interrupted work's context instead of resuming it, even though the
checkpoint was sitting on disk the whole time.

Fixed both: an explicit `[turn ended] Compaction interrupted this task.
It'll pick back up automatically with your next message.` status line
whenever a batch is abandoned this way, and `send()` now checks for a
pending checkpoint and folds its resume context in *every* time, not just
at startup. Covered by two new tests in `src/agent/loop.test.ts` — one
checking for the `[turn ended]` message, another driving two consecutive
`send()` calls and confirming the second one's request to the model
actually contains the interrupted work's context (74 tests total, all
passing).

### Log area stuck at the top instead of anchored to the input box

Reported directly: text only appeared near the top of the screen and never
reached down toward the bottom. Cause: the log `Box` used Ink's default
top-alignment, so on a short conversation (fewer lines than `logHeight`),
content clustered at the top with a growing gap of blank space below it,
all the way down to the input box — the opposite of a normal scrolling
terminal/chat view, where recent output sits right next to where you type.
Fixed with `justifyContent="flex-end"` on the log `Box`, so any leftover
blank space sits *above* the content instead of below it. Verified: after
sending one short message, it now renders directly above the input box
instead of stranded near the top of a 40-row terminal.

(Separately: the same message noted the terminal's own right-side scrollbar
stops working. That's an inherent trade-off of the alternate screen buffer
switch from the previous fix — vim, htop, and less have exactly the same
limitation, since a dedicated alt-screen is by definition not part of the
terminal's regular scrollback. llamacli doesn't currently have its own
in-app scrollback (Page Up/Down) to compensate; that would be a genuine new
feature, not a bug fix, and is a reasonable follow-up if wanted.)

### Raw tool-calling template tags leaking into responses

Reported live, mid-session: a response ended with literal
`</parameter>\n</function>\n</tool_call>` text visible in the log.
Reproduced directly against the real backend (bypassing llamacli entirely)
with a moderately complex `run_shell` request — the *raw* API response
already contained the leaked tags in `message.content`, confirming this
isn't a bug in llamacli's own SSE parsing. It's the model occasionally
failing to trigger llama-server's grammar-constrained tool-calling mode and
instead emitting a fragment of its own fine-tuning chat template as plain
text. It's intermittent — the exact same prompt reproduced it once and then
came back clean three times in a row — and two different tag vocabularies
were observed across attempts (Hermes-style `tool_call`/`function`/
`parameter`, and Anthropic-style `invoke`/`parameter`), so this can't be
fixed by changing how the SSE stream is parsed.

Mitigated with `stripToolCallTemplateLeak()` (`src/agent/textSanitize.ts`):
strips a narrow, tool-calling-specific tag vocabulary from both the live
streaming display (`App.tsx`, re-run over the *cumulative* text on every
chunk, since a tag can arrive split across several small chunks) and the
final message stored in conversation history (`AgentLoop`, so a leaked tag
doesn't linger in context and reinforce the same pattern on a later turn).
Deliberately scoped to known tool-calling tag names, not generic XML/HTML,
so real `<div>`/`<span>`/etc. content a user pastes is left alone. Tests
use the exact leaked strings captured from the real backend. Covered by
`src/agent/textSanitize.test.ts` (85 tests total, all passing).

### Reserving space for the menu created a new permanent gap

Reported directly, again about the top-fixed output area: some blank space
existed and text never reached down to the prompt input. Cause: the
previous fix for menu-open/close ghosting (see below) permanently reserved
the slash menu's full height as a *separate* box, always present whether
the menu was open or not — solving the ghosting, but leaving an ugly
~10-row gap between the log and the input box any time the menu was
closed (i.e. almost always).

Fixed properly this time: the log area's outer `Box` keeps a truly constant
`height={logHeight}` at all times (so nothing below it can ever shift —
preserving the ghosting fix), but what's rendered *inside* that fixed space
changes — `visibleLogRows` shrinks by the menu's height only while it's
open, so the menu and the log content share the same never-resized box
instead of the menu getting its own permanently-reserved one. Verified via
pty: log content now sits directly above the input box with no gap when
the menu is closed, the menu still renders cleanly right above the input
box when open, and closing it again leaves no ghosting — including a real
follow-up assistant response rendering correctly right after.

### Ctrl-C exited the whole app instead of doing nothing

Reported directly: some terminals/users treat Ctrl-C as copy, not an
interrupt, and it shouldn't kill llamacli either way it's configured. Cause:
Ink's `render()` defaults to `exitOnCtrlC: true` — the instant Ctrl-C is
pressed, Ink tears the whole app down itself, independent of anything the
app's own code does. Fixed by passing `{ exitOnCtrlC: false }` to `render()`
in `index.tsx`, and explicitly handling `Ctrl-C` as a no-op in `App.tsx`'s
`useInput` (rather than letting it fall through to the generic
"append this character" branch, which would otherwise insert the raw
control byte into whatever you were typing). `/quit` remains the only way
to exit. Verified via pty: the process stays alive and fully responsive
(accepts new input, submits messages) after three consecutive Ctrl-C
presses, with no stray characters left in the input line; `/quit` still
exits cleanly afterward.

### Requests to llama.cpp were never bounded in size

Found live, mid-session, while analyzing the real llama-server's own logs
(per a direct request to keep doing that): `GET /slots` showed a request
stuck generating past 22,000 tokens with no end in sight, pinning the
single inference slot (`-np 1`) and blocking every other request
indefinitely. Two compounding gaps, both fixed in `loop.ts`:

- Every chat request sent to the backend was missing `max_tokens` entirely.
  llama-server's own default for that is `-1` (unbounded), and with
  `repeat_penalty` effectively off, nothing stopped a degenerate generation
  (no stop token reached) from running forever instead of failing visibly.
  Now every request caps `max_tokens` at 25% of the configured context
  window (minimum 512) — generous for one reply, but never unbounded.
- A single tool result (e.g. `read_file` on a large file, a noisy shell
  command's stdout) had no size limit either — its full raw content went
  straight from `executeTool()` into the message history and from there,
  uncapped, into the next request body. `capToolResult()` now truncates any
  one tool result past ~24,000 characters (roughly 6k tokens) before it's
  pushed, with an explicit `[...truncated: N more characters omitted]`
  marker so the model knows content was cut rather than silently seeing
  less than what's actually there.

Verified against the real backend's `/slots` endpoint (confirmed the
runaway request's `max_tokens`/`n_predict` were both `-1`), plus new unit
tests: one asserting the request body's `max_tokens` field, one writing a
50,000-character file and asserting the tool-result message that actually
reaches the backend is shorter than the raw file and carries the
truncation marker.

### Compaction fired on every single turn: config drifted out of sync with the real server

Reported live via a pasted real session: `[compaction complete]` followed
immediately by `[turn ended] Compaction interrupted this task` — repeating
turn after turn, never letting any actual work finish. Root cause: the
project's `.llamacli/config.yaml` had `contextSize: 8192`, but the real
`llama-server` it was talking to was actually running with `-c 65536` —
eight times larger. `AgentLoop` had no way to know that; it trusted the
config value completely, so `autoTriggerRatio: 0.85` was being evaluated
against a context window 8x too small, tripping compaction almost
immediately on nearly every turn instead of only when actually needed.

Fixed two ways: corrected the stale config value for the immediate fix, and
— since a config file can always drift out of sync with whatever the
server actually ends up running as again — added
`OpenAICompatibleClient.getContextSize()`, which reads the real `n_ctx`
from llama.cpp's own `/props` endpoint
(`default_generation_settings.n_ctx`). `index.tsx` now prefers this live
value over the static config at startup, falling back to config (then
8192) only for backends that don't expose it. Verified directly against
the real running server (`getContextSize()` correctly returned `65536`,
matching `/props` output), plus 3 new unit tests against a fake `/props`
server covering the real response shape, a missing-`n_ctx` response, and a
non-OK response — all falling back rather than silently returning a bogus
value.

### Assistant text had no color/formatting, unlike Claude Code's own output

Reported directly: no ANSI color anywhere in assistant text, and no visible
distinction for fenced code blocks — everything rendered as flat white
text regardless of what markdown the model actually produced. Fixed by
rendering assistant messages through `marked` + `marked-terminal`
(`src/tui/markdown.ts`), giving real headings, bold/italic, syntax-
highlighted code blocks, and lists in the terminal, matching how Claude
Code's own CLI output looks.

Two real bugs surfaced while building this, both caught by tests/direct
verification rather than assumed away:

- `marked-terminal` renders through `chalk`, which decides whether to emit
  color at the moment it's first imported. Setting `process.env.FORCE_COLOR`
  *after* a static `import ... from "marked-terminal"` silently did
  nothing — ES module imports are hoisted, so marked-terminal (and the
  chalk instance it creates) finish initializing, with color already
  decided, before any of the importing module's own top-level code runs.
  Two new tests caught this (asserting the actual output contains ANSI
  escape codes, not just that rendering doesn't throw). Fixed by forcing
  the env var first and only then dynamically importing marked-terminal
  (top-level `await import(...)`), so chalk sees it during its own
  initialization.
- Rendering ANSI-carrying text (markdown output, and pre-existing colored
  diffs) through the log area's existing `wrapToWidth()` corrupts it —
  that function iterates the text one *character* at a time, which tears
  an escape sequence like `\x1b[32m` into individual characters, breaking
  the code and miscounting its pieces as visible glyphs. This is exactly
  why colored diffs were previously just left unwrapped entirely rather
  than passed through it (risking their own overflow). Added
  `wrapAnsiSafe()` (`src/tui/textWidth.ts`, via the `wrap-ansi` package)
  which treats escape sequences as zero-width and re-opens whatever style
  was active at each wrap point, and switched both diff and assistant
  markdown rendering to use it.

A third bug turned up only once real markdown content (with its frequent
blank-line separators between blocks) started flowing through the log
area: reported directly as a blank area appearing even when the screen was
full of text. Root cause, confirmed with a minimal Ink render: an
empty-string `<Text>` gets **zero** rendered height in Ink — not one row
like every other line — so a wrapped blank-line entry silently vanished
from the layout instead of taking up its own row. That made the log box's
actual rendered height fall short of its fixed `logHeight` budget, and
since the box is `justifyContent="flex-end"`, the shortfall showed up as a
gap at the *top* instead of the bottom. This was always a latent risk for
any multi-line diff/status content with blank lines, just rare enough
before to not show up — markdown made it routine. Fixed by rendering a
single space instead of an empty string for blank wrapped lines. Verified
with a real pty-driven render: filled the log area past capacity with
markdown content, captured the actual terminal screen with `pyte`, and
confirmed the log box is genuinely filled edge-to-edge (the one remaining
blank row in that capture was traced back to a real blank line in the
source markdown, not a rendering artifact) with color present throughout.

### Token estimate silently ignored tool_calls, so real usage exceeded the context window

Reported live via a pasted real session in a tool-heavy project: two
consecutive turns both failed with the backend's own `400
exceed_context_size_error` — `request (65,636 tokens) exceeds the
available context size (65,536 tokens)`, then again at 65,648 right after.
Nothing had shrunk in between, so the same oversized history was sent
twice in a row and failed both times — indistinguishable from the app
being stuck.

Root cause in `compaction/compactor.ts`: `estimateTokens()`/`shouldCompact()`
only ever looked at `message.content`. An assistant message that's
requesting tool calls has `content: null` — the actual payload sent to the
backend lives entirely in `tool_calls[].function.arguments` instead
(`{"command": "..."}` for `run_shell`, `{"path": "..."}` for `read_file`,
etc.), which the estimate was silently treating as empty. In a session
that calls tools constantly (exactly this kind of session), that's not a
rounding error — it undercounts a large fraction of the real conversation,
so `shouldCompact()` kept reporting plenty of headroom right up until the
backend's own hard limit disagreed. Fixed by including tool call
name+arguments in both the tokenizer-backed and the chars/4 fallback
estimate (`messageText()`).

Also added a second, independent layer of defense: since any estimate can
still be wrong (a future backend field it doesn't account for, a
tokenizer quirk), `AgentLoop.runUntilIdle()` now treats the backend's own
`exceed_context_size_error` as authoritative — on that specific error it
forces an immediate compaction and retries the request once (capped at
one retry per turn, so a single message that's still too large after
compacting reports an error instead of looping). This means even a
still-inaccurate estimate can no longer repeat the same failure turn
after turn the way it just did live.

Covered by new tests: `estimateTokens` correctly counting a tool_calls
message's arguments (vs. one with neither content nor tool_calls, which
stays 0), one turn-level test asserting a single overflow triggers exactly
one forced compaction and one retry that then succeeds, and one asserting
a *persistent* overflow (still fails after the retry) is reported rather
than retried forever.

### Streaming crashed with "Cannot read properties of undefined (reading '0')"

Reported live, right in the middle of otherwise-normal work: a plain,
unreadable crash. Root cause in `openaiClient.ts`'s `streamChat()`: the
initial HTTP response can be a perfectly normal `200 OK` (so the existing
`res.ok` check passes) even though the request eventually fails — llama-
server can start streaming tokens normally and only *later* discover
mid-generation that it's now over the context window (or some other
runtime failure), at which point it emits an SSE data chunk shaped like
`{"error": {...}}` with no `choices` field at all. The code unconditionally
indexed `parsed.choices[0]`, which throws exactly this error on a chunk
that has no `choices`. `loop.ts`'s own delta callback had the same
unguarded assumption one level up (`chunk.choices[0]?.delta` — the
optional chaining protects the property read *after* the index, not the
index into `undefined` itself).

Fixed both: `streamChat()` now recognizes an error-shaped chunk and throws
a real, readable `Error` with the backend's own message (so it still
correctly triggers the context-overflow auto-recovery above when that's
the cause), and skips any chunk that isn't actually array-shaped `choices`
instead of assuming it always is. `loop.ts`'s callback was hardened
defensively too (`chunk.choices?.[0]?.delta`), since `ModelBackend` is an
interface other implementations could satisfy differently.

Covered by two new tests against a fake raw-SSE server: one serving a
normal partial delta followed by a mid-stream error chunk, asserting
`chat()` rejects with a message containing the actual backend error text
(not the previous opaque crash); one confirming a normal, error-free SSE
stream still completes and assembles correctly (no regression).

### Scenario stress test: simulating dozens of developers, long-running

Every bug documented above was found live, one at a time, by a real person
hitting it. Asked directly why there were so many, and to build a
synthetic scenario testing many long-running developer sessions against a
fake (not real llama.cpp) backend instead — `src/agent/scenario.test.ts`
runs 60 concurrent simulated "developers" (independent `AgentLoop`
instances, each with their own temp project directory), 40 turns each,
against a fake backend cycling through realistic tool usage: `read_file`,
`run_shell` (including deliberately failing commands), `write_file`,
`edit_file` (including against text that was never actually there —
a routine real failure, not an edge case), `update_plan`, an unconfigured
`browser_list_tabs` call, replies carrying both `content` and `tool_calls`
at once, and a genuinely oversized (50,000-char) tool result — plus a
realistic (size-triggered, not arbitrary) injected context-overflow error
partway through. Real tools execute for real against each developer's own
directory; only the model is fake. The assertion: none of this should ever
produce an unhandled crash, and every injected overflow should be fully
auto-recovered, not reported as a final error.

It immediately found two more real bugs, neither previously reported live:

- The forced-compaction retry (added above) capped itself at exactly one
  retry per turn. A single long tool-calling turn — many chained tool
  calls before the model finally stops and answers, which is completely
  normal — can legitimately hit context overflow *more than once* before
  the turn ends, with compaction genuinely succeeding each time. The flat
  one-retry cap treated the second occurrence as if the mechanism had
  failed and permanently ended the turn, even though nothing was actually
  stuck. Fixed by retrying based on whether compaction is *measurably
  shrinking* the conversation (checked directly via `estimateTokens`
  before/after each forced compaction) rather than a fixed count, with a
  generous hard cap (8) purely as a last-resort safety net.
- `capToolResult`'s cap (24,000 characters, ~6k tokens) was a fixed
  absolute constant, independent of the actual configured context window.
  On a smaller-context deployment, a single large tool result could by
  itself equal or exceed the *entire* window, making that conversation
  permanently unrecoverable — no amount of compacting older messages can
  ever free up room a single current message already fully occupies.
  Scaled the cap to a fraction of the real context window instead
  (`toolResultCharCap()`), keeping the previous 24k as an upper bound for
  the common large-context case.
- A related, deeper structural bug the above led straight to:
  `runCompaction`'s "kept tail" (the most recent messages, kept verbatim
  instead of summarized) was `messages.slice(-6)` — a fixed *message
  count*, not a size budget. If those 6 happen to be individually large
  (routine in a tool-heavy turn), the tail alone can already be at or past
  the entire window, so compaction could summarize away every single
  older message and still show *zero* measurable progress — silently
  defeating the entire compaction mechanism regardless of how much older
  history there was to reclaim. Replaced with `selectKeptTail()`, which
  walks back from the most recent message accumulating real size against
  a budget (40% of the context window) instead of a fixed count — always
  keeping at least the single most recent message even if it alone
  exceeds the budget (there's no better option at that point).

Two new focused unit tests cover the tail-sizing fix directly: kept-tail
size actually shrinks under a small window vs. a large one (proving it
tracks the real budget, not some unrelated fixed limit), and the tail
always includes at least the most recent message even when that alone
blows the budget. The scenario test itself passed cleanly across repeated
runs afterward (60 developers × 40 turns, ~6.5s) once both fixes landed —
and stays in the suite going forward as a standing regression net, not a
one-off.

### Scenario test extended across languages and program types — found a real hang risk

Asked directly to extend the scenario to cover many different languages
and program types, not just uniform `.txt` content — the scenario now
assigns each simulated developer one of six real profiles (Python/Flask
API, Go gRPC service, Rust CLI, TypeScript/Node web server, Java Spring
service, Ruby batch pipeline), each with its own file extension, sample
source, and *real* toolchain commands (`python3 -m py_compile`, `go vet`,
`cargo test`, `java -version`, etc.) actually executed via `run_shell`.

Running it immediately surfaced a real hang risk: `run_shell`'s
`execAsync()` call had **no timeout at all**. In production, that means
any command the model asks it to run that blocks — a network stall, a
process waiting on stdin, a genuinely long-running build/test — hangs the
*entire agent loop* forever with no way to recover. This is very plausibly
the actual explanation behind more than one earlier "seems stuck?" report
in this project, not just the other, already-diagnosed bugs. Separately
(found while fixing the above and confirming what `run_shell` actually
runs against): its `cwd` was hardcoded to `process.cwd()` — the whole CLI
process's own working directory, not necessarily the project actually
being worked on. It only ever happened to line up correctly because
`llamacli` is conventionally launched from inside the project directory;
nothing actually guaranteed it.

Fixed both in `tools/index.ts`: `run_shell` now passes a `timeout`
(`RUN_SHELL_TIMEOUT_MS`, 60s default, overridable for tests) to
`execAsync`, so a blocked command is killed and reported as a normal tool
error instead of hanging forever; and `executeTool()` now takes the real
`projectRoot` explicitly (threaded from `AgentLoop`) and uses it as `cwd`
instead of the implicit, coincidental `process.cwd()`. Covered by 3 new
focused unit tests: a genuinely blocking command (`sleep 30`) gets killed
near the configured timeout rather than the test hanging; a normal fast
command still completes correctly (no regression); and a command's actual
working directory is verified (via `pwd`) to be the passed project root,
not wherever the test process itself happens to run from.

The scenario test's own scale was tuned down afterward (24 developers × 20
turns, ~17s) — the earlier 60×40 scale passed correctly too (confirmed
directly, ~82s) but that slowdown came from real concurrent subprocess
spawning (JVM startups, etc.) under this many simultaneous real toolchain
calls, not a bug — the smaller scale keeps the suite fast for routine runs
while still exercising every language profile several times over.

### Slash menu could only be navigated with arrow keys, not typed

Found while restarting a real session end-to-end to re-verify everything
above: `/quit` typed as literal text (`/`, `q`, `u`, `i`, `t`, Enter)
didn't quit — pressing `/` opens the menu, and every key while it's open
went to a branch that only handled up/down/return/escape, silently
dropping every other keystroke. So the letters `q`/`u`/`i`/`t` did
nothing, and Enter selected whatever the arrow position already was
(index 0, `/help`), not `/quit`. Confirmed directly with a real pty
session against the live backend. Arrow-navigating to the right item
still worked correctly (this is how the earlier Ctrl-C fix's `/quit`
verification passed), but typing the command name — the obvious first
thing anyone would try — was a dead end.

Added real typing-to-filter, requested directly: any character typed
while the menu is open now filters `SLASH_MENU_ITEMS` by a case-
insensitive substring match against the command's name (`filterMenuItems()`
in `App.tsx`), resetting the highlighted selection to the top match;
backspace narrows/widens the filter (or closes the menu entirely once it
backspaces past the leading `/`); Enter selects whatever's currently
highlighted *within the filtered list*, and does nothing if nothing
matches, rather than crashing on an out-of-range index.

The one layout constraint this had to respect: the menu box's real
rendered height must stay exactly constant (`SLASH_MENU_ITEMS.length`
rows) no matter how many items the filter leaves — letting it shrink
would reintroduce the exact "menu height changing shifts everything below
it" ghosting bug fixed earlier, before typing-to-filter existed.
`SlashMenu.tsx` now always renders the full row count, padding with blank
rows (a single space, not an empty string — the empty-string-collapses-to-
zero-height bug from the markdown work applies here too) when fewer items
match.

Covered by 6 new unit tests on `filterMenuItems()` (empty query returns
everything, exact/partial/substring/case-insensitive matches, no match
returns empty rather than falling back to all commands), plus direct pty
verification against the real backend: typing `/qu` correctly narrowed the
menu to just `/quit` and `/queue` (both genuinely contain "qu") with the
menu box still exactly 8 rows tall, and pressing Enter on the top match
exited cleanly (exit code 0).

### Plan/todo progress now persists on every update, and shows live in the status bar

Proposed directly: write a todo list before starting a multi-step task,
check items off as work proceeds, show progress ("step N of M")
persistently, and — the actual concern behind the proposal — make sure a
force-killed session doesn't lose that list, and that starting a new task
doesn't silently wipe one still in progress.

The infrastructure for this already existed (`checkpoint.json`,
`steps: [{description, status}]`, `buildResumePrompt()`) but had a real
gap: it was only ever written when a *compaction* happened
(`compact()` → `runCompaction()` → `writeCheckpoint()`). A session that
called `update_plan` and was then killed — Ctrl-C at the OS level, a
crash, a power loss — before any compaction ever triggered lost the whole
plan with nothing to resume from, exactly the scenario raised.

Fixed in `loop.ts`: `applyStateTool()`'s `update_plan` handler now writes
a checkpoint immediately on every call (`reason: "plan-progress"`, a new
`Checkpoint` reason alongside `"auto-threshold"`/`"manual"`), independent
of compaction — best-effort, so a write failure there can't break the
tool-call response the model is waiting on. It's cleared automatically
once every step is `"done"` (checked at the natural end of a turn with no
further tool calls) rather than lingering to confuse an unrelated future
task; a plan left genuinely incomplete stays on disk on purpose, for the
next process to pick up. `buildResumePrompt()` now distinguishes *why*
it's resuming — `"resuming previous session"` for a plain plan-progress
checkpoint vs. the existing `"resuming after compaction"` — since saying
"after compaction" for a session that was just killed mid-task would be
actively misleading about why the agent seems to be picking up
mid-conversation.

A `done, total` count is now surfaced through a new `onPlanProgress`
callback, wired through to a small fixed-width slot in the status bar
(`StatusBar.tsx`) — "3/7" persists there for as long as the plan is
active, instead of the plan only ever being visible as one line that
scrolls by in the log. It's reserved space regardless of whether a plan
is active (a blank slot, not an absent one) so starting/finishing a plan
mid-session never shifts the cwd/model fields next to it — the same
"layout must never change based on transient state" principle behind
`App.tsx`'s fixed `logHeight`. On a narrow terminal (<60 columns) the slot
is hidden entirely instead, rather than forcing cwd/model to squeeze for
it (caught directly by a test: reserving it unconditionally pushed a
40-column terminal's real total row width past 40).

Covered by 5 new `AgentLoop` tests (a checkpoint exists mid-turn with no
compaction ever having triggered; an incomplete plan survives to the end
of a turn; progress events fire correctly including the final `(0, 0)` on
completion; a plan-progress checkpoint resumes with its own wording) and 3
new `StatusBar` tests (the "N/M" formatting, falling back to blank instead
of overflowing the reserved slot for a pathological plan, and the narrow-
terminal slot-hiding threshold). Verified end-to-end against the real
backend in a throwaway project: declared a 3-step plan (status bar showed
`0/3`), hard-killed the process with `SIGKILL` (not a graceful `/quit`) mid-task,
confirmed the checkpoint survived on disk with the right steps, restarted
the process, and confirmed it resumed automatically with the correct
"resuming previous session" wording, the right remaining steps, and `0/3`
restored in the status bar.

### Live monitoring found two more real issues: a lax overflow safety margin, and a permanently-tripping circuit breaker

Asked directly to analyze real monitoring data (throughput/accuracy) from
a live session and check for improvement opportunities. Generation speed
(~40 t/s), prompt-processing speed (~200 t/s), and error rate (0 in 1,081
log lines / 102 requests) were all healthy — but the analysis surfaced two
real, unrelated issues.

**1. `autoTriggerRatio`'s default (0.85) left no real safety margin.**
Worked out from the numbers, then confirmed against real usage that
reached 89% of the window in one live turn: the worst case for a single
turn is `autoTriggerRatio` (when the threshold check last passed) *plus*
the `max_tokens` fraction of the window a single reply can add before the
*next* check (loop.ts caps `max_tokens` at 25% of the window). With the
old default, `0.85 + 0.25 = 1.10` — a single turn could overshoot the real
context window by up to 10%, relying on the context-overflow auto-retry
(added earlier) far more than it should need to be relied on. Lowered
`DEFAULT_CONFIG.compaction.autoTriggerRatio` to `0.70` (`config.ts`),
leaving `0.70 + 0.25 = 0.95` — real margin under 100% even in the worst
case. Covered by a test asserting this invariant directly (`autoTriggerRatio
+ 0.25 < 1.0`) rather than just a fixed default value, so a future change
to either number can't silently reopen the gap.

**2. The self-healing circuit breaker's 30-minute "hard timeout" never
reset — ever.** Caught live, directly from a real session: after being
open longer than 30 minutes (completely normal for an interactive coding
session), the very next tool call hit `[stopped] self-healing circuit
breaker tripped: hard timeout exceeded (1800000ms)`. Root cause in
`selfHeal.ts`/`loop.ts`: `CircuitBreaker` is constructed once per
`AgentLoop` — i.e. once per process — and its `startedAt` timestamp is set
once, in the constructor, and never touched again anywhere. `shouldStop()`
measures elapsed time since THAT moment (process/session startup), not
since the current task began. `reset()` existed on the class but was never
called from anywhere. The practical effect: once a session had been open
30+ minutes, literally every subsequent tool call for the rest of that
process's life would trip the same way — the entire session's ability to
use tools was permanently broken until restarted, with no recovery except
quitting. Fixed by calling `this.breaker.reset()` at the start of both
`send()` and `resumeIfCheckpointExists()` — the intent of a "hard timeout"
is to catch one runaway task/turn stuck looping for 30+ minutes straight,
not to cap how long a session itself can stay open, so the clock (and the
repetitive-call-detection window) now restarts fresh on every new turn.

Covered by a test using `node:test`'s `mock.timers` to simulate 31 minutes
passing between two turns and assert the second one isn't tripped — and,
since an earlier version of this same test passed even with the bug still
present (its scripted backend responses ran out for an unrelated reason
before ever reaching the second timeout check, silently masking the real
assertion), it also asserts the exact number of backend calls made, to
guard against that exact class of vacuous test happening again. Verified
directly: temporarily disabling the `reset()` calls reproduced the precise
real error message from the live session, confirming the test actually
catches the regression, not just that it passes with the fix applied.

### No scrollback, a mangled markdown table, and how the table fix actually works

Two related UI reports. First, directly: no way to scroll back and see
earlier output — a known, accepted trade-off from switching to the
terminal's alternate screen buffer (needed for reliable absolute cursor
positioning) is that it also disables the terminal's own native
scrollback. Added an in-app scrollback instead (`App.tsx`): Up/Down arrow
and Page Up/Down (repurposed — both are otherwise unused while typing a
normal message) scroll the fixed-height log box, with a one-row indicator
(`── ↑ scrolled up N lines · ↓/PageDown to return to live ──`) appearing
at the top while scrolled, and automatically snapping back to the live
tail the moment you send a new message (so you're never left having to
scroll back down manually to see your own reply). The one-row indicator
is reserved from the log box's own always-constant `logHeight` — the
outer box's height still never changes, the same principle every earlier
layout fix here depends on — not appended past it, which would reopen the
"total content exceeds the fixed layout height" bug class fixed
repeatedly before.

Second, reported directly with a screenshot: a markdown table rendered
with mangled, disjointed borders in a real terminal. Root cause, found by
reading marked-terminal's own source: its `width` option — which
`renderMarkdown()` already receives and uses for prose reflow — is never
actually forwarded to `cli-table3`, the library it delegates table
rendering to. A table row reaches the wrap step as one long, real-terminal-
width-unaware ANSI-colored line, and wrapping it — even correctly,
without tearing escape codes — still destroys a table's visual structure:
half a cell's border ends up on one line, the rest orphaned on the next
with nothing lining up, which is exactly the disjointed look in the
report. `cli-table3` has no "fit to an overall width" option either —
only explicit per-column widths, which would need knowing each table's
actual column count ahead of render time.

Fixed with a new `wrapPreservingTables()` (`textWidth.ts`): a table row
(detected by the presence of any of its box-drawing characters,
`┌┐└┘├┤┬┴┼─│`) is *clipped* instead of wrapped when it's too wide —
kept from the left, whatever doesn't fit is dropped — which degrades far
more gracefully (missing right-hand columns, but what IS shown still
looks like a real table) than wrapping ever could. Non-table lines still
wrap normally. `App.tsx`'s assistant-message rendering now uses this
instead of a plain `wrapAnsiSafe()`.

Verified against the real backend in a throwaway project: asked for a
real markdown table comparing three languages, confirmed every border
character lines up correctly across rows in the actual rendered terminal
screen (captured and replayed through `pyte`), with the table cleanly
clipped rather than corrupted where it ran past the terminal width. Also
verified the scrollback itself end-to-end: filled a small (15-row)
terminal past capacity, confirmed Page Up revealed earlier content with
the scroll indicator showing the correct line count, and Page Down
returned exactly to the original live view. Covered by new unit tests for
both `wrapPreservingTables` (clips a table row, still wraps prose
normally, preserves ANSI codes on the clip, leaves an already-fitting row
unchanged) and `renderMarkdown` (still produces valid table output —
border characters and all cell values — across a range of widths, since
the actual width constraint now happens one layer up).

### max_tokens silently ignored for streaming requests — a runaway response pinned the slot for 17 minutes

Caught live, watching a real session's logs: a real request with
`max_tokens: 16384` kept streaming anyway, past 45,000 tokens, only
stopping once it physically ran out of the entire 65,536-token context
window (`truncated = 1`) — nearly 17 minutes pinning the single inference
slot on one response, during which every other request queued behind it
indefinitely.

This looked at first like the earlier `max_tokens` fix (capping every
request at 25% of the window — see above) hadn't actually worked, but
direct reproduction narrowed it further: a `stream: false` request with
the identical `max_tokens` correctly stopped with `finish_reason:
"length"`; the exact same request with `stream: true` did not. `max_tokens`
genuinely isn't honored for **streaming** requests on this llama.cpp
build — a streaming-only gap in the backend itself, not something
adjustable from llamacli's side, and not a case of the earlier fix being
wrong; the cap being sent was always correct, the server just wasn't
respecting it for this request shape.

Since the backend can't be trusted to stop on its own, `openaiClient.ts`'s
`streamChat()` now enforces `max_tokens` itself: it counts streamed delta
events as a token-count proxy (llama.cpp emits one SSE chunk per generated
token in the normal case), and once that count reaches `max_tokens`, calls
`AbortController.abort()` on the request — ending the connection outright
rather than continuing to wait — and reports `finish_reason: "length"` to
match what a real cap would have produced, so nothing downstream needs to
know the server itself didn't enforce it.

Verified directly against the real backend, live: a prompt designed to
run away (count to 100,000) with `max_tokens: 20` now stops at exactly 20
streamed deltas in under 2 seconds, instead of running unbounded; a normal
short reply still completes correctly with `finish_reason: "stop"` (not
tripping the cap). Covered by 2 new unit tests against a fake server that
streams indefinitely until the client disconnects: one confirms the
response is cut at exactly `max_tokens` deltas, `finish_reason: "length"`,
and completes in well under a second — proving an actual early abort, not
a lucky fast server — the other confirms an unbounded stream is consumed
in full when no `max_tokens` is set at all (no regression).

### A hung browser tab could block a tool call — and the whole turn — forever

Asked directly to audit the logs/code for more stability gaps after the
above. Found by proactively checking `browser.ts` for the same class of
bug just fixed twice already (`run_shell`'s missing timeout, the
streaming `max_tokens` gap): a CDP command's response promise
(`session.send()` in `browser.ts`) had no timeout at all. If the browser
tab crashed, hung, or the connection otherwise just stopped responding
mid-session — without an actual WebSocket-level error event, which is
exactly how a stalled-but-still-open connection behaves — the promise
never resolved or rejected, hanging that tool call, and the entire agent
turn waiting on it, forever.

Fixed by giving every CDP command its own timeout (`CDP_TIMEOUT_MS`,
15s default, exported for tests to shrink), matching the connection-open
step, which already had one. Covered by a new test using a fake CDP
WebSocket server (via the `ws` package, added as a devDependency) that
accepts the connection but deliberately never replies to anything —
confirming a tool call actually times out near the configured bound
(verified: fires at ~311ms against a 300ms cap) instead of hanging.

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
>
> ### 크래시 수정: 백엔드/컴팩션 네트워크 실패로 프로세스가 죽던 문제
>
> 스크린 레코딩으로 발견: `.llamacli/config.yaml`이 없는 디렉토리에서 `llamacli`를
> 실행하면 아무것도 안 떠 있는 기본 백엔드 URL로 폴백되는데, 이때 `ECONNREFUSED`가
> 잡히지 않은 예외로 전체 Node 프로세스를 그대로 죽여버렸음. 이제 `AgentLoop`가 메인
> chat 요청과 컴팩션 요약 요청 양쪽 모두를 캐치해서 크래시 대신 `[error]`/`[compaction
> failed]` 상태 메시지로 전환한다(체크포인트는 요약 요청 *전에* 이미 디스크에 저장되므로
> 요약이 실패해도 데이터 손실 없음). `index.tsx`의 `onSubmit`과
> `resumeIfCheckpointExists()` 호출부에도 이중 방어용 try/catch를 추가함. 영상에 나온
> 정확한 에러 문구로 재현한 뒤, 빌드된 전역 명령을 실제 pty로 구동해 수정 확인함.
> `src/agent/loop.test.ts`로 커버됨.
>
> ### 레이아웃 수정: 슬래시 메뉴가 화면을 넘쳐서 잔상이 남던 문제
>
> 두 번째 스크린 레코딩으로 발견: 처음 실행 후 슬래시 메뉴를 열면, 앱의 상태바
> 아래쪽 박스 바깥에 글자 하나가 잔상처럼 남아 보였음. 원인 — `App.tsx`의 바깥
> `Box`는 `height={rows}`로 고정돼 있지만 `logHeight`는 상수(`rows - 6`)로 계산돼
> 슬래시 메뉴 자체가 차지하는 행 수(둥근 테두리 위+아래 + 항목당 1줄, 약 10줄)를
> 전혀 반영하지 않았음. 메뉴가 열리면 전체 콘텐츠가 `rows`를 초과해 실제 터미널이
> 스크롤되고, 메뉴가 닫혀 콘텐츠가 다시 줄어들어도 그 스크롤이 깔끔히 복구되지
> 않아 잔상이 남음(PROMPT.md §6이 요구하는 "팝업 닫히면 잔상 없이 복구" 요건과
> 정확히 충돌). 메뉴가 열려있을 때 `logHeight`를 메뉴의 실제 높이만큼 줄이고,
> 바깥 `Box`에도 `overflow="hidden"`을 추가해 이 계산이 다시 조금이라도 어긋나도
> 전체 콘텐츠가 터미널 높이를 절대 넘지 않도록 이중 안전장치를 걸어 수정.
>
> ### 백엔드 자동 감지: 죽은 기본 포트를 그냥 찍던 문제 해결
>
> 같은 영상에서 메시지를 보내도 어떤 모델에도 도달하지 못하는 것도 확인됨:
> `.llamacli/config.yaml`이 없으면 하드코딩된 기본 백엔드 URL(127.0.0.1:8081)로
> 폴백하는데, 실제로 다른 포트에 서버가 떠 있는 이 기기에서조차 그 포트엔 아무것도
> 없었음. 이제 `loadConfig()`가 rule/skill에 이미 쓰던 것과 같은 패턴(§5)을 따른다:
> 설정이 없으면 흔한 로컬 포트(`src/backend/detect.ts` 참고 — llama-server의 기본
> 8080, 예전 기본값 8081, Ollama의 11434)를 탐색해 실제 OpenAI 호환
> `/v1/models`에 응답하는 서버를 찾고, 찾으면 그걸 가리키는
> `.llamacli/config.yaml`을 자동 생성하며 무엇을 찾았는지 `[setup]` 상태 메시지로
> 알려준다. 아무 데도 없으면 여전히 플레이스홀더 설정을 쓰고 그 사실을 명확히
> 알린다(조용히 잘못 찍지 않음). 사전 설정이 전혀 없는 디렉토리에서 실행해
> 실제로 이 기기의 실행 중인 서버를 찾아 수동 설정 없이 연결되는 것까지 확인함.
> `src/backend/detect.test.ts`, `src/config.test.ts`로 커버됨.
>
> ### 입력줄 줄바꿈 수정: 같은 잔상 버그가 긴 입력줄로도 재현됨
>
> 세 번째 영상에서, 슬래시 메뉴를 아예 열지 않았는데도 위와 같은 잔상 버그가 여전히
> 재현됨. 원인 — 입력줄의 `<Text>{input}</Text>`에 폭 제한이 전혀 없어서, 타이핑한
> 텍스트가 터미널 폭보다 길어지면 Ink가 잘라내는 대신 여러 줄로 줄바꿈했음. 이건
> 메뉴 때와 정확히 같은 "전체 콘텐츠가 고정된 레이아웃 높이를 초과" 오버플로우이며,
> 팝업 대신 긴 한 줄이 트리거였을 뿐임 — 다시 줄어들 때(백스페이스, 혹은 한 줄로
> 다시 줄어들 때) 같은 방식으로 잔상이 남음. `string-width`로 실제 터미널 표시
> 폭을 측정해서(한글 등 wide 문자는 1이 아니라 2칸을 차지하므로 단순 `.length` 기준
> 자르기로는 여전히 넘칠 수 있음) 항상 한 줄에 들어가는 만큼의 꼬리 부분만 렌더링하고,
> 잘렸으면 앞에 `…`을 붙이도록 수정 — 일반적인 한 줄짜리 터미널 입력창과 동일한 동작.
> 입력줄 박스에도 `height={1}`과 `overflow="hidden"`을 백스톱으로 추가함. 검증: 210자
> 짜리 줄도 더 이상 한 줄을 넘지 않음(얼마나 길어지거나 어떻게 편집되든). `src/tui/textWidth.test.ts`로
> 커버됨.
>
> (조사 중 사용되지 않는 `uuid` 의존성도 함께 제거함 — 보안 권고가 열려있었는데 코드
> 어디서도 실제로 import된 적이 없었음.)
>
> ### 진짜 근본 원인 발견: 렌더링 후 터미널 커서가 입력줄로 이동하지 않고 있었음
>
> 사용자가 말로 직접 알려준 것: 타이핑한 글자가 프롬프트 영역이 아니라 화면 좌측
> 하단에 나타난다는 것. Ink가 쓰는 *raw 바이트*를(보이는 렌더링 결과가 아니라) 직접
> 캡처해서 위 세 번의 잔상 버그 신고 뒤에 숨어있던 진짜 원인을 찾음:
> **Ink는 렌더링 후 실제 터미널 커서를 절대 되돌리지 않는다.** 매 프레임마다 Ink는
> 전체 UI를 위에서 아래로 쓰고, 마지막 줄(StatusBar) 바로 아래의 빈 줄에 커서를 그대로
> 남겨둔다 — 사용자가 실제로 타이핑하고 있는 입력줄로 다시 올라가지 않는다. 한글 등
> CJK 입력을 담당하는 데스크톱 IME(fcitx/ibus)는 자신의 조합 팝업을 Ink가 그린 화면이
> 아니라 *실제* 커서 위치에 앵커링하므로, 이전의 오버플로우/잔상 수정과 무관하게
> 조합 중인 글자가 계속 화면 좌측 하단에 나타난 것 — 정확히 신고하신 그대로.
>
> 같은 raw 캡처에서 추가로 발견: `StatusBar`도 입력줄/슬래시 메뉴와 똑같이 폭 제한이
> 없는 버그가 있었음 — cwd/model 조합이 길면 2번째 줄로 줄바꿈되면서, 커서 수정이
> 의존하는 "고정된 행 간격" 가정 자체가 깨지고 있었음. 잘라내기 로직을 공용
> `src/tui/textWidth.ts`로 분리해서 `StatusBar`(`src/tui/StatusBar.tsx`의
> `statusBarFieldWidth`)에도 적용해 이제 항상 정확히 한 줄로 고정됨.
>
> 1차 시도: 매 렌더링 후 커서를 2줄 위로(빈 트레일러 줄 + 한 줄로 고정된 StatusBar 줄)
> 올리고 입력 텍스트 바로 뒤 컬럼으로 이동시킴(`\x1b[2A\x1b[<col>G\x1b[?25h`). 합성 pty
> 테스트에서는 정확히 맞았지만, 이어진 **실제** GNOME Terminal 녹화에서는 한 줄 아래로
> 어긋나서 StatusBar의 cwd 텍스트와 눈에 띄게 겹쳐버림. "Ink의 writer가 어디서 끝나든
> 거기서 N줄 위로"라는 가정 자체가 터미널/Ink 내부 쓰기 패턴에 따라 이식성이 없었던
> 것 — 한 환경에서 아무리 정확히 측정해도 고정 오프셋을 추측하는 전략 자체가 틀렸음.
>
> **터미널과 무관하게 항상 맞는 방식으로 교체**: 실제 커서를 옮기는 대신, Ink 자신의
> 출력 일부로 커서를 명시적으로 그린다 — 입력 텍스트 바로 뒤에 반전 비디오 공백을
> 추가(`<Text inverse> </Text>`). Ink가 그 문자를 실제로 그리는 자리가 곧 입력 위치이며,
> 이는 구조적으로 항상 맞다 — Ink가 아래에 몇 줄을 남기든 추측할 필요가 없음. raw
> 출력으로 검증: "hello"를 입력하면 입력줄이 정확히 `hello\x1b[7m \x1b[27m`로 끝남 —
> 반전 비디오 블록이 타이핑한 텍스트 바로 뒤에 붙음. IME 조합 팝업의 앵커링 문제(앱
> 차원에서 손댈 수 없는 더 깊은 터미널/IME 차원의 한계)까지 고치진 못하지만, 실제로
> 물어본 "내가 타이핑한 게 어디로 가는가"에는 항상 정확한 답을 줌. 실제 터미널 리사이즈
> (SIGWINCH) 직후에도 정확한 것 확인함. `src/tui/StatusBar.test.ts`,
> `src/tui/textWidth.test.ts`로 커버됨.
>
> ### Alternate screen buffer: 진짜 근본적인 문제를 마침내 고침
>
> 후속 신고 내용이 정확했다: "프롬프트가 좌측 하단 쉘 구석에서 시작해서, 타이핑한
> 글자가 입력 상자 아래에 찍힌다." 이건 단순 커서 오프셋 버그보다 더 근본적인 걸
> 가리켰음 — Ink가 전용 화면으로 전환한 적이 없어서, 터미널 뷰포트의 맨 위가 아니라
> 셸 커서가 launch 시점에 우연히 있던 그 행에서부터 그리고 있었음. 고정된 원점이
> 없으면 *어떤* 절대 좌표 계산도 신뢰할 수 없고, 이전 수정이 썼던 상대 좌표 계산조차
> 측정할 고정 기준점이 없었던 것.
>
> 이번엔 제대로 고침: `index.tsx`가 렌더링 전에 터미널의 **alternate screen
> buffer**(`\x1b[?1049h`, vim/htop/less가 쓰는 것과 같은 메커니즘)로 전환하고,
> 모든 종료 경로(`/quit`, Ctrl-C, 처리 안 된 에러, 정상 종료)에서 단일
> `process.on("exit", ...)` 핸들러 + 시그널 핸들러로 원래 화면을 복원함. 이제 1행이
> 항상 고정되고 알려진 원점이 됨을 보장함. 앱의 전체 렌더링 높이가 매 프레임 확실히
> 일정하다는 사실(위에서 메뉴/입력줄/상태바 오버플로우 버그를 전부 고쳤으므로)과
> 결합하면, 입력줄의 위치는 이제 Ink의 writer가 어디서 끝나는지 관찰해서 추측할
> 대상이 아니라 앱 자체의 레이아웃 계산으로 완전히 *계산 가능*해짐. 반전 비디오
> 가짜 커서를 그 레이아웃 계산에서 직접 나온 진짜 **절대** 좌표
> (`\x1b[<row>;<col>H`)로 교체함.
>
> raw 출력으로 end-to-end 검증: 40행 터미널에서 "hi"를 입력하면 정확히
> `\x1b[36;6H\x1b[?25h`가 나옴 — 36행은 `logHeight(34) + 구분선(1) + 1`과,
> 6번째 컬럼은 `패딩(1) + 스피너(1) + 공백(1) + "hi"폭(2) + 1`과 독립적으로 계산한
> 공식과 정확히 일치. 25×90으로 실제 리사이즈한 뒤에도 재검증: `\x1b[21;10H`가
> 다시 재계산된 공식과 정확히 일치함. `/quit`이 `\x1b[?1049l`을 정확히 내보내
> 원래 셸 화면을 아무것도 남기지 않고 복원하는 것도 확인함.
>
> ### 이번 버그의 진짜 범인: 슬래시 메뉴가 아래 요소들을 통째로 밀어냄
>
> 다섯 번째 신고에서 실제 픽셀을 확대해보니 "셀"이라는 글자가 입력 박스 테두리 줄에
> 그대로 남아있었음. 근본 원인: 메뉴가 열려있을 때만 `logHeight`가 메뉴 높이만큼
> 줄어들었고, 그래서 메뉴를 열면 입력 박스와 상태바 행이 한 프레임 안에서 ~10행씩
> 아래로 밀렸다가, 닫으면 다시 위로 밀림 — Ink의 증분 diffing이 "밀려나간 자리"의
> 이전 내용을 항상 완전히 지우지는 못해서, 정확히 관찰된 그 자리에 잔재가 남았던 것.
>
> 첫 시도: 메뉴를 `position="absolute"` 오버레이로 그려서 로그 박스 높이에 아예
> 영향을 안 주게 함. Ink 4.x에서는 이게 **동작하지 않음** — `position: absolute`는
> Yoga position 타입만 설정할 뿐 실제 오프셋은 전혀 없음(Ink의 `Styles` 타입에
> top/left/right/bottom 자체가 없음, `node_modules/ink/build/styles.js`를 직접
> 읽어 확인). 대신 `marginTop`으로 오프셋을 주니 메뉴의 렌더링 결과가
> `overflow: hidden` 경계에 잘리는 대신 그 밖으로 밀려나가 실제 터미널이 스크롤됨 —
> raw 바이트 캡처로 메뉴가 상태바보다 훨씬 아래, 화면 밖에 그려지는 걸 직접 확인.
>
> **최종 수정**: 메뉴의 전체 높이(`SLASH_MENU_ITEMS.length + 2`)를 열려있든 아니든
> 레이아웃에 **항상 고정으로 예약**함 — 이제 열고 닫는 건 크기가 절대 안 변하는 박스
> 안의 콘텐츠 변경(`<SlashMenu>` 렌더링 vs 아무것도 안 그림)일 뿐이라, 그 아래
> 요소들이 움직일 필요 자체가 없음. 메뉴가 닫혀있을 때 로그 영역과 입력 박스 사이에
> 빈 공간이 보이는 실제 트레이드오프가 있지만, Ink가 특정 방식으로 동작하길 기대하는
> 게 아니라 "절대 잔상 없음"을 무조건적으로 보장하는 유일한 방법이었음.
>
> raw 커서 위치 바이트로 검증: 입력 박스의 커서 행(예: `\x1b[38;...H`)이 메뉴를
> 열기 전/열려있는 동안/닫은 후 전부 바이트 단위로 동일함 — 컬럼만 타이핑한 글자를
> 따라 바뀜. 닫은 후 프레임이 어디에도 잔재 없이 완전히 깨끗한 것도 확인.
>
> ### 추가로 고친 것: 입력창이 실제로는 자기 테두리 안에 있지 않았음
>
> 별도로 직접 신고받은 내용: "입력창은 선으로 그려진 박스 안의 영역이야" — 화면에
> 보이는 테두리 사각형이 순전히 장식용(빈 `<Box borderStyle="single" />` 구분선)일
> 뿐이었고, 실제로 타이핑한 텍스트는 그 박스 안이 아니라 아래의 테두리 없는 별도
> 행에 그려지고 있었다는 지적. 스피너와 입력 텍스트를 자식으로 갖는 실제 테두리
> `Box` 하나로 합쳐서, 이제 테두리가 실제로 타이핑하는 자리를 눈에 보이게 감싸도록
> 고침.
>
> ### 같은 오버플로우 버그가 숨어있던 마지막 자리: 줄바꿈 안 된 로그 줄
>
> 실제 응답에 이상한 글자가 섞인 것으로 신고됨(`...입니다!m월 %d일 %A\""}`가 답변에
> 그대로 붙어 나옴). 같은 질문을 실제 모델에 직접 재현해보니 모델이 스트리밍하는
> 실제 콘텐츠 자체는 완전히 깨끗해서 모델 품질 문제는 배제됨. 진짜 원인: `logHeight`
> 행 예산이 로그 항목(도구 호출 JSON, 긴 assistant 문단, 상태 메시지) 하나를 항상
> 정확히 1행으로 취급했지만, 그 폭에는 아무 제한이 없었음 — 긴 줄(`run_shell` 도구
> 호출 인자에서 아주 흔함)은 Ink가 알아서 줄바꿈하는데 이게 예산 계산에 전혀
> 반영이 안 돼서, 실제 행 수가 일시적으로 예산을 초과했음. 입력줄/상태바/슬래시
> 메뉴에서 이미 고쳤던 것과 정확히 같은 "전체 콘텐츠가 고정 레이아웃 높이를 초과"
> 버그 클래스 — 이게 마지막으로 숨어있던 자리였음.
>
> 범용 `wrapToWidth()`(`src/tui/textWidth.ts`, 기존 `tailToWidth()` 옆에 추가)로
> 수정 — diff(이미 자체 줄 분리 로직이 있었음)뿐 아니라 **모든** 로그 줄 종류를 실제
> 터미널 폭 기준으로(디스플레이 폭 인식 줄바꿈) 감싸서, `logHeight`의 항목별 계산이
> 항상 정확하도록 함. 좁은(70컬럼) 터미널에서 여러 번 재시도한 긴 `run_shell` 도구
> 호출 줄이 여러 행으로 줄바꿈되는 실제 모델 응답으로 검증 — 최종 답변이 잔재 섞임
> 없이 완전히 깨끗하게 렌더링됨. `src/tui/textWidth.test.ts`로 커버됨.
>
> ### 컴팩션 크래시: 엄격한 백엔드가 요약 요청을 거부함
>
> 세션 도중 실시간으로 신고됨: `[compaction failed] chat failed: 400
> {"error":{"message":"Cannot continue an assistant message that contains
> tool calls."}}`. 근본 원인: `runCompaction`의 `toSummarize =
> messages.slice(0, -6)`가 tool call 턴 경계를 전혀 고려하지 않고 고정된 개수로
> 자름 — 자르는 지점이 하필 `tool_calls`를 가진 assistant 메시지 바로 뒤이고, 그에
> 대응하는 `tool` 역할 응답은 유지된 tail 쪽에 남는 경우, 요약 요청(일반 non-tool
> completion 호출)이 매달린 tool call로 끝나버림. 최소 한 개의 실제 백엔드가 이걸
> 그대로 거부함.
>
> `sanitizeForSummary()`로 수정: 요약 요청에 들어가는 모든 `tool_calls`/`tool`
> 역할 메시지를 평범한 서술 텍스트로 변환함(예:
> `[called tool run_shell with {"command":"date"}]`) — 슬라이스를 턴 경계에 맞추려는
> 시도는 정확한 메시지 개수 패턴에 의존하므로 취약해서 대신 이 방식을 택함. 실제
> 백엔드로 직접 테스트하다가 같은 백엔드에서 두 번째 제약도 드러남 — "끝에 assistant
> 메시지 2개 이상 불가" — tool call 메시지를 role:"assistant"로 변환하면 바로 앞의
> assistant 메시지 뒤에 붙어버릴 수 있기 때문. 변환으로 생긴 연속된 같은 역할 메시지를
> 병합해서 수정. 실제로 실패했던 정확한 메시지 개수 패턴으로 실제 백엔드에 대고
> 재검증함. `src/compaction/compactor.test.ts`로 커버됨.
>
> ### 에이전트가 멈춘 건지 계속 진행 중인 건지 알 수 없음
>
> 위 컴팩션 실패 출력을 그대로 인용하며 후속 신고됨: "진행중인지 멈춘건지
> 모르겠네". 실제 공백: 컴팩션이 턴 도중 도구 호출 배치를 중단시키면(컴팩션 자체가
> 성공했든 실패했든) 턴이 그냥 끝나버림 — 유일하게 표시되는 메시지는 `compact()`가
> 남긴 것뿐인데, 실패 시에는 "턴이 끝났다"는 말이 전혀 없음. 바깥에서 보면 멈춰버린
> 것과 구분이 안 됨.
>
> 조사하다가 추가로 발견: 세션 도중 컴팩션이 남긴 체크포인트는 지금까지
> `resumeIfCheckpointExists()`(프로세스 시작 시 딱 한 번만 실행)로만 다시 집어드는
> 구조였음 — 같은 세션 안에서 새 메시지를 입력하면, 체크포인트가 디스크에 그대로
> 있는데도 중단됐던 작업의 맥락이 조용히 사라져버렸음.
>
> 둘 다 수정: 이런 식으로 배치가 중단될 때마다 `[turn ended] Compaction
> interrupted this task. It'll pick back up automatically with your next
> message.`라는 명시적 상태 메시지를 추가했고, `send()`가 이제 시작 시점뿐 아니라
> **매번** 대기 중인 체크포인트를 확인해서 재개 맥락을 끼워 넣도록 함.
> `src/agent/loop.test.ts`에 새 테스트 2개로 커버됨 — 하나는 `[turn ended]` 메시지
> 확인, 다른 하나는 연속으로 `send()`를 두 번 호출해서 두 번째 요청이 실제로 중단된
> 작업의 맥락을 포함하는지 확인(총 74개 테스트 전부 통과).
>
> ### 로그 영역이 하단이 아니라 상단에 붙박여 있던 문제
>
> 직접 신고됨: 글씨가 화면 상단 근처에만 나타나고 하단까지 전혀 안 내려온다는 것.
> 원인: 로그 `Box`가 Ink 기본값인 상단 정렬을 쓰고 있어서, 대화가 짧으면(줄 수가
> `logHeight`보다 적으면) 콘텐츠가 상단에 몰리고 그 아래로 입력 박스까지 이어지는
> 점점 커지는 빈 공간이 생겼음 — 최근 출력이 입력하는 자리 바로 옆에 있어야 하는
> 일반적인 스크롤 터미널/채팅 UI와 정반대. 로그 `Box`에 `justifyContent="flex-end"`를
> 줘서 수정 — 이제 남는 빈 공간이 콘텐츠 *아래*가 아니라 *위*에 생김. 검증: 짧은
> 메시지 하나를 보내면 이제 40행 터미널 상단 어딘가가 아니라 입력 박스 바로 위에
> 렌더링됨.
>
> (별개로 같은 메시지에서 터미널 자체의 우측 스크롤바가 더 이상 동작하지 않는다는
> 것도 언급하셨음. 이건 이전 수정에서 켠 alternate screen buffer의 본질적인
> 트레이드오프임 — vim, htop, less도 정확히 같은 한계가 있는데, 전용 alt-screen은
> 정의상 터미널의 일반 스크롤백에 포함되지 않기 때문. llamacli는 현재 이를 보완할
> 자체 인앱 스크롤백(Page Up/Down)이 없음 — 이건 버그 수정이 아니라 진짜 새 기능이라,
> 원하시면 후속 작업으로 진행할 만함.)
>
> ### tool-call 템플릿 태그가 원본 응답에 새는 문제
>
> 세션 도중 실시간으로 신고됨: 응답 끝에 `</parameter>\n</function>\n</tool_call>`라는
> 리터럴 텍스트가 그대로 보임. llamacli를 완전히 우회해서 실제 백엔드로 직접 재현 —
> 적당히 복잡한 `run_shell` 요청을 보내니 **원시** API 응답 자체에 이미 leak된 태그가
> `message.content`에 들어있어서, llamacli 자체의 SSE 파싱 버그가 아님을 확인함. 모델이
> 가끔 llama-server의 그래머 제약 tool-calling 모드를 제대로 트리거하지 못하고, 대신
> 자기 파인튜닝 챗 템플릿의 일부를 평범한 텍스트로 그대로 뱉어내는 것. 확률적으로
> 발생함 — 똑같은 프롬프트가 한 번은 재현됐다가 연속 세 번은 깨끗하게 나옴 — 그리고
> 시도마다 다른 두 종류의 태그 어휘가 관찰됨(Hermes 스타일
> `tool_call`/`function`/`parameter`, Anthropic 스타일 `invoke`/`parameter`) — 그래서
> SSE 스트림 파싱 방식을 바꿔서 고칠 수 있는 문제가 아님.
>
> `stripToolCallTemplateLeak()`(`src/agent/textSanitize.ts`)로 완화: 실시간 스트리밍
> 표시(`App.tsx`, 매 청크마다 *누적* 텍스트 전체에 다시 적용 — 태그가 여러 개의 작은
> 청크로 쪼개져 도착할 수 있으므로)와 대화 기록에 저장되는 최종 메시지(`AgentLoop`,
> 새어나간 태그가 문맥에 남아 다음 턴에서 같은 패턴을 강화하지 않도록) 양쪽에서 좁은,
> tool-calling 전용 태그 어휘만 제거함. 일반 XML/HTML이 아니라 의도적으로 좁게 잡아서,
> 사용자가 실제로 붙여넣는 `<div>`/`<span>` 등의 콘텐츠는 건드리지 않음. 테스트는 실제
> 백엔드에서 캡처한 정확한 leak 문자열을 그대로 사용함. `src/agent/textSanitize.test.ts`
> 로 커버됨(총 85개 테스트 전부 통과).
>
> ### 메뉴 공간 예약이 새로운 영구 공백을 만듦
>
> 다시 직접 신고됨(같은 "상단 고정 출력 영역" 관련): 공백이 존재하고 텍스트가
> 프롬프트 입력까지 내려오지 않는다는 것. 원인: 메뉴 열고 닫을 때 잔상이 생기던
> 이전 수정(아래 참고)이 슬래시 메뉴의 전체 높이를 **별도의** 박스로 열려있든
> 아니든 항상 예약해뒀음 — 잔상 문제는 해결했지만, 메뉴가 닫혀있을 때(거의 항상)
> 로그와 입력 박스 사이에 보기 흉한 ~10줄짜리 공백이 생겨버림.
>
> 이번엔 제대로 고침: 로그 영역의 바깥 `Box`는 항상 정확히 `height={logHeight}`로
> 고정된 채 유지하되(아래에 있는 게 절대 안 움직임 — 잔상 수정은 그대로 보존), 그
> 고정된 공간 *안에서* 렌더링되는 내용만 바꿈 — `visibleLogRows`가 메뉴가 열려있을
> 때만 메뉴 높이만큼 줄어들어서, 메뉴가 별도의 영구 예약 공간을 갖는 대신 로그
> 콘텐츠와 같은, 절대 크기가 안 바뀌는 박스를 공유함. pty로 검증: 메뉴가 닫혀있을 때
> 로그 콘텐츠가 이제 공백 없이 입력 박스 바로 위에 붙고, 메뉴가 열려있을 때도 입력
> 박스 바로 위에 깨끗하게 렌더링되며, 다시 닫아도 잔상이 없음 — 그 직후 실제
> assistant 응답이 정상적으로 렌더링되는 것까지 확인함.
>
> ### Ctrl-C가 앱 전체를 종료시키던 문제
>
> 직접 신고됨: 일부 터미널/사용자에게는 Ctrl-C가 인터럽트가 아니라 복사이고,
> 어느 쪽이든 llamacli를 죽이면 안 됨. 원인: Ink의 `render()`가 기본값으로
> `exitOnCtrlC: true`를 씀 — Ctrl-C를 누르는 순간 앱 자체 코드와 무관하게 Ink가
> 스스로 앱 전체를 무너뜨림. `index.tsx`의 `render()`에 `{ exitOnCtrlC: false }`를
> 넘기고, `App.tsx`의 `useInput`에서 `Ctrl-C`를 명시적으로 아무것도 안 하도록
> 처리해서 수정(일반 "이 문자를 추가" 분기로 흘러가게 두면 타이핑 중이던 내용에
> raw 제어 바이트가 그대로 삽입되어버림). `/quit`이 여전히 유일한 종료 방법임.
> pty로 검증: Ctrl-C를 연속 3번 눌러도 프로세스가 살아있고 완전히 정상 동작함(새
> 입력 받고 메시지 전송도 됨), 입력줄에 이상한 문자도 안 남음; 이후 `/quit`도
> 여전히 깔끔하게 종료됨.
>
> ### llama.cpp로 보내는 요청 크기에 상한이 전혀 없던 문제
>
> 실제 llama-server 로그를 계속 실시간 분석해달라는 요청에 따라 작업하던 중
> 세션 도중에 직접 발견함: `GET /slots`를 확인하니 요청 하나가 22,000토큰을
> 넘도록 끝날 기미 없이 계속 생성 중이었고, 단일 추론 슬롯(`-np 1`)을 계속
> 점유해서 다른 모든 요청을 무기한 막고 있었음. 겹쳐진 원인 두 가지를
> `loop.ts`에서 모두 수정:
>
> - 백엔드로 보내는 모든 채팅 요청에 `max_tokens`가 아예 지정되지 않고 있었음.
>   llama-server의 기본값은 `-1`(무제한)이고, `repeat_penalty`도 사실상
>   꺼져있어서 정지 토큰을 못 만나면 생성이 눈에 띄게 실패하는 대신 그냥
>   영원히 계속됨. 이제 모든 요청이 설정된 컨텍스트 윈도우의 25%(최소
>   512)로 `max_tokens`를 상한함 — 한 번의 응답치고는 넉넉하지만 절대
>   무제한은 아님.
> - 도구 실행 결과 하나(예: 큰 파일의 `read_file`, 출력이 많은 셸 명령) 역시
>   크기 제한이 없어서, `executeTool()`의 원본 전체 내용이 그대로 메시지
>   기록에 들어가고 거기서 다시 상한 없이 다음 요청 본문에 그대로 실림.
>   이제 `capToolResult()`가 도구 결과 하나를 약 24,000자(대략 6천 토큰)를
>   넘으면 잘라내고, `[...truncated: N more characters omitted]` 표시를
>   명시적으로 남겨서 모델이 실제보다 적은 내용을 본 것처럼 조용히 속지
>   않게 함.
>
> 실제 백엔드의 `/slots` 엔드포인트로 확인함(폭주 중이던 요청의
> `max_tokens`/`n_predict`가 둘 다 `-1`이었음 확인), 새 유닛 테스트 2개도
> 추가함: 요청 본문의 `max_tokens` 필드를 검증하는 것 하나, 50,000자짜리
> 파일을 만들어 백엔드로 실제 전달되는 도구 결과 메시지가 원본보다 짧고
> truncated 표시를 담고 있는지 검증하는 것 하나.
>
> ### 매 턴마다 컴팩션이 발동하던 문제: 설정 파일이 실제 서버와 어긋나 있었음
>
> 실제 세션 출력을 그대로 붙여넣은 신고로 발견함: `[compaction complete]`
> 바로 다음에 `[turn ended] Compaction interrupted this task`가 턴마다
> 계속 반복되고, 실제 작업은 하나도 끝나지 못함. 근본 원인: 프로젝트의
> `.llamacli/config.yaml`에 `contextSize: 8192`로 박혀있었는데, 실제로
> 대화하고 있던 `llama-server`는 `-c 65536`로 떠 있었음 — 8배 차이.
> `AgentLoop`는 이걸 알 방법이 없어서 설정값을 그대로 믿었고, 그 결과
> `autoTriggerRatio: 0.85`가 실제보다 8배 작은 컨텍스트 윈도우 기준으로
> 평가되면서 거의 매 턴마다 컴팩션이 필요하지도 않은데 즉시 발동해버림.
>
> 두 가지로 수정: 우선 당장은 설정값 자체를 바로잡았고, 설정 파일이
> 나중에 또 실제 서버와 어긋날 수 있으므로 — `OpenAICompatibleClient`에
> `getContextSize()`를 추가해서 llama.cpp 자체의 `/props` 엔드포인트
> (`default_generation_settings.n_ctx`)에서 실제 값을 읽어오게 함.
> `index.tsx`는 이제 시작 시 이 실제 값을 정적 설정값보다 우선하고,
> 이 엔드포인트가 없는 백엔드에서만 설정값(그다음 8192)으로 폴백함.
> 실제로 돌고 있는 서버로 직접 검증함(`getContextSize()`가 실제
> `/props` 출력과 일치하는 `65536`을 정확히 반환함), 가짜 `/props`
> 서버를 만들어 실제 응답 형태·`n_ctx` 없는 응답·비정상 응답 3가지를
> 다루는 새 유닛 테스트도 추가함 — 셋 다 엉뚱한 값을 조용히 반환하는
> 대신 폴백하는지 검증.
>
> ### assistant 텍스트에 색상/서식이 전혀 없던 문제 (Claude Code 자체 출력과 달리)
>
> 직접 신고됨: assistant 텍스트 어디에도 ANSI 색상이 없고, 코드 블록도 눈에 띄는
> 구분이 전혀 없음 — 모델이 실제로 어떤 마크다운을 만들었든 전부 흰 평문으로만
> 렌더링됨. `marked` + `marked-terminal`(`src/tui/markdown.ts`)을 통해 assistant
> 메시지를 렌더링하도록 고쳐서, 실제 헤딩·굵게/기울임·문법 강조된 코드 블록·리스트가
> 터미널에 제대로 나오게 함 — Claude Code 자체 CLI 출력과 비슷한 모양.
>
> 이걸 만드는 과정에서 실제 버그 2개가 드러났고, 둘 다 그냥 넘어가지 않고
> 테스트/직접 검증으로 잡음:
>
> - `marked-terminal`은 `chalk`를 통해 렌더링하는데, `chalk`는 자신이 처음
>   import되는 시점에 색상 출력 여부를 결정함. `import ... from "marked-terminal"`
>   같은 정적 import *다음에* `process.env.FORCE_COLOR`를 설정해도 조용히
>   아무 효과가 없었음 — ES 모듈 import는 호이스팅되므로, 이 모듈 자신의
>   최상위 코드가 실행되기 전에 marked-terminal(과 그게 내부적으로 만드는
>   chalk 인스턴스)이 이미 색상 여부를 결정한 채로 초기화를 끝내버림. 새
>   테스트 2개가 이걸 바로 잡아냄(렌더링이 그냥 안 죽는지가 아니라, 실제
>   출력에 ANSI 이스케이프 코드가 포함돼 있는지를 직접 검증). env 변수를
>   먼저 강제로 설정하고 그 다음에야 marked-terminal을 동적으로 import(최상위
>   `await import(...)`)하도록 고쳐서, chalk가 자기 초기화 시점에 이 값을
>   보게 함.
> - ANSI가 섞인 텍스트(마크다운 출력, 그리고 기존의 색깔 있는 diff)를 로그
>   영역의 기존 `wrapToWidth()`로 감싸면 내용이 깨짐 — 이 함수는 텍스트를
>   한 *글자*씩 순회하는데, 이러면 `\x1b[32m` 같은 이스케이프 시퀀스가 낱개
>   문자로 찢어지면서 코드 자체가 깨지고 그 조각들이 눈에 보이는 글자처럼
>   폭 계산에 잘못 들어감. 색깔 있는 diff를 예전엔 아예 줄바꿈 없이 그냥
>   그대로 출력했던 이유가 정확히 이것(대신 diff 자체가 넘칠 위험을 감수함).
>   `wrap-ansi` 패키지를 써서 이스케이프 시퀀스를 폭 0으로 취급하고 줄바꿈
>   지점마다 활성 스타일을 다시 열어주는 `wrapAnsiSafe()`(`src/tui/textWidth.ts`)를
>   추가하고, diff와 assistant 마크다운 렌더링 둘 다 이걸 쓰도록 바꿈.
>
> 세 번째 버그는 실제 마크다운 콘텐츠(블록 사이 빈 줄 구분이 잦음)가 로그
> 영역에 흐르기 시작하고 나서야 드러남: 화면에 글씨가 가득 찼는데도 상단에
> 공백 영역이 생긴다고 직접 신고됨. 최소 Ink 렌더로 직접 확인한 근본 원인:
> Ink에서 빈 문자열 `<Text>`는 다른 모든 줄과 달리 렌더링 높이가 **0**임 —
> 즉 줄바꿈된 빈 줄 항목 하나가 자기 몫의 한 행을 차지하는 대신 레이아웃에서
> 조용히 사라져버림. 그 결과 로그 박스의 실제 렌더링 높이가 고정된
> `logHeight` 예산보다 부족해지고, 이 박스가 `justifyContent="flex-end"`라서
> 그 부족분이 하단이 아니라 *상단* 공백으로 나타남. 이건 원래도 여러 줄짜리
> diff/상태 메시지에 빈 줄이 섞이면 항상 잠재돼 있던 위험이었는데, 그동안은
> 드물어서 안 보였을 뿐 — 마크다운이 이걸 일상적으로 만들어버림. 줄바꿈된
> 빈 줄에 빈 문자열 대신 스페이스 하나를 렌더링하도록 고쳐서 해결. 실제
> pty로 구동한 렌더로 검증함: 로그 영역 용량을 넘길 만큼 마크다운 콘텐츠를
> 채운 뒤 `pyte`로 실제 터미널 화면을 캡처해서, 로그 박스가 정말로 끝에서
> 끝까지 빈틈없이 채워져 있는 것을 확인함(그 캡처에서 유일하게 남아있던
> 빈 줄 하나는 렌더링 결함이 아니라 원본 마크다운 안의 진짜 빈 줄로 추적
> 확인됨), 색상도 전체에 걸쳐 제대로 나오는 것까지 확인함.
>
> ### 토큰 추정이 tool_calls를 조용히 무시해서 실제 사용량이 컨텍스트 윈도우를 넘던 문제
>
> 도구 호출이 많은 실제 프로젝트 세션을 그대로 붙여넣은 신고로 발견함: 연속된
> 두 턴이 둘 다 백엔드 자체의 `400 exceed_context_size_error`로 실패함 —
> `request (65,636 tokens) exceeds the available context size (65,536
> tokens)`, 바로 다음 턴에도 65,648에서 똑같이 실패. 그 사이에 아무것도
> 줄어들지 않아서 같은 크기의 과도한 대화 기록이 연달아 두 번 그대로
> 전송되고 둘 다 실패함 — 앱이 멈춘 것과 구분이 안 되는 상황.
>
> `compaction/compactor.ts`의 근본 원인: `estimateTokens()`/`shouldCompact()`가
> `message.content`만 보고 있었음. 도구 호출을 요청하는 assistant 메시지는
> `content: null`이고, 백엔드로 실제 전송되는 내용은 전부
> `tool_calls[].function.arguments`에 있음(`run_shell`이면
> `{"command": "..."}`, `read_file`이면 `{"path": "..."}` 등) — 이걸
> 추정치가 그냥 빈 값처럼 조용히 취급하고 있었음. 도구를 계속 호출하는
> 세션(정확히 이런 세션)에서는 이게 반올림 오차 수준이 아니라 실제 대화의
> 상당 부분을 통째로 못 세는 것이라서, 백엔드 자체의 하드 리밋이 반박할
> 때까지 `shouldCompact()`는 계속 "아직 여유 있음"이라고 보고함. tool_calls의
> 이름+인자를 토크나이저 기반 추정과 chars/4 폴백 추정 둘 다에 포함하도록
> 고침(`messageText()`).
>
> 독립적인 두 번째 방어층도 추가함: 어떤 추정치든 여전히 틀릴 수 있으므로(
> 나중에 추정에 반영 안 된 백엔드 필드, 토크나이저의 특이 케이스 등),
> `AgentLoop.runUntilIdle()`이 이제 백엔드 자체의 `exceed_context_size_error`를
> 정답으로 취급함 — 이 에러를 만나면 즉시 강제 컴팩션을 한 번 실행하고
> 요청을 한 번만 재시도함(턴당 재시도 1회로 제한해서, 컴팩션 후에도 여전히
> 너무 큰 메시지 하나가 무한 반복되지 않고 에러로 보고됨). 이제 추정치가
> 여전히 부정확하더라도 방금 실제로 겪은 것처럼 턴마다 같은 실패가 반복되진
> 않음.
>
> 새 테스트로 커버함: `estimateTokens`가 tool_calls 메시지의 인자를 제대로
> 세는지(content도 tool_calls도 없는 메시지는 여전히 0인 것과 대비), 오버플로우
> 한 번이 정확히 강제 컴팩션 1회 + 재시도 1회로 이어지고 그 재시도가
> 성공하는지 검증하는 턴 단위 테스트 하나, 재시도 후에도 *계속* 오버플로우가
> 나는 경우 무한 재시도 대신 에러로 보고되는지 검증하는 테스트 하나.
>
> ### 스트리밍 중 "Cannot read properties of undefined (reading '0')" 크래시
>
> 평범하게 작업하던 도중 직접 신고됨: 무슨 뜻인지 알 수 없는 크래시. `openaiClient.ts`의
> `streamChat()`의 근본 원인: 초기 HTTP 응답은 완전히 정상적인 `200 OK`일 수 있어서
> (기존 `res.ok` 체크는 통과함) 요청이 결국 실패하더라도 이건 못 잡음 — llama-server는
> 토큰 스트리밍을 정상적으로 시작했다가 생성 도중에야 컨텍스트 윈도우를 넘겼다는 걸
> (또는 다른 런타임 실패를) 뒤늦게 발견하고, 그 시점에 `choices` 필드가 아예 없는
> `{"error": {...}}` 형태의 SSE 데이터 청크를 보낼 수 있음. 코드가 조건 없이
> `parsed.choices[0]`을 인덱싱하고 있어서, `choices`가 없는 청크를 받으면 정확히 이
> 에러가 남. `loop.ts` 자체의 delta 콜백도 한 단계 위에서 같은 무방비 가정을 하고
> 있었음(`chunk.choices[0]?.delta` — optional chaining은 인덱싱 *다음의* 속성
> 읽기만 보호하지, `undefined`에 대한 인덱싱 자체는 못 막음).
>
> 둘 다 수정: `streamChat()`은 이제 에러 형태의 청크를 인식해서 백엔드 자체 메시지를
> 담은 진짜 읽을 수 있는 `Error`를 던짐(그래서 원인이 컨텍스트 초과일 때는 위의
> 자동 복구 로직도 여전히 정상적으로 발동함), 그리고 `choices`가 실제로 배열 형태가
> 아닌 청크는 항상 그렇다고 가정하는 대신 그냥 건너뜀. `loop.ts`의 콜백도 방어적으로
> 보강함(`chunk.choices?.[0]?.delta`) — `ModelBackend`는 다른 구현체가 다르게 만족시킬
> 수 있는 인터페이스이기 때문.
>
> 가짜 raw SSE 서버를 상대로 한 새 테스트 2개로 커버함: 정상적인 부분 delta 다음에
> 스트림 중간 에러 청크가 오는 경우를 흉내 내서 `chat()`이 (예전의 알 수 없는 크래시가
> 아니라) 실제 백엔드 에러 텍스트를 담은 메시지로 reject되는지 검증하는 것 하나,
> 에러 없는 정상 SSE 스트림은 여전히 정상적으로 완료되고 조립되는지(회귀 없음) 검증하는
> 것 하나.
>
> ### 시나리오 스트레스 테스트: 수십 명의 개발자가 장기 프로그래밍하는 상황 가상 시뮬레이션
>
> 위에 문서화된 버그들은 전부 실제 사람이 한 번에 하나씩 실제로 겪어서 발견된
> 것들임. "왜 이렇게 버그가 많냐"는 직접적인 질문과 함께, 실제 llama.cpp가 아닌
> 가상의(fake) 백엔드로 여러 개발자의 장기 세션을 시뮬레이션하는 테스트를
> 만들어달라는 요청을 받음 — `src/agent/scenario.test.ts`는 독립된 `AgentLoop`
> 인스턴스(각자 자기 임시 프로젝트 디렉토리를 가진) 60개를 동시에("수십 명의
> 개발자") 40턴씩("장기 프로그래밍") 돌리며, 가짜 백엔드가 현실적인 도구 사용을
> 순환시킴: `read_file`, `run_shell`(일부러 실패하는 명령 포함), `write_file`,
> `edit_file`(실제로 쓰인 적 없는 텍스트를 대상으로 하는 것도 포함 — 엣지 케이스가
> 아니라 흔한 실제 실패), `update_plan`, 설정 안 된 `browser_list_tabs` 호출,
> `content`와 `tool_calls`를 동시에 담은 응답, 그리고 진짜로 거대한(50,000자)
> 도구 결과까지 — 여기에 (임의가 아니라 실제 크기에 맞춰 발동하는) 컨텍스트
> 오버플로우도 중간중간 주입함. 도구는 각 개발자의 실제 디렉토리에서 진짜로
> 실행됨 — 가짜인 건 모델뿐. 검증 기준: 이 중 무엇도 처리되지 않은 크래시로
> 이어지면 안 되고, 주입된 모든 오버플로우가 최종 에러로 보고되는 대신 전부
> 자동 복구돼야 함.
>
> 실제로 이전에 신고된 적 없는 진짜 버그 2개를 바로 찾아냄:
>
> - (위에서 추가한) 강제 컴팩션 재시도가 턴당 정확히 1회로 상한돼 있었음. 모델이
>   결국 멈추고 답하기 전까지 도구 호출을 여러 번 연쇄하는 하나의 긴 턴은(완전히
>   정상적인 상황) 그 턴이 끝나기 전에 컨텍스트 오버플로우를 한 번 이상 정당하게
>   겪을 수 있고, 그때마다 컴팩션은 실제로 제대로 성공함. 고정된 1회 재시도
>   상한은 아무것도 실제로 막힌 게 없는데도 두 번째 발생을 마치 복구 메커니즘이
>   소진된 것처럼 취급해서 턴을 영구적으로 끝내버림. 고정 횟수 대신 컴팩션이
>   *실제로 측정 가능하게 줄어들고 있는지*(각 강제 컴팩션 전후로 `estimateTokens`를
>   직접 비교)를 기준으로 재시도하도록 고침, 순전히 최후의 안전장치로 넉넉한
>   하드 캡(8회)을 둠.
> - `capToolResult`의 상한(24,000자, ~6천 토큰)이 실제 설정된 컨텍스트 윈도우와
>   무관한 고정 절대값이었음. 더 작은 컨텍스트로 배포된 경우, 도구 결과 하나가
>   그 자체로 전체 윈도우와 맞먹거나 넘어설 수 있어서, 그 대화는 영구적으로
>   복구 불가능해짐 — 현재 메시지 하나가 이미 통째로 차지하고 있는 공간은 오래된
>   메시지를 아무리 압축해도 되찾을 수 없음. 실제 컨텍스트 윈도우의 일정 비율로
>   상한을 스케일링하도록 고침(`toolResultCharCap()`), 큰 컨텍스트(대부분의 실제
>   상황)에서는 기존 24k를 상한값으로 그대로 유지.
> - 위에서 바로 이어진, 더 근본적인 구조적 버그 하나: `runCompaction`의 "유지되는
>   꼬리"(요약하지 않고 그대로 남기는 최근 메시지들)가 `messages.slice(-6)` —
>   고정된 *메시지 개수*였지 크기 예산이 아니었음. 이 6개가 개별적으로 크면(도구
>   호출이 많은 턴에서는 흔함) 꼬리 자체만으로도 이미 전체 윈도우와 맞먹거나
>   넘어설 수 있어서, 오래된 메시지를 전부 요약해서 없애더라도 측정 가능한 진전이
>   *전혀* 없는 것처럼 보일 수 있음 — 되찾을 오래된 대화 기록이 얼마나 있든
>   상관없이 컴팩션 메커니즘 전체를 조용히 무력화시킴. `selectKeptTail()`로
>   교체함 — 가장 최근 메시지부터 거꾸로 훑으면서 고정 개수가 아니라 실제 크기를
>   예산(컨텍스트 윈도우의 40%)과 비교해서 누적함, 단 가장 최근 메시지 하나는
>   그것만으로 예산을 넘더라도 항상 유지함(그 시점에서는 더 나은 선택지가 없으므로).
>
> 새 유닛 테스트 2개로 꼬리-크기 조정 수정을 직접 커버함: 작은 윈도우 vs 큰
> 윈도우에서 유지되는 꼬리 크기가 실제로 달라지는지(엉뚱한 고정 한계가 아니라
> 진짜 예산을 따라가는지 증명), 가장 최근 메시지 하나가 예산을 그 자체로 넘더라도
> 항상 유지되는지. 시나리오 테스트 자체는 두 수정이 모두 반영된 뒤 반복 실행에서
> 깨끗하게 통과함(개발자 60명 × 40턴, 약 6.5초) — 그리고 일회성이 아니라 앞으로도
> 회귀를 막는 상시 테스트로 스위트에 계속 남음.
>
> ### 시나리오 테스트를 여러 언어/프로그램 종류로 확장 — 실제 행 위험 발견
>
> 균일한 `.txt` 콘텐츠만이 아니라 여러 언어와 프로그램 종류를 다루도록 시나리오를
> 확장해달라는 직접 요청. 이제 시뮬레이션되는 개발자마다 6개의 실제 프로필 중
> 하나를 배정받음(Python/Flask API, Go gRPC 서비스, Rust CLI, TypeScript/Node
> 웹 서버, Java Spring 서비스, Ruby 배치 파이프라인) — 각자 자기 파일 확장자,
> 샘플 소스 코드, 그리고 `run_shell`을 통해 실제로 실행되는 진짜 툴체인 명령
> (`python3 -m py_compile`, `go vet`, `cargo test`, `java -version` 등)을 가짐.
>
> 실행하자마자 진짜 행(hang) 위험을 바로 찾아냄: `run_shell`의 `execAsync()`
> 호출에 **타임아웃이 전혀 없었음**. 실제 운영에서 이건, 모델이 실행을 요청한
> 명령이 뭔가에 막히면(네트워크 지연, stdin 대기 중인 프로세스, 진짜로 오래
> 걸리는 빌드/테스트) 에이전트 루프 *전체*가 복구할 방법 없이 영원히 멈춘다는
> 뜻임. 이건 이 프로젝트에서 앞서 나온 "멈춘 거 같은데?" 신고들 중 하나 이상의
> 실제 원인이었을 개연성이 매우 큼 — 이미 진단해서 고친 다른 버그들만이 아니라.
> 별개로(위 수정을 고치면서 `run_shell`이 실제로 무엇을 대상으로 실행되는지
> 확인하다가 발견함): `cwd`가 `process.cwd()`로 하드코딩돼 있었음 — CLI 프로세스
> 자체의 작업 디렉토리이지, 실제로 작업 중인 프로젝트가 아님. `llamacli`가 관례상
> 프로젝트 디렉토리 안에서 실행되기 때문에 우연히 맞아떨어졌을 뿐, 실제로 보장된
> 적은 없었음.
>
> `tools/index.ts`에서 둘 다 수정: `run_shell`이 이제 `execAsync`에 `timeout`
> (`RUN_SHELL_TIMEOUT_MS`, 기본 60초, 테스트에서 오버라이드 가능)을 넘겨서, 막힌
> 명령은 영원히 멈추는 대신 죽여서 평범한 도구 에러로 보고함. `executeTool()`은
> 이제 실제 `projectRoot`를 명시적으로 받아서(`AgentLoop`에서 전달) `cwd`로 쓰지,
> 암묵적이고 우연적인 `process.cwd()`를 쓰지 않음. 새 유닛 테스트 3개로 커버함:
> 진짜로 막히는 명령(`sleep 30`)이 설정된 타임아웃 근처에서 죽는지(테스트 자체가
> 멈추지 않고), 평범하고 빠른 명령은 여전히 정상적으로 완료되는지(회귀 없음),
> 명령의 실제 작업 디렉토리가(`pwd`로) 전달된 프로젝트 루트인지 검증.
>
> 시나리오 테스트 자체 규모는 이후 하향 조정함(개발자 24명 × 20턴, 약 17초) —
> 앞서의 60×40 규모도 정상적으로 통과하긴 했음(직접 확인, 약 82초)이지만 그
> 느려짐은 이만큼 많은 실제 툴체인 호출을 동시에 실행할 때의 실제 동시 서브프로세스
> 생성 부하(JVM 기동 등) 때문이지 버그가 아니었음 — 더 작은 규모로도 각 언어
> 프로필을 여러 번 돌리면서 일상적인 실행에서는 스위트를 빠르게 유지함.
>
> ### 슬래시 메뉴가 화살표로만 탐색 가능했고 타이핑은 안 됐던 문제
>
> 위 수정 사항들을 전부 다시 검증하려고 실제 세션을 처음부터 재시작하는 과정에서
> 발견함: `/quit`를 글자 그대로 타이핑하면(`/`, `q`, `u`, `i`, `t`, Enter) 종료가
> 안 됨 — `/`를 누르면 메뉴가 열리고, 메뉴가 열려있는 동안의 모든 키 입력은
> 위/아래/엔터/이스케이프만 처리하는 분기로 가서 나머지는 전부 조용히 무시됨.
> 그래서 `q`/`u`/`i`/`t` 글자들은 아무 효과도 없었고, Enter를 누르면 그 시점의
> 화살표 위치(기본값 인덱스 0, `/help`)가 선택됐지 `/quit`이 선택되는 게 아니었음.
> 실제 백엔드로 pty 세션을 직접 띄워서 확인함. 화살표로 정확한 항목까지 탐색하는
> 건 정상 동작했음(이전 Ctrl-C 수정에서 `/quit` 검증이 통과했던 이유), 하지만
> 누구나 가장 먼저 시도할 법한 "명령어 이름을 그냥 타이핑하기"는 막다른 길이었음.
>
> 직접 요청받아 진짜 타이핑 필터링 기능을 추가함: 메뉴가 열려있는 동안 입력하는
> 모든 문자가 이제 `SLASH_MENU_ITEMS`를 명령어 이름 기준 대소문자 구분 없는
> 부분 문자열 매칭으로 필터링함(`App.tsx`의 `filterMenuItems()`), 선택 강조는
> 매번 최상단 일치 항목으로 리셋됨. 백스페이스는 필터를 좁히거나 넓힘(또는 맨
> 앞의 `/`까지 지우면 메뉴 자체를 닫음). Enter는 *필터링된 목록 안에서* 현재
> 강조된 항목을 선택하고, 아무것도 일치하지 않으면 범위 밖 인덱스로 죽는 대신
> 그냥 아무 동작도 하지 않음.
>
> 지켜야 했던 레이아웃 제약 하나: 메뉴 박스의 실제 렌더링 높이는 필터로 몇 개가
> 남든 정확히 고정(`SLASH_MENU_ITEMS.length`행)이어야 함 — 줄어들게 놔두면
> 타이핑 필터링이 생기기 전에 고쳤던 "메뉴 높이가 바뀌면 아래 요소들이 전부
> 밀린다"는 잔상 버그가 그대로 재발함. `SlashMenu.tsx`는 이제 일치 항목이
> 몇 개든 항상 전체 행 수를 렌더링하고, 부족한 만큼 빈 행(빈 문자열이 아니라
> 스페이스 하나 — 마크다운 작업에서 나온 "빈 문자열은 높이 0으로 붕괴" 버그가
> 여기도 그대로 적용됨)으로 채움.
>
> 새 유닛 테스트 6개로 `filterMenuItems()`를 커버함(빈 쿼리는 전체 반환,
> 정확히/부분적으로/부분 문자열로/대소문자 무시하고 일치, 일치하는 게 없으면
> 전체로 폴백하는 대신 빈 목록 반환), 여기에 실제 백엔드로 직접 pty 검증도
> 추가함: `/qu`를 타이핑하면 정확히 `/quit`과 `/queue`로만 좁혀지고(둘 다
> 진짜로 "qu"를 포함함) 메뉴 박스는 여전히 정확히 8행을 유지하며, 최상단
> 일치 항목에서 Enter를 누르면 깔끔하게 종료됨(exit code 0).
>
> ### 계획/todo 진행 상황이 이제 매번 업데이트마다 저장되고, 상태 표시줄에 실시간으로 나옴
>
> 직접 제안받음: 여러 단계짜리 작업을 시작하기 전에 todo 리스트를 먼저 작성하고,
> 진행하면서 항목을 체크해나가고, 진행 상황("N번째/전체 M개")을 계속 보이는 곳에
> 표시하고 — 제안의 실제 요지는 — 강제 종료된 세션이 그 목록을 잃어버리지 않게
> 하고, 새 작업이 시작될 때 진행 중이던 목록이 조용히 지워지지 않게 하는 것.
>
> 이걸 위한 인프라는 이미 존재했음(`checkpoint.json`, `steps: [{description, status}]`,
> `buildResumePrompt()`) — 하지만 진짜 공백이 있었음: 이게 *컴팩션*이 일어날 때만
> 기록됐음(`compact()` → `runCompaction()` → `writeCheckpoint()`). `update_plan`을
> 호출한 세션이 컴팩션이 한 번도 발동하기 전에 종료되면(OS 레벨 Ctrl-C, 크래시,
> 정전) 계획 전체를 잃어버리고 재개할 게 아무것도 없었음 — 정확히 이 제안이
> 짚은 상황.
>
> `loop.ts`에서 수정: `applyStateTool()`의 `update_plan` 핸들러가 이제 호출될
> 때마다 즉시 체크포인트를 기록함(`reason: "plan-progress"`, 기존
> `"auto-threshold"`/`"manual"` 옆에 추가된 새 `Checkpoint` reason), 컴팩션과
> 무관하게 — best-effort 방식이라 여기서 쓰기가 실패해도 모델이 기다리고 있는
> 도구 호출 응답 자체는 깨지지 않음. 모든 단계가 `"done"`이 되면(도구 호출 없이
> 턴이 자연스럽게 끝나는 시점에 체크) 자동으로 지워져서 관련 없는 다음 작업에
> 잘못 물려 들어가지 않도록 함; 진짜로 아직 안 끝난 계획은 의도적으로 디스크에
> 남겨서 다음 프로세스가 이어받을 수 있게 함. `buildResumePrompt()`는 이제 재개하는
> *이유*를 구분함 — 순수 plan-progress 체크포인트는 "resuming previous session",
> 기존의 "resuming after compaction"은 그대로 — 작업 중간에 강제 종료된 세션에게
> "컴팩션 이후"라고 말하면 왜 대화 중간부터 이어받는 것처럼 보이는지에 대해
> 실제로 오해를 살 수 있기 때문.
>
> `done, total` 카운트가 이제 새 `onPlanProgress` 콜백을 통해 나오고, 상태
> 표시줄(`StatusBar.tsx`)의 작은 고정폭 슬롯에 연결됨 — "3/7"이 계획이 활성
> 상태인 동안 계속 거기 남아있음, 로그에서 한 번 스크롤되고 사라지는 한 줄로만
> 보이는 대신. 계획이 활성인지 여부와 무관하게 항상 공간이 예약됨(빈 슬롯이지
> 없는 슬롯이 아님)이라서 세션 도중 계획이 시작되거나 끝나도 옆의 cwd/model
> 필드가 절대 밀리지 않음 — `App.tsx`의 고정된 `logHeight` 뒤에 있는 것과 같은
> "레이아웃은 일시적인 상태에 따라 절대 바뀌면 안 된다"는 원칙. 좁은 터미널
> (60컬럼 미만)에서는 이 슬롯을 아예 숨김 — cwd/model이 이걸 위해 억지로
> 쪼그라들게 하는 대신(테스트로 직접 잡아냄: 무조건 예약하면 40컬럼 터미널의
> 실제 전체 행 너비가 40을 넘어버림).
>
> 새 `AgentLoop` 테스트 5개로 커버함(컴팩션이 한 번도 발동하지 않은 채로 턴
> 중간에 체크포인트가 존재하는지, 미완료 계획이 턴이 끝날 때까지 살아남는지,
> 진행 이벤트가 올바르게 발생하고 완료 시 마지막에 `(0, 0)`이 오는지, plan-progress
> 체크포인트가 자기만의 문구로 재개되는지), 새 `StatusBar` 테스트 3개(“N/M” 포맷팅,
> 비정상적으로 큰 계획일 때 예약된 슬롯을 넘치는 대신 빈 값으로 폴백하는지, 좁은
> 터미널에서 슬롯을 숨기는 임계값). 실제 백엔드로 임시 프로젝트에서 엔드투엔드
> 검증함: 3단계 계획을 선언(상태 표시줄에 `0/3` 표시됨), 작업 도중 `/quit`이 아니라
> `SIGKILL`로 강제 종료, 체크포인트가 올바른 단계 상태로 디스크에 남아있는지 확인,
> 프로세스를 재시작해서 "resuming previous session" 문구·올바른 남은 단계·상태
> 표시줄의 `0/3`이 자동으로 복원되는지까지 확인함.
>
> ### 실시간 모니터링에서 진짜 문제 2개를 더 발견함: 느슨한 오버플로우 안전마진, 그리고 영원히 안 풀리는 회로차단기
>
> 실제 라이브 세션의 모니터링 데이터(속도/정확도)를 분석하고 개선 여지가 있는지
> 점검해달라는 직접 요청. 생성 속도(~40 t/s), 프롬프트 처리 속도(~200 t/s), 에러율
> (로그 1,081줄/요청 102건 중 0건) 전부 건강했음 — 하지만 분석 과정에서 서로 무관한
> 진짜 문제 2개가 드러남.
>
> **1. `autoTriggerRatio` 기본값(0.85)이 실질적인 안전마진을 전혀 남기지 않고 있었음.**
> 숫자로 계산해보고 실제 사용량이 라이브 세션 한 턴에서 윈도우의 89%까지 올라간 걸로
> 확인함: 한 턴의 최악의 경우는 `autoTriggerRatio`(마지막으로 임계값 체크를 통과한
> 시점) *더하기* 다음 체크 전까지 응답 하나가 추가할 수 있는 윈도우 비율
> (`loop.ts`가 `max_tokens`을 윈도우의 25%로 상한함). 예전 기본값으로는
> `0.85 + 0.25 = 1.10` — 한 턴이 실제 컨텍스트 윈도우를 최대 10%까지 초과할 수
> 있었고, (앞서 추가한) 컨텍스트 오버플로우 자동 재시도에 필요 이상으로 의존하게
> 됨. `DEFAULT_CONFIG.compaction.autoTriggerRatio`를 `0.70`으로 낮춤(`config.ts`),
> `0.70 + 0.25 = 0.95`로 최악의 경우에도 100% 아래로 실질적인 여유를 둠. 고정된
> 기본값 하나만 검증하는 대신 이 불변식 자체를 직접 검증하는 테스트로 커버함
> (`autoTriggerRatio + 0.25 < 1.0`) — 둘 중 하나가 나중에 바뀌어도 이 여유가 조용히
> 다시 사라지지 않도록.
>
> **2. 자가 치유 회로차단기의 30분 "하드 타임아웃"이 한 번도 리셋되지 않고 있었음.**
> 실제 세션에서 직접 잡아냄: 세션이 30분 넘게 켜져 있으면(대화형 코딩 세션에선
> 완전히 정상적인 상황) 바로 다음 도구 호출이 `[stopped] self-healing circuit
> breaker tripped: hard timeout exceeded (1800000ms)`에 걸림. `selfHeal.ts`/`loop.ts`의
> 근본 원인: `CircuitBreaker`는 `AgentLoop`당 한 번, 즉 프로세스당 한 번만
> 생성되고, `startedAt` 타임스탬프는 생성자에서 딱 한 번 설정된 뒤 다시는 건드려지지
> 않음. `shouldStop()`은 *그 시점*(프로세스/세션 시작) 이후 경과 시간을 재는 거지,
> 현재 작업이 시작된 시점 이후가 아님. `reset()` 메서드는 클래스에 존재했지만
> 어디서도 호출되지 않고 있었음. 실제 효과: 세션이 30분 넘게 켜져 있으면 그 뒤로
> 남은 프로세스 수명 동안 문자 그대로 모든 후속 도구 호출이 똑같이 걸림 — 세션의
> 도구 사용 능력 전체가 재시작 전까지 영구적으로 망가지고, 종료 외엔 복구 방법이
> 없었음. `send()`와 `resumeIfCheckpointExists()` 시작 부분에서 각각
> `this.breaker.reset()`을 호출하도록 수정 — "하드 타임아웃"의 원래 의도는 도구
> 호출 하나/턴 하나가 30분 넘게 계속 루프를 도는 걸 잡는 것이지 세션 자체가 얼마나
> 오래 켜져 있을 수 있는지를 제한하는 게 아니므로, 이제 매 새 턴마다 시계(그리고
> 반복 호출 감지 윈도우)가 새로 시작됨.
>
> `node:test`의 `mock.timers`로 두 턴 사이에 31분이 지나는 걸 시뮬레이션하고 두
> 번째 턴이 걸리지 않는지 검증하는 테스트로 커버함 — 그리고 이 테스트의 이전
> 버전은 버그가 그대로 있어도 통과했었기 때문에(스크립트된 백엔드 응답이 두 번째
> 타임아웃 체크에 도달하기 전에 무관한 이유로 바닥나서 실제 검증을 조용히
> 무력화시킴), 정확한 백엔드 호출 횟수까지 검증해서 같은 종류의 공허한 테스트가
> 다시 생기지 않도록 막음. 직접 검증함: `reset()` 호출을 일시적으로 비활성화하니
> 실제 라이브 세션에서 나온 바로 그 에러 메시지가 정확히 재현됐고, 이걸로 이
> 테스트가 수정을 적용했을 때 통과한다는 것뿐 아니라 회귀를 실제로 잡아낸다는
> 것까지 확인함.
>
> ### 스크롤백이 없던 문제, 깨진 마크다운 테이블, 그리고 테이블 수정이 실제로 작동하는 방식
>
> 관련된 UI 신고 두 건. 먼저 직접 신고: 예전 출력으로 되돌아가 볼 스크롤 방법이
> 없음 — alt-screen buffer로 전환한 것(안정적인 절대 커서 위치 지정에 필요)의
> 이미 알려진, 받아들인 트레이드오프로 터미널 자체의 네이티브 스크롤백도 같이
> 꺼지는 부작용이 있었음. 앱 자체 안에 스크롤백을 새로 추가함(`App.tsx`): 위/아래
> 화살표와 Page Up/Down(둘 다 평범한 메시지를 타이핑하는 동안엔 원래 안 쓰이는
> 키라 재활용) 키가 고정 높이 로그 박스를 스크롤하고, 스크롤 중일 땐 맨 위에
> 한 줄짜리 안내(`── ↑ scrolled up N lines · ↓/PageDown to return to live ──`)가
> 나타나며, 새 메시지를 보내는 순간 자동으로 라이브 하단으로 복귀함(자기가 보낸
> 메시지 보려고 수동으로 다시 스크롤 내릴 필요 없게). 이 한 줄짜리 안내는 로그
> 박스 자체의 항상 고정된 `logHeight` 안에서 확보됨 — 바깥 박스 높이는 여전히
> 절대 안 바뀜, 여기 있는 이전의 모든 레이아웃 수정이 의존하는 것과 같은 원칙 —
> 그 너머로 추가되는 게 아님(그랬다면 이전에 반복해서 고쳤던 "전체 콘텐츠가
> 고정 레이아웃 높이를 넘는다" 버그 종류가 다시 열림).
>
> 두 번째, 스크린샷과 함께 직접 신고: 실제 터미널에서 마크다운 테이블이 깨지고
> 흩어진 테두리로 렌더링됨. marked-terminal 자체 소스를 읽어서 찾은 근본 원인:
> `renderMarkdown()`이 이미 받아서 산문 리플로우에 쓰고 있는 `width` 옵션이,
> 테이블 렌더링을 위임받는 라이브러리인 `cli-table3`에는 실제로 전혀 전달되지
> 않고 있었음. 테이블 행 하나가 실제 터미널 너비를 전혀 모르는, 하나의 길고
> ANSI 색상이 입혀진 줄로 줄바꿈 단계에 도달하고, 그걸 줄바꿈하면 — 이스케이프
> 코드를 안 찢는 올바른 방식이라 해도 — 테이블의 시각적 구조 자체가 깨짐: 셀
> 하나의 테두리 절반은 한 줄에, 나머지 절반은 다음 줄에 아무것도 안 맞은 채
> 고아처럼 남음 — 신고에 나온 것과 정확히 같은 흩어진 모습. `cli-table3`에도
> "전체 너비에 맞추기" 옵션은 없음 — 명시적인 컬럼별 너비만 있는데, 이건 렌더링
> 시점 이전에 각 테이블의 실제 컬럼 개수를 알아야 함.
>
> 새 `wrapPreservingTables()`(`textWidth.ts`)로 수정: 테이블 행(박스 그리기
> 문자 `┌┐└┘├┤┬┴┼─│` 중 하나의 존재로 감지)은 너무 넓을 때 줄바꿈되는 대신
> *잘림* — 왼쪽부터 유지하고 안 맞는 부분은 버림 — 이게 줄바꿈보다 훨씬 더
> 우아하게 저하됨(오른쪽 컬럼들이 없어지긴 하지만, 보이는 부분은 여전히 진짜
> 테이블처럼 보임). 테이블이 아닌 줄은 여전히 정상적으로 줄바꿈됨. `App.tsx`의
> assistant 메시지 렌더링이 이제 단순 `wrapAnsiSafe()` 대신 이걸 씀.
>
> 실제 백엔드로 임시 프로젝트에서 검증함: 세 언어를 비교하는 진짜 마크다운
> 테이블을 요청해서, 실제 렌더링된 터미널 화면(캡처해서 `pyte`로 재생)에서
> 모든 테두리 문자가 행마다 정확히 맞춰지는 것과, 터미널 너비를 넘는 부분은
> 깨지는 대신 깔끔하게 잘리는 것까지 확인함. 스크롤백 자체도 엔드투엔드로
> 검증함: 작은(15행) 터미널을 용량 넘게 채우고, Page Up이 스크롤 인디케이터에
> 정확한 줄 수를 보여주면서 이전 콘텐츠를 드러내는지, Page Down이 정확히 원래
> 라이브 화면으로 복귀하는지 확인함. 새 유닛 테스트로 `wrapPreservingTables`
> (테이블 행을 자름, 산문은 여전히 정상적으로 줄바꿈, 자른 부분에서도 ANSI
> 코드 보존, 이미 맞는 행은 그대로 둠)와 `renderMarkdown`(실제 너비 제약은
> 이제 한 단계 위에서 일어나므로, 여러 너비에 걸쳐 여전히 유효한 테이블 출력 —
> 테두리 문자와 모든 셀 값 — 을 만드는지)를 커버함.
>
> ### 스트리밍 요청에서 max_tokens가 조용히 무시됨 — 폭주 응답 하나가 17분간 슬롯을 독점함
>
> 실제 세션 로그를 지켜보다가 직접 잡아냄: `max_tokens: 16384`로 보낸 실제
> 요청이 그래도 계속 스트리밍을 이어가서 45,000토큰을 넘겼고, 65,536토큰
> 컨텍스트 윈도우 전체를 물리적으로 다 채우고서야(`truncated = 1`) 멈춤 —
> 응답 하나에 단일 추론 슬롯이 거의 17분 동안 묶여있었고, 그동안 다른 모든
> 요청이 무기한 대기열에 쌓임.
>
> 처음엔 앞서 했던 `max_tokens` 수정(모든 요청을 윈도우의 25%로 상한하는 것 —
> 위 참고)이 실제로는 안 먹힌 것처럼 보였는데, 직접 재현해보니 범위가 더
> 좁혀짐: 똑같은 `max_tokens`를 넣은 `stream: false` 요청은 정확히
> `finish_reason: "length"`로 멈췄는데, 똑같은 요청을 `stream: true`로만
> 바꾸면 안 멈췄음. 이 llama.cpp 빌드에서 `max_tokens`가 **스트리밍** 요청에서는
> 정말로 지켜지지 않음 — 백엔드 자체의 스트리밍 전용 결함이라 llamacli 쪽에서
> 조정할 수 있는 부분이 아니고, 앞선 수정이 잘못됐던 것도 아님; 보낸 상한값
> 자체는 항상 맞았고, 서버가 이 요청 형태에서만 그걸 안 지켰던 것.
>
> 백엔드가 스스로 멈춘다고 믿을 수 없으므로, `openaiClient.ts`의
> `streamChat()`이 이제 `max_tokens`를 직접 강제함: 스트리밍되는 delta
> 이벤트 수를 토큰 수의 대용치로 셈(llama.cpp는 보통 생성 토큰 하나당 SSE
> 청크 하나를 보냄), 그 수가 `max_tokens`에 도달하면 요청에
> `AbortController.abort()`를 호출함 — 계속 기다리는 대신 연결 자체를 끊음 —
> 그리고 실제 상한이 적용됐을 때와 똑같이 `finish_reason: "length"`로
> 보고해서, 아래쪽 코드는 서버가 실제로 이걸 지켰는지 몰라도 되게 함.
>
> 실제 백엔드로 직접 라이브 검증함: 폭주하도록 설계한 프롬프트(10만까지
> 세기)를 `max_tokens: 20`으로 보내니 무제한으로 계속되는 대신 정확히 20개
> 스트리밍 delta에서 2초도 안 돼 멈춤; 평범한 짧은 답변은 여전히
> `finish_reason: "stop"`으로 정상 완료됨(상한에 안 걸림). 클라이언트가
> 연결을 끊을 때까지 무한정 스트리밍하는 가짜 서버를 상대로 한 새 유닛
> 테스트 2개로 커버함: 하나는 응답이 정확히 `max_tokens`개의 delta에서
> 잘리고 `finish_reason: "length"`이며 1초 훨씬 안에 완료되는지 확인(서버가
> 우연히 빨랐던 게 아니라 실제로 조기에 중단시켰다는 증거), 다른 하나는
> `max_tokens`를 아예 안 넣었을 때 무제한 스트림이 끝까지 전부 소비되는지
> 확인(회귀 없음).
>
> ### 멈춘 브라우저 탭이 도구 호출을, 그리고 턴 전체를 영원히 막을 수 있던 문제
>
> 위 작업 이후 로그/코드를 더 점검해서 안정성 강화 여지가 있는지 직접
> 요청받음. 이미 두 번 고친 것과 같은 종류의 버그(`run_shell`의 누락된
> 타임아웃, 스트리밍 `max_tokens` 갭)가 또 있는지 먼저 확인하다가
> `browser.ts`에서 발견: CDP 명령의 응답 Promise(`browser.ts`의
> `session.send()`)에 타임아웃이 전혀 없었음. 브라우저 탭이 크래시하거나
> 멈추거나, 연결이 그냥 응답을 멈추면(실제 WebSocket 레벨 에러 이벤트 없이 —
> 멈췄지만 여전히 열려있는 연결이 정확히 이렇게 동작함) 이 Promise는 절대
> resolve도 reject도 안 되고, 그 도구 호출과 그걸 기다리는 에이전트 턴 전체가
> 영원히 멈춤.
>
> CDP 명령 하나하나에 자체 타임아웃을 부여해서 수정(`CDP_TIMEOUT_MS`, 기본
> 15초, 테스트에서 줄일 수 있도록 export) — 이미 타임아웃이 있던 연결 시작
> 단계와 맞춤. 연결은 받아들이지만 무엇에도 절대 응답하지 않는 가짜 CDP
> WebSocket 서버(`ws` 패키지 사용, devDependency로 추가)를 이용한 새 테스트로
> 커버함 — 도구 호출이 실제로 설정된 시간 근처에서 타임아웃되는지 확인함
> (검증: 300ms 상한에 대해 약 311ms에서 발동), 멈추는 대신.

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

### Real-time analysis (not just on-demand)

Rather than waiting for `/improve` or session end, `AgentLoop` re-checks the
failure log immediately after every new tool/backend failure and, the first
time a pattern crosses the recurrence threshold, appends it to a running,
append-only journal — `.llamacli/state/improvement-log.md` — with an
`[auto-improve]` status line pointing at it. This is fire-and-forget
background analysis (it calls the model, so it must never block the
tool-call loop it's reacting to) and, critically, **writing to this log file
never changes agent behavior on its own** — it's a passive record, not a
rule, and not fed back into the system prompt. Turning a finding into an
actual rule still always requires the explicit `/improve` → `/improve-apply`
review flow above. Each recurring pattern (by its grouping signature, not
its growing occurrence count) is only logged once per session, so a
still-failing pattern doesn't spam the file on every subsequent occurrence.

**Deferred to after the turn, not fired mid-turn.** Asked directly to
analyze the real llama-server's own logs (`journalctl --user -u
llama-server.service`) for improvement points, and found one: this backend
only has a single inference slot (`-np 1`), and the log showed real cache
churn (`making room for prompt cache entry, removing oldest entry` — 18
evictions in an hour, ~38% of slot selections falling back to LRU instead
of reusing a cached prefix). The original implementation triggered the
improvement-check call immediately inside the tool-call loop, right after
logging a failure — meaning it could race the *same turn's own next
request* for that single slot and delay the user's response. Fixed by only
checking after the whole turn's `runUntilIdle()` loop has completed
(`hasNewFailuresThisTurn` flag, checked in `send()`/
`resumeIfCheckpointExists()`), so the background analysis call never
competes with an in-flight turn for the one available slot. Verified with
a test that tracks call ordering and asserts the improvement-check request
only ever appears after the turn's own final response.

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
>
> ### 실시간 분석 (수동 트리거만이 아님)
>
> `/improve`나 세션 종료를 기다리지 않고, `AgentLoop`가 새 도구/백엔드 실패가 발생할
> 때마다 즉시 실패 로그를 다시 확인해서, 어떤 패턴이 반복 임계치를 처음 넘는 순간
> 실시간·append-only 저널인 `.llamacli/state/improvement-log.md`에 기록하고
> `[auto-improve]` 상태 메시지로 알려준다. 이건 fire-and-forget 백그라운드 분석이라
> (모델을 호출하므로 반응 대상인 도구 호출 루프를 절대 막으면 안 됨) — 중요한 건
> **이 로그 파일에 쓰는 것 자체는 에이전트 동작을 전혀 바꾸지 않는다**는 것. 순수한
> 기록일 뿐 rule이 아니고 시스템 프롬프트에도 다시 주입되지 않는다. 실제 rule로
> 만들려면 여전히 위의 `/improve` → `/improve-apply` 검토 절차가 필요하다. 각 반복
> 패턴은 (계속 늘어나는 발생 횟수가 아니라 그룹핑 시그니처 기준으로) 세션당 한 번만
> 기록되므로, 계속 실패하는 패턴이 매번 파일을 도배하지 않는다.
>
> **턴 도중이 아니라 턴이 끝난 뒤로 미룸.** 실제 llama-server 자체 로그
> (`journalctl --user -u llama-server.service`)를 직접 분석해서 개선점을 찾아달라는
> 요청을 받고 하나를 발견함: 이 백엔드는 추론 슬롯이 1개(`-np 1`)뿐인데, 로그에 실제
> 캐시 스래싱이 보임(`making room for prompt cache entry, removing oldest entry` —
> 1시간에 18번 제거, 슬롯 선택의 ~38%가 캐시된 prefix 재사용 대신 LRU로 폴백). 원래
> 구현은 실패를 로그에 남긴 직후 도구 호출 루프 안에서 곧바로 개선 체크 호출을
> 트리거했음 — 즉 **같은 턴의 다음 요청**과 그 하나뿐인 슬롯을 두고 경쟁해서 사용자
> 응답을 지연시킬 수 있었음. 턴 전체(`runUntilIdle()` 루프)가 완전히 끝난 뒤에만
> 체크하도록 수정(`hasNewFailuresThisTurn` 플래그, `send()`/
> `resumeIfCheckpointExists()`에서 확인) — 이제 백그라운드 분석 호출이 진행 중인 턴과
> 하나뿐인 슬롯을 두고 절대 경쟁하지 않음. 호출 순서를 추적해서 개선 체크 요청이 항상
> 턴의 최종 응답 이후에만 나타나는지 확인하는 테스트로 검증함.

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
