/**
 * Which accelerator a SOURCE build should target on this machine, and how many
 * compile jobs it can afford. Pure, so every machine shape is testable.
 *
 * The old builder knew two shapes — "CUDA" and "CPU" — and chose between them with a
 * single boolean. That is why an AMD or Apple machine compiled a CPU-only server
 * with the GPU sitting idle.
 */

import type { Hardware, Run } from "./hardware.js";

export type BuildBackend = "cuda" | "vulkan" | "metal" | "cpu";

export interface BuildTarget {
  backend: BuildBackend;
  /** cmake build directory. Names are looked up by findLlamaServer's preference list. */
  dir: string;
  flags: string[];
  /** For logs. */
  label: string;
}

/**
 * Best backend a from-source build can actually produce here.
 *
 * Only backends whose toolchain was MEASURED present are returned: CUDA needs
 * `nvcc` (a GPU without a toolkit makes `-DGGML_CUDA=ON` a configure error, not a
 * fallback), Vulkan needs `glslc`. ROCm is intentionally absent: the HIP build needs
 * compiler environment wiring this installer has not been able to verify, and the
 * release publishes a ROCm prebuilt, which the engine ladder tries first.
 */
export function chooseBuildTarget(
  hw: Pick<Hardware, "gpuBackend" | "canBuildCuda" | "canBuildVulkan" | "platform" | "arch">,
  cudaArch?: string | null,
  /** "cpu" skips accelerators — the ladder's last resort when an accelerated build
   *  compiled but would not run. Any other value is the same as not forcing. */
  forced?: BuildBackend
): BuildTarget {
  if (forced === "cpu") return { backend: "cpu", dir: "build-cpu", label: "CPU", flags: [] };
  if (hw.canBuildCuda) {
    return {
      backend: "cuda", dir: "build-cuda", label: "CUDA",
      // Compiling every architecture is most of a CUDA build's time. Targeting the
      // card actually present cuts it several-fold; it is omitted, not guessed, when
      // the capability could not be read.
      flags: ["-DGGML_CUDA=ON", ...(cudaArch ? [`-DCMAKE_CUDA_ARCHITECTURES=${cudaArch}`] : [])],
    };
  }
  if (hw.platform === "darwin" && hw.arch === "arm64") {
    return { backend: "metal", dir: "build-metal", label: "Metal", flags: ["-DGGML_METAL=ON"] };
  }
  if ((hw.gpuBackend === "vulkan" || hw.gpuBackend === "rocm" || hw.gpuBackend === "cuda") && hw.canBuildVulkan) {
    return { backend: "vulkan", dir: "build-vulkan", label: "Vulkan", flags: ["-DGGML_VULKAN=ON"] };
  }
  return { backend: "cpu", dir: "build-cpu", label: "CPU", flags: [] };
}

/** `nvidia-smi` reports compute capability as "7.5"; cmake wants "75". */
export async function detectCudaArch(run: Run): Promise<string | null> {
  try {
    const out = await run("nvidia-smi", ["--query-gpu=compute_cap", "--format=csv,noheader"], { timeout: 5000 });
    const caps = [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+$/.test(l)))];
    return caps.length > 0 ? caps.map((c) => c.replace(".", "")).join(";") : null;
  } catch {
    return null;
  }
}

/**
 * Compile jobs the machine can hold in memory at once.
 *
 * `-j` = core count was the old rule, and on an 8 GB box with 12 cores that starts 12
 * compilers — nvcc alone peaks at several GB each — and the kernel OOM-kills one
 * mid-build, which surfaces as an unexplained "Killed". The per-job figures are
 * conservative estimates, not measurements: they only need to keep the machine out
 * of swap, and a build a little slower than possible still finishes.
 */
export function buildJobs(hw: Pick<Hardware, "cpuCount" | "ramAvailableBytes">, backend: BuildBackend): number {
  const perJobGiB = backend === "cuda" ? 3 : 1.5;
  const byRam = Math.floor(hw.ramAvailableBytes / 1024 ** 3 / perJobGiB);
  return Math.max(1, Math.min(hw.cpuCount, 16, byRam));
}

/** Disk a source build needs, beyond the checkout: objects and the CUDA/Vulkan
 *  kernels are what make it large. Estimates with generous margins — an early refusal
 *  is cheap, a build that dies at 90% is not. */
export function buildDiskBytes(backend: BuildBackend): number {
  const GiB = 1024 ** 3;
  return backend === "cuda" ? 6 * GiB : backend === "vulkan" ? 3 * GiB : 2 * GiB;
}
