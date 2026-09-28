#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadConfig, updateLayaEnabled } from "./config.js";
import { loadRules, loadSkillIndex, injectRulesIntoSystemPrompt, injectSkillIndexIntoSystemPrompt } from "./skills/loader.js";
import { SLASH_MENU_ITEMS } from "./tui/SlashMenu.js";
import { LlamaServerManager } from "./backend/llamaServer.js";
import { OpenAICompatibleClient } from "./backend/openaiClient.js";
import { AgentLoop, summarizeErrorForDisplay } from "./agent/loop.js";
import { configureBrowserTools, configureSkills } from "./tools/index.js";
import { isBrowserAvailable } from "./tools/browser.js";
import { loadPromptHistory, savePromptHistory } from "./tui/promptHistory.js";
import { readCheckpoint, clearCheckpoint } from "./compaction/checkpoint.js";
import { clearNotes } from "./compaction/notes.js";
import { findOtherInstances, terminateInstance } from "./instanceGuard.js";
import { createInterface } from "node:readline/promises";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { buildVersionString } from "./tui/banner.js";
import { checkAndApplyUpdate, spawnRestart } from "./selfUpdate.js";
import { getCapabilities, setTerminalCapabilities, buildSequences, withMouse, applyColorDepth } from "./tui/terminal.js";
import { copySelection, stripAnsiForCopy } from "./tui/selection.js";
import { getCursorPlacement } from "./tui/cursorPlacement.js";
import { ensureLocalStack } from "./setup/bootstrap.js";
import { layaPortEnv, LAYA_PORT } from "./setup/ports.js";
import { describeReset } from "./setup/resetDiff.js";
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
/** A blocking y/N question, reusing the same in-log + input-box pattern the
 *  startup resume question uses.
 *
 *  Returns false on anything that isn't an explicit yes, so a stray keystroke,
 *  a closed stdin or a timeout all take the safe branch — a destructive
 *  command must never proceed on ambiguity. */
function askYesNo(ui: any, question: string): Promise<boolean> {
  ui?.pushStatus(`${question}\nY(예) / N(아니오) 를 입력해주세요.`, "status");
  return new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim().toLowerCase();
      // Escape sequences (a mouse report, an arrow key) can arrive in the same
      // chunk; only a chunk that is EXACTLY y/n counts as an answer, so a
      // report can never be read as consent.
      if (text === "y" || text === "\r" || text === "\n") {
        process.stdin.off("data", onData);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        resolve(true);
      } else if (text === "n" || text === "\x03") {
        process.stdin.off("data", onData);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        resolve(false);
      }
    };
    process.stdin.on("data", onData);
  });
}

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

/** Before taking over the screen: if llamacli is already running in this
 *  project, ask whether to stop it (see instanceGuard.ts). Declining exits
 *  instead of running two sessions side by side. */
async function ensureSingleInstance(): Promise<void> {
  const others = findOtherInstances(process.cwd(), process.pid, process.argv[1] ?? "");
  if (others.length === 0) return;
  process.stdout.write(
    `이 프로젝트에서 llamacli가 이미 실행 중입니다 (PID ${others.join(", ")}).\n` +
      "기존 프로세스를 종료하고 새로 시작할까요? 저장된 체크포인트는 그대로 남습니다.\n"
  );
  let answer = "";
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answer = (await rl.question("[y/N] ")).trim().toLowerCase();
    rl.close();
  }
  if (answer !== "y" && answer !== "yes") {
    process.stdout.write("새 세션을 시작하지 않고 종료합니다.\n");
    process.exit(1);
  }
  for (const pid of others) {
    const gone = await terminateInstance(pid);
    process.stdout.write(gone ? `PID ${pid} 종료됨.\n` : `PID ${pid}를 종료하지 못했습니다.\n`);
    if (!gone) process.exit(1);
  }
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

