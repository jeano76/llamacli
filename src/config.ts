import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { DEFAULT_8GB_PROFILE } from "./backend/llamaServer.js";
import { detectRunningServer, COMMON_PORTS } from "./backend/detect.js";

export interface LlamacliConfig {
  backend: "local-llama" | "openai-compatible";
  model: string;
  baseUrl?: string; // for openai-compatible / attach-existing
  apiKey?: string;
  llama?: {
    binPath: string;
    modelPath: string;
    port: number;
    contextSize: number;
    threads: number;
    gpuLayers: number;
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
  };
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
  detect: () => Promise<{ baseUrl: string; model: string } | null> = () => detectRunningServer()
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
    return {
      config: {
        ...DEFAULT_CONFIG,
        ...parsed,
        compaction: { ...DEFAULT_CONFIG.compaction, ...parsed.compaction },
      },
    };
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
