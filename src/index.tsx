#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadConfig } from "./config.js";
import { loadRules, loadSkillIndex, injectRulesIntoSystemPrompt, injectSkillIndexIntoSystemPrompt } from "./skills/loader.js";
import { SLASH_MENU_ITEMS } from "./tui/SlashMenu.js";
import { resolveBackend } from "./backend/resolve.js";
import { DeferredBackend } from "./backend/deferred.js";
import { AgentLoop, summarizeErrorForDisplay } from "./agent/loop.js";
import { configureBrowserTools, configureSkills } from "./tools/index.js";
import { isBrowserAvailable } from "./tools/browser.js";
import { loadPromptHistory, savePromptHistory } from "./tui/promptHistory.js";
import { readCheckpoint, clearCheckpoint } from "./compaction/checkpoint.js";
import { clearNotes } from "./compaction/notes.js";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { buildVersionString } from "./tui/banner.js";
import { checkAndApplyUpdate, spawnRestart } from "./selfUpdate.js";
import { getCapabilities, setTerminalCapabilities, buildSequences, withMouse, applyColorDepth } from "./tui/terminal.js";
import { copySelection, stripAnsiForCopy } from "./tui/selection.js";
import { getCursorPlacement } from "./tui/cursorPlacement.js";
import { KEY_BINDINGS, formatKeyRow } from "./tui/keybindings.js";
import { installCrashHandlers } from "./crashHandler.js";

const BASE_SYSTEM_PROMPT = `You are llamacli, a coding agent running on a local llama.cpp backend.
Always follow the fundamentals of a strong software architect: minimal diffs, respect existing
conventions, never make unverified changes, and confirm before destructive commands.

When starting a task that needs multiple steps, declare them with the update_plan tool, and
update each step's status (todo/in_progress/done) as it starts or finishes. This plan survives
context compaction, so work can resume accurately after it.

While investigating or debugging, call the note tool the moment you establish something worth
not re-deriving: a root cause, a verified fact, a dead end already ruled out. Do this as you go,
not only once told to — context compaction keeps only a summary of the conversation, but a note
survives it word for word.

If you need a one-off script to test or reproduce something, reuse the SAME filename for every
attempt (overwrite it) instead of a new incrementing name (test1.js, test2.js, ...), and delete
it once you are done with it. Leaving a trail of one-off scripts behind is a sign you are stuck
re-testing the same thing rather than making progress — if that is happening, use note and step
back instead of writing another one.`;

// Only appended when the browser tools are actually enabled (config.yaml's
// browser.enabled). Describing tools the model wasn't given is both
// confusing and a pure token cost — the point of the toggle is to stop
// paying for browser support in the (usual) sessions that never use it.
const BROWSER_SYSTEM_PROMPT = `

You can also remotely control a browser the user already has running with
--remote-debugging-port, via browser_list_tabs / browser_navigate / browser_eval /
browser_screenshot. These attach to an existing tab only — never assume a browser is running,
and never try to launch one yourself.`;

// Appended only when enableThinking is on — requested directly: reasoning
// is shown in the TUI (see App.tsx's "reasoning" log-line kind) as plain
// dim text with no language hint of its own, and the model's default
// reasoning language doesn't necessarily match what the user is typing in.
const THINKING_LANGUAGE_SYSTEM_PROMPT = `

Write your chain-of-thought reasoning in Korean (한국어). Your final answers and any text
inside tool calls (code, commands, file content) are unaffected by this — write those in
whatever language is otherwise correct for them.`;

/**
 * Switches to the terminal's alternate screen buffer (the same mechanism
 * vim/htop/less use) so the app always starts drawing at a stable (1,1)
 * origin, instead of wherever the shell's cursor happened to be when it
 * launched — a user reported the prompt appearing to "start from the
 * bottom-left shell corner," which traces back to this: without a
 * dedicated screen, Ink's layout is anchored to whatever row the terminal
 * was already scrolled to, not the top of the visible viewport. This also
 * makes ABSOLUTE cursor positioning (used in App.tsx to place the real
 * cursor exactly on the input line) reliable, since row 1 is now a fixed,
 * known reference point rather than an unknown offset into scrollback.
 * The original screen is restored on exit so nothing is left behind.
 *
 * Every sequence here comes from `buildSequences`, which emits "" for
 * anything the detected terminal can't take. That replaces the previous
 * single `if (!supportsAnsiTui()) return;` guard, because "ANSI works" never
 * implied "alt screen works" — and App.tsx's absolute cursor addressing is
 * only *meaningful* once this has succeeded, since rows are counted from the
 * top of the active buffer. Each capability is now asked about separately;
 * see terminal.ts.
 */
