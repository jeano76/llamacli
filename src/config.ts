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
  compaction: { autoTriggerRatio: 0.85 },
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
    return { config: { ...DEFAULT_CONFIG, ...parsed } };
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
