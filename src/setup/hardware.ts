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
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GpuBackend = "cuda" | "rocm" | "vulkan" | "metal" | "none";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple";

export interface Gpu {
  /** nvidia-smi's device index, as llama.cpp's `--main-gpu` / `CUDA_VISIBLE_DEVICES` want it. */
  index: number;
  name: string;
  vramTotalBytes: number;
  vramFreeBytes: number;
  /** Absent means NVIDIA — the only vendor this type described originally, so
   *  every existing literal and `parseNvidiaSmiCsv` stays valid unchanged. */
  vendor?: GpuVendor;
  /** True when "VRAM" is really system RAM the GPU may address (Apple Silicon).
   *  Then `vramTotalBytes` is the GPU's working-set budget, NOT physical memory
   *  that is additional to RAM — callers that add the two together double-count. */
  unifiedMemory?: boolean;
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
  /** A ROCm/HIP compiler is present AND an AMD GPU is, so `-DGGML_HIP=ON` can work. */
  canBuildRocm?: boolean;
  /** A Vulkan shader compiler (`glslc`) is present, so `-DGGML_VULKAN=ON` can work. */
  canBuildVulkan?: boolean;
  /** CPU architecture as Node names it ("x64" | "arm64" …). */
  arch?: string;
  /** Build toolchain availability, as found on PATH. */
  tools: Record<string, boolean>;
  platform: string;
}

/** Command runner seam. `run("nvidia-smi", [...])` resolves with stdout, or
 *  rejects if the binary is missing / exits nonzero — callers that treat a
 *  missing tool as "just CPU then" wrap it in try/catch. */
/** Optional per-call settings for a `Run`. Third parameter so every existing
 *  two-argument call site and test double keeps working unchanged. */
export interface RunOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Resolve with the output instead of rejecting on a non-zero exit.
   *
   *  Needed wherever the exit code IS the signal — probing whether a
   *  llama-server build can parse a model file fails precisely by exiting
   *  non-zero, and treating that as a thrown error loses the message that says
   *  why. */
  tolerateExitCode?: boolean;
  windowsHide?: boolean;
}

export type Run = (file: string, args: string[], opts?: RunOptions) => Promise<string>;

