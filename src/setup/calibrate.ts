/**
 * Launch-time calibration of `--n-cpu-moe` against the memory that is REALLY free.
 *
 * `tuneForHardware` derives the flag arithmetically (header KV cost, free VRAM, a reserve fraction
 * calibrated on one reference card). That is a prediction. This module checks it by starting the
 * server:
 *
 *  - UP, on failure: if the load dies with a GPU out-of-memory, more expert layers are kept on the
 *    CPU and the load is retried (bounded). A prediction that was too optimistic costs a retry
 *    instead of a dead session.
 *  - DOWN, once, when the load succeeded with room to spare: the free VRAM is read from the card; if
 *    a whole number of expert layers would still fit with a safety margin, the server is restarted
 *    with that many fewer on the CPU (more of the model on the GPU = faster tokens). If that trial
 *    does not load, the previous working launch is restored.
 *  - UP, on thin margin: a load that succeeded but left LESS than the safety margin free is one
 *    allocation away from an out-of-memory at the first long prompt, so a trial with enough more
 *    expert layers on the CPU to restore the margin is made (restored if it does not load). Each is attempted once per
 *    model+context+card (`calibratedFor`) and the result is recorded, so later launches start
 *    straight from the measured value.
 *
 * Only for MoE models with `--n-cpu-moe`: a dense model has no experts to move.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { LlamaServerConfig } from "../backend/llamaServer.js";
import { isMoeModel, readGgufKvShape } from "./ggufMeta.js";

const MiB = 1024 ** 2;
const execFileP = promisify(execFile);

export interface ServerLike {
  start(): Promise<void>;
  stop(): void;
  logTail?(lines?: number): string;
  gpuLog?(): string;
}

export interface CalibrationResult {
  /** The value the server is running with. */
  cpuMoeLayers: number;
  /** "raised": the first launch ran out of memory. "lowered": a trial with fewer CPU layers loaded. */
  outcome: "kept" | "raised" | "lowered" | "lower-rejected" | "margin-raised" | "margin-raise-rejected";
  /** Free VRAM (MiB) read after the load, when it could be read. */
  freeMiB?: number;
  /** Key stored in config so the trial is not repeated for the same model, context and card. */
  calibratedFor: string;
}

export interface StartCalibratedOptions {
  make: (cfg: LlamaServerConfig) => ServerLike;
  say?: (line: string) => void;
  /** Allow the downward trial. The OOM retry is always on. */
  calibrate?: boolean;
  /** Injected for tests. Free MiB on the primary GPU, or undefined when it cannot be read. */
  readVramFreeMiB?: () => Promise<number | undefined>;
  /** Injected for tests. Resolves when a stopped server's memory is back. */
  waitReleased?: (freeBeforeStopMiB: number | undefined) => Promise<void>;
  /** Injected for tests; default reads the GGUF header. */
  info?: { moe: boolean; moeLayers: number; modelBytes: number };
  gpuName?: string;
  marginMiB?: number;
  maxOomRetries?: number;
}

export const OOM_PATTERN = /out of memory|cudaMalloc failed|failed to allocate|ggml_backend_cuda_buffer_type_alloc_buffer|unable to allocate.*(?:CUDA|Vulkan)|ErrorOutOfDeviceMemory/i;

export function calibrationKey(cfg: Pick<LlamaServerConfig, "modelPath" | "contextSize">, gpuName?: string): string {
  return `${basename(cfg.modelPath)}@${cfg.contextSize}@${gpuName ?? "gpu"}`;
}

export async function defaultReadGpuName(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader", "-i", "0"], { timeout: 8000 });
    return stdout.trim().split("\n")[0]?.trim().replace(/\s+/g, "-") || undefined;
  } catch {
    return undefined;
  }
}

export async function defaultReadVramFreeMiB(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i", "0"], { timeout: 8000 });
    const n = Number(stdout.trim().split("\n")[0]);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Waits until the card's free memory stops changing (a killed server's memory is returned lazily). */
async function defaultWaitReleased(read: () => Promise<number | undefined>, freeBefore: number | undefined): Promise<void> {
  let last: number | undefined;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const now = await read();
    if (now === undefined) return;
    if (last !== undefined && now === last && (freeBefore === undefined || now > freeBefore)) return;
    last = now;
  }
}

async function infoFor(cfg: LlamaServerConfig): Promise<{ moe: boolean; moeLayers: number; modelBytes: number } | undefined> {
  const moe = await isMoeModel({ path: cfg.modelPath, filename: basename(cfg.modelPath) }).catch(() => undefined);
  if (!moe) return undefined;
  const kv = await readGgufKvShape(cfg.modelPath).catch(() => undefined);
  const { stat } = await import("node:fs/promises");
  const size = (await stat(cfg.modelPath).catch(() => undefined))?.size ?? 0;
  if (!kv?.layers || !size) return undefined;
  return { moe: true, moeLayers: kv.layers, modelBytes: size };
}

