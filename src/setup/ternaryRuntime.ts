/**
 * Getting a llama-server that can actually READ a ternary (PTQ1_0 / PQ2_0) model.
 *
 * ── Why stock llama.cpp is not an option here ────────────────────────────────
 * The Bonsai family's quants are not a stock ggml type. Type 143 (`PTQ1_0`) and
 * its 2-bit sibling are added by a fork, and stock `ggml-org/llama.cpp` rejects
 * the file outright:
 *
 *     tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)
 *
 * The model card is unambiguous — "Bonsai 2 still requires the PrismML llama.cpp
 * fork" — and the roadmap table on it shows the CUDA kernels are still Open
 * upstream. So this is not a "build a newer stock" problem. Compiling
 * `LLAMA_CPP_REPO` for 30-40 minutes produces a binary that fails on the very
 * model it was built for.
 *
 * ── Download first, build only if that is impossible ──────────────────────────
 * The fork publishes pinned prebuilt binaries per platform. Those are seconds to
 * fetch against 10-40 minutes to compile, so a download is tried first and a build
 * is the fallback for platforms with no published asset. Building is not removed
 * — it is the only route on a platform the release does not cover — but it is no
 * longer the default answer for the common case.
 *
 * Verified on the machine this was written for: the pinned CPU asset unpacks and
 * loads `Ternary-Bonsai-2-27B-PTQ1_0.gguf` in ~2.4 s at `-ngl 0`.
 *
 * ── Asset naming mirrors the fork's own `download_binaries.sh` ───────────────
 * Reproduced rather than invented, because the fork is the source of truth for
 * running these models and a name this file guesses at would 404. The CUDA tag is
 * bucketed from the DRIVER's reported version, not from `nvcc`, because that is
 * what determines which prebuilt will load.
 */

import { access, constants, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractTarGz } from "./tarGz.js";
import { extractZip } from "./zip.js";
import { downloadFile } from "./download.js";
import type { TransferProgress } from "./download.js";
import type { Run } from "./llamaCpp.js";

/** The fork that carries the ternary quants. Never the stock repo for these models. */
export const PRISM_LLAMA_CPP_REPO = "https://github.com/PrismML-Eng/llama.cpp";

/** Pinned release. A tag, not "latest": a moving tag would make the downloaded
 *  build disagree with the version this install claims to be running. */
export const PRISM_RELEASE_TAG = "prism-b10743-adfffbe";

const RELEASE_BASE = `${PRISM_LLAMA_CPP_REPO}/releases/download/${PRISM_RELEASE_TAG}`;

/** Where llamacli keeps its own ternary-capable runtime. */
export const PRISM_RUNTIME_HOME = join(homedir(), ".llamacli", "prism-llama.cpp");

export function prismAssetUrl(asset: string): string {
  return `${RELEASE_BASE}/${asset}`;
}

/** The CUDA build tag matching a reported driver CUDA version.
 *
 *  Buckets copied from the fork's own script, including its fallback: an
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

export const LINUX_CUDA_TAGS = ["12.4", "12.8", "13.3"] as const;
export const WINDOWS_CUDA_TAGS_X64 = ["12.4", "13.3"] as const;
export const WINDOWS_CUDA_TAGS_ARM64 = ["13.4"] as const;

export interface PrismMachine {
  /** "linux" | "darwin" | "win32" */
  platform: string;
  /** "x64" | "arm64" */
  arch: string;
  /** Best acceleration available, as hardware.ts reports it. */
  gpuBackend: "cuda" | "vulkan" | "none";
  /** The CUDA version the driver reports, when there is one. */
  cudaVersion?: string | null;
}

export interface PrismAsset {
  asset: string;
  url: string;
  /** Subdirectory under the runtime home, mirroring the fork's own layout so a
   *  CPU build and a CUDA build can coexist. */
  subdir: string;
  /** Archive format. The release publishes tarballs for Linux/macOS and ZIP for
   *  Windows, so the extractor is chosen from this rather than from the OS. */
  format: "tar.gz" | "zip";
  /** Leading path components to drop. Linux/macOS archives nest everything under
   *  `llama-<tag>/`; the Windows zips are flat. */
  strip: number;
  /** The server binary's name in this package — `.exe` on Windows. */
  binName: string;
  /** True when the choice had to fall back, so the caller can say so. */
  fellBack?: boolean;
}