function enterAltScreen(): void {
  const seq = buildSequences(getCapabilities());
  // Mouse reporting is off by default now (see terminal.ts's `mouse` field):
  // enabling it means text selection requires holding Shift on nearly every
  // terminal — a silent cost paid for a convenience feature. It stays
  // reachable via `/mouse` (or LLAMACLI_MOUSE=1), and the wheel/click
  // handling is now also on the keyboard, so nothing is actually lost.
  //
  // Reported directly: "입력 프롬프트가 화면 제일 하단 좌측에 있는 경우도
  // 있고 하단이 갑자기 깜빡이는 경우도 있고" — App.tsx's own per-render
  // effect is what actually moves the cursor onto the input line (and
  // hides/shows it), but that effect only runs AFTER React's first paint.
  // Between switching to the alt screen and that first effect firing, the
  // real terminal cursor sits wherever Ink's own sequential top-to-bottom
  // writes happened to leave it — trailing the last line it printed, i.e.
  // bottom-left — fully visible and blinking there by the terminal's own
  // default, until our effect catches up and moves/hides it. `altScreenOn`
  // therefore ends with the cursor-hide, closing that window entirely: the
  // cursor stays hidden by default and only becomes visible again where
  // App.tsx's effect explicitly puts it, on the input line.
  // backgroundOn comes FIRST, before any box is drawn, so the very first frame
  // is already painted on black rather than flashing the terminal's own
  // background for one repaint.
  process.stdout.write(seq.backgroundOn + seq.altScreenOn + seq.mouseOn);
}

function exitAltScreen(): void {
  const seq = buildSequences(getCapabilities());
  // backgroundOff is NOT optional. Without it the black background outlives the
  // process and recolours the user's shell for the rest of the session — the
  // app is gone but its SGR state is not.
  process.stdout.write(seq.mouseOff + seq.altScreenOff + seq.backgroundOff);
}

/**
 * Returns a stdout-like object that re-asserts the prompt's cursor position
 * after every frame written through it.
 *
 * Ink needs a real stream (it reads `.columns`/`.rows` for layout and calls
 * `.on`/`.off` for resize), so this returns a proxy over the original rather
 * than a bare `{write}` stub — dropping those properties is what makes naive
 * wrappers produce a 0x0 layout or a resize crash.
 *
 * `write` appends the placement only when there is one registered, so the cost
 * while the app is idle is a single null check. The placement is read at write
 * time (not captured) so it always reflects the most recent prompt render.
 */
function wrapStdoutWithCursorReassertion<T extends NodeJS.WriteStream>(stdout: T): T {
  const original = stdout.write.bind(stdout);
  let reasserting = false;
  const patched = ((chunk: any, ...rest: any[]): boolean => {
    const result = original(chunk, ...rest);
    const placement = getCursorPlacement();
    if (placement && !reasserting) {
      // Guard against recursion: a write that itself triggers another write
      // (possible if stdout is a pipe being drained synchronously) would
      // otherwise re-enter here forever.
      reasserting = true;
      try {
        // The black background is re-asserted here, before the cursor
        // placement, for the same reason the cursor is. Ink emits a full SGR
        // reset (`\x1b[0m`) in the middle of frames, and SGR 0 resets the
        // default background along with everything else — so the black set at
        // startup is undone partway through the very first frame, and any cell
        // after that reset comes back on the terminal's own background.
        // Re-asserting at the end of every frame means the next frame starts
        // from black again.
        //
        // The background is read from buildSequences rather than hard-coded so
        // the color-depth fallback (16-colour SGR 40) stays in one place.
        original(buildSequences(getCapabilities()).backgroundOn + placement);
      } finally { reasserting = false; }
    }
    return result;
  }) as typeof stdout.write;
  // Object.create keeps the real stream as the prototype so `.columns`,
  // `.rows`, `.on`, `.off`, `.isTTY` and friends all still resolve, and only
  // `write` is shadowed.
  return Object.create(stdout, { write: { value: patched, configurable: true } });
}

/** A promise plus the function that settles it — used to hold backend
 *  resolution until the TUI is on screen, so its first log line has somewhere
 *  to go. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r as (value?: T) => void;
  });
  return { promise, resolve };
}

const REPO_URL = "https://github.com/jeano76/llamacli";

/** "vYYYYMMDD" — dist/index.js's own mtime (no separate build-info step
 *  exists to read a date from). Computed here (needs fs access) and handed
 *  to App, which renders the "HARNESS" wordmark itself as ASCII art plus
 *  this version line — see AppProps.startupBanner's doc comment for why
 *  it's not a raw pre-alt-screen stdout write (that was invisible in
 *  practice: reported directly, "최초 구동 로그가 나오지 않았어"). */
function startupVersion(): string {
  try {
    return buildVersionString(statSync(fileURLToPath(import.meta.url)).mtimeMs);
  } catch {
    // dist/index.js not found under this run mode (e.g. tsx dev) — banner
    // just omits the version rather than failing startup over it.
    return "";
  }
}