/** Reported directly: "윈도우즈에서 프롬프트에서 한글을 입력시 일부
 *  문자코드가 깨지는 경우 강제 종료가 되는거 같은데?" — Ink already calls
 *  stdin.setEncoding('utf8') (which correctly buffers a multi-byte UTF-8
 *  sequence split across chunk boundaries via Node's own StringDecoder),
 *  so that's not the failure mode here. The much more likely cause on
 *  Windows specifically: the console's ACTIVE CODE PAGE isn't UTF-8
 *  (65001) — on an older conhost / non-Windows-Terminal session, keyboard
 *  input for multi-byte characters (Korean, or any non-ASCII text) can get
 *  encoded by the OS using whatever legacy codepage is active (e.g. CP949)
 *  instead of UTF-8, and Node — expecting UTF-8 — decodes those bytes into
 *  garbage/replacement characters, or lone surrogates, before this process
 *  ever sees valid text. `chcp` changes the ACTIVE CONSOLE's codepage (the
 *  same console handle the parent shell is attached to), not just this
 *  child process's own environment, so running it once here fixes it for
 *  the whole session exactly like running `chcp 65001` manually before
 *  launching would — done synchronously, before anything else touches
 *  stdin, and best-effort (never blocks or fails startup: an older/locked-
 *  down `chcp`, or none at all, just leaves the codepage as whatever it
 *  already was). */
function ensureWindowsUtf8Console(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("chcp", ["65001"], { stdio: "ignore", shell: true });
  } catch {
    // Best-effort only — see doc comment above.
  }
}

/** Reported directly: "llamacli에서 fastcheck on 또는 off 등의 명령어가
 *  동작하지 않아" — the laya integration script used to be resolved
 *  relative to `projectRoot` (the directory llamacli happens to be RUN
 *  from), so `/fastcheck` only ever worked in the couple of project
 *  directories that happened to already have their own copy of this
 *  script sitting at their root. Confirmed live: running from any other
 *  directory, `python3 <projectRoot>/scripts/laya_integration.py enable`
 *  fails with "can't open file" (ENOENT), silently, every time.
 *
 *  The script belongs to the llamacli INSTALLATION, not to whatever
 *  project it's currently pointed at — resolve it the same way
 *  maybeSelfUpdateAndRestart resolves its own install directory: next to
 *  the running entry point. Ships as dist/scripts/laya_integration.py
 *  (copied there by `npm run build`, so it travels with every self-update
 *  same as every other dist/ file); under `tsx` (dev mode) the entry
 *  point is src/index.tsx and the script sits one level up at the project
 *  root's own scripts/, unchanged from before. */
