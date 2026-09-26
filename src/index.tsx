#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadConfig } from "./config.js";
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
import { spawn, ChildProcess } from "node:child_process";
import { buildVersionString } from "./tui/banner.js";
import { checkAndApplyUpdate, spawnRestart } from "./selfUpdate.js";
import { supportsAnsiTui } from "./tui/ansiSupport.js";

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
 */
function enterAltScreen(): void {
  // Reported directly: on a terminal that doesn't actually interpret ANSI
  // escapes (legacy Windows cmd.exe, a WSL window whose console didn't
  // negotiate VT mode, output piped through something that mangles control
  // sequences), these bytes show up as literal stray characters instead of
  // switching screens — see ansiSupport.ts's doc comment. Skip entirely
  // rather than risk it; the app still works, just without the alt-screen
  // origin-stability/scrollback niceties described below.
  if (!supportsAnsiTui()) return;
  // Also turn on mouse reporting (button events, SGR encoding) so the
  // wheel scrolls the log — the alt screen has no native scrollback, and
  // PageUp/PageDown alone was reported as not enough. Side effect: the
  // terminal's own click-drag text selection needs Shift held while this
  // is on (standard for mouse-aware terminal apps).
  process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
}

function exitAltScreen(): void {
  if (!supportsAnsiTui()) return;
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
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
  await maybeSelfUpdateAndRestart();
  await ensureSingleInstance();
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

  const projectRoot = process.cwd();
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
  /** Default cap, seconds, for a laya round-trip when config.yaml doesn't set
   *  `laya.timeoutSeconds`. A hung server must never block a turn. */
  const DEFAULT_LAYA_TIMEOUT_SECONDS = 30;
  const LAYA_TIMEOUT_MS = (config.laya?.timeoutSeconds ?? DEFAULT_LAYA_TIMEOUT_SECONDS) * 1000;
  const layaScriptPath = pathResolve(projectRoot, "scripts/laya_integration.py");

  /** Spawn the laya integration script with a hard timeout. All config writes,
   *  server boot and health checks live in Python; Node only runs it and reads
   *  stdout, killing the process if it outlives LAYA_TIMEOUT_MS so a hung script
   *  can never wedge the TUI or block a turn. Resolves with stdout on success
   *  (exit 0) and rejects otherwise — callers catch everything. */
  const runLayaScript = (args: string[]): Promise<{ stdout: string }> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const child: ChildProcess = spawn("python3", [layaScriptPath, ...args], {
        timeout: LAYA_TIMEOUT_MS,
      });
      // `child.kill(timeout:true)` is Node < 18.0 semantics; use a manual timer
      // that kills the process and resolves as an error so callers treat it like
      // any other failure (silent fall back — Ornith still runs).
      timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`laya script timed out after ${LAYA_TIMEOUT_MS}ms`));
      }, LAYA_TIMEOUT_MS);

      let out = "";
      child.on("error", (err) => {
        if (!settled) { clearTimeout(timer); settled = true; reject(err); }
      });
      child.stdout?.on("data", (d: Buffer) => { out += String(d); });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Only treat exit code 0 as success; anything else is a silent fall
          // back so the normal turn proceeds unchanged.
          code === 0 ? resolve({ stdout: out }) : reject(new Error(`laya script exited with code ${code}`));
        }
      });
    });

  const runLayaGate = async (userText: string): Promise<void> => {
    if (!runtimeEnabled) return;              // off => instant no-op (no checks)
    try {
      await runLayaScript(["fastcheck", "--text", userText]);
      // On success the script has already surfaced laya's verdict to the TUI via
      // its own stdout capture; nothing more to push here.
    } catch {
      // Any failure (nonzero exit, timeout, spawn error) => silent fall back:
      // Ornith still runs the turn unchanged. Never throw past here.
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
            const lines = SLASH_MENU_ITEMS.map((i) => `${i.label.padEnd(10)} ${i.description}`);
            ui?.pushStatus(
              [
                "Available slash commands:",
                ...lines,
                "",
                "When context usage hits the threshold, compaction runs automatically and work resumes on its own afterward.",
              ].join("\n")
            );
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
                // enable takes no argument; the script decides install guidance.
                await runLayaScript(["enable"]);
                runtimeEnabled = true;   // immediate: next turn already gated
              } else if (sub === "off" || sub === "disable") {
                await runLayaScript(["disable"]);
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
    { exitOnCtrlC: false }
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
