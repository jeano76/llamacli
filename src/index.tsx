#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadConfig } from "./config.js";
import { loadRules, loadSkillIndex, injectRulesIntoSystemPrompt, injectSkillIndexIntoSystemPrompt } from "./skills/loader.js";
import { SLASH_MENU_ITEMS } from "./tui/SlashMenu.js";
import { LlamaServerManager } from "./backend/llamaServer.js";
import { OpenAICompatibleClient } from "./backend/openaiClient.js";
import { AgentLoop } from "./agent/loop.js";
import { configureBrowserTools, configureSkills } from "./tools/index.js";
import { isBrowserAvailable } from "./tools/browser.js";
import { loadPromptHistory, savePromptHistory } from "./tui/promptHistory.js";
import { readCheckpoint, clearCheckpoint } from "./compaction/checkpoint.js";

const BASE_SYSTEM_PROMPT = `You are llamacli, a coding agent running on a local llama.cpp backend.
Always follow the fundamentals of a strong software architect: minimal diffs, respect existing
conventions, never make unverified changes, and confirm before destructive commands.

When starting a task that needs multiple steps, declare them with the update_plan tool, and
update each step's status (todo/in_progress/done) as it starts or finishes. This plan survives
context compaction, so work can resume accurately after it.`;

// Only appended when the browser tools are actually enabled (config.yaml's
// browser.enabled). Describing tools the model wasn't given is both
// confusing and a pure token cost — the point of the toggle is to stop
// paying for browser support in the (usual) sessions that never use it.
const BROWSER_SYSTEM_PROMPT = `

You can also remotely control a browser the user already has running with
--remote-debugging-port, via browser_list_tabs / browser_navigate / browser_eval /
browser_screenshot. These attach to an existing tab only — never assume a browser is running,
and never try to launch one yourself.`;

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
  process.stdout.write("\x1b[?1049h");
}

function exitAltScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

async function main() {
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
    injectRulesIntoSystemPrompt(BASE_SYSTEM_PROMPT + (browserEnabled ? BROWSER_SYSTEM_PROMPT : ""), rules),
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
    onAssistantDelta: (t) => (globalThis as any).__llamacli_ui?.pushAssistantDelta(t),
    onAssistantDone: () => (globalThis as any).__llamacli_ui?.finalizeAssistant(),
    onToolCall: (name, args) => (globalThis as any).__llamacli_ui?.pushTool(`[tool] ${name} ${args}`),
    onDiff: (_path, diff) => (globalThis as any).__llamacli_ui?.pushDiff(diff),
    onStatus: (s) => (globalThis as any).__llamacli_ui?.pushStatus(s),
    onContextUsage: (used, total) =>
      (globalThis as any).__llamacli_ui?.setContextUsedRatio(total > 0 ? Math.min(1, used / total) : 0),
    onPlanProgress: (done, total) => (globalThis as any).__llamacli_ui?.setPlanProgress(done, total),
    onCompactionStatus: (status, timestamp) => (globalThis as any).__llamacli_ui?.setCompactionStatus(status, timestamp),
  });

  // Session-end self-improvement gate (PROMPT.md §3): if failures were
  // logged and never reviewed, /quit shows the proposal instead of exiting —
  // a second /quit confirms. Applying the proposal (if any) always requires
  // the separate explicit /improve-apply, never happens on quit itself.
  let quitConfirmed = false;

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
          return;
        }
        ui?.setBusy(true);
        loop
          .resumeIfCheckpointExists()
          .catch((err: any) => ui?.pushStatus(`[error] failed to resume from checkpoint: ${err.message}`))
          .finally(() => ui?.setBusy(false));
      }}
      onForceQuit={() => {
        const ui = (globalThis as any).__llamacli_ui;
        // Mid-turn: cancel it (aborts the backend request, writes a
        // resumable checkpoint) — matches the busy-specific path this used
        // to be. Idle: save whatever conversation exists so far, the same
        // mechanism /quit's own save-before-exit already uses. Either way,
        // this is the "force" exit: no self-improvement-proposal gate (see
        // AppProps.onForceQuit's doc comment) — just save and go.
        const save = ui?.isBusy?.() ? loop.cancelCurrentTurn() : loop.saveStateOnQuit();
        save
          .catch((err: any) => ui?.pushStatus(`[couldn't save progress: ${err.message}] quitting anyway.`))
          .finally(() => {
            ui?.setBusy(false);
            unmount();
            // Reported live: force-quit appeared to work (the status line
            // logged, Y/N dialog closed) but the process itself kept
            // running and kept accepting/processing input afterward.
            // unmount() only tears down the Ink render tree and releases
            // stdin's raw-mode listener — it does NOT call process.exit(),
            // and a lingering open handle (node-fetch's keep-alive
            // connection pool, an in-flight timer) is enough to keep
            // Node's event loop alive indefinitely on its own. The
            // SIGINT/SIGTERM handlers above already call process.exit(0)
            // explicitly for exactly this reason — this path needs the
            // same explicit call, not just unmount() on its own.
            process.exit(0);
          });
      }}
      onSubmit={async (text) => {
        const ui = (globalThis as any).__llamacli_ui;
        ui?.setBusy(true);
        try {
          await loop.send(text);
        } catch (err: any) {
          // Defensive: AgentLoop already catches expected backend/compaction
          // failures internally, but nothing here should ever be allowed to
          // crash the whole TUI process over an unexpected error.
          ui?.pushStatus(`[error] ${err.message}`);
        } finally {
          ui?.setBusy(false);
        }
      }}
      onSlashCommand={(key) => {
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
              ui?.pushStatus("[saving progress before quitting...]");
              loop
                .saveStateOnQuit()
                .catch((err: any) => ui?.pushStatus(`[couldn't save progress: ${err.message}] quitting anyway.`))
                .finally(() => {
                  unmount();
                  // Reported live (via the sibling onForceQuit path, same
                  // bug applies here): unmount() alone tears down the Ink
                  // render tree but does NOT terminate the Node process —
                  // a lingering open handle (node-fetch's keep-alive pool,
                  // an in-flight timer) is enough to keep it running
                  // indefinitely, silently accepting/processing further
                  // input even though /quit appeared to have worked. The
                  // SIGINT/SIGTERM handlers above already call
                  // process.exit(0) explicitly for exactly this reason.
                  process.exit(0);
                });
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
              .catch((err: any) => ui?.pushStatus(`[self-improvement analysis failed] ${err.message}`));
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
              .catch((err: any) => ui?.pushStatus(`[compaction failed] ${err.message}`))
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
              .catch((err: any) => ui?.pushStatus(`[self-improvement analysis failed] ${err.message}`));
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
              .catch((err: any) => ui?.pushStatus(`[rule save failed] ${err.message}`));
            break;
          case "plan-clear":
            loop
              .clearPlan()
              .then(() => ui?.pushStatus("Plan progress cleared."))
              .catch((err: any) => ui?.pushStatus(`[error] failed to clear plan: ${err.message}`));
            break;
          // "queue" is handled locally inside App (needs the live queue state).
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
