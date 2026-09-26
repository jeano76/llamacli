import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { DEFAULT_8GB_PROFILE } from "./backend/llamaServer.js";
import { detectRunningServer, detectModelAt, COMMON_PORTS } from "./backend/detect.js";

export interface LlamacliConfig {
  backend: "local-llama" | "openai-compatible";
  model: string;
  baseUrl?: string; // for openai-compatible / attach-existing
  apiKey?: string;
  /** repeat_penalty sent with every chat request (see loop.ts's
   *  AgentLoopOptions.repeatPenalty for why this isn't left unset).
   *  Defaults to 1.1. */
  repeatPenalty?: number;
  llama?: {
    binPath: string;
    modelPath: string;
    port: number;
    contextSize: number;
    threads: number;
    gpuLayers: number;
  };
  /** Checks run after each file edit, keyed "*.ext" → command with {file}
   *  (merged over the built-in ones in agent/harness.ts), or false to turn
   *  them off. */
  verify?: {
    afterEdit?: Record<string, string> | false;
  };
  /** Aider-style auto-commit of each successful edit. Off by default — see
   *  agent/gitCheckpoint.ts's doc comment. */
  checkpoint?: {
    git?: boolean;
  };
  compaction: {
    autoTriggerRatio: number;
    /** Auto-continue past a compaction that interrupts a tool call mid-turn
     *  instead of stopping and waiting for the user to type another
     *  message. See loop.ts's AgentLoopOptions.autoResume. */
    autoResume: boolean;
  };
  /** Remote debugging (Chrome DevTools Protocol) for the browser tools —
   *  connects to an already-running Chrome/Chromium started with
   *  --remote-debugging-port, never launches one itself. */
  browser?: {
    debugPort: number;
    host?: string;
    /** Whether to offer the 4 browser tools to the model.
     *
     *  LEFT UNSET (the default) this is AUTOMATIC: llamacli probes the
     *  debug port at startup and offers the tools only if a debuggable
     *  browser actually answers. They're useless without one — every call
     *  would just fail with "couldn't reach the browser debug port" —
     *  while still costing ~400-500 prompt tokens on EVERY request for
     *  their schema (measured: the full tool schema is 1,238 tokens, 7.6%
     *  of a 16,384-token window). So a session that never starts a
     *  debuggable browser never pays for them, and one that does gets
     *  them with no configuration at all.
     *
     *  Set explicitly to force it either way (true: offer them even if
     *  the probe fails, e.g. a browser started later in the session;
     *  false: never offer them). */
    enabled?: boolean;
  };
  /** Whether to let the model emit chain-of-thought (`reasoning_content`)
   *  before its actual answer/tool call. Defaults to FALSE — measured
   *  directly against the real backend, and it is the root cause behind a
   *  long run of "the model never finished writing the file" failures:
   *
   *    same 420-token budget, same prompt:
   *      thinking on  -> 420 reasoning_content deltas, 0 tool_calls deltas
   *      thinking off ->   0 reasoning_content deltas, 362 tool_calls deltas
   *
   *  With it on, the model spent the ENTIRE max_tokens budget on thinking
   *  and never even began the tool call — so nothing was written, nothing
   *  could be salvaged (there were no tool_call deltas to recover), and
   *  the UI showed nothing at all while it happened (llamacli renders
   *  `content` deltas, not `reasoning_content`), which is what "it looks
   *  stuck" actually was. llama-server itself warns about this at startup:
   *  "chat template supports preserving reasoning, it is enabled by
   *  default (may use more tokens, disable via --no-reasoning-preserve)".
   *
   *  Set true to opt back in (a model/task where visible deliberation is
   *  worth the budget); llamacli then also streams the reasoning to the UI
   *  rather than going silent. */
  enableThinking?: boolean;
}

