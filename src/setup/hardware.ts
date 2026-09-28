/**
 * What machine are we on?
 *
 * Everything in `src/setup/` is a decision made from these numbers and nothing
 * else: which model fits, how many layers go on the GPU, how many CPU threads
 * are worth spending, whether we can even build llama.cpp with CUDA. So this
 * module is deliberately the *only* place that shells out to probe hardware,
 * and it takes an injectable `run` seam so every decision downstream can be
 * unit-tested against a synthetic machine instead of whatever box the suite
 * happens to run on (the same reasoning as config.ts's injectable detector —
 * on the dev box, 8080 is a real permanently-running server, so tests that
 * probed it for real were testing the machine, not the code).
 */

import { cpus, totalmem, freemem, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GpuBackend = "cuda" | "vulkan" | "none";

export interface Gpu {
  /** nvidia-smi's device index, as llama.cpp's `--main-gpu` / `CUDA_VISIBLE_DEVICES` want it. */
  index: number;
  name: string;
  vramTotalBytes: number;
  vramFreeBytes: number;
}

export interface Hardware {
  /** Logical CPUs. */
  cpuCount: number;
  ramTotalBytes: number;
  ramAvailableBytes: number;
  /** Every NVIDIA GPU nvidia-smi reports, in index order. Empty on non-NVIDIA / headless boxes. */
  gpus: Gpu[];
  /** Best available acceleration backend. "none" means CPU-only llama.cpp. */
  gpuBackend: GpuBackend;
  /** True when a CUDA toolchain (`nvcc`) is present, i.e. a from-source build
   *  can actually target the GPU. Distinct from `gpuBackend`, which describes
   *  what the *machine* has: a box can have a GPU and no CUDA compiler, in
   *  which case building must not ask for `-DGGML_CUDA=ON`. */
  canBuildCuda: boolean;
  /** Build toolchain availability, as found on PATH. */
  tools: Record<string, boolean>;
  platform: string;
}

/** Command runner seam. `run("nvidia-smi", [...])` resolves with stdout, or
 *  rejects if the binary is missing / exits nonzero — callers that treat a
 *  missing tool as "just CPU then" wrap it in try/catch. */
export type Run = (file: string, args: string[]) => Promise<string>;

export const defaultRun: Run = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
};

/** One `nvidia-smi` call for everything we need. CSV+nounits is used instead of
 *  the default human-readable table precisely because parsing a table with
 *  fixed column widths is how you end up silently reading 0 MiB on a box that
 *  has 8 GB. Fields: index,name,memory.total,memory.free. */
const NVIDIA_QUERY_ARGS = [
  "--query-gpu=index,name,memory.total,memory.free",
  "--format=csv,noheader,nounits",
];

export function parseNvidiaSmiCsv(csv: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of csv.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    // "0, NVIDIA GeForce RTX 2070 SUPER, 8192, 7456" — the name may itself
    // contain commas on some cards, so only the first field is split off and
    // the last two are taken from the right.
    const firstComma = row.indexOf(",");
    if (firstComma < 0) continue;
    const index = Number(row.slice(0, firstComma).trim());
    const tail = row.slice(firstComma + 1).split(",");
    if (tail.length < 3) continue;
    const name = tail.slice(0, tail.length - 2).join(",").trim();
    const totalMiB = Number(tail[tail.length - 2].trim());
    const freeMiB = Number(tail[tail.length - 1].trim());
    if (!Number.isFinite(index) || !Number.isFinite(totalMiB)) continue;
    gpus.push({
      index,
      name,
      vramTotalBytes: Math.max(0, totalMiB) * 1024 * 1024,
      // nvidia-smi reports "N/A" for free memory on some MIG/driver states,
      // which Number() turns into NaN — fall back to "assume it is all busy"
      // rather than 0, which would make a perfectly idle GPU look unusable.
      vramFreeBytes: Number.isFinite(freeMiB) ? Math.max(0, freeMiB) * 1024 * 1024 : 0,
    });
  }
  return gpus;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Toolchain we need before a from-source llama.cpp build can even be
 *  attempted. `curl` is not a build dep but IS needed to download a model, and
 *  its absence is a very different failure than a missing compiler, so it's
 *  reported here too. */
const PROBE_TOOLS = ["git", "cmake", "make", "ninja", "g++", "cc", "nvcc", "curl", "pkg-config"];

export async function detectHardware(run: Run = defaultRun): Promise<Hardware> {
  // os.cpus() returns [] in some container/VM setups, so keep a floor of 1
  // rather than propagating 0 into every downstream division.
  const cpuCount = Math.max(1, cpus().length || 1);

  let gpus: Gpu[] = [];
  try {
    gpus = parseNvidiaSmiCsv(await run("nvidia-smi", NVIDIA_QUERY_ARGS));
  } catch {
    gpus = []; // no NVIDIA driver, no nvidia-smi, or we're in a container without it
  }

  const tools: Record<string, boolean> = {};
  await Promise.all(
    PROBE_TOOLS.map(async (tool) => {
      try {
        await run("sh", ["-c", `command -v ${tool}`]);
        tools[tool] = true;
      } catch {
        tools[tool] = false;
      }
    })
  );

  return {
    cpuCount,
    ramTotalBytes: totalmem(),
    ramAvailableBytes: freemem(),
    gpus,
    gpuBackend: gpus.length > 0 ? "cuda" : "none",
    canBuildCuda: gpus.length > 0 && Boolean(tools.nvcc),
    tools,
    platform: platform(),
  };
}

/** Total VRAM across all NVIDIA GPUs, in bytes. 0 when there is no NVIDIA GPU —
 *  which is a meaningful answer, not a missing one: it is what makes the model
 *  planner fall back to a smaller model instead of picking a 22 GB one and
 *  discovering the truth at load time. */
export function totalVram(hw: Hardware): number {
  return hw.gpus.reduce((sum, g) => sum + g.vramTotalBytes, 0);
}

/** The GPU a model should actually be loaded on.
 *
 *  "Nvidia GPU를 우선 순으로" — with several boards installed, picking by
 *  TOTAL memory is wrong on a mixed box (a 24 GB compute card and an 8 GB card
 *  in the same chassis should not average into "16 GB, fine"); picking by
 *  FREE memory is right for the real question, which is "where does this model
 *  fit right now, given the desktop compositor already holds 150 MiB on GPU 0".
 *  Ties break toward the lower index, which is nvidia-smi's own enumeration
 *  order and matches the box's `nvidia-smi -L` output. Returns null with no
 *  NVIDIA GPU, which downstream reads as "CPU-only". */
export function pickPrimaryGpu(hw: Hardware): Gpu | null {
  if (hw.gpus.length === 0) return null;
  return [...hw.gpus].sort(
    (a, b) => b.vramFreeBytes - a.vramFreeBytes || a.index - b.index
  )[0];
}

export const UNITS = { MiB, GiB };
