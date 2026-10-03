/**
 * Pieces shared by the llama.cpp engine installers (stock prebuilts, source builds): which CUDA build
 * a driver can run, how Node names the CPU architecture, how to read the driver's CUDA version, and —
 * most importantly — how to tell that a downloaded server actually WORKS rather than merely unpacked.
 */

import type { Run } from "./llamaCpp.js";

/** The CUDA build tag matching a reported driver CUDA version.
 *
 *  Buckets from the llama.cpp release scripts, including their fallback: an
 *  unrecognised version gets 12.4 rather than nothing, because a build that loads
 *  is better than no build, and CUDA minor-version compatibility means an older
 *  toolkit runs on a newer driver.
 *
 *  Returns null only for input that is not a version at all, so a caller can tell
 *  "no CUDA" from "CUDA of unknown vintage". */
export function cudaTagFor(version: string | undefined | null): string | null {
  if (!version) return null;
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 13 || (major === 13 && minor >= 3)) return "13.3";
  if (major === 13 || (major === 12 && minor >= 8)) return "12.8";
  if (major === 12) return "12.4";
  // Older than anything published: the fork's own script falls back to 12.4.
  return "12.4";
}

/**
 * CUDA tags the release publishes, PER PLATFORM — and they differ.
 *
 * Linux x64 carries 12.4, 12.8 and 13.3. Windows x64 carries only 12.4 and 13.3.
 * So the Linux rule ("13.x driver → 12.8") names a file that does not exist on
 * Windows and 404s there — at the exact moment someone is waiting on a 245 MB
 * download. Picking from the published set for the platform, highest-not-newer-than
 * the driver and falling back to the oldest when the driver predates all of them,
 * is what makes the same code correct on both.
 */
export function pickPublishedCudaTag(
  driverVersion: string | undefined | null,
  published: readonly string[]
): string | null {
  if (published.length === 0) return null;
  const preferred = cudaTagFor(driverVersion);
  if (!preferred) return null;
  const asTuple = (v: string): [number, number] => {
    const m = /^(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const [dmaj, dmin] = asTuple(driverVersion!.trim());
  const le = (a: string) => {
    const [maj, min] = asTuple(a);
    return maj < dmaj || (maj === dmaj && min <= dmin);
  };
  // Newest published tag the driver can run, else the oldest available.
  const ordered = [...published].sort((a, b) => {
    const [amaj, amin] = asTuple(a);
    const [bmaj, bmin] = asTuple(b);
    return amaj === bmaj ? amin - bmin : amaj - bmaj;
  });
  return [...ordered].reverse().find(le) ?? ordered[0];
}

/** Normalises Node's `process.arch` to the release's naming. */
export function archTag(arch: string): "x64" | "arm64" | null {
  if (arch === "x64" || arch === "amd64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return null;
}

/** The driver's reported CUDA version, or null.
 *
 *  nvidia-smi first and `nvcc` only as a fallback, as the runtime installers do: the
 *  prebuilt has to load on the DRIVER, so that is the version that decides. */
export async function detectCudaVersion(run: Run): Promise<string | null> {
  try {
    const out = await run("nvidia-smi", [], { timeout: 5000 });
    const m = /CUDA[ A-Z]*Version:\s*(\d+\.\d+)/.exec(out);
    if (m) return m[1];
  } catch {
    /* no nvidia-smi, or it failed — fall through to nvcc */
  }
  try {
    const out = await run("nvcc", ["--version"], { timeout: 5000 });
    const m = /release (\d+\.\d+)/.exec(out);
    if (m) return m[1];
  } catch {
    /* no toolkit: CPU build it is */
  }
  return null;
}

export interface AcquireAttempt {
  /** What was tried, in words the user can act on. */
  label: string;
  ok: boolean;
  binPath?: string;
  /** Why it did not work, when it did not. */
  detail?: string;
}

/** Does this binary actually RUN, actually INITIALISE its accelerator, and can it
 *  read the model if we have one?
 *
 *  Three separate questions, and the middle one is the WSL case. `--version` does
 *  not touch CUDA, and the model probe below runs at `-ngl 0` precisely so it cannot
 *  disturb a live server — so neither of those proves the device loads. Under WSL the
 *  CUDA runtime comes from the Windows driver, and a binary that cannot find it
 *  passes every other check and then fails on the first real request. `--list-devices`
 *  is what actually exercises backend initialisation.
 *
 *  Every one of these has a failure that looks like a working install from the
 *  outside, and the previous version of this code ran nothing at all. */
export async function verifyLlamaServer(
  binPath: string,
  run: Run,
  modelPath?: string,
  expectGpu = false
): Promise<{ ok: boolean; detail?: string }> {
  const { probeLlamaServer, probeModelCompatibility, looksLikeUnsupportedModelFormat } = await import("./llamaCpp.js");
  const probe = await probeLlamaServer(binPath, run);
  if (!probe.ok) return { ok: false, detail: probe.error ?? "실행 실패" };

  if (expectGpu) {
    try {
      await run(binPath, ["--list-devices"], { timeout: 30_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail:
          `가속기를 초기화할 수 없음: ${detail.split("\n")[0]}` +
          ` (WSL 이라면 Windows NVIDIA 드라이버의 CUDA 런타임이 필요합니다 — CPU 폴백은 자동으로 시도합니다)`,
      };
    }
  }

  if (!modelPath) return { ok: true };
  const compat = await probeModelCompatibility(binPath, modelPath, { run });
  if (!compat.ok && looksLikeUnsupportedModelFormat(compat.error)) {
    return { ok: false, detail: `이 모델의 양자화를 읽지 못함: ${compat.error}` };
  }
  return { ok: true };
}
