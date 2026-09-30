import { spawn, ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { OpenAICompatibleClient } from "./openaiClient.js";

/** Size of a file, or 0 when it cannot be read. */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

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
  /** `-tb`: prompt-processing threads. Separate from `-t` because prefill is a
   *  large batched matmul with a very different thread-scaling curve. */
  threadsBatch?: number;
  /** `-b`: logical batch size. */
  batchSize?: number;
  /** `-ub`: physical batch size. */
  ubatchSize?: number;
  /**
   * `--n-cpu-moe N`: how many MoE expert layers to keep in system RAM.
   *
   * This is the single most important flag for a small-VRAM card running a
   * Mixture-of-Experts model, and it is why an 8 GB card can run a 35B-A3B at
   * all: only the ~3B "active" parameters must be resident in VRAM, and the
   * rest streams from RAM. Omitting it on such a machine is not a tuning
   * difference, it is an out-of-memory at load.
   *
   * 0 / undefined means "do not pass the flag" — llama.cpp's own default, and
   * the right thing on a card with VRAM to spare.
   */
  cpuMoeLayers?: number;
  /** `-fa`: flash attention. */
  flashAttn?: boolean;
  /** `--cache-type-k`. q8_0 halves the KV cache versus f16 at a speed cost
   *  small enough to be invisible; on a small card that is often the
   *  difference between 16k of context and 32k. */
  cacheTypeK?: string;
  /** `--cache-type-v`. */
  cacheTypeV?: string;
  /** `-np`: concurrent slots. A coding agent is one conversation per process,
   *  and every extra slot multiplies the KV cache and batch buffers. */
  parallel?: number;
}

/** 8GB RAM 환경 기본 프로파일: 과도한 ctx-size로 인한 OOM을 피하는 보수적 기본값. */
export const DEFAULT_8GB_PROFILE: Omit<LlamaServerConfig, "binPath" | "modelPath"> = {
  host: "127.0.0.1",
  port: 8080,
  contextSize: 8192,
  threads: 4,
  gpuLayers: 0,
};

/**
 * Builds the argv for a llama-server child.
 *
 * Split out and pure so the flag list is testable without a real binary. Every
 * flag the tuning layer computes is translated here, which is the point: the
 * previous version passed six of fourteen, which meant `--n-cpu-moe` — the flag
 * that makes a 35B MoE model loadable on a small card at all — was computed,
 * written to config.yaml, displayed back to the user, and then silently never
 * handed to the process.
 *
 * Optional flags are omitted rather than defaulted, so llama.cpp's own defaults
 * apply instead of this module inventing a value for them.
 */
export function buildServerArgs(config: LlamaServerConfig): string[] {
  const args = [
    "-m", config.modelPath,
    "--host", config.host,
    "--port", String(config.port),
    "-c", String(config.contextSize),
    "-t", String(config.threads),
    "-ngl", String(config.gpuLayers),
  ];
  if (config.threadsBatch !== undefined) args.push("-tb", String(config.threadsBatch));
  if (config.batchSize !== undefined) args.push("-b", String(config.batchSize));
  if (config.ubatchSize !== undefined) args.push("-ub", String(config.ubatchSize));
  // Only when positive: `--n-cpu-moe 0` is llama.cpp's default, and passing it
  // explicitly would make a server that intends full GPU offload
  // indistinguishable from one that never touched the flag.
  if (config.cpuMoeLayers !== undefined && config.cpuMoeLayers > 0) {
    args.push("--n-cpu-moe", String(config.cpuMoeLayers));
  }
  if (config.flashAttn !== undefined) args.push("-fa", config.flashAttn ? "on" : "off");
  if (config.cacheTypeK) args.push("--cache-type-k", config.cacheTypeK);
  if (config.cacheTypeV) args.push("--cache-type-v", config.cacheTypeV);
  if (config.parallel !== undefined) args.push("-np", String(config.parallel));
  return args;
}

/** How long to wait for a spawned server to answer.
 *
 *  A model load is not a startup. Loading a 21 GB GGUF from USB takes minutes,
 *  and llama-server serves nothing — not even /v1/models — until the weights
 *  are resident. The previous 30 s timeout was shorter than a real load on the
 *  machine this was written for, so a correctly-configured server was reported
 *  as "did not become ready" and, worse, left running as an orphan holding
 *  VRAM. The budget scales with the model so a small model still fails fast.
 */