export async function startCalibrated(
  cfg: LlamaServerConfig,
  o: StartCalibratedOptions
): Promise<{ server: ServerLike; cfg: LlamaServerConfig; calibration?: CalibrationResult }> {
  const say = o.say ?? (() => {});
  const readFree = o.readVramFreeMiB ?? defaultReadVramFreeMiB;
  const waitReleased = o.waitReleased ?? ((f) => defaultWaitReleased(readFree, f));
  const info = o.info ?? (await infoFor(cfg));

  // Not a MoE model with an offload plan: nothing to calibrate, plain start.
  if (!info || cfg.gpuLayers === 0) {
    const server = o.make(cfg);
    await server.start();
    return { server, cfg };
  }

  const key = calibrationKey(cfg, o.gpuName ?? (await defaultReadGpuName()));
  // Tried before for this exact model + context + card: start from the recorded value, no trial.
  const alreadyCalibrated = cfg.calibratedFor === key;

  let cur = cfg;
  let server = o.make(cur);
  let outcome: CalibrationResult["outcome"] = "kept";
  const retries = o.maxOomRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    try {
      await server.start();
      break;
    } catch (err) {
      const text = `${err instanceof Error ? err.message : String(err)}\n${server.logTail?.(60) ?? ""}`;
      const have = cur.cpuMoeLayers ?? 0;
      if (!OOM_PATTERN.test(text) || attempt >= retries || have >= info.moeLayers) throw err;
      const next = Math.min(info.moeLayers, have + Math.max(2, Math.ceil(Math.max(have, 8) * 0.15)));
      say(`GPU 메모리 부족으로 로드에 실패했습니다 — --n-cpu-moe ${have} → ${next} 로 늘려 다시 시도합니다 (${attempt + 1}/${retries}).`);
      const before = await readFree();
      server.stop();
      await waitReleased(before);
      cur = { ...cur, cpuMoeLayers: next };
      server = o.make(cur);
      outcome = "raised";
    }
  }

  const have = cur.cpuMoeLayers ?? 0;
  let freeMiB = await readFree();
  if (o.calibrate && !alreadyCalibrated && outcome === "kept" && freeMiB !== undefined && (have > 0 || freeMiB < (o.marginMiB ?? 600))) {
    // Expert tensors are ~90% of a MoE file, spread evenly over its layers.
    const perLayerMiB = (info.modelBytes * 0.9) / info.moeLayers / MiB;
    const margin = o.marginMiB ?? 600;
    const layersOfSlack = (freeMiB - margin) / perLayerMiB;
    const drop = Math.min(have, Math.floor(layersOfSlack));
    const add = Math.min(info.moeLayers - have, Math.ceil(-layersOfSlack));
    const delta = drop >= 1 ? -drop : add >= 1 ? add : 0;
    if (delta !== 0) {
      const target = have + delta;
      const raising = delta > 0;
      say(
        raising
          ? `VRAM 여유가 ${Math.round(freeMiB)} MiB 로 안전 여유(${margin} MiB)보다 얇아 --n-cpu-moe ${have} → ${target} 을(를) 시험합니다 (긴 프롬프트에서 메모리 부족이 날 위험을 줄입니다).`
          : `VRAM 여유가 ${Math.round(freeMiB)} MiB 남아 있어 --n-cpu-moe ${have} → ${target} 을(를) 시험합니다 (층당 ≈ ${Math.round(perLayerMiB)} MiB, 안전 여유 ${margin} MiB).`
      );
      server.stop();
      await waitReleased(freeMiB);
      const trial = { ...cur, cpuMoeLayers: target };
      const trialServer = o.make(trial);
      try {
        await trialServer.start();
        server = trialServer; cur = trial; outcome = raising ? "margin-raised" : "lowered";
        freeMiB = await readFree();
        say(`--n-cpu-moe ${target} 로 올라왔습니다 (남은 VRAM ${freeMiB === undefined ? "?" : Math.round(freeMiB)} MiB). 이 값을 기록합니다.`);
      } catch (err) {
        say(`--n-cpu-moe ${target} 는 로드되지 않아 (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}) 직전의 ${have} 로 되돌립니다.`);
        trialServer.stop();
        await waitReleased(freeMiB);
        server = o.make(cur);
        await server.start(); // the launch that worked a moment ago; if this fails the caller reports it
        outcome = raising ? "margin-raise-rejected" : "lower-rejected";
        freeMiB = await readFree();
      }
    } else {
      say(`--n-cpu-moe ${have} 는 이 머신에서 이미 적정합니다 (남은 VRAM ${Math.round(freeMiB)} MiB, 안전 여유 ${margin} MiB 이상이고 한 층을 더 올릴 만큼은 아님).`);
    }
  }
  return { server, cfg: cur, calibration: { cpuMoeLayers: cur.cpuMoeLayers ?? 0, outcome, freeMiB, calibratedFor: key } };
}