export const defaultRun: Run = async (file, args, opts = {}) => {
  const { stdout } = await execFileAsync(file, args, {
    timeout: opts.timeout ?? 10_000,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
    windowsHide: opts.windowsHide,
  }).catch((err: any) => {
    if (!opts.tolerateExitCode) throw err;
    // execFile puts both streams in the error's message on failure, which is
    // where the "invalid ggml type" text lives.
    return { stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
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

/** Per-process VRAM, straight from the driver's own accounting.
 *
 *  `nvidia-smi`'s memory.total/memory.free pair cannot tell us WHICH process is
 *  holding the card, and that distinction is the whole point: the tuner needs
 *  to discount llamacli's own llama-server (whose weights are the memory it is
 *  sizing a context FOR) while still respecting an unrelated app. The compute
 *  apps table is the only query that attributes memory to a pid, so this is
 *  what makes the discount safe rather than a guess.
 */
const NVIDIA_COMPUTE_QUERY_ARGS = ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"];

/** Parses the compute-apps table into pid → bytes.
 *
 *  Rows can be absent (no CUDA processes), and MIG/driver states have produced
 *  "N/A" in the used_memory column, so a row is skipped rather than poisoning
 *  the map with NaN. A missing pid therefore means "no measurable usage",
 *  which callers treat as 0 — the conservative direction.
 */
export function parseNvidiaComputeAppsCsv(csv: string): Map<number, number> {
  const byPid = new Map<number, number>();
  for (const line of csv.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const tail = row.split(",");
    if (tail.length < 2) continue;
    const pid = Number(tail[0].trim());
    const usedMiB = Number(tail[tail.length - 1].trim());
    if (!Number.isFinite(pid) || !Number.isFinite(usedMiB) || usedMiB <= 0) continue;
    byPid.set(pid, usedMiB * MiB);
  }
  return byPid;
}

/**
 * Finds llama-server processes belonging to THIS install.
 *
 * Attribution is deliberately narrow, because a false positive here hands out a
 * context the card cannot hold. A pid qualifies only if it is running a binary
 * whose realpath is inside this install's llama.cpp build directory — which is
 * what llamacli launches (see bootstrap's buildLlamaCpp) — and not merely
 * anything named "llama-server", since a system-wide package or another user's
 * session would match on name alone.
 *
 * Best-effort by construction: no `pgrep` (minimal containers, Windows), or a
 * permission error, yields an empty list, and the caller then keeps the plain
 * free-VRAM reading. That is the safe direction — crediting nothing never
 * over-allocates.
 */
export async function findOwnLlamaServerPids(
  llamaDir: string | undefined,
  run: Run = defaultRun
): Promise<number[]> {
  if (!llamaDir) return [];
  let out: string;
  try {
    // `pgrep -f` matches the full command line, which is where the binary path
    // appears; -x is deliberately NOT used because the command line carries
    // flags (-m, --port, ...) we do not want to pin exactly.
    out = await run("pgrep", ["-f", `llama-server`]);
  } catch {
    return []; // pgrep exits 1 when nothing matched — that is not an error
  }
  const pids = out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (pids.length === 0) return [];

  // Confirm each candidate's executable really lives in our build dir.
  const own: number[] = [];
  for (const pid of pids) {
    try {
      const exe = (await run("readlink", ["-f", `/proc/${pid}/exe`])).trim();
      if (exe && isInsideDir(exe, llamaDir)) own.push(pid);
    } catch {
      // Can't read it (permissions, or the process exited between the two
      // calls) — not provably ours, so not credited.
    }
  }
  return own;
}

/** True when `child` resolves to a path inside `dir` (or `dir` itself).
 *
 *  Compared on resolved, separator-normalised paths so a trailing slash or a
 *  `..` segment can't produce a match, and a sibling directory that merely
 *  shares a prefix ("/opt/llamacli-2" vs "/opt/llamacli") is correctly
 *  rejected. */
function isInsideDir(child: string, dir: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const c = norm(child);
  const d = norm(dir);
  return c === d || c.startsWith(d + "/");
}

/**
 * VRAM held by a llama-server belonging to THIS install, in GiB.
 *
 * Pid set is passed in rather than discovered here because "is this llama-server
 * ours" is a question about which binary we launched, not about the driver. Only
 * positively-attributed pids count, and the result is clamped to the card size
 * in the caller. Returns 0 when nothing is attributable, which keeps a first run
 * (genuinely empty card) on the plain free-VRAM reading.
 */
export async function ownLlamaServerVramGiB(
  serverPids: readonly number[],
  run: Run = defaultRun
): Promise<number> {
  if (serverPids.length === 0) return 0;
  try {
    const byPid = parseNvidiaComputeAppsCsv(await run("nvidia-smi", NVIDIA_COMPUTE_QUERY_ARGS));
    let total = 0;
    for (const pid of serverPids) total += byPid.get(pid) ?? 0;
    return total / GiB;
  } catch {
    // No nvidia-smi / no permission / MIG: fall back to discounting nothing.
    return 0;
  }
}

/** Toolchain we need before a from-source llama.cpp build can even be
 *  attempted. `curl` is not a build dep but IS needed to download a model, and
 *  its absence is a very different failure than a missing compiler, so it's
 *  reported here too. */
const PROBE_TOOLS = [
  "c++", "clang++",
  "git", "cmake", "make", "ninja", "g++", "cc", "nvcc", "curl", "pkg-config",
  // Accelerator toolchains: decide whether a GPU-targeted source build can work.
  "hipcc", "glslc", "vulkaninfo",
  // Installers and privilege: decide HOW missing build tools could be installed.
  "sudo", "apt-get", "dnf", "pacman", "apk", "zypper", "brew", "winget", "choco", "pip3",
  // Windows-only compiler; harmless to probe elsewhere.
  "cl",
];

/** Everything `detectHardware` reads from the host besides running commands.
 *  A seam so a synthetic AMD / Apple / Windows machine can be tested on any box. */
export interface HostProbe {
  platform: string;
  arch: string;
  ramTotalBytes: number;
  ramAvailableBytes: number;
  cpuCount: number;
  /** UTF-8 contents of a file, or null when absent/unreadable. */
  readText: (path: string) => Promise<string | null>;
  /** Entries of a directory, or [] when absent. */
  listDir: (path: string) => Promise<string[]>;
}

export const realHostProbe = (): HostProbe => ({
  platform: platform(),
  arch: process.arch,
  ramTotalBytes: totalmem(),
  ramAvailableBytes: freemem(),
  // os.cpus() returns [] in some container/VM setups, so keep a floor of 1
  // rather than propagating 0 into every downstream division.
  cpuCount: Math.max(1, cpus().length || 1),
  readText: async (p) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(p, "utf8").catch(() => null);
  },
  listDir: async (p) => {
    const { readdir } = await import("node:fs/promises");
    return readdir(p).catch(() => []);
  },
});

/** Share of unified memory macOS lets the GPU wire by default. Apple documents no
 *  fixed number; the commonly observed default on machines up to ~64 GB is about
 *  two thirds, rising toward three quarters on larger ones. 0.67 is deliberately
 *  on the low side: a model sized to a budget the OS then refuses fails at load,
 *  whereas an under-sized one only runs slightly smaller. */
export const APPLE_GPU_MEMORY_FRACTION = 0.67;

const PCI_VENDORS: Record<string, GpuVendor> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

/** AMD GPUs from the kernel's own amdgpu sysfs files (`mem_info_vram_*`, bytes).
 *  Read from sysfs rather than parsing `rocm-smi` output, because sysfs works with
 *  no ROCm userspace installed — which is exactly the machine being provisioned. */
export async function detectAmdGpus(host: HostProbe): Promise<Gpu[]> {
  const gpus: Gpu[] = [];
  const cards = (await host.listDir("/sys/class/drm")).filter((n) => /^card\d+$/.test(n)).sort();
  for (const card of cards) {
    const dev = `/sys/class/drm/${card}/device`;
    const vendor = (await host.readText(`${dev}/vendor`))?.trim().toLowerCase();
    if (!vendor || PCI_VENDORS[vendor] !== "amd") continue;
    const total = Number((await host.readText(`${dev}/mem_info_vram_total`))?.trim());
    if (!Number.isFinite(total) || total <= 0) continue; // an APU reports none here
    const used = Number((await host.readText(`${dev}/mem_info_vram_used`))?.trim());
    const product = (await host.readText(`${dev}/product_name`))?.trim();
    gpus.push({
      index: gpus.length,
      name: product || `AMD GPU (${card})`,
      vramTotalBytes: total,
      vramFreeBytes: Number.isFinite(used) ? Math.max(0, total - used) : total,
      vendor: "amd",
    });
  }
  return gpus;
}

/** True when `vulkaninfo --summary` lists a real (non-software) device. */
export function vulkanSummaryHasGpu(summary: string): boolean {
  return /PHYSICAL_DEVICE_TYPE_(DISCRETE|INTEGRATED|VIRTUAL)_GPU/.test(summary);
}

export async function detectHardware(
  run: Run = defaultRun,
  hostOverride: Partial<HostProbe> = {}
): Promise<Hardware> {
  const host: HostProbe = { ...realHostProbe(), ...hostOverride };
  const isWin = host.platform === "win32";

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
        // `command -v` is a shell builtin that does not exist on Windows, where
        // every tool would read as absent and a perfectly equipped machine would
        // be told to install a compiler it already has.
        if (isWin) await run("where", [tool]);
        else await run("sh", ["-c", `command -v ${tool}`]);
        tools[tool] = true;
      } catch {
        tools[tool] = false;
      }
    })
  );

  // Non-NVIDIA accelerators. NVIDIA wins when present ("Nvidia GPU를 우선 순으로").
  let gpuBackend: GpuBackend = gpus.length > 0 ? "cuda" : "none";
  if (gpus.length === 0) {
    if (host.platform === "darwin" && host.arch === "arm64") {
      // Apple Silicon: one GPU sharing system RAM. Reported as a GPU so every
      // consumer of `gpus` sizes the model against it, flagged so the memory is
      // not counted twice.
      const budget = Math.floor(host.ramTotalBytes * APPLE_GPU_MEMORY_FRACTION);
      gpus = [{
        index: 0,
        name: "Apple Silicon (unified memory)",
        vramTotalBytes: budget,
        vramFreeBytes: Math.floor(host.ramAvailableBytes * APPLE_GPU_MEMORY_FRACTION),
        vendor: "apple",
        unifiedMemory: true,
      }];
      gpuBackend = "metal";
    } else if (host.platform === "linux") {
      gpus = await detectAmdGpus(host);
      if (gpus.length > 0) gpuBackend = tools.hipcc ? "rocm" : "vulkan";
    }
  }
  if (gpuBackend === "none" && tools.vulkaninfo) {
    // Intel, or any device with no VRAM figure we can read. The backend is known
    // (Vulkan runs on it) even though its memory is not, so the model is sized as
    // for a CPU box while the engine still uses the accelerator.
    try {
      if (vulkanSummaryHasGpu(await run("vulkaninfo", ["--summary"], { timeout: 10_000 }))) {
        gpuBackend = "vulkan";
      }
    } catch {
      /* no usable Vulkan driver */
    }
  }

  return {
    cpuCount: host.cpuCount,
    ramTotalBytes: host.ramTotalBytes,
    ramAvailableBytes: host.ramAvailableBytes,
    gpus,
    gpuBackend,
    canBuildCuda: gpus.length > 0 && (gpus[0].vendor ?? "nvidia") === "nvidia" && Boolean(tools.nvcc),
    canBuildRocm: gpus.some((g) => g.vendor === "amd") && Boolean(tools.hipcc),
    canBuildVulkan: Boolean(tools.glslc),
    arch: host.arch,
    tools,
    platform: host.platform,
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