export function readyTimeoutMs(modelBytes: number): number {
  const GB = 1024 ** 3;
  // 30 s of fixed overhead, plus 4 s per GB, floored at 5 minutes: the fastest
  // possible case (a 5 GB model fully resident) still gets a generous margin
  // over the previous 30 s, and a 21 GB model gets ~2.5 minutes.
  return Math.max(5 * 60_000, 30_000 + (modelBytes / GB) * 4_000);
}

/**
 * Manages a locally spawned `llama-server` subprocess and exposes it through
 * the same OpenAI-compatible client used for any remote backend. Callers
 * never talk HTTP or process management directly — go through this class.
 */
export class LlamaServerManager {
  private proc: ChildProcess | null = null;
  /** Rolling tail of the child's output. A pipe nobody reads fills its buffer
   *  (64 KiB on Linux) and then BLOCKS the child mid-load, which presents as a
   *  server that never becomes ready for no visible reason. Draining into a
   *  bounded buffer fixes the hang and still leaves the last lines available to
   *  explain a failure. */
  private log: string[] = [];
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private spawnError: Error | null = null;
  /** Set when this manager owns the child, so an exit handler can reap it. */
  private installedExitHook = false;

  constructor(private config: LlamaServerConfig) {}

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.exited = null;
    this.spawnError = null;
    this.log = [];

    this.proc = spawn(this.config.binPath, buildServerArgs(this.config), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 'error' fires when the binary is missing or not executable. Without a
    // listener it is an unhandled 'error' event, which takes the whole process
    // down with an opaque stack instead of a message naming the path.
    this.proc.on("error", (err) => {
      this.spawnError = err;
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = { code, signal };
    });
    for (const stream of [this.proc.stdout, this.proc.stderr]) {
      stream?.on("data", (chunk: Buffer) => this.appendLog(chunk.toString("utf8")));
      // 'error' on a pipe (EPIPE when the child dies first) is also fatal if
      // unhandled, and says nothing useful.
      stream?.on("error", () => {});
    }

    // A spawned child must not outlive us: llama-server holds the model in
    // VRAM, so an orphan from a crashed session is the direct cause of the
    // next session OOMing. Registered once, and removed in stop().
    if (!this.installedExitHook) {
      const reap = () => this.stop();
      process.once("exit", reap);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, reap);
      }
      this.installedExitHook = true;
    }

    await this.waitUntilReady();
  }

  stop(): void {
    if (this.proc && this.exited === null) {
      this.proc.kill();
    }
    this.proc = null;
  }

  /** Connects to an already-running llama-server instead of spawning one. */
  static attachExisting(baseUrl: string): OpenAICompatibleClient {
    return new OpenAICompatibleClient(baseUrl);
  }

  client(): OpenAICompatibleClient {
    return new OpenAICompatibleClient(this.baseUrl);
  }

  /** The child's recent output, for error messages. */
  logTail(lines = 20): string {
    return this.log.slice(-lines).join("").trim();
  }

  private appendLog(text: string): void {
    // Bounded: a long-running server logs for hours, and this buffer exists to
    // explain a failure, not to archive a session.
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.log.push(text);
  }

  private async waitUntilReady(): Promise<void> {
    const budget = readyTimeoutMs(await fileSize(this.config.modelPath));
    const start = Date.now();
    while (Date.now() - start < budget) {
      // The child dying is the common failure, and it is diagnosable: waiting
      // out the whole budget first would report a timeout instead of the real
      // cause.
      if (this.spawnError) {
        throw new Error(
          `llama-server 를 실행할 수 없습니다 (${this.config.binPath}): ${this.spawnError.message}`
        );
      }
      if (this.exited) {
        const detail = this.logTail();
        throw new Error(
          `llama-server 가 기동 중 종료되었습니다 (code=${this.exited.code}, signal=${this.exited.signal ?? "none"}).` +
          (detail ? `\n${detail}` : "")
        );
      }
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`);
        if (res.ok) return;
      } catch {
        // not listening yet — the normal state during a multi-minute load
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Leave nothing behind: a server that is still loading would hold the
    // model in VRAM for the rest of the machine's uptime.
    this.stop();
    const detail = this.logTail();
    throw new Error(
      `llama-server 가 ${Math.round(budget / 1000)}초 내에 준비되지 않았습니다 (${this.baseUrl}).` +
      (detail ? `\n${detail}` : "")
    );
  }
}
