/**
 * A stock (ggml-org) llama-server for THIS machine, from a published prebuilt when
 * one exists, and from source only when none works.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * llama.cpp used to be only compiled (10 to 40 minutes) on every machine without a
 * binary — even though ggml-org publishes prebuilts for CUDA, ROCm, Vulkan, Metal
 * and CPU on Linux, macOS and Windows.
 *
 * ── Assets are DISCOVERED, not hardcoded ────────────────────────────────────
 * ggml-org tags a release for every merged change (`b11344`, `b11342`, …) and bakes
 * the tag into each asset's filename, and the set of CUDA versions it builds for
 * changes between releases (12.4 → 12.8 → 13.4 over this project's lifetime). A
 * hardcoded name goes stale within days. So the release list is read from the GitHub
 * API and the asset is chosen from the names it actually contains — the filename
 * patterns below were taken from a real release listing, not from memory.
 *
 * ── Every rung is verified by running it ────────────────────────────────────
 * Rule: a download that unpacks is not a working server. The
 * binary must start, initialise its accelerator, and — when a model is known — read
 * it. Anything less reports a broken install as a working one.
 */

import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractTarGz } from "./tarGz.js";
import { extractZip } from "./zip.js";
import { normalizeSha256 } from "./checksum.js";
import { downloadFile, type TransferProgress } from "./download.js";
import { pickPublishedCudaTag, detectCudaVersion, archTag, verifyLlamaServer, type AcquireAttempt } from "./engineCommon.js";
import { binNameFor, buildLlamaCpp, LLAMA_CPP_REPO, type LlamaLocation } from "./llamaCpp.js";
import type { GpuBackend, Hardware, Run } from "./hardware.js";
import { executableExists } from "./fsUtil.js";

export const STOCK_RUNTIME_HOME = join(homedir(), ".llamacli", "llama.cpp-prebuilt");
/** `LLAMACLI_RELEASES_URL` points the engine lookup at a mirror (or a test double). Unset = llama.cpp's GitHub releases. */
export const STOCK_RELEASES_URL = process.env.LLAMACLI_RELEASES_URL || "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5";

export interface ReleaseAsset { name: string; url: string; /** GitHub's own `digest` ("sha256:…") for the asset, when the API gave one. */ sha256?: string }
export interface Release { tag: string; assets: ReleaseAsset[] }

/** Raw GitHub API → what is needed. Tolerant: a malformed entry is skipped. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) return [];
  const out: Release[] = [];
  for (const r of json) {
    if (!r || typeof r.tag_name !== "string" || !Array.isArray(r.assets)) continue;
    const assets: ReleaseAsset[] = r.assets
      .filter((a: any) => a && typeof a.name === "string" && typeof a.browser_download_url === "string")
      .map((a: any) => ({
        name: a.name,
        url: a.browser_download_url,
        ...(normalizeSha256(a.digest) ? { sha256: normalizeSha256(a.digest)! } : {}),
      }));
    out.push({ tag: r.tag_name, assets });
  }
  return out;
}

export type StockBackend = "cuda" | "rocm" | "vulkan" | "metal" | "cpu";

export interface StockRung {
  backend: StockBackend;
  label: string;
  /** Directory under STOCK_RUNTIME_HOME. Named so `backendFromPath` recognises it. */
  subdir: string;
  asset: ReleaseAsset;
  /** Archives that must be unpacked beside it (the CUDA runtime libraries). */
  companions: ReleaseAsset[];
  format: "tar.gz" | "zip";
  /** Leading path components to drop (Linux/macOS archives nest under `llama-<tag>/`). */
  strip: number;
  tag: string;
}

export interface StockMachine {
  platform: string;
  arch: string;
  gpuBackend: GpuBackend;
  cudaVersion?: string | null;
  /** A CUDA toolkit is installed, so the CUDA runtime bundle is not needed. */
  hasCudaToolkit: boolean;
  /** Linux libc; "musl" has no published prebuilt (they are glibc builds). */
  libc?: "glibc" | "musl";
}

