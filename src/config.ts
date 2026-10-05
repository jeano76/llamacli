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
    /** Calibration key (model@context@gpu) already trialled; see setup/calibrate.ts. */
    calibratedFor?: string;
    flashAttn?: boolean;
    cacheTypeK?: string;
    cacheTypeV?: string;
    /**
     * `-c` in llama.cpp is the TOTAL context across all slots, not per-slot
     * (`llama-context.cpp:294`: `n_ctx_seq = n_ctx / n_seq_max`). This field
     * means PER-SLOT — it is what the tuning layer's VRAM budget is sized
     * against and what compaction thresholds are derived from — so
     * `buildServerArgs` multiplies it by `parallel` when writing the real flag.
     * Without that, raising `parallel` silently halves the working context.
     */
    parallel?: number;
    /**
     * Speculative decoding: `--spec-type`, a comma-separated list.
     *
     * Speculation exists to cut DECODE latency, which is ~100% of compaction
     * latency (the summary's prompt is served from llama-server's prompt cache,
     * so everything after it is generation). The model-free methods —
     * `ngram-mod`, `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-cache`
     * — need no draft checkpoint, which matters because those require a
     * separately trained draft for this exact target model.
     *
     * Off by default: the gain is workload-dependent and MUST be measured, and
     * a wrong value here costs throughput rather than only latency. See
     * `llama.speculativeDraftNMax` for the draft-length knob.
     */
    speculativeTypes?: string;
    /**
     * `--spec-draft-n-max`: how many tokens the speculative method proposes per
     * step. llama.cpp's own default is 3; sweep 4/8/16 when tuning. Larger
     * values propose more per verification pass but are accepted less often at
     * later positions, so throughput can flatten or regress.
     */
    speculativeDraftNMax?: number;
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
    /**
     * Where a successful compaction lands, as a fraction of the trigger
     * level (default 0.4). Lower = longer until the next compaction,
     * keeping less recent history verbatim. See loop.ts postCompactionBudget.
     */
    postCompactionTargetRatio?: number;
    /**
     * Minimum NEW growth since the last compaction (fraction of window,
     * default 0.05) before another auto-compaction may fire. Prevents a
     * compaction-every-step loop when fixed overhead leaves little room.
     * Overflow-retry still compacts directly.
     */
    minGrowthFraction?: number;
    /**
     * Wall-clock ceiling for the summary generation, in milliseconds. Unset /
     * 0 = no ceiling, which is the historical behavior.
     *
     * `summaryMaxTokens` bounds the summary in TOKENS, which makes its latency
     * a function of a decode rate that varies by an order of magnitude across
     * the machines this runs on (38 tok/s measured on the 8 GB RTX 2070 box,
     * ~300 tok/s on a fully-offloaded 24 GB card). So a token budget tuned on
     * one machine is a 27-second wait on one and a 3-second wait on the other,
     * and the thing the user actually experiences — "how long am I staring
     * at this" — has no bound at all on any machine.
     *
     * This puts a bound on the thing being bounded. When the deadline passes,
     * the summary request is aborted and whatever text arrived so far becomes
     * the summary (compactor.ts's trimPartialSummary drops the trailing
     * half-sentence so the model never resumes mid-clause). A partial summary
     * compresses a 14k-token history less well than a complete one, which
     * means compaction fires again sooner — so this trades summary detail and
     * compaction frequency for a hard latency ceiling, and the right value is
     * a judgement call. Leave it unset if you would rather have the best
     * summary and accept however long it takes.
     *
     * 20_000 ms is suggested as a starting point on slow hardware (roughly
     * where a 1024-token summary at 38 tok/s would finish anyway, so it costs
     * nothing there and bounds the machines that are far slower).
     */
    summaryDeadlineMs?: number;
    /**
     * Run compaction during the idle gap BETWEEN turns at this fraction of the
     * context window, instead of only when `autoTriggerRatio` is crossed
     * mid-turn. Unset = disabled.
     *
     * A compaction fired at the trigger interrupts a live turn: the user is
     * looking at a frozen UI for the summary's whole generation (measured
     * 4.3-13.6 s per compaction on the reference box, more at a larger
     * summary budget). This threshold fires the same work while the UI is idle
     * waiting for the next message, so it stops being a wait.
     *
     * It does NOT make compaction cheaper — the summary is still generated
     * either way. It changes only WHEN. Set it near `autoTriggerRatio` (e.g.
     * 0.5 against a 0.7 trigger) to catch most of the benefit while barely
     * changing how often compaction runs.
     *
     * The trade, stated plainly: a lower threshold summarizes a SHORTER
     * conversation, so the summary is a little worse and the next compaction
     * arrives sooner. This is a quality-for-latency exchange, which is why it
     * is opt-in and why the number belongs in config rather than in code.
     */
    warmTriggerRatio?: number;
    /**
     * Warm-prefill the prompt cache after an idle-gap (warm) compaction.
     * Unset/false = off, which is the historical behavior.
     *
     * What it does: a compaction rewrites the system message, so the next
     * turn's whole context misses the server's prompt cache and pays a full
     * re-prefill (tens of seconds on a large window — the larger half of what
     * a compaction actually costs the user; see
     * docs/compaction-invisibility-investigation.md §2). When this is on, the
     * idle gap that just ran a warm compaction also sends the compacted
     * conversation once with `max_tokens: 1`, so the next real turn only
     * prefills its own new message. The request is cancelled the moment new
     * input arrives, and any failure is swallowed — the fallback is exactly
     * today's behavior.
     *
     * Two honest caveats. First, it occupies the single inference slot for
     * the length of that prefill, so on a server shared with other sessions
     * or processes it can delay someone else's turn the way any long request
     * would — leave it off there. Second, like warmTriggerRatio itself, this
     * moves cost rather than removing it; what it removes is the user's wait,
     * not the work.
     */
    warmPrefill?: boolean;
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
     *  of a 16,384-token window — an 11-tool schema on a previous tokenizer;
     *  re-measured 2026-10-04 as 1,002 for the 12-tool schema on Ornith.
     *  Token counts are tokenizer-dependent. Neither number changes the
     *  conclusion, which is why this stays opt-in.) So a session that never starts a
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
