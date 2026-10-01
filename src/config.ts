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
  /** Explicit model file, when the user wants one particular GGUF rather than
   *  whatever the Hub currently publishes for the chosen family. Takes
   *  precedence over model acquisition on a first run. */
  modelPath?: string;
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
    /**
     * The rest of the machine-derived tuning. Every field here is computed by
     * the bootstrap AND handed to the spawned process — the two used to drift,
     * leaving values in config.yaml that no server was ever started with.
     *
     * `cpuMoeLayers` is the one that matters most: without it a 35B MoE model
     * does not fit a small card at all.
     */
    threadsBatch?: number;
    batchSize?: number;
    ubatchSize?: number;
    cpuMoeLayers?: number;
    flashAttn?: boolean;
    cacheTypeK?: string;
    cacheTypeV?: string;
    parallel?: number;
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
    /**
     * Generation budget for the summary, in tokens.
     *
     * This number IS the compaction's latency. Measured against the real
     * backend (38 tok/s decode, with the prefill served from the prompt cache),
     * 1024 is ~27 s and the old window-derived 4096 was ~107 s for the same
     * work. Defaults to 1024; raise it if summaries are losing detail you
     * need, lower it for a faster/terser summary.
     */
    summaryMaxTokens?: number;
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
   *  before its actual answer/tool call. Defaults to TRUE.
   *
   *  It used to default false, and the recorded reason was a real measurement
   *  — but the measurement was misread. What was actually observed:
   *
   *    same prompt, same model, varying the reply budget:
   *      420  -> thinking on: 1874 chars reasoning, 0 content, finish=length
   *      420  -> thinking off: 293 chars content, finish=stop
   *      1024 -> thinking on: reasoning AND content, finish=stop
   *
   *  The failure was never "thinking is expensive" — it was that `max_tokens`
   *  had no allowance for reasoning, and reasoning is drawn from the same budget
   *  and spent first. A 420-token budget cannot hold both. `computeMaxTokens`
   *  now reserves THINKING_TOKEN_ALLOWANCE and lifts the floor to 1,024 when
   *  this is on, so the starvation the old default was avoiding no longer
   *  happens; with that fixed, disabling it by default only removed deliberation
   *  that was working correctly at any reasonable budget.
   *
   *  Set false to turn it off, which also keeps `enable_thinking: false` out
   *  of requests and hides reasoning from the log. Note that a server started
   *  with `--reasoning on` emits reasoning regardless of this setting. */
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

/** Path to this project's config.yaml, so callers can read/write it directly
 *  without re-deriving the join(). */
export function configPath(projectRoot: string): string {
  return join(projectRoot, ".llamacli", "config.yaml");
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

    // Persisting the generated config is best-effort, exactly as the read
    // above is. It used to be an unguarded `mkdir` + `writeFile` inside the
    // catch block, so a project directory that cannot be written to — a
    // read-only mount, a checkout owned by another user, a container running
    // as a non-owner — made EVERY launch reject with EACCES. That is a much
    // worse failure than the one it was handling: the file being missing is
    // handled fine, and the generated config is only a convenience.
    //
    // Found by a project-axis sweep (100 project states). The session must
    // still start; the user is told the setting was not saved rather than
    // being shown a stack trace.
    let saved = true;
    try {
      await mkdir(join(projectRoot, ".llamacli"), { recursive: true });
      await writeFile(path, stringify(config), "utf8");
    } catch {
      saved = false;
    }

    const setupMessage = !saved
      ? `[setup] No .llamacli/config.yaml found, and this project directory is not writable, so the generated config could not be saved. ` +
        `llamacli is using in-memory defaults for this session only — they will be re-derived on every launch. ` +
        `Run llamacli in a directory you own, or make this one writable, to persist them.`
      : detected
      ? `[setup] No .llamacli/config.yaml found — detected a running server at ${detected.baseUrl} and created one pointing at it.`
      : `[setup] No .llamacli/config.yaml found and no local server detected on common ports (${COMMON_PORTS.join(", ")}). ` +
        `Created a placeholder — edit .llamacli/config.yaml to point at your backend.`;

    return { config, setupMessage };
  }
}