/**
 * The rungs available in ONE release, best first, for this machine.
 *
 * Order: the machine's own accelerator, then Vulkan (which runs on NVIDIA and AMD
 * alike and needs no vendor toolkit — the rung that rescues a CUDA driver that is
 * too old for the CUDA prebuilt), then CPU as the floor.
 */
export function stockRungsFor(release: Release, m: StockMachine): StockRung[] {
  const a = archTag(m.arch);
  if (!a) return [];
  if (m.platform === "linux" && m.libc === "musl") return []; // glibc-only prebuilts: go straight to a source build
  const byName = new Map(release.assets.map((x) => [x.name, x]));
  const tag = release.tag;
  const rungs: StockRung[] = [];
  const add = (r: Omit<StockRung, "tag">) => rungs.push({ ...r, tag });

  const tagsOf = (re: RegExp) => release.assets.map((x) => re.exec(x.name)?.[1]).filter((v): v is string => Boolean(v));

  if (m.platform === "darwin") {
    // The macOS build ships Metal; there is no separate CPU asset to fall back to.
    const asset = byName.get(`llama-${tag}-bin-macos-${a}.tar.gz`);
    // Apple Silicon runs it on Metal. An Intel Mac gets the same archive but is not
    // claimed to be accelerated, so it is not required to initialise a GPU.
    const metal = a === "arm64";
    if (asset) add({ backend: metal ? "metal" : "cpu", label: metal ? "Metal 사전 빌드" : "macOS x64 사전 빌드", subdir: metal ? "metal" : "cpu", asset, companions: [], format: "tar.gz", strip: 1 });
    return rungs;
  }

  const win = m.platform === "win32";
  const linux = m.platform === "linux";
  if (!win && !linux) return [];
  const os = win ? "win" : "ubuntu";
  const ext = win ? "zip" : "tar.gz";
  const strip = win ? 0 : 1;
  const fmt: StockRung["format"] = win ? "zip" : "tar.gz";

  // CUDA: which versions exist is read from the release, then the newest the DRIVER can run.
  if (m.gpuBackend === "cuda") {
    const re = win
      ? new RegExp(`^llama-${tag}-bin-win-cuda-(\\d+\\.\\d+)-${a}\\.zip$`)
      : new RegExp(`^llama-${tag}-bin-ubuntu-cuda-(\\d+\\.\\d+)-${a}\\.tar\\.gz$`);
    const published = tagsOf(re);
    const picked = pickPublishedCudaTag(m.cudaVersion, published);
    if (picked) {
      const asset = byName.get(win ? `llama-${tag}-bin-win-cuda-${picked}-${a}.zip` : `llama-${tag}-bin-ubuntu-cuda-${picked}-${a}.tar.gz`);
      // The runtime bundle is a separate asset (hundreds of MB). It is only needed
      // when the machine has no CUDA toolkit to supply the libraries itself — and
      // on Windows it is needed regardless, since there is no system CUDA there.
      const cudart = byName.get(
        win ? `cudart-llama-bin-win-cuda-${picked}-${a}.zip` : `cudart-llama-${tag}-bin-ubuntu-cuda-${picked}-${a}.tar.gz`
      );
      if (asset) {
        add({
          backend: "cuda", label: `CUDA ${picked} 사전 빌드`, subdir: `cuda-${picked}`, asset,
          companions: cudart && (win || !m.hasCudaToolkit) ? [cudart] : [],
          format: fmt, strip,
        });
      }
    }
  }

  if (m.gpuBackend === "rocm") {
    const re = win ? new RegExp(`^llama-${tag}-bin-win-rocm-([\\d.]+)-${a}\\.zip$`) : new RegExp(`^llama-${tag}-bin-ubuntu-rocm-([\\d.]+)-${a}\\.tar\\.gz$`);
    const v = tagsOf(re)[0];
    const asset = v && byName.get(win ? `llama-${tag}-bin-win-rocm-${v}-${a}.zip` : `llama-${tag}-bin-ubuntu-rocm-${v}-${a}.tar.gz`);
    if (asset) add({ backend: "rocm", label: `ROCm ${v} 사전 빌드`, subdir: "rocm", asset, companions: [], format: fmt, strip });
  }

  if (m.gpuBackend !== "none") {
    const asset = byName.get(win ? `llama-${tag}-bin-win-vulkan-${a}.zip` : `llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`);
    if (asset) add({ backend: "vulkan", label: "Vulkan 사전 빌드", subdir: "vulkan", asset, companions: [], format: fmt, strip });
  }

  const cpu = byName.get(win ? `llama-${tag}-bin-win-cpu-${a}.zip` : `llama-${tag}-bin-${os}-${a}.${ext}`);
  if (cpu) add({ backend: "cpu", label: "CPU 사전 빌드", subdir: "cpu", asset: cpu, companions: [], format: fmt, strip });
  return rungs;
}