/** Normalises Node's `process.arch` to the fork's naming. */
export function archTag(arch: string): "x64" | "arm64" | null {
  if (arch === "x64" || arch === "amd64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return null;
}

/**
 * The published asset for this machine, or null when the release does not cover
 * it — which is the signal to build from source instead.
 *
 * null is returned, never a guess, for the two cases where a wrong pick is worse
 * than a compile: an unsupported architecture, and CUDA on non-x64 (the release
 * publishes no such build, and the fork's script warns and falls back; here the
 * caller is told, and can decide to build).
 */
export function prismAssetFor(machine: PrismMachine): PrismAsset | null {
  const tag = PRISM_RELEASE_TAG;
  const make = (
    asset: string,
    subdir: string,
    format: "tar.gz" | "zip",
    strip: number,
    binName: string,
    fellBack?: boolean
  ): PrismAsset => ({ asset, url: prismAssetUrl(asset), subdir, format, strip, binName, fellBack });

  const a = archTag(machine.arch);
  if (!a) return null;

  if (machine.platform === "darwin") {
    return make(`llama-${tag}-bin-macos-${a}.tar.gz`, "macos", "tar.gz", 1, "llama-server");
  }

  if (machine.platform === "win32") {
    // Windows assets are ZIP and FLAT, and their CUDA tags are a different set.
    if (machine.gpuBackend === "cuda") {
      if (a === "x64") {
        const t = pickPublishedCudaTag(machine.cudaVersion, WINDOWS_CUDA_TAGS_X64);
        if (!t) return null;
        return make(`llama-${tag}-bin-win-cuda-${t}-x64.zip`, `cuda-${t}`, "zip", 0, "llama-server.exe");
      }
      // arm64 publishes exactly one CUDA build, so there is no choice to make and
      // no driver comparison to do — it is the only one that can exist here.
      return make(
        `llama-${tag}-bin-win-cuda-${WINDOWS_CUDA_TAGS_ARM64[0]}-arm64.zip`,
        `cuda-${WINDOWS_CUDA_TAGS_ARM64[0]}`,
        "zip",
        0,
        "llama-server.exe"
      );
    }
    if (machine.gpuBackend === "vulkan") {
      // Vulkan is published for x64 only.
      return a === "x64"
        ? make(`llama-${tag}-bin-win-vulkan-x64.zip`, "vulkan", "zip", 0, "llama-server.exe")
        : null;
    }
    return make(`llama-${tag}-bin-win-cpu-${a}.zip`, "cpu", "zip", 0, "llama-server.exe");
  }

  if (machine.platform !== "linux") return null;

  if (machine.gpuBackend === "cuda") {
    if (a !== "x64") return null; // no CUDA arm64 build is published
    const t = pickPublishedCudaTag(machine.cudaVersion, LINUX_CUDA_TAGS);
    if (!t) return null; // CUDA present but the version is unreadable
    const exact = LINUX_CUDA_TAGS.includes(t as never);
    return make(`llama-${tag}-bin-linux-cuda-${t}-x64.tar.gz`, `cuda-${t}`, "tar.gz", 1, "llama-server", !exact);
  }
  if (machine.gpuBackend === "vulkan") {
    return make(`llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`, "vulkan", "tar.gz", 1, "llama-server");
  }
  return make(`llama-${tag}-bin-ubuntu-${a}.tar.gz`, "cpu", "tar.gz", 1, "llama-server");
}

/** The driver's reported CUDA version, or null.
 *
 *  nvidia-smi first and `nvcc` only as a fallback, matching the fork's script: the
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

export interface DownloadRuntimeOptions {
  machine: PrismMachine;
  /** Defaults to PRISM_RUNTIME_HOME. */
  destRoot?: string;
  log?: (line: string) => void;
  onProgress?: (p: TransferProgress) => void;
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to the extractor the asset's format calls for. */
  extract?: (archive: string, dest: string, opts: { strip: number }) => string[];
  /** Injected for tests. */
  download?: typeof downloadFile;
}

export interface DownloadRuntimeResult {
  ok: boolean;
  /** Path to a llama-server that can read the ternary quants. */
  binPath?: string;
  /** Which published asset was used, for the status line. */
  asset?: string;
  lines: string[];
}

/**
 * Fetches and unpacks the pinned prebuilt llama-server for this machine.
 *
 * Returns `ok: false` with a reason rather than throwing, and returns `asset`
 * undefined when no published asset exists — the caller's cue to build from the
 * fork instead. Never falls back to stock: a stock build cannot read these
 * models, so "no prebuilt" and "stock" are not interchangeable outcomes.
 */
