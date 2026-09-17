import { spawn, ChildProcess } from "node:child_process";
import { OpenAICompatibleClient } from "./openaiClient.js";

export interface LlamaServerConfig {
  /** Path to the llama-server binary. */
  binPath: string;
  /** Path to the .gguf model file. */
  modelPath: string;
  host: string;
  port: number;
  contextSize: number;
  threads: number;
  gpuLayers: number;
}

/** 8GB RAM 환경 기본 프로파일: 과도한 ctx-size로 인한 OOM을 피하는 보수적 기본값. */
export const DEFAULT_8GB_PROFILE: Omit<LlamaServerConfig, "binPath" | "modelPath"> = {
  host: "127.0.0.1",
  port: 8081,
  contextSize: 8192,
  threads: 4,
  gpuLayers: 0,
};

/**
 * Manages a locally spawned `llama-server` subprocess and exposes it through
 * the same OpenAI-compatible client used for any remote backend. Callers
 * never talk HTTP or process management directly — go through this class.
 */
export class LlamaServerManager {
  private proc: ChildProcess | null = null;

  constructor(private config: LlamaServerConfig) {}

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(
      this.config.binPath,
      [
        "-m", this.config.modelPath,
        "--host", this.config.host,
        "--port", String(this.config.port),
        "-c", String(this.config.contextSize),
        "-t", String(this.config.threads),
        "-ngl", String(this.config.gpuLayers),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await this.waitUntilReady();
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  /** Connects to an already-running llama-server instead of spawning one. */
  static attachExisting(baseUrl: string): OpenAICompatibleClient {
    return new OpenAICompatibleClient(baseUrl);
  }

  client(): OpenAICompatibleClient {
    return new OpenAICompatibleClient(this.baseUrl);
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`);
        if (res.ok) return;
      } catch {
        // server not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("llama-server did not become ready within timeout");
  }
}