/** Backends whose installed prebuilt is acceptable for this machine, best first. */
export function acceptableStockBackends(gpuBackend: GpuBackend, platform: string, arch: string): StockBackend[] {
  if (platform === "darwin") return [arch === "arm64" ? "metal" : "cpu"];
  switch (gpuBackend) {
    case "cuda": return ["cuda", "vulkan", "cpu"];
    case "rocm": return ["rocm", "vulkan", "cpu"];
    case "vulkan": return ["vulkan", "cpu"];
    default: return ["cpu"];
  }
}

/** Prebuilts this installer already put on disk, as `{subdir, binPath, backend}`, best first.
 *  Nothing is downloaded when one of these still runs: "already installed" must mean
 *  "not fetched again" — the release tag moves on every merged commit, so asking the
 *  network what is newest would re-download hundreds of MB for no reason. */
export async function listInstalledStock(
  machine: { gpuBackend: GpuBackend; platform: string; arch: string },
  root: string = STOCK_RUNTIME_HOME
): Promise<{ subdir: string; binPath: string; backend: StockBackend }[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const order = acceptableStockBackends(machine.gpuBackend, machine.platform, machine.arch);
  const backendOf = (n: string): StockBackend | null =>
    n.startsWith("cuda") ? "cuda" : n === "rocm" ? "rocm" : n === "vulkan" ? "vulkan" : n === "metal" ? "metal" : n === "cpu" ? "cpu" : null;
  const found: { subdir: string; binPath: string; backend: StockBackend }[] = [];
  for (const n of names) {
    const backend = backendOf(n);
    if (!backend || !order.includes(backend)) continue;
    const binPath = join(root, n, binNameFor());
    if (await executableExists(binPath)) found.push({ subdir: n, binPath, backend });
  }
  return found.sort((a, b) => order.indexOf(a.backend) - order.indexOf(b.backend));
}

const stampPath = (dir: string) => join(dir, ".llama_release");

export interface InstallRungOptions {
  destRoot?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: TransferProgress) => void;
  log?: (l: string) => void;
  download?: typeof downloadFile;
  extract?: (archive: string, dest: string, o: { strip: number }) => unknown;
}