export async function downloadPrismRuntime(
  opts: DownloadRuntimeOptions
): Promise<DownloadRuntimeResult> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    opts.log?.(l);
  };

  const asset = prismAssetFor(opts.machine);
  if (!asset) {
    say(
      `PrismML 릴리스(${PRISM_RELEASE_TAG})에 이 플랫폼용 사전 빌드가 없습니다. ` +
        `대신 fork(${PRISM_LLAMA_CPP_REPO})에서 직접 빌드합니다.`
    );
    return { ok: false, lines };
  }
  if (asset.fellBack) {
    say(`이 드라이버에 정확히 맞는 CUDA 빌드가 없어 ${asset.subdir} 빌드를 사용합니다.`);
  }

  const root = join(opts.destRoot ?? PRISM_RUNTIME_HOME, asset.subdir);
  // `.exe` on Windows: the release ships `llama-server.exe`, and looking for the
  // bare name there would report a successful install of nothing.
  const binPath = join(root, asset.binName);

  // Already have this exact release unpacked: nothing to download.
  if (await isExecutable(binPath)) {
    const stamp = await readStamp(root);
    if (stamp === `${PRISM_RELEASE_TAG}`) {
      say(`이미 설치된 ${PRISM_RELEASE_TAG} 런타임을 사용합니다: ${binPath}`);
      return { ok: true, binPath, asset: asset.asset, lines };
    }
  }

  say(`PrismML llama-server(${PRISM_RELEASE_TAG}) 를 받습니다: ${asset.asset}`);
  const archive = join(opts.destRoot ?? PRISM_RUNTIME_HOME, asset.asset);
  await mkdir(join(root, ".."), { recursive: true });
  try {
    const dl = opts.download ?? downloadFile;
    await dl(asset.url, archive, {
      fetchImpl: opts.fetchImpl,
      onProgress: opts.onProgress,
    });
  } catch (err) {
    await rm(archive, { force: true }).catch(() => {});
    say(`다운로드 실패: ${err instanceof Error ? err.message : String(err)}`);
    say(`fork(${PRISM_LLAMA_CPP_REPO})에서 빌드하는 경로로 갑니다.`);
    return { ok: false, lines };
  }

  try {
    // Format and strip both come from the asset: Linux/macOS tarballs nest under
    // `llama-<tag>/` and must drop it, Windows zips are flat and must not.
    const extract = opts.extract ?? (asset.format === "zip" ? extractZip : extractTarGz);
    extract(archive, root, { strip: asset.strip });
  } catch (err) {
    await rm(archive, { force: true }).catch(() => {});
    say(`압축 해제 실패: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, lines };
  }
  await rm(archive, { force: true }).catch(() => {});

  if (!(await isExecutable(binPath))) {
    say(`압축은 풀렸지만 ${binPath} 를 찾을 수 없습니다.`);
    return { ok: false, lines };
  }
  await writeFile(join(root, ".llama_release"), `${PRISM_RELEASE_TAG}\n`, "utf8").catch(() => {});
  say(`준비 완료: ${binPath}`);
  return { ok: true, binPath, asset: asset.asset, lines };
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readStamp(dir: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(join(dir, ".llama_release"), "utf8")).trim();
  } catch {
    return null;
  }
}
/**
 * A llama-server that reads the ternary quants, for THIS machine.
 *
 * One entry point on purpose. Two call sites need it — the bootstrap's binary step
 * and its post-model-choice step — and they must not be able to drift: if the
 * binary step downloaded a prebuilt while the model step built the fork, the
 * install would depend on which ran first.
 *
 * Download first, build the FORK second. Never stock, and never silently: if both
 * fail, this returns null with the reasons, and the caller reports rather than
 * pretending an install happened.
 */
export async function acquireTernaryLlamaServer(opts: {
  hardware: { platform: string; gpuBackend: "cuda" | "vulkan" | "none"; canBuildCuda: boolean };
  run: Run;
  log?: (line: string) => void;
  /** Injected for tests. */
  download?: typeof downloadPrismRuntime;
  /** Injected for tests. Defaults to the real build. */
  build?: (o: { hw: never; run: Run; log?: (l: string) => void; repo: string }) => Promise<string>;
}): Promise<{ binPath: string; backend: "cuda" | "vulkan" | "cpu" } | null> {
  const log = opts.log ?? (() => {});
  const cudaVersion = await detectCudaVersion(opts.run);
  const machine: PrismMachine = {
    platform: opts.hardware.platform,
    arch: process.arch,
    gpuBackend: opts.hardware.gpuBackend,
    cudaVersion,
  };

  const dl = opts.download ?? downloadPrismRuntime;
  const prebuilt = await dl({ machine, log }).catch((err) => {
    log(`PrismML 사전 빌드 받기 실패: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false as const, lines: [] };
  });
  if (prebuilt.ok && prebuilt.binPath) {
    return {
      binPath: prebuilt.binPath,
      backend: opts.hardware.gpuBackend === "none" ? "cpu" : opts.hardware.gpuBackend,
    };
  }

  log("사전 빌드가 없어 PrismML fork 에서 직접 빌드합니다. 10~40분 걸릴 수 있습니다.");
  const build = opts.build ?? ((o) => import("./llamaCpp.js").then((m) => m.buildLlamaCpp(o as never)));
  try {
    const binPath = await build({
      hw: opts.hardware as never,
      run: opts.run,
      log,
      repo: PRISM_LLAMA_CPP_REPO,
    } as never);
    return { binPath, backend: opts.hardware.canBuildCuda ? "cuda" : "cpu" };
  } catch (err) {
    log(`PrismML fork 빌드 실패: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