/** Requested directly: "CLI 구동시 신규 버전의 바이너리가 github에
 *  존재를 하면 해당 버전을 업데이트하고 cli는 재구동을 하는 기능을 넣어줘"
 *  — checked once, right at startup, before anything else touches the
 *  screen or the project. checkAndApplyUpdate() itself never installs
 *  anything that fails either hash check (see its own doc comment) — a
 *  failure here (offline, GitHub unreachable, hash mismatch) is silent and
 *  this process just continues running as-is, never blocking startup on a
 *  network call succeeding. Skipped entirely under `tsx` (dev mode): the
 *  running file is a .tsx source file, not the built dist/index.js this
 *  mechanism updates. */
async function maybeSelfUpdateAndRestart(): Promise<void> {
  let entryPath: string;
  try {
    entryPath = fileURLToPath(import.meta.url);
  } catch {
    return;
  }
  if (!entryPath.endsWith(".js")) return;
  const distDir = dirname(entryPath);
  // Reported directly: this whole transition (the process exits, a new one
  // starts) looked like a malfunction — the terminal just silently dropped
  // back to a bare shell prompt with no explanation, before the new
  // process's own alt-screen even had a chance to appear. Announce it in
  // two explicit, unmistakable stages instead of one terse line printed
  // only after everything already finished:
  let announcedUpdateFound = false;
  const result = await checkAndApplyUpdate(distDir, {
    onUpdateFound: (manifest) => {
      announcedUpdateFound = true;
      process.stdout.write(
        "\n" +
          "==================== llamacli 자동 업데이트 ====================\n" +
          `새 버전(${manifest.version})을 발견했습니다. 지금 다운로드하고 검증합니다.\n` +
          "완료되면 이 프로그램이 자동으로 종료됐다가 다시 시작됩니다 — 화면이\n" +
          "잠깐 사라졌다가 나타나는 것은 오작동이 아니라 정상적인 업데이트\n" +
          "과정이니 그대로 기다려 주세요.\n" +
          "==================================================================\n\n"
      );
    },
  }).catch((err: any) => ({ updated: false, reason: String(err?.message ?? err) }));
  if (!result.updated) return;
  process.stdout.write(
    `[self-update] ${result.reason} — 업데이트가 끝났습니다. 지금 바로 새 버전으로 재시작합니다...\n`
  );
  // Give the terminal a moment to actually paint the message above before
  // this process exits — reported directly that the prior single-line,
  // immediate-exit version was too easy to miss even when correct, which
  // is exactly what made the whole transition read as broken rather than
  // as an update in progress.
  if (announcedUpdateFound) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  spawnRestart(entryPath);
  process.exit(0);
}

