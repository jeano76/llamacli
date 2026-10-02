import { spawn, ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { GPU_LOG_LINE } from "../setup/gpuReport.js";
import { isMoeModelFile } from "../setup/ggufMeta.js";
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
  /** `-np`: concurrent slots. A coding agent is one conversation per process.
   *  Note this does NOT multiply the KV cache: llama.cpp allocates the pool
   *  once at `n_ctx / n_parallel` (llama-context.cpp:294), so more slots mean
   *  a smaller per-slot pool — but it DOES divide the context, which is why
   *  `buildServerArgs` multiplies `contextSize` (per-slot) by this.
   *  Passing it explicitly also keeps llama.cpp's `auto` default (which
   *  resolves to 4 slots AND kv_unified, the one case where the pool really
   *  does grow) from taking over. */
  parallel?: number;
  /** `--spec-type`: comma-separated speculative decoding methods. The
   *  model-free ones (`ngram-mod`, `ngram-simple`, `ngram-map-k`, `ngram-cache`)
   *  need no draft checkpoint. Undefined = off. */
  speculativeTypes?: string;
  /** `--spec-draft-n-max`: proposed tokens per step (llama.cpp default 3). */
  speculativeDraftNMax?: number;
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
  const parallel = config.parallel ?? 1;
  // `-c` is the TOTAL context across all slots, not per-slot. Verified against
  // llama.cpp source and a live server:
  //
  //   src/llama-context.cpp:294   n_ctx_seq = n_ctx / n_seq_max
  //   common/common.cpp:1722      n_seq_max  = n_parallel
  //   tools/server/server-context.cpp:4027  n_ctx_slot() = llama_n_ctx_seq()
  //
  // and confirmed empirically: a server launched `-c 40960 -np 1` logs
  // `n_slots = 1, n_ctx_slot = 40960`, while `/props` reports the same
  // per-slot figure (slot_n_ctx) that getContextSize() reads.
  //
  // So `-np 2` with an unchanged `-c 40960` silently halves the usable context
  // per conversation — from 40,960 to 20,480 — with no error anywhere.
  // getContextSize() WOULD follow it (it reads the per-slot number), so
  // compaction thresholds would correctly scale down... which is precisely why
  // this is dangerous: the user sees "compacting more often" rather than
  // "half my context disappeared", and the token cost of compaction is about to
  // double without anyone choosing it.
  //
  // `contextSize` is PER-SLOT everywhere else in this project — it is what
  // config.yaml's `llama.contextSize` means, what tuning.ts computes a VRAM
  // budget for, and what the compaction thresholds are derived against. So the
  // multiplication happens here, at the one boundary where llama.cpp's meaning
  // differs from ours, and stays commented above so nobody "simplifies" it back.
  const totalContext = config.contextSize * parallel;
  const args = [
    "-m", config.modelPath,
    "--host", config.host,
    "--port", String(config.port),
    "-c", String(totalContext),
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
  // Speculative decoding. Motivation is specific: compaction latency is almost
  // entirely decode (the summary request's prompt is a verbatim prefix of the
  // turn that just ran, so llama-server serves the prefill from its prompt
  // cache — ~0.3 s measured — and everything after it is generation at the
  // machine's decode rate), so the only way to make the summary itself faster
  // is to generate more tokens per forward pass.
  //
  // The model-free methods are the ones exposed here deliberately:
  // `ngram-mod`, `ngram-simple`, `ngram-map-k`, `ngram-map-k4v` and
  // `ngram-cache` need no draft checkpoint, whereas `draft-simple`/`eagle3`/
  // `mtp`/`dflash`/`dspark` all require a separately trained draft for this
  // exact target model — a much larger ask than turning on a flag.
  //
  // Omitted unless configured, because the right setting is workload-specific
  // and this is a measured trade rather than a known win. `-no-kvu` and the
  // context handling above are unaffected either way.
  if (config.speculativeTypes) {
    args.push("--spec-type", config.speculativeTypes);
    if (config.speculativeDraftNMax !== undefined) {
      args.push("--spec-draft-n-max", String(config.speculativeDraftNMax));
    }
  }
  // Explicitly OFF, and deliberately not left to the default.
  //
  // With -np omitted (llama.cpp's auto), server.cpp:156-160 sets
  // n_parallel=4 AND kv_unified=true together, and kv_unified is the ONE case
  // where the KV pool genuinely does grow with the slot count
  // (llama-context.cpp:290-292 keeps n_ctx_seq = n_ctx instead of dividing,
  // shared across sequences). Passing -np explicitly takes the other branch and
  // keeps kv_unified off. Emitting -no-kvu as well means that stays true if a
  // future llama.cpp changes what auto resolves to — this project computes its
  // own context budget from a single conversation, and a silent 4-slot default
  // would invalidate that arithmetic.
  args.push("-no-kvu");
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
  /** Load-time lines about the accelerator, kept separately from `log`: the rolling tail
   *  drops the early part of a long model load, which is where llama.cpp says how many
   *  layers went to the GPU. */
  private gpuLines: string[] = [];

  constructor(private config: LlamaServerConfig) {}

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.exited = null;
    this.spawnError = null;
    this.log = [];
    this.gpuLines = [];

    // A recorded `cpuMoeLayers` outlives the model it was measured for: the config of a machine
    // that once ran a MoE model keeps it, and every later launch passed --n-cpu-moe to whatever
    // model came next. On a dense model the flag has nothing to act on, so it is dropped here —
    // the one place every launch path (startup, /models, /server restart) goes through — whenever
    // the model's own header says it has no experts. Unknown means "leave it as configured".
    if (this.config.cpuMoeLayers && (await isMoeModelFile(this.config.modelPath)) === false) {
      this.config = { ...this.config, cpuMoeLayers: 0 };
    }

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

  /** What the server said about the GPU while loading (offload count, device, OOM). */
  gpuLog(): string {
    return this.gpuLines.join("\n");
  }

  private appendLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (GPU_LOG_LINE.test(line) && this.gpuLines.length < 40) this.gpuLines.push(line.trim());
    }
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
