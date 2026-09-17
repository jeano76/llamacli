import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_8GB_PROFILE } from "./backend/llamaServer.js";

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
};

export async function loadConfig(projectRoot: string): Promise<LlamacliConfig> {
  const path = join(projectRoot, ".llamacli", "config.yaml");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as Partial<LlamacliConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}
