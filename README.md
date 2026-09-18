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