async function main() {
  // The ONLY thing that runs before the alt screen: the self-update check.
  // Everything else — including the whole first-run setup — happens after
  // render(), behind the TUI. Running any of it here meant the screen was up
  // and empty while minutes of installing and downloading went by, which is
  // what made llamacli look like it vanished mid-"setup" (reported directly:
  // "llamacli 를 입력하면 setup 진행이 되면서 화면이 사라져"). See
  // backend/resolve.ts for the resolution itself and deferred.ts for why the
  // loop can be handed a backend before one exists.
  await maybeSelfUpdateAndRestart();
  const projectRoot = process.cwd();
  enterAltScreen();
  let cleanedUp = false;
  /** Teardown callbacks, run by `cleanup`. Anything holding an OS resource
   *  (a spawned llama-server, above all) registers here so it is released on
   *  every exit path, not only the graceful one. */
  const cleanupRegistry: Array<() => void> = [];
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const fn of cleanupRegistry) {
      try {
        fn();
      } catch {
        // Teardown must not be able to mask the exit it is part of.
      }
    }
    exitAltScreen();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  // Reported directly: "llamacli 를 윈도우즈 쉘에서 프롬프트를 입력했는데
  // 왜 바로 쉘 프롬프트로 떨어지지?" — with no top-level crash handler,
  // ANY error thrown outside the one try/catch around loop.send() below
  // (a React render error, a rejected promise from a fire-and-forget
  // callback, a Windows-specific spawn/path failure) hit Node's default
  // handler and the process just vanished — see crashHandler.ts's own doc
  // comment for why the crash message itself can be silently lost on
  // Windows specifically, and how this avoids that.
  installCrashHandlers(projectRoot, cleanup);
  const { config, setupMessage } = await loadConfig(projectRoot);
  const rules = await loadRules(projectRoot);
  const skillIndex = await loadSkillIndex(projectRoot);
  // Automatic by default: offer the browser tools only when a debuggable
  // browser is actually reachable right now (see browser.ts
  // isBrowserAvailable / config.ts browser.enabled). An explicit
  // `enabled` in config.yaml forces it either way.
  const browserCfg = config.browser ?? { debugPort: 9222, host: "127.0.0.1" };
  const browserEnabled = config.browser?.enabled ?? (await isBrowserAvailable(browserCfg));
  const systemPrompt = injectSkillIndexIntoSystemPrompt(
    injectRulesIntoSystemPrompt(
      BASE_SYSTEM_PROMPT +
        (browserEnabled ? BROWSER_SYSTEM_PROMPT : "") +
        (config.enableThinking ? THINKING_LANGUAGE_SYSTEM_PROMPT : ""),
      rules
    ),
    skillIndex
  );
  configureBrowserTools(browserCfg, projectRoot, browserEnabled);
  configureSkills(skillIndex);
  const initialHistory = await loadPromptHistory(projectRoot);
  // Read (but don't act on) any checkpoint left from a previous session —
  // the resume/discard decision is now asked via the TUI (pendingResumeGoal
  // below) instead of resuming automatically. Reading it here, before
  // render(), is what lets that first render already know whether to show
  // the question at all.
  const pendingCheckpoint = await readCheckpoint(projectRoot);

  // ── Backend resolution ────────────────────────────────────────────────────
  // Three cases, decided in order (see backend/resolve.ts for why the order is
  // the whole design): an already-running server is adopted at its own
  // endpoint/port; otherwise an installed llama.cpp is started on a free port;
  // otherwise llama.cpp is installed, configured and given a model.
  //
  // It runs AFTER render() and behind a DeferredBackend, deliberately. Doing it
  // before the screen came up is what made `llamacli` look like it vanished —
  // reported directly: "llamacli 를 입력하면 setup 진행이 되면서 화면이
  // 사라져". A first run installs llama.cpp and downloads a 20 GB model, so
  // that wait is minutes long and cannot be spent with a blank screen. Running
  // it behind the TUI means the banner is up immediately and every step is a
  // status line the user can read, and a message typed during setup simply
  // waits for it rather than failing against a dead port.
  const thresholds = {
    autoTriggerRatio: config.compaction.autoTriggerRatio,
    // Provisional, replaced by the server's own report below. Read live on every
    // turn (AgentLoop reads this object, not a captured copy), so updating it
    // after setup takes effect without rebuilding the loop.
    contextWindowTokens: config.llama?.contextSize ?? 8192,
  };
  const ui = () => (globalThis as any).__llamacli_ui;
  // The work itself starts only after render() below (see startResolution) — the
  // promise is created now because AgentLoop needs a backend to construct. Every
  // line lands in the TUI's own log rather than on the normal screen, so the
  // progress survives instead of being erased by the alt screen.
  const startResolution = deferred();
  const resolution = startResolution.promise.then(() =>
    resolveBackend({
      projectRoot,
      config,
      log: (line) => ui()?.pushStatus(line),
      // Explicit, in addition to the manager's own exit hook: SIGINT is handled
      // above for the alt screen, and a server left running holds the model in
      // VRAM for the rest of the machine's uptime.
      registerCleanup: (fn) => cleanupRegistry.push(fn),
    })
  );
  const backend = new DeferredBackend(resolution.then((r) => r.backend));

  // Prefer the backend's own reported context size over the static config value
  // whenever possible — a config file can silently drift out of sync with
  // whatever the server is actually running (seen live: config said 8192, the
  // real server was -c 65536, so compaction fired 8x too eagerly and interrupted
  // every single turn in an endless compact/resume loop). Runs after the
  // backend exists, so the value comes from the server that is really serving.
  resolution
    .then(async (r) => {
      if (r.kind === "unresolved") {
        ui()?.pushStatus(`[설정 실패] ${r.reason}`);
        return;
      }
      try {
        const reported = await r.backend.getContextSize?.();
        if (reported) thresholds.contextWindowTokens = reported;
      } catch {
        // Non-llama.cpp backend, or /props unavailable — the config value stands.
      }
    })
    .catch(() => {
      // resolveBackend never rejects for a resolution failure (it returns
      // `unresolved`), so this is only reachable if something outside it threw.
      // Reported rather than swallowed: a silent failure here would leave the
      // TUI showing a ready-looking prompt against a backend that is not there.
      ui()?.pushStatus("[설정 실패] 모델 백엔드를 준비하는 중 오류가 발생했습니다.");
    });




  const loop = new AgentLoop({
    projectRoot,
    model: config.model,
    backend,
    systemPrompt,
    // The same object the resolution above mutates, passed by reference: a copy
    // here would freeze the provisional value and the server's real context size
    // would never take effect.
    thresholds,
    autoResume: config.compaction.autoResume,
    enableThinking: config.enableThinking ?? false,
    verify: config.verify?.afterEdit,
    gitCheckpoint: config.checkpoint?.git ?? false,
    repeatPenalty: config.repeatPenalty,
    onAssistantDelta: (t) => (globalThis as any).__llamacli_ui?.pushAssistantDelta(t),
    onAssistantDone: () => {
      (globalThis as any).__llamacli_ui?.finalizeAssistant();
      (globalThis as any).__llamacli_ui?.finalizeReasoning();
    },
    onReasoningDelta: (t) => (globalThis as any).__llamacli_ui?.pushReasoningDelta(t),
    onQueueChange: (q) => (globalThis as any).__llamacli_ui?.setQueue(q),
    onToolCall: (name, args) => {
      let preview = "";
      try {
        const parsed = JSON.parse(args);
        preview = parsed.path ?? parsed.command ?? parsed.query ?? "";
      } catch {
        preview = args.slice(0, 60);
      }
      const label = preview ? `${name}(${preview})` : name;
      (globalThis as any).__llamacli_ui?.pushTool(label);
    },
    onToolCallDone: () => (globalThis as any).__llamacli_ui?.finalizeToolCall(),
    onDiff: (_path, diff) => (globalThis as any).__llamacli_ui?.pushDiff(diff),
    onToolResult: (command, output) => {
      (globalThis as any).__llamacli_ui?.pushToolResult(command, output);
    },
    onStatus: (s) => (globalThis as any).__llamacli_ui?.pushStatus(s),
    onContextUsage: (used, total) =>
      (globalThis as any).__llamacli_ui?.setContextUsedRatio(total > 0 ? Math.min(1, used / total) : 0),
    onPlanProgress: (done, total) => (globalThis as any).__llamacli_ui?.setPlanProgress(done, total),
    onCompactionStatus: (status, timestamp) => (globalThis as any).__llamacli_ui?.setCompactionStatus(status, timestamp),
    onCompactionDetail: (detail) => (globalThis as any).__llamacli_ui?.pushCompactionDetail(detail),
    onTurnStart: () => (globalThis as any).__llamacli_ui?.collapseDiffs(),
  });

  // Session-end self-improvement gate (PROMPT.md §3): if failures were
  // logged and never reviewed, /quit shows the proposal instead of exiting —
  // a second /quit confirms. Applying the proposal (if any) always requires
  // the separate explicit /improve-apply, never happens on quit itself.
  let quitConfirmed = false;

  // Every quit path ends here: show the save-in-progress animation (App's
  // quitting state), save, then ALWAYS exit — on success, on failure, or
  // after QUIT_SAVE_TIMEOUT_MS at the latest. Reported live: saving could
  // take minutes with nothing on screen but one status line (/quit waited
  // in the task queue behind the whole running turn, then ran a full
  // compaction), and there was no way to skip it, so quitting looked like
  // a hang. A running turn is now cancelled (fast checkpoint write) rather
  // than waited for, and Esc/Ctrl-C during the save quits without saving.
  const QUIT_SAVE_TIMEOUT_MS = 180_000;
  const exitNow = () => {
    unmount();
    // unmount() alone doesn't end the process: a lingering handle (the
    // keep-alive connection pool, a timer) keeps Node running — reported
    // live as quit appearing to work while the process stayed alive.
    process.exit(0);
  };
  const exitAfterSaving = () => {
    const ui = (globalThis as any).__llamacli_ui;
    const save = ui?.isBusy?.() ? loop.cancelCurrentTurn() : loop.saveStateOnQuit();
    ui?.beginQuitting?.();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        ui?.pushStatus("[saving is taking too long — quitting without waiting for it]");
        resolve();
      }, QUIT_SAVE_TIMEOUT_MS)
    );
    Promise.race([
      save.catch((err: any) =>
        ui?.pushStatus(`[couldn't save progress: ${summarizeErrorForDisplay(err.message)}] quitting anyway.`)
      ),
      timeout,
    ]).finally(exitNow);
  };

  // Hand the detected color depth to chalk BEFORE the first render, because
  // chalk is what Ink colors through. Without this, NO_COLOR and a 16-color
  // terminal only affected the handful of raw SGR sequences this app writes
  // itself — all of Ink's own color (<Text color="cyan">, dimColor, the box
  // borders, the context gauge) would still come out at whatever chalk
  // decided from the environment, which is exactly the per-terminal
  // mismatch this detection exists to remove. See terminal.ts.
  applyColorDepth(getCapabilities());

  const { unmount } = render(
    // exitOnCtrlC: false — Ink's default behavior kills the whole process
    // the instant Ctrl-C is pressed, which conflicts with terminals/users
    // that treat Ctrl-C as copy (reported directly). Raw mode disables the
    // TTY's normal SIGINT generation for Ctrl-C, so with this off, the
    // keystroke reaches App.tsx's own useInput handler like any other key —
    // where it's explicitly treated as a no-op (see App.tsx) rather than
    // being inserted into the input or exiting. /quit remains the only way
    // to exit the app; Ctrl-C no longer does anything inside it at all.
    <App
      cwd={projectRoot}
      model={config.model}
      startupBanner={{ version: startupVersion(), repoUrl: REPO_URL }}
      initialHistory={initialHistory}
      onHistoryChange={(history) => {
        // Fire-and-forget: a failed write here must never block sending a
        // message — it only means history browsing across restarts falls a
        // step behind, not that anything in the actual conversation breaks.
        savePromptHistory(projectRoot, history).catch(() => {});
      }}
      pendingResumeGoal={pendingCheckpoint?.goal ?? null}
      onResumeDecision={(resume) => {
        const ui = (globalThis as any).__llamacli_ui;
        if (!resume) {
          // Declined — this checkpoint must not linger and get silently
          // picked up by a later automatic path (e.g. a mid-turn compaction
          // interruption's own resume check) once the user has explicitly
          // said "start fresh." Best-effort: a failed delete here just
          // means the (now-stale) checkpoint sits on disk unused, not a
          // reason to block starting the session.
          clearCheckpoint(projectRoot).catch(() => {});
          clearNotes(projectRoot).catch(() => {});
          return;
        }
        ui?.setBusy(true);
        loop
          .resumeIfCheckpointExists()
          .catch((err: any) => ui?.pushStatus(`[error] failed to resume from checkpoint: ${summarizeErrorForDisplay(err.message)}`))
          .finally(() => ui?.setBusy(false));
      }}
      onForceQuit={() => {
        // The "force" exit: no self-improvement-proposal gate (see
        // AppProps.onForceQuit) — just save and go.
        exitAfterSaving();
      }}
      onQuitWithoutSaving={exitNow}
      onSubmit={async (text) => {
        const ui = (globalThis as any).__llamacli_ui;
        ui?.setBusy(true);
        try {
          await loop.send(text);
        } catch (err: any) {
          // Defensive: AgentLoop already catches expected backend/compaction
          // failures internally, but nothing here should ever be allowed to
          // crash the whole TUI process over an unexpected error.
          ui?.pushStatus(`[error] ${summarizeErrorForDisplay(err.message)}`);
        } finally {
          ui?.setBusy(false);
          // The turn just ended — the UI is about to sit idle waiting for
          // the next keystroke (reading the reply, typing, etc). If this
          // turn already pushed context usage past the auto-threshold, do
          // that compaction NOW instead of leaving it for the next send()
          // to pay for synchronously. See warmCompactIfNeeded's doc comment.
          loop.warmCompactIfNeeded();
        }
      }}
      onQueueMessage={(text) => loop.queueMessage(text)}
      onSlashCommand={async (key, argument = "") => {
        const ui = (globalThis as any).__llamacli_ui;
        switch (key) {
          case "quit": {
            if (quitConfirmed || !loop.hasFailureLog()) {
              // Requested directly: quitting should save current progress
              // to disk first, the same way compaction already does
              // before/after summarizing — so the next launch resumes
              // where this one left off instead of losing whatever wasn't
              // already captured by a plan-progress checkpoint. Never lets
              // a save failure block quitting itself (unmount() always
              // runs, success or not) — matches the rest of the app's
              // "an internal failure reports itself, never hangs the
              // whole thing" approach.
              // Save current progress first so the next launch resumes
              // where this one left off (see exitAfterSaving above).
              exitAfterSaving();
              break;
            }
            quitConfirmed = true;
            ui?.pushStatus("[analyzing for self-improvement before quitting...]");
            loop
              .proposeSelfImprovement()
              .then((proposal) => {
                if (!proposal) {
                  ui?.pushStatus("No recurring failure pattern found, nothing to propose. Press /quit again to exit.");
                  return;
                }
                ui?.pushStatus(
                  [
                    `[self-improvement proposal] ${proposal.summary}`,
                    "",
                    proposal.ruleMarkdown,
                    "",
                    "Run /improve-apply to save it, or press /quit again to exit without applying it.",
                  ].join("\n")
                );
              })
              .catch((err: any) => ui?.pushStatus(`[self-improvement analysis failed] ${summarizeErrorForDisplay(err.message)}`));
            break;
          }
          case "help": {
            // The keybinding table is the point of this, not an appendix:
            // every interaction that isn't a slash command is a key, and
            // before this the only way to learn one was to read the source.
            // Rendered from KEY_BINDINGS so it can't drift from what the key
            // handler actually does — see keybindings.ts.
            const lines: string[] = [];
            for (const group of KEY_BINDINGS) {
              lines.push(group.title, ...group.bindings.map((b) => "  " + formatKeyRow(b)), "");
            }
            lines.push(
              "명령 (/ 로 시작)",
              ...SLASH_MENU_ITEMS.map((i) => `  ${i.label.padEnd(16)} ${i.description}`),
              "",
              "컨텍스트 사용량이 임계치에 닿으면 자동 압축이 실행되고 이후 작업이 자동으로 이어집니다."
            );
            ui?.pushStatus(lines.join("\n"));
            break;
          }
          case "keys": {
            const lines: string[] = [];
            for (const group of KEY_BINDINGS) {
              lines.push(group.title, ...group.bindings.map((b) => "  " + formatKeyRow(b)), "");
            }
            ui?.pushStatus(lines.join("\n").trimEnd());
            break;
          }
          case "term": {
            // Report what was actually detected rather than making the user
            // guess from symptoms. Every field here corresponds to a
            // behavior that used to differ silently between terminals —
            // see terminal.ts.
            const caps = getCapabilities();
            const onOff = (b: boolean) => (b ? "켜짐" : "꺼짐");
            ui?.pushStatus(
              [
                `터미널      : ${caps.terminal}`,
                `판정 근거   : ${caps.reason}`,
                `TERM        : ${process.env.TERM ?? "(미설정)"}`,
                `멀티플렉서  : ${caps.inMultiplexer ? "예 (tmux/screen)" : "아니오"}`,
                "",
                `제어문자    : ${onOff(caps.ansi)}`,
                `색상        : ${{ 0: "없음", 4: "16색", 8: "256색", 24: "진짜색(24bit)" }[caps.colorDepth]}`,
                `유니코드    : ${onOff(caps.unicode)}`,
                `대체화면    : ${onOff(caps.altScreen)}`,
                `동기화 출력 : ${onOff(caps.synchronizedOutput)}`,
                `하이퍼링크  : ${onOff(caps.hyperlink)}`,
                `마우스(SGR) : ${caps.mouse ? "켜짐" : caps.mouseSgr ? "꺼짐 (지원되지만 /mouse 로 켜짐)" : "꺼짐 (이 터미널 미지원)"}`,
                "",
                "강제로 바꾸려면 환경변수로 실행: LLAMACLI_FORCE_ANSI=1, LLAMACLI_NO_ANSI=1,",
                "LLAMACLI_COLOR_DEPTH=0|4|8|24, LLAMACLI_ASCII=1, LLAMACLI_MOUSE=1, NO_COLOR=1",
              ].join("\n")
            );
            break;
          }
          case "mouse": {
            // Toggling at runtime instead of re-exec: the capability record
            // is pure data, so this just re-derives one boolean. The
            // sequences are emitted here (not only at startup) because the
            // terminal has to be put into mouse-reporting mode at the moment
            // the user asks for it.
            const caps = getCapabilities();
            if (!caps.mouseSgr) {
              ui?.pushStatus(
                `[mouse] 이 터미널은 SGR 마우스 보고(1006)를 지원하지 않아 켤 수 없습니다. ` +
                  `터미널 단축키로 스크롤하거나 PageUp/PageDown 을 사용하세요. (/term 으로 확인)`
              );
              break;
            }
            const next = withMouse(caps, !caps.mouse);
            setTerminalCapabilities(next);
            // Put the terminal into (or take it out of) mouse-reporting mode
            // right now, since the user asked for it mid-session rather than
            // at startup. mouseOff is emitted whenever SGR is available so a
            // terminal whose mode we enabled and then disabled still gets
            // cleaned up.
            const seq = buildSequences(next);
            process.stdout.write(next.mouse ? seq.mouseOn : seq.mouseOff);
            ui?.pushStatus(
              next.mouse
                ? "[mouse] 켜짐 — 휠 스크롤 · 클릭으로 접힌 블록 토글 · 드래그로 선택 후 놓으면 복사(가장자리에서 자동 스크롤). " +
                  "네이티브 선택이 필요하면 Shift 를 누른 상태로 드래그하세요."
                : "[mouse] 꺼짐 — Shift 없이 드래그해 텍스트를 선택할 수 있습니다. 단, 이 화면은 alt screen 이라 " +
                  "터미널 스크롤백이 없어 화면 위로 드래그해도 과거 출력까지 이어지지 않습니다."
            );
            break;
          }
          case "copy": {
            const rows: string[] = (globalThis as any).__llamacli_ui?.getVisibleLogText?.() ?? [];
            if (rows.length === 0) {
              ui?.pushStatus("[복사] 로그에 복사할 내용이 없습니다.");
              break;
            }
            const n = Number.parseInt(argument.trim(), 10);
            const picked = Number.isFinite(n) && n > 0 ? rows.slice(-n) : rows;
            const text = stripAnsiForCopy(picked.join("\n"));
            void copySelection(text)
              .then((result) => {
                ui?.pushStatus(
                  `[복사] ${text.length}자를 ${result.via === "osc52" ? "클립보드에 넣고" : "클립보드가 거부해서 파일로"} 저장했습니다 → ${result.path}`
                );
              })
              .catch((err: any) => ui?.pushStatus(`[복사 실패] ${summarizeErrorForDisplay(err.message)}`));
            break;
          }
          case "compact":
            ui?.pushStatus(
              ui?.isBusy?.() ? "[compaction scheduled] It will run once the current turn finishes." : "[compaction started]"
            );
            ui?.setBusy(true);
            loop
              .forceCompact()
              .catch((err: any) => ui?.pushStatus(`[compaction failed] ${summarizeErrorForDisplay(err.message)}`))
              .finally(() => ui?.setBusy(false));
            break;
          case "skills":
            ui?.pushStatus(
              skillIndex.length
                ? `Loaded skills:\n${skillIndex.map((s) => `- ${s.name}: ${s.trigger}`).join("\n")}`
                : "No skills registered (.llamacli/skills/*.md)."
            );
            break;
          case "rules":
            ui?.pushStatus(
              rules.length
                ? `Loaded rules:\n${rules.map((r) => `- ${r.path}`).join("\n")}`
                : "No rules applied (.llamacli/rules/ or .clinerules)."
            );
            break;
          case "improve":
            ui?.pushStatus("[analyzing for self-improvement...]");
            loop
              .proposeSelfImprovement()
              .then((proposal) => {
                ui?.pushStatus(
                  proposal
                    ? [
                        `[self-improvement proposal] ${proposal.summary}`,
                        "",
                        proposal.ruleMarkdown,
                        "",
                        "Run /improve-apply to apply it (nothing is written to disk until you do).",
                      ].join("\n")
                    : "No recurring failure pattern yet, nothing to propose."
                );
              })
              .catch((err: any) => ui?.pushStatus(`[self-improvement analysis failed] ${summarizeErrorForDisplay(err.message)}`));
            break;
          case "improve-apply":
            loop
              .applyPendingImprovement()
              .then((path) => {
                ui?.pushStatus(
                  path
                    ? `[rule saved] ${path} (injected into the system prompt automatically from the next session on)`
                    : "No pending proposal to apply. Run /improve first."
                );
              })
              .catch((err: any) => ui?.pushStatus(`[rule save failed] ${summarizeErrorForDisplay(err.message)}`));
            break;
          case "plan-clear":
            loop
              .clearPlan()
              .then(() => ui?.pushStatus("Plan progress cleared."))
              .catch((err: any) => ui?.pushStatus(`[error] failed to clear plan: ${summarizeErrorForDisplay(err.message)}`));
            break;
        }
      }}
    />,
    // `stdout` is wrapped so the real cursor is put back where the prompt is
    // after EVERY frame Ink writes.
    //
    // Reported directly: "프롬프트 창에 문자를 적고 있으면 마지막 커서가 하단
    // 최좌측으로 나타나는 경우가 있어" — while typing, the cursor sometimes
    // appears in the bottom-left corner.
    //
    // The cause is an ordering property of Ink 4: the reconciler calls a
    // `throttle(onRender, 32, {leading: true, trailing: true})`
    // (node_modules/ink/build/ink.js), so a frame can be written up to 32 ms
    // AFTER App's effect has already positioned the cursor. That repaint leaves
    // the real cursor wherever the frame's output ended — the bottom-left of the
    // alt screen — and nothing re-places it, because no state change followed.
    // Ink's public `onRender` render-option is never called in 4.4.1 (only
    // `debug` mode uses the user's callback), so there is no supported post-paint
    // hook and the fix has to sit on the write itself.
    //
    // Wrapping `write` rather than shortening the old 400 ms self-heal timer is
    // what makes this correct rather than merely less visible: it closes the
    // window instead of bounding how long the cursor is wrong, and it costs a
    // null check while nothing is being drawn. See cursorPlacement.ts.
    { exitOnCtrlC: false, stdout: wrapStdoutWithCursorReassertion(process.stdout) }
  );

  if (setupMessage) (globalThis as any).__llamacli_ui?.pushStatus(setupMessage);

  // The screen is up and the log can accept lines, so backend resolution
  // finally begins. Until this point it was only a pending promise, because a
  // first run installs llama.cpp and downloads a model — minutes of work whose
  // progress would otherwise be printed to a screen Ink is about to take over.
  startResolution.resolve();

  // Resuming (or discarding) a found checkpoint now happens via the
  // App-rendered Y/N question (pendingResumeGoal/onResumeDecision above)
  // instead of unconditionally here — this used to auto-resume with no way
  // to say "no, start fresh."
}

main().catch((err) => {
  exitAltScreen(); // otherwise this error is drawn into the alt-screen and lost when it's torn down
  console.error(err);
  process.exit(1);
});