/** Downloads and unpacks one rung. Throws with a reason on failure. */
export async function installStockRung(rung: StockRung, opts: InstallRungOptions = {}): Promise<string> {
  const base = opts.destRoot ?? STOCK_RUNTIME_HOME;
  const root = join(base, rung.subdir);
  const bin = join(root, binNameFor());
  const dl = opts.download ?? downloadFile;
  await mkdir(base, { recursive: true });

  // Companions FIRST: if the runtime bundle cannot be fetched there is no point
  // pulling a server that cannot load without it.
  const all = [rung.asset, ...rung.companions];
  const files = all.map((a) => ({ a, dest: join(base, a.name) }));
  try {
    for (const { a, dest } of [...files.slice(1), files[0]]) {
      await dl(a.url, dest, { fetchImpl: opts.fetchImpl, onProgress: opts.onProgress, label: a.name, expectedSha256: a.sha256 } as never);
    }
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const extract = opts.extract ?? (rung.format === "zip" ? extractZip : extractTarGz);
    for (const { a, dest } of files) {
      // The bundle's top directory has a different name from the server's, so both
      // are stripped one level into the same root — verified against a real listing.
      extract(dest, root, { strip: a === rung.asset ? rung.strip : rung.format === "zip" ? 0 : 1 });
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  } finally {
    await Promise.all(files.map((f) => rm(f.dest, { force: true }).catch(() => {})));
  }

  if (!(await executableExists(bin))) {
    const names = await readdir(root).catch(() => [] as string[]);
    throw new Error(`압축은 풀렸지만 ${bin} 이 없습니다 (내용: ${names.slice(0, 6).join(", ") || "비어 있음"}).`);
  }
  await writeFile(stampPath(root), `${rung.tag}\n`, "utf8").catch(() => {});
  return bin;
}

export interface AcquireStockOptions {
  hardware: Hardware;
  run: Run;
  log?: (line: string) => void;
  /** Known only on a re-run; absent on a first launch. */
  modelPath?: string;
  destRoot?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (p: TransferProgress) => void;
  /** Injected for tests. */
  releases?: () => Promise<Release[]>;
  install?: (rung: StockRung) => Promise<string>;
  verify?: (bin: string, expectGpu: boolean) => Promise<{ ok: boolean; detail?: string }>;
  build?: typeof buildLlamaCpp;
  /** Skip the from-source rung (the caller is forbidden to compile). */
  allowBuild?: boolean;
  /** Where prebuilts live. Defaults to STOCK_RUNTIME_HOME; injected by tests. */
  installedRoot?: string;
}

export interface AcquireStockResult {
  binPath: string;
  backend: LlamaLocation["backend"];
  source: "downloaded" | "built";
  attempts: AcquireAttempt[];
}

async function fetchReleases(fetchImpl: typeof fetch | undefined): Promise<Release[]> {
  const res = await (fetchImpl ?? fetch)(STOCK_RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "llamacli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub 릴리스 조회 실패: HTTP ${res.status}`);
  return parseReleases(await res.json());
}

/**
 * The stock ladder: prebuilt for this accelerator → Vulkan → CPU → compile.
 * Returns null only when every rung failed; `attempts` of the failure are logged.
 */
export async function acquireStockLlamaServer(opts: AcquireStockOptions): Promise<AcquireStockResult | null> {
  const log = opts.log ?? (() => {});
  const attempts: AcquireAttempt[] = [];
  const hw = opts.hardware;
  const verify = opts.verify ?? ((bin, gpu) => verifyLlamaServer(bin, opts.run, opts.modelPath, gpu));
  const install = opts.install ?? ((r) => installStockRung(r, { destRoot: opts.destRoot, fetchImpl: opts.fetchImpl, onProgress: opts.onProgress, log }));

  // 0. Already installed → verify and use; no network, no download.
  for (const have of await listInstalledStock(
    { gpuBackend: hw.gpuBackend, platform: hw.platform, arch: hw.arch ?? process.arch },
    opts.installedRoot
  )) {
    const verdict = await verify(have.binPath, have.backend !== "cpu");
    if (verdict.ok) {
      log(`이미 설치된 llama-server 를 사용합니다 (다시 받지 않음): ${have.binPath}`);
      attempts.push({ label: `설치됨 (${have.subdir})`, ok: true, binPath: have.binPath });
      return { binPath: have.binPath, backend: have.backend, source: "downloaded", attempts };
    }
    attempts.push({ label: `설치됨 (${have.subdir})`, ok: false, binPath: have.binPath, detail: `실행되지 않음: ${verdict.detail ?? "알 수 없음"}` });
  }

  // 1. Published prebuilts.
  let releases: Release[] = [];
  try {
    releases = await (opts.releases ?? (() => fetchReleases(opts.fetchImpl)))();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    attempts.push({ label: "릴리스 목록", ok: false, detail });
    log(`사전 빌드를 조회하지 못했습니다 (${detail}).`);
  }

  const machine: StockMachine = {
    platform: hw.platform,
    arch: hw.arch ?? process.arch,
    gpuBackend: hw.gpuBackend,
    cudaVersion: hw.gpuBackend === "cuda" ? await detectCudaVersion(opts.run as never) : null,
    hasCudaToolkit: Boolean(hw.tools.nvcc),
    libc: hw.libc,
  };

  // Newest release that offers a rung; an in-flight release can be missing assets.
  const tried = new Set<string>();
  for (const release of releases) {
    for (const rung of stockRungsFor(release, machine)) {
      if (tried.has(rung.backend)) continue;
      tried.add(rung.backend);
      log(`llama.cpp ${release.tag} ${rung.label} 를 받습니다…`);
      let bin: string;
      try {
        bin = await install(rung);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        attempts.push({ label: rung.label, ok: false, detail: why });
        log(`${rung.label} 를 받지 못했습니다 (${why}) — 다음 후보로 넘어갑니다.`);
        continue;
      }
      const verdict = await verify(bin, rung.backend !== "cpu");
      if (!verdict.ok) {
        attempts.push({ label: rung.label, ok: false, binPath: bin, detail: `받았지만 실행되지 않음: ${verdict.detail ?? "알 수 없음"}` });
        log(`${rung.label} 는 받았지만 이 머신에서 실행되지 않습니다 (${verdict.detail ?? "알 수 없음"}) — 다음 후보로 넘어갑니다.`);
        continue;
      }
      attempts.push({ label: rung.label, ok: true, binPath: bin });
      return { binPath: bin, backend: rung.backend, source: "downloaded", attempts };
    }
  }

  // 2. Source. Last, because it is 10-40 minutes and needs a toolchain.
  if (opts.allowBuild === false) {
    log("사전 빌드를 얻지 못했고 빌드가 금지되어 있습니다.");
    for (const a of attempts) log(`  - ${a.label}: ${a.detail}`);
    return null;
  }
  const build = opts.build ?? buildLlamaCpp;
  const mkBackend = (forced?: "cpu") => build({ hw, run: opts.run as never, log, backend: forced, onProgress: opts.onProgress });
  for (const forced of [undefined, "cpu"] as const) {
    try {
      const binPath = await mkBackend(forced);
      const accelerated = forced === undefined && /build-(cuda|rocm|vulkan|metal)/.test(binPath);
      const verdict = await verify(binPath, accelerated);
      const label = `소스 빌드 (${forced ?? "자동"})`;
      if (!verdict.ok) {
        attempts.push({ label, ok: false, binPath, detail: verdict.detail });
        if (!accelerated) break; // CPU rebuild would be identical
        log(`가속 빌드가 동작하지 않아 CPU 로 다시 빌드합니다: ${verdict.detail}`);
        continue;
      }
      attempts.push({ label, ok: true, binPath });
      const backend = (/build-(cuda|rocm|vulkan|metal)/.exec(binPath)?.[1] ?? "cpu") as LlamaLocation["backend"];
      return { binPath, backend, source: "built", attempts };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      attempts.push({ label: `소스 빌드 (${forced ?? "자동"})`, ok: false, detail });
      log(`빌드 실패: ${detail}`);
      break;
    }
  }
  for (const a of attempts) log(`  - ${a.label}: ${a.ok ? "성공" : a.detail}`);
  return null;
}

export { LLAMA_CPP_REPO };
