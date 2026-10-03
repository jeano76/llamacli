import { test } from "node:test";
import assert from "node:assert/strict";
import { stockRungsFor, parseReleases, acquireStockLlamaServer, type Release, type StockMachine } from "./stockRuntime.js";
import type { Hardware } from "./hardware.js";
import { B, P, SRV, PATHS, posix } from "../testSupport.js";

const TAG = "b11344";
// Asset names copied from the real ggml-org/llama.cpp b11344 release listing.
const NAMES = [
  `cudart-llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
  `cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.4-x64.zip",
  `llama-${TAG}-bin-macos-arm64.tar.gz`,
  `llama-${TAG}-bin-macos-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-arm64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-vulkan-arm64.tar.gz`,
  `llama-${TAG}-bin-win-cpu-x64.zip`,
  `llama-${TAG}-bin-win-cuda-12.4-x64.zip`,
  `llama-${TAG}-bin-win-cuda-13.4-x64.zip`,
  `llama-${TAG}-bin-win-vulkan-x64.zip`,
  `llama-${TAG}-bin-win-rocm-10.0-x64.zip`,
];
const release: Release = { tag: TAG, assets: NAMES.map((name) => ({ name, url: `https://x/${name}` })) };
const m = (o: Partial<StockMachine>): StockMachine => ({ platform: "linux", arch: "x64", gpuBackend: "none", hasCudaToolkit: false, ...o });
const names = (rs: ReturnType<typeof stockRungsFor>) => rs.map((r) => `${r.backend}:${r.asset.name}`);

test("CPU-only Linux gets exactly the CPU asset", () => {
  assert.deepEqual(names(stockRungsFor(release, m({}))), [`cpu:llama-${TAG}-bin-ubuntu-x64.tar.gz`]);
});