export const DEFAULT_CONFIG: LlamacliConfig = {
  backend: "local-llama",
  model: "local-model",
  // Found via real monitoring data: with the previous 0.85, the worst case
  // (a max_tokens-length reply landing right after the threshold check
  // passes) is 0.85 + 0.25 (max_tokens' own fraction of the window, see
  // loop.ts) = 1.10 — i.e. a single turn could overshoot the REAL context
  // window by up to 10%, which is exactly the failure the context-overflow
  // auto-retry (loop.ts) exists to recover from. Observed directly: usage
  // reached 89% of the window in one real turn. Lowering to 0.70 (0.70 +
  // 0.25 = 0.95) keeps a real margin under 100% even in that worst case,
  // so the overflow-retry safety net is rarely needed rather than routinely
  // relied on. Trades slightly more frequent compaction for that.
  compaction: { autoTriggerRatio: 0.7, autoResume: true },
  llama: {
    binPath: "llama-server",
    modelPath: "",
    port: DEFAULT_8GB_PROFILE.port,
    contextSize: DEFAULT_8GB_PROFILE.contextSize,
    threads: DEFAULT_8GB_PROFILE.threads,
    gpuLayers: DEFAULT_8GB_PROFILE.gpuLayers,
  },
  browser: { debugPort: 9222, host: "127.0.0.1" },
};

export interface LoadConfigResult {
  config: LlamacliConfig;
  /** Set only when no config.yaml existed yet and one was just generated —
   *  a human-readable note (what was auto-detected, or what needs manual
   *  setup) meant for a one-time startup status message. */
  setupMessage?: string;
}

export async function loadConfig(
  projectRoot: string,
  // Overridable for tests, so they don't depend on what's actually running
  // on this machine's common ports (on the dev machine this project was
  // built on, 8080 is a real, permanently-running server).
  detect: () => Promise<{ baseUrl: string; model: string } | null> = () => detectRunningServer(),
  // Overridable for tests, same reason. Only called for an *existing*
  // openai-compatible config — see below.
  detectModel: (baseUrl: string) => Promise<string | null> = detectModelAt
): Promise<LoadConfigResult> {
  const path = join(projectRoot, ".llamacli", "config.yaml");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as Partial<LlamacliConfig>;
    // A plain top-level spread would let an existing config.yaml that
    // predates a new compaction field (e.g. old files only have
    // autoTriggerRatio) silently drop that field's default entirely,
    // since `parsed.compaction` — present but incomplete — replaces
    // DEFAULT_CONFIG.compaction wholesale instead of filling the gap.
    // Caught adding autoResume: every project's pre-existing
    // .llamacli/config.yaml would otherwise load with autoResume
    // `undefined` (falsy) instead of the intended default of `true`.
    const config: LlamacliConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      compaction: { ...DEFAULT_CONFIG.compaction, ...parsed.compaction },
    };

    // The `model` field in config.yaml is a cache, not the source of
    // truth — it's whatever was detected (or hand-edited) the last time
    // this file was written, and goes stale the moment the server's
    // loaded model changes (a quant swap, a checkpoint switch). For
    // openai-compatible backends the server itself always knows the
    // current model, so re-ask it on every load and prefer that live
    // value; only fall back to the stored one if the server's
    // unreachable (offline use, server not started yet).
    if (config.backend === "openai-compatible" && config.baseUrl) {
      const liveModel = await detectModel(config.baseUrl);
      if (liveModel) config.model = liveModel;
    }

    return { config };
  } catch {
    // No config yet in this project. Rather than silently falling back to
    // a default backend URL that's usually dead (this exact gap caused an
    // ECONNREFUSED crash on a machine that actually had a real server
    // running on a different port), probe for one and generate a real
    // config from it — same "reuse what's there, else generate our own
    // default" pattern already used for rules/skills (PROMPT.md §5).
    const detected = await detect();
    const config: LlamacliConfig = detected
      ? { ...DEFAULT_CONFIG, backend: "openai-compatible", baseUrl: detected.baseUrl, model: detected.model }
      : DEFAULT_CONFIG;

    await mkdir(join(projectRoot, ".llamacli"), { recursive: true });
    await writeFile(path, stringify(config), "utf8");

    const setupMessage = detected
      ? `[setup] No .llamacli/config.yaml found — detected a running server at ${detected.baseUrl} and created one pointing at it.`
      : `[setup] No .llamacli/config.yaml found and no local server detected on common ports (${COMMON_PORTS.join(", ")}). ` +
        `Created a placeholder — edit .llamacli/config.yaml to point at your backend.`;

    return { config, setupMessage };
  }
}