function resolveLayaScriptPath(): string {
  let entryPath: string;
  try {
    entryPath = fileURLToPath(import.meta.url);
  } catch {
    entryPath = "";
  }
  const entryDir = dirname(entryPath || pathResolve("src", "index.tsx"));
  return entryPath.endsWith(".js")
    ? pathResolve(entryDir, "scripts", "laya_integration.py") // dist/index.js -> dist/scripts/...
    : pathResolve(entryDir, "..", "scripts", "laya_integration.py"); // src/index.tsx -> <root>/scripts/...
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
  ensureWindowsUtf8Console();
  await maybeSelfUpdateAndRestart();
  await ensureSingleInstance();
  const projectRoot = process.cwd();
  // ── First-run bootstrap ───────────────────────────────────────────────────
  // Runs BEFORE the alt screen, so its progress lines land on the normal
  // scrollback where they can scroll past, and before loadConfig so the config
  // it writes is the one that gets loaded.
  //
  // Every step is idempotent and derived from measured hardware, so this is a
  // few stat() calls on an already-set-up machine and a real install on a fresh
  // one — with no prompt anywhere. It is also allowed to fail: the report is
  // surfaced and the app continues, because a bootstrap that throws would take
  // down a working install. `LLAMACLI_NO_BOOTSTRAP=1` skips it entirely.
  let bootstrapReport: Awaited<ReturnType<typeof ensureLocalStack>> | undefined;
  if (process.env.LLAMACLI_NO_BOOTSTRAP !== "1") {
    try {
      bootstrapReport = await ensureLocalStack({
        projectRoot,
        log: (line) => process.stdout.write(`[setup] ${line}\n`),
      });
    } catch (err) {
      process.stdout.write(
        `[setup] 자동 설정을 완료하지 못했습니다 (${err instanceof Error ? err.message : String(err)}). ` +
          `기존 설정으로 계속합니다.\n`
      );
    }
  }
  enterAltScreen();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
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

  let backend: OpenAICompatibleClient;
  if (config.backend === "local-llama" && config.llama?.modelPath) {
    const manager = new LlamaServerManager({
      binPath: config.llama.binPath,
      modelPath: config.llama.modelPath,
      host: "127.0.0.1",
      port: config.llama.port,
      contextSize: config.llama.contextSize,
      threads: config.llama.threads,
      gpuLayers: config.llama.gpuLayers,
    });
    await manager.start();
    backend = manager.client();
  } else {
    backend = new OpenAICompatibleClient(config.baseUrl ?? "http://127.0.0.1:8081", config.apiKey);
  }

  // Prefer the backend's own reported context size over the static config
  // value whenever possible — a config file can silently drift out of sync
  // with whatever the server is actually running (seen live: config said
  // 8192, the real server was -c 65536, so compaction fired 8x too eagerly
  // and interrupted every single turn in an endless compact/resume loop).
  // Falls back to config (then 8192) for backends that don't expose this.
  let contextWindowTokens = config.llama?.contextSize ?? 8192;
  try {
    const reported = await backend.getContextSize?.();
    if (reported) contextWindowTokens = reported;
  } catch {
    // Non-llama.cpp backend, or /props unavailable — config value stands.
  }

  // --- laya (fast System-1) before-turn gate wiring ----------------------- #
  // The gate is a no-op callback unless config.laya.enabled. `/fastcheck on|off`
  // flips this flag at runtime (no restart): once on, the first turn of every
  // subsequent message runs a laya round-trip BEFORE Ornith; the model then sees
  // the honest System-1 read and decides whether to trust it. Off => the callback
  // returns immediately and no health/server check is attempted at all. The Python
  // script owns server boot + config IO, so this only spawns it with a bounded
  // timeout and degrades silently on any failure (a hung/failed server must never
  // block or crash a turn — the normal Ornith run always proceeds).
  const layaEnabled = Boolean(config.laya?.enabled ?? false);
  let runtimeEnabled = layaEnabled;            // toggled by /fastcheck |off|on|
  // Stable per-session id for the LAYA gate's cumulative perf line. Assigned
  // once, on the first short-circuit, so loop.ts (which pushes a foldable
  // summary keyed by this id via App.pushGateLog) keeps appending to ONE
  // growing line across every fastcheck run instead of spawning one per run.
  let layaGateId = 0;
  /** Default cap, seconds, for a laya round-trip when config.yaml doesn't set
   *  `laya.timeoutSeconds`. A hung server must never block a turn. */
  const DEFAULT_LAYA_TIMEOUT_SECONDS = 30;
  const LAYA_TIMEOUT_MS = (config.laya?.timeoutSeconds ?? DEFAULT_LAYA_TIMEOUT_SECONDS) * 1000;
  const layaScriptPath = resolveLayaScriptPath();
  // The single laya port, from config when set, else the bootstrap's plan, else
  // the canonical default. Read ONCE here so every laya spawn and the health
  // check refer to the same number.
  const layaPort =
    (typeof config.laya?.port === "number" && config.laya.port) ||
    bootstrapReport?.ports?.layaPort ||
    LAYA_PORT;

  // Reported directly, live: "[laya error] laya script timed out after
  // 30000ms" — the very first real `/fastcheck on` install (pip installing
  // laya[serve]'s torch+CUDA deps) got killed mid-install by the same 30s
  // bound meant for an ordinary per-turn gate round-trip. That bound is
  // right for the gate (a hung check must never wedge a turn) but far too
  // short for a one-time install that can legitimately take minutes —
  // install_laya() itself already allows up to 600s for the pip step.
  const LAYA_INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // matches install_laya()'s own pip timeout=600

  /** Spawn the laya integration script with a hard timeout. All config writes,
   *  server boot and health checks live in Python; Node only runs it and reads
   *  stdout, killing the process if it outlives the timeout so a hung script
   *  can never wedge the TUI or block a turn. Resolves with stdout on success
   *  (exit 0) and rejects otherwise — callers catch everything. `timeoutMs`
   *  overrides LAYA_TIMEOUT_MS for calls that legitimately need longer (the
   *  install-triggering call below uses LAYA_INSTALL_TIMEOUT_MS).
   *
   *  Reported directly: "로그가 나오지 않는데?" — this used to only ever
   *  hand the caller the FULL accumulated stdout once the process exited,
   *  so a multi-minute install (pip installing torch+CUDA) showed nothing
   *  at all until it was completely done. `onLine`, when given, is called
   *  with each COMPLETE line as it actually arrives, so a caller that wants
   *  to show live progress (the install-triggering call below) can push
   *  each line the moment it's printed instead of waiting for the end.
   *  `-u` (unbuffered) is required on top of this — Python fully buffers
   *  stdout by default whenever it isn't a real TTY (i.e. always, here,
   *  since Node pipes it), so without it every print() would still sit in
   *  Python's OWN buffer regardless of how promptly Node reads it. */
  const runLayaScript = (
    args: string[],
    timeoutMs: number = LAYA_TIMEOUT_MS,
    onLine?: (line: string) => void
  ): Promise<{ stdout: string }> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const child: ChildProcess = spawn("python3", ["-u", layaScriptPath, ...args], {
        timeout: timeoutMs,
        // The laya port is set from OUR config on every spawn, so the port
        // llamacli names and the port laya binds cannot drift apart.
        //
        // This is the fix for a bug that made the app look hung: `laya-serve`
        // reads its BIND port from LAYA_PORT (upstream default 8000) while every
        // health probe in laya_integration.py read LAYA_ENDPOINT (default 8099).
        // The server bound 8000, the probe polled 8099, so bootstrap_laya timed
        // out on a perfectly healthy server and then killed it as "failed to
        // boot" — a laya-serve that was healthy on :8000 while every fastcheck
        // call still blocked ~25-30s per turn. Both variables are set to the one
        // planned port so the bind and the probe cannot disagree (see
        // layaPortEnv).
        env: { ...process.env, ...layaPortEnv(layaPort) },
      });
      // `child.kill(timeout:true)` is Node < 18.0 semantics; use a manual timer
      // that kills the process and resolves as an error so callers treat it like
      // any other failure (silent fall back — Ornith still runs).
      timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`laya script timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let out = "";
      let lineBuf = "";
      child.on("error", (err) => {
        if (!settled) { clearTimeout(timer); settled = true; reject(err); }
      });
      child.stdout?.on("data", (d: Buffer) => {
        const chunk = String(d);
        out += chunk;
        if (!onLine) return;
        lineBuf += chunk;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? ""; // last element: not newline-terminated yet — keep buffering it
        for (const line of lines) onLine(line);
      });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Flush a final line that never got a trailing newline (common:
          // the process's very last print() before exiting).
          if (onLine && lineBuf) onLine(lineBuf);
          // Only treat exit code 0 as success; anything else is a silent fall
          // back so the normal turn proceeds unchanged.
          code === 0 ? resolve({ stdout: out }) : reject(new Error(`laya script exited with code ${code}`));
        }
      });
    });

  const runLayaGate = async (userText: string): Promise<{
    judgeSaysCheap: boolean; verdict?: string; score?: number; conf?: number; gateId?: number;
    /** The gate could not be consulted at all (no server, timeout, spawn
     *  error, non-zero exit). Distinct from "the judge said go slow".
     *
     *  Reported directly: the gate looked like it was running, and it was —
     *  but it was failing every single turn. The laya server was listening on
     *  :8000 while every health probe polled :8099, so each call burned the full
     *  30 s timeout, hit the catch below, and returned a bare
     *  `{judgeSaysCheap:false}`. `decideGate` read that as a confident
     *  "full turn needed" and printed `gate: 전체 턴 필요로 판단 (conf=0.000)`
     *  — a verdict that was never made, presented identically to a real one.
     *  The user could not tell a dead gate from a working one. `failed` is what
     *  lets the two be told apart. */
    failed?: boolean;
  } | undefined> => {
    // Off => the gate doesn't run at all, and `undefined` (rather than a
    // synthetic "not cheap") is what makes decideGate report "gate: 꺼짐"
    // instead of pretending laya was asked and declined. Throwing here would
    // be wrong: loop.ts catches a throw and prints "laya gate skipped
    // (using full model): …" on every single turn, which is exactly the noise
    // a deliberately-disabled feature must not produce.
    if (!runtimeEnabled) return undefined;
    try {
      const { stdout } = await runLayaScript(["fastcheck", "--text", userText]);
      // cmd_fastcheck prints its own progress lines (install/boot-wait) on
      // stdout BEFORE the final verdict, so the verdict can land on any
      // line, not necessarily the first — _verdict_prose() (scripts/
      // laya_integration.py) marks it unambiguously with a "GATE_VERDICT: "
      // prefix carrying a single-word token (SHORTCIRCUIT|PROCEED|DEGRADED)
      // plus conf=, found by scanning every line rather than assuming
      // line 0. Previously this looked only at stdout's first line AND
      // checked for the hyphenated literal "short-circuit" while the prose
      // it was matching against started with "[laya]" and used "SHORTCIRCUIT"
      // (no hyphen) — neither check could ever match the other, so the
      // live per-turn gate could never actually short-circuit regardless of
      // what verdict it computed.
      const verdictLine = stdout.split(/\r?\n/).find((l) => /^GATE_VERDICT:/i.test(l.trim()));
      const mVerdict = verdictLine && /SHORTCIRCUIT|PROCEED|DEGRADED|TRUTHFUL/i.exec(verdictLine);
      const verdict = mVerdict ? mVerdict[0].toLowerCase() : undefined;
      const mScore = verdictLine && /(?:^|\s)score=([\d.]+)/i.exec(verdictLine);
      const mConf = verdictLine && /(?:^|\s)conf=([\d.]+)/i.exec(verdictLine);
      const score = mScore ? Number(mScore[1]) : undefined;
      const conf = mConf ? Number(mConf[1]) : undefined;

      // `judgeSaysCheap` is the JUDGE's opinion, not a decision. Whether it
      // actually downgrades the turn is decided in agent/gate.ts, where the
      // high-risk rail can override it — see that module for the measurement
      // that made "skip the model" untenable.
      const judgeSaysCheap = verdict === "shortcircuit";
      if (judgeSaysCheap) {
        // Assign the stable id exactly once so every subsequent run appends to
        // the same foldable perf line.
        if (layaGateId === 0) layaGateId = 1;
        return { judgeSaysCheap, verdict, score, conf, gateId: layaGateId };
      }
      return { judgeSaysCheap, verdict, score, conf };
    } catch {
      // Any failure (nonzero exit, timeout, spawn error) => the gate doesn't get
      // a say and the full turn runs unchanged. Never throw past here — a turn
      // must never fail because a gate did.
      //
      // `failed: true` is what stops this from being reported as a verdict. It
      // used to be indistinguishable from a real "not cheap" answer, so a gate
      // that was down on every single turn looked exactly like a gate that was
      // working and simply always choosing the full path.
      return { judgeSaysCheap: false, failed: true };
    }
  };

  // Agent-trace: evaluate a run_shell tool RESULT after it returns (laya's
  // typed-decisions checkpoint). Fire-and-forget — never awaited, so it can
  // never block or slow an Ornith turn. Silently ignored on any failure
  // (disabled gate, missing server, timeout) and when output is empty. Uses
  // the same bounded-spawn primitive as the gate; a success just needs to be
  // surfaced to the user via onStatus.
  const runLayaTrace = (command: string, output: string): void => {
    if (!runtimeEnabled) return;              // off => instant no-op (no checks)
    if (!output || !output.trim()) return;    // nothing to evaluate
    try {
      runLayaScript(["trace", "--tool", "run_shell", "--summary", output])
        .then((r) => (globalThis as any).__llamacli_ui?.pushStatus(r.stdout.trim()))
        .catch(() => {});                      // silent fall back, never throw
    } catch {
      // Any spawn failure => silent fall back. Never propagate here.
    }
  };

  const loop = new AgentLoop({
    projectRoot,
    model: config.model,
    backend,
    systemPrompt,
    thresholds: {
      autoTriggerRatio: config.compaction.autoTriggerRatio,
      contextWindowTokens,
    },
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
      // After a run_shell result lands, trace it in the background for observability.
      runLayaTrace(command, output);
      (globalThis as any).__llamacli_ui?.pushToolResult(command, output);
    },
    onStatus: (s) => (globalThis as any).__llamacli_ui?.pushStatus(s),
    onContextUsage: (used, total) =>
      (globalThis as any).__llamacli_ui?.setContextUsedRatio(total > 0 ? Math.min(1, used / total) : 0),
    onPlanProgress: (done, total) => (globalThis as any).__llamacli_ui?.setPlanProgress(done, total),
    onCompactionStatus: (status, timestamp) => (globalThis as any).__llamacli_ui?.setCompactionStatus(status, timestamp),
    onCompactionDetail: (detail) => (globalThis as any).__llamacli_ui?.pushCompactionDetail(detail),
    onTurnStart: () => (globalThis as any).__llamacli_ui?.collapseDiffs(),
    layaGate: runLayaGate,
    // Gate results reach the TUI through App's dispatch (onGateVerdict →
    // pushGateLog), which keeps the gate line a single stable-id cumulative
    // summary across every fastcheck short-circuit.
    onGateVerdict: (result) => (globalThis as any).__llamacli_ui?.onGateVerdict(result),
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
          // /copy — the keyboard route to the same clipboard the drag-selection
          // writes to, and the one that works with the mouse off entirely.
          // Two forms:
          //   /copy            the whole visible log
          //   /copy N          the last N log rows
          // Deliberately reads the rows from the same buffer the drag uses, so
          // the two can never disagree about what "the log" is.
          // /reset — re-derive the model, the llama flags and the ports from
          // the CURRENT hardware, after asking.
          //
          // Asked rather than just done, because it discards machine-derived
          // settings: if the user hand-tuned `llama.contextSize` (to match a
          // larger -c on their server, say) that is thrown away and replaced
          // with what the hardware probe decided. The user's OWN keys — apiKey,
          // verify commands, the laya toggle — are deliberately kept; see
          // keepUserOwnedKeys for why losing one of those would be data loss
          // rather than a reset.
          case "reset": {
            const answer = await askYesNo(
              ui,
              "현재 시스템(GPU·VRAM·메모리)에 맞는 모델과 llama 설정을 다시 계산합니다.\n" +
                "지금까지의 모델/컨텍스트/스레드 설정은 덮어써집니다 (진행 후 재시작 필요).\n" +
                "계속하시겠습니까?",
            );
            if (!answer) {
              ui?.pushStatus("[reset] 취소했습니다.");
              break;
            }
            ui?.setBusy(true);
            try {
              // Phase markers, so a reset that takes a while (it measures the
              // backend, and may re-download a model) never looks frozen. Each
              // says what is about to happen AND what it is about to affect.
              ui?.pushStatus("[reset 1/4] 지금 시스템의 GPU·VRAM·메모리를 확인하고 있습니다…", "status");
              ui?.pushStatus("[reset 2/4] 백엔드 속도를 측정해 컨텍스트 크기를 정합니다… (수 초)", "status");
              const report = await ensureLocalStack({
                projectRoot,
                force: true,
                // Measure the backend rather than reading the hardware table, so
                // the llama settings reflect what this machine actually does —
                // including a throttled card, a fallback build, or a busy box.
                calibrate: true,
                // A stale laya is invisible AND poisonous: one left on :8000
                // while the config said :8099 made every gate call time out
                // while the UI reported the silence as a verdict. /reset kills
                // it and clears the venv, which re-running the config alone
                // could never do.
                resetLaya: true,
                log: (line) => ui?.pushStatus(`[reset] ${line}`),
              });
              const changed = describeReset(report.config, config as unknown as Record<string, unknown>);
              const layaNote = report.calibration?.degraded
                ? "속도 측정 불가 — 하드웨어 정보 기반으로 설정했습니다.\n"
                : "";
              // Say what is now in force, not only what changed: the useful
              // fact after a reset is which model and how big a context the
              // machine settled on.
              const nowInForce =
                `[reset 3/4] 적용된 설정\n` +
                `  · 모델: ${String((report.config as any)?.model ?? config.model)}\n` +
                `  · 컨텍스트: ${(report.tuning?.contextSize ?? 0).toLocaleString()} 토큰 ` +
                `(GPU ${report.tuning?.gpuLayers === 0 ? "미사용 (CPU)" : "오프로드"}, 스레드 ${report.tuning?.threads})\n` +
                (report.calibration && !report.calibration.degraded
                  ? `  · 측정: prefill ${report.calibration.throughput.promptTokensPerSecond.toFixed(0)} tok/s, ` +
                    `decode ${report.calibration.throughput.decodeTokensPerSecond.toFixed(1)} tok/s\n`
                  : "");
              ui?.pushStatus(
                changed.length > 0
                  ? `[reset 4/4] 완료. 바뀐 항목 ${changed.length}개:\n${changed.map((c) => `  · ${c}`).join("\n")}\n` +
                    nowInForce + layaNote +
                    "새 설정을 적용하려면 llamacli 를 재시작하세요."
                  : "[reset 4/4] 현재 시스템에 이미 최적이었습니다. 바뀐 항목이 없습니다.\n" +
                    nowInForce + layaNote +
                    "재시작할 필요도 없습니다."
              );
            } catch (err) {
              ui?.pushStatus(`[reset 실패] ${summarizeErrorForDisplay((err as any)?.message ?? String(err))}`);
            } finally {
              ui?.setBusy(false);
            }
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
          // "queue" is handled locally inside App (needs the live queue state).
          // laya: /fastcheck toggles the before-turn gate at runtime and runs
          // one-time ad-hoc questions. First word selects the sub-command;
          // anything else is treated as an ad-hoc question text (always works,
          // regardless of on/off state). The enable/disable/status branches are
          // delegated to the Python script so YAML is never hand-edited here.
          case "fastcheck": {
            // `argument` is the text typed after "/fastcheck" — a bare word
            // ("on"/"off"/"status") or an ad-hoc question. Split just once; the
            // rest is preserved verbatim for the ad-hoc-question path below.
            const tokens = argument.trim().split(/\s+/);
            const sub = (tokens[0] ?? "").toLowerCase();
            if (sub === "") {
              ui?.pushStatus(
                [
                  "/fastcheck — laya before-turn gate (see docs/fastcheck-toggle-directive.md)",
                  "  /fastcheck on            run a laya round-trip before each turn",
                  "  /fastcheck off           stop the gate immediately (no restart needed)",
                  "  /fastcheck status        show enabled state + integration health",
                  "  /fastcheck <question>    ask laya one time now, no matter on/off",
                ].join("\n")
              );
              break;
            }
            ui?.setBusy(true);
            try {
              if (sub === "on" || sub === "enable") {
                // Persist the choice to config.yaml FIRST so it survives a
                // restart — this is the whole point of editing YAML rather than
                // keeping a session-only flag. Warn but still proceed with the
                // round-trip below if the write fails.
                const persisted = await updateLayaEnabled(projectRoot, true);
                if (!persisted) {
                  ui?.pushStatus("[laya] could not write laya.enabled:true to config.yaml — add it manually to keep this enabled.");
                }
                runtimeEnabled = true;   // immediate: next turn already gated (this session)
                // Enabling also boots/installs the laya server (if missing) so the
                // feature works immediately. Enable first (so cmd_fastcheck's
                // enabled-gate passes and it proceeds to install/boot), then run the
                // fastcheck round-trip which surfaces install/boot progress + success
                // via pushStatus; on success we flip the gate on so the very next
                // turn is already System-1 gated.
                const enableResult = await runLayaScript(["enable"]);
                if (enableResult.stdout) {
                  ui?.pushStatus(enableResult.stdout);
                }
                // This specific call can trigger a real install (pip installing
                // laya[serve]) — the ordinary per-turn LAYA_TIMEOUT_MS (30s) is
                // nowhere near enough for that, see LAYA_INSTALL_TIMEOUT_MS's doc
                // comment. onLine pushes each progress line the moment it's
                // printed (see runLayaScript's doc comment) — reported directly
                // ("로그가 나오지 않는데?"): without this, nothing appeared for
                // however many minutes the install actually took.
                await runLayaScript(["fastcheck"], LAYA_INSTALL_TIMEOUT_MS, (line) => {
                  if (line.trim()) ui?.pushStatus(line);
                });
                runtimeEnabled = true;   // immediate: next turn already gated
              } else if (sub === "off" || sub === "disable") {
                // Persist the off choice too — symmetry with `on`.
                await updateLayaEnabled(projectRoot, false);
                runtimeEnabled = false;  // immediate no-op, incl. no health check
              } else if (sub === "status" || sub === "state") {
                await runLayaScript(["status"]);
              } else {
                // ad-hoc question: always works regardless of on/off state;
                // `argument` is the full verbatim text after "/fastcheck".
                await runLayaScript(["fastcheck", "--text", argument.trim()]);
              }
            } catch (err: any) {
              ui?.pushStatus(`[laya error] ${summarizeErrorForDisplay(err.message)}`);
            } finally {
              ui?.setBusy(false);
            }
            break;
          }
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