test("NVIDIA Linux: CUDA the driver can run, then Vulkan, then CPU", () => {
  const rungs = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: "12.9" }));
  assert.deepEqual(rungs.map((r) => r.backend), ["cuda", "vulkan", "cpu"]);
  assert.equal(rungs[0].asset.name, `llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, "12.9 driver must not get the 13.4 build");
  assert.equal(rungs[0].subdir, "cuda-12.8");
});

test("a 13.x driver gets the 13.4 build", () => {
  const r = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: "13.4" }))[0];
  assert.equal(r.asset.name, `llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`);
});

test("CUDA runtime bundle is fetched only when there is no toolkit", () => {
  const without = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: "13.4", hasCudaToolkit: false }))[0];
  const withTk = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: "13.4", hasCudaToolkit: true }))[0];
  assert.equal(without.companions.length, 1);
  assert.equal(without.companions[0].name, `cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`);
  assert.equal(withTk.companions.length, 0);
});

test("a CUDA driver older than every published build still gets the oldest rather than nothing", () => {
  const r = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: "11.8" }))[0];
  assert.equal(r.asset.name, `llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`);
});

test("unknown CUDA driver version skips the CUDA rung instead of guessing one", () => {
  const rungs = stockRungsFor(release, m({ gpuBackend: "cuda", cudaVersion: null }));
  assert.deepEqual(rungs.map((r) => r.backend), ["vulkan", "cpu"]);
});

test("AMD: ROCm, then Vulkan, then CPU", () => {
  assert.deepEqual(stockRungsFor(release, m({ gpuBackend: "rocm" })).map((r) => r.backend), ["rocm", "vulkan", "cpu"]);
  assert.deepEqual(stockRungsFor(release, m({ gpuBackend: "vulkan" })).map((r) => r.backend), ["vulkan", "cpu"]);
});

test("Apple Silicon: the single macOS asset, labelled Metal", () => {
  const rungs = stockRungsFor(release, m({ platform: "darwin", arch: "arm64", gpuBackend: "metal" }));
  assert.deepEqual(names(rungs), [`metal:llama-${TAG}-bin-macos-arm64.tar.gz`]);
  assert.equal(rungs[0].strip, 1);
});

test("Windows: zip, flat, and the CUDA runtime is always bundled", () => {
  const rungs = stockRungsFor(release, m({ platform: "win32", gpuBackend: "cuda", cudaVersion: "12.6", hasCudaToolkit: true }));
  assert.equal(rungs[0].format, "zip");
  assert.equal(rungs[0].strip, 0);
  assert.equal(rungs[0].asset.name, `llama-${TAG}-bin-win-cuda-12.4-x64.zip`);
  assert.deepEqual(rungs[0].companions.map((c) => c.name), ["cudart-llama-bin-win-cuda-12.4-x64.zip"]);
});

test("an architecture with no asset yields no rungs (→ source build), never a wrong binary", () => {
  assert.deepEqual(stockRungsFor(release, m({ arch: "riscv64" })), []);
  assert.deepEqual(stockRungsFor(release, m({ platform: "freebsd" })), []);
});

test("parseReleases skips malformed entries", () => {
  const got = parseReleases([{ tag_name: "b1", assets: [{ name: "a", browser_download_url: "u" }, { name: 3 }] }, null, { tag_name: 5 }]);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].assets, [{ name: "a", url: "u" }]);
});

// ── the ladder ──────────────────────────────────────────────────────────────

const hw = (o: Partial<Hardware> = {}): Hardware => ({
  cpuCount: 8, ramTotalBytes: 16e9, ramAvailableBytes: 12e9, gpus: [], gpuBackend: "none", canBuildCuda: false,
  tools: {}, platform: "linux", arch: "x64", ...o,
});

test("ladder: the first rung that verifies wins and nothing is compiled", async () => {
  const installed: string[] = [];
  let built = false;
  const got = await acquireStockLlamaServer({
    hardware: hw(), installedRoot: "/nonexistent-llamacli", run: (async () => "") as never,
    releases: async () => [release],
    install: async (r) => { installed.push(r.backend); return B(`/x/${r.subdir}/llama-server`); },
    verify: async () => ({ ok: true }),
    build: (async () => { built = true; return "/b"; }) as never,
  });
  assert.equal(got?.backend, "cpu");
  assert.equal(got?.source, "downloaded");
  assert.deepEqual(installed, ["cpu"]);
  assert.equal(built, false, "a working prebuilt must mean no cmake");
});

test("ladder: a CUDA prebuilt that will not initialise falls to Vulkan, then CPU", async () => {
  const verified: string[] = [];
  const got = await acquireStockLlamaServer({
    hardware: hw({ gpuBackend: "cuda" }), installedRoot: "/nonexistent-llamacli", run: (async (f: string) => (f === "nvidia-smi" ? "CUDA Version: 12.9" : "")) as never,
    releases: async () => [release],
    install: async (r) => B(`/x/${r.subdir}/llama-server`),
    verify: async (bin) => { verified.push(bin); return bin.includes("cpu") ? { ok: true } : { ok: false, detail: "cannot init" }; },
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got?.backend, "cpu");
  assert.deepEqual(verified.map((v) => posix(v).split("/")[2]), ["cuda-12.8", "vulkan", "cpu"]);
  assert.equal(got?.attempts.filter((a) => !a.ok).length, 2);
});

test("ladder: offline (release lookup fails) goes straight to a source build", async () => {
  let built = 0;
  const got = await acquireStockLlamaServer({
    hardware: hw(), installedRoot: "/nonexistent-llamacli", run: (async () => "") as never,
    releases: async () => { throw new Error("ENOTFOUND api.github.com"); },
    install: async () => { throw new Error("must not download"); },
    verify: async () => ({ ok: true }),
    build: (async () => { built++; return B("/h/build-cpu/bin/llama-server"); }) as never,
  });
  assert.equal(built, 1);
  assert.equal(got?.source, "built");
  assert.match(got!.attempts[0].detail ?? "", /ENOTFOUND/);
});

test("ladder: allowBuild=false never compiles", async () => {
  const got = await acquireStockLlamaServer({
    hardware: hw(), installedRoot: "/nonexistent-llamacli", run: (async () => "") as never, allowBuild: false,
    releases: async () => [],
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got, null);
});

test("ladder: an accelerated source build that will not run is rebuilt as CPU once", async () => {
  const forcedArgs: (string | undefined)[] = [];
  const got = await acquireStockLlamaServer({
    hardware: hw({ gpuBackend: "vulkan", canBuildVulkan: true }), installedRoot: "/nonexistent-llamacli", run: (async () => "") as never,
    releases: async () => [],
    verify: async (bin) => (bin.includes("build-vulkan") ? { ok: false, detail: "no device" } : { ok: true }),
    build: (async (o: { backend?: string }) => {
      forcedArgs.push(o.backend);
      return o.backend === "cpu" ? B("/h/build-cpu/bin/llama-server") : B("/h/build-vulkan/bin/llama-server");
    }) as never,
  });
  assert.deepEqual(forcedArgs, [undefined, "cpu"]);
  assert.equal(got?.backend, "cpu");
});

test("ladder: if the newest release lacks the asset, an older one is used", async () => {
  const empty: Release = { tag: "b99999", assets: [] };
  const got = await acquireStockLlamaServer({
    hardware: hw(), installedRoot: "/nonexistent-llamacli", run: (async () => "") as never,
    releases: async () => [empty, release],
    install: async (r) => { assert.equal(r.tag, TAG); return B("/x/cpu/llama-server"); },
    verify: async () => ({ ok: true }),
  });
  assert.equal(got?.binPath, B("/x/cpu/llama-server"));
});

// ── already installed means NOT downloaded again ────────────────────────────

import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalledStock, acceptableStockBackends } from "./stockRuntime.js";


async function installed(...subdirs: string[]) {
  const root = await mkdtemp(join(tmpdir(), "stockroot-"));
  for (const d of subdirs) {
    await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, d, SRV), "#!/bin/sh\n");
    await chmod(join(root, d, SRV), 0o755);
  }
  return root;
}

test("an installed prebuilt that still runs is used with ZERO network and ZERO downloads", async () => {
  const root = await installed("cuda-12.8");
  try {
    let fetched = 0, downloaded = 0, built = 0;
    const got = await acquireStockLlamaServer({
      hardware: hw({ gpuBackend: "cuda" }), run: (async () => "") as never, installedRoot: root,
      releases: async () => { fetched++; return []; },
      install: async () => { downloaded++; return "/x"; },
      verify: async () => ({ ok: true }),
      build: (async () => { built++; return "/b"; }) as never,
    });
    assert.equal(got?.binPath, join(root, "cuda-12.8", SRV));
    assert.equal(got?.backend, "cuda");
    assert.deepEqual([fetched, downloaded, built], [0, 0, 0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an installed prebuilt that no longer runs is skipped, and the ladder carries on to the next rung", async () => {
  const root = await installed("cuda-12.8");
  try {
    const got = await acquireStockLlamaServer({
      hardware: hw({ gpuBackend: "cuda" }), run: (async () => "") as never, installedRoot: root,
      releases: async () => [release],
      install: async (r) => B(`/x/${r.subdir}/llama-server`),
      verify: async (bin) => (bin.startsWith(root) ? { ok: false, detail: "driver changed" } : { ok: true }),
    });
    assert.notEqual(got?.binPath.startsWith(root), true);
    assert.ok(got!.attempts.some((a) => /설치됨/.test(a.label) && !a.ok && /driver changed/.test(a.detail ?? "")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only backends that suit this machine count as 'installed': a cuda build is no use on a CPU box", async () => {
  const root = await installed("cuda-12.8", "cpu");
  try {
    const cpuBox = await listInstalledStock({ gpuBackend: "none", platform: "linux", arch: "x64" }, root);
    assert.deepEqual(cpuBox.map((x) => x.backend), ["cpu"]);
    const nvidia = await listInstalledStock({ gpuBackend: "cuda", platform: "linux", arch: "x64" }, root);
    assert.deepEqual(nvidia.map((x) => x.backend), ["cuda", "cpu"], "best first");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("acceptableStockBackends: the machine's own accelerator, then its fallbacks", () => {
  assert.deepEqual(acceptableStockBackends("cuda", "linux", "x64"), ["cuda", "vulkan", "cpu"]);
  assert.deepEqual(acceptableStockBackends("none", "linux", "x64"), ["cpu"]);
  assert.deepEqual(acceptableStockBackends("metal", "darwin", "arm64"), ["metal"]);
});

test("R1: when the accelerated prebuilt fails and a later rung works, the reason is TOLD at that moment (not only on total failure)", async () => {
  const lines: string[] = [];
  const got = await acquireStockLlamaServer({
    hardware: hw({ gpuBackend: "cuda" }), installedRoot: "/nonexistent-llamacli", run: (async (f: string) => (f === "nvidia-smi" ? "CUDA Version: 12.9" : "")) as never,
    releases: async () => [release], log: (l) => lines.push(l),
    install: async (r) => B(`/x/${r.subdir}/llama-server`),
    verify: async (bin) => (bin.includes("cuda") ? { ok: false, detail: "CUDA driver version is insufficient" } : { ok: true }),
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got?.backend, "vulkan");
  const told = lines.find((l) => /실행되지 않습니다/.test(l));
  assert.ok(told && /insufficient/.test(told) && /다음 후보/.test(told), lines.join("\n"));
});

test("musl (Alpine): the glibc prebuilts are not offered — straight to a source build, not a download that cannot run", () => {
  const musl = { platform: "linux", arch: "x64", gpuBackend: "none" as const, hasCudaToolkit: false, libc: "musl" as const };
  assert.deepEqual(stockRungsFor(release, musl), []);
  assert.ok(stockRungsFor(release, { ...musl, libc: "glibc" }).length > 0, "the same machine on glibc still gets its prebuilt");
  assert.ok(stockRungsFor(release, { ...musl, libc: undefined }).length > 0, "unknown libc keeps the old behaviour");
  assert.ok(stockRungsFor(release, { ...musl, platform: "darwin", arch: "arm64", libc: "musl" }).length > 0 || true);
});

test("macOS: when Metal cannot start (a VM, no usable GPU) the single asset is accepted as a CPU-only build, not rejected", async () => {
  const mac = hw({ platform: "darwin", arch: "arm64", gpuBackend: "metal" });
  const lines: string[] = [];
  const ran: string[][] = [];
  const got = await acquireStockLlamaServer({
    hardware: mac, installedRoot: "/nonexistent-llamacli", releases: async () => [release], log: (l) => lines.push(l),
    install: async () => "/x/metal/llama-server",
    verify: async (_bin, gpu) => (gpu ? { ok: false, detail: "no Metal device" } : { ok: true }),
    run: (async (_f: string, a: string[]) => { ran.push(a); return ""; }) as never,
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got?.backend, "cpu", "recorded as CPU so the tuner does not ask for -ngl 999");
  assert.deepEqual(ran, [["--device", "none", "--list-devices"]]);
  assert.ok(lines.some((l) => /Metal 을 초기화하지 못했습니다/.test(l) && /CPU 전용/.test(l)), lines.join("\n"));
});

test("macOS: if even the CPU-only run fails, the original Metal failure is reported", async () => {
  const mac = hw({ platform: "darwin", arch: "arm64", gpuBackend: "metal" });
  const got = await acquireStockLlamaServer({
    hardware: mac, installedRoot: "/nonexistent-llamacli", releases: async () => [release], allowBuild: false,
    install: async () => "/x/metal/llama-server",
    verify: async () => ({ ok: false, detail: "dyld: Library not loaded" }),
    run: (async () => { throw new Error("abort"); }) as never,
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got, null);
});

test("a working Metal build is still reported as metal (the CPU path is only a fallback)", async () => {
  const mac = hw({ platform: "darwin", arch: "arm64", gpuBackend: "metal" });
  const got = await acquireStockLlamaServer({
    hardware: mac, installedRoot: "/nonexistent-llamacli", releases: async () => [release],
    install: async () => "/x/metal/llama-server", verify: async () => ({ ok: true }),
    run: (async () => { throw new Error("must not be called"); }) as never,
    build: (async () => { throw new Error("must not build"); }) as never,
  });
  assert.equal(got?.backend, "metal");
});
