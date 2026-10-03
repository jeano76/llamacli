import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { planBuildEnv, applyBuildEnv } from "./buildEnv.js";
import { chooseBuildTarget, detectHipInfo, buildDiskBytes } from "./buildTarget.js";
import { buildLlamaCpp, makeBuildProgress } from "./llamaCpp.js";
import { windowsAdapterHasVulkanGpu, detectHardware, type Hardware } from "./hardware.js";
import { stockRungsFor, type Release } from "./stockRuntime.js";
import { formatProgress, type TransferProgress } from "./download.js";
import { ensureLocalStack } from "./bootstrap.js";

const GiB = 1024 ** 3;
const tools = (p: string[]) => Object.fromEntries(p.map((t) => [t, true]));

// ── user-space cmake ────────────────────────────────────────────────────────

test("no root, no sudo, only cmake missing, pip present: install cmake into the user's dir", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "g++", "make", "apt-get", "pip3"]) }, { isRoot: false });
  assert.equal(plan.commands.length, 1);
  assert.deepEqual([plan.commands[0].file, ...plan.commands[0].args], ["pip3", "install", "--user", "cmake"]);
  assert.equal(plan.commands[0].privileged, false);
  assert.equal(plan.cmakeBin, join(homedir(), ".local", "bin", "cmake"));
  assert.equal(plan.manual, undefined);
});

test("user-space install is NOT offered when a compiler is also missing — pip cannot supply one", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "make", "apt-get", "pip3"]) }, { isRoot: false });
  assert.deepEqual(plan.commands, []);
  assert.ok(plan.manual);
});

test("a user-space cmake is verified by its path, not by PATH", async () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "g++", "make", "apt-get", "pip3"]) }, { isRoot: false });
  const ran: string[] = [];
  const res = await applyBuildEnv(plan, {
    run: (async (f: string) => { ran.push(f); if (f === "cmake") throw new Error("not on PATH"); return ""; }) as never,
  });
  assert.equal(res.ok, true);
  assert.ok(ran.includes(plan.cmakeBin!));
});

test("buildLlamaCpp invokes the user-space cmake by absolute path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llc-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  const calls: string[] = [];
  const run = async (f: string, a: string[]) => {
    calls.push(f);
    if (f === "git" && a[0] === "config") return "https://github.com/ggml-org/llama.cpp";
    if (a.includes("--build")) {
      await mkdir(join(dir, "build-cpu", "bin"), { recursive: true });
      await writeFile(join(dir, "build-cpu", "bin", "llama-server"), "x");
      await chmod(join(dir, "build-cpu", "bin", "llama-server"), 0o755);
    }
    return "";
  };
  const hw: Hardware = { cpuCount: 4, ramTotalBytes: 16 * GiB, ramAvailableBytes: 12 * GiB, gpus: [], gpuBackend: "none", canBuildCuda: false,
    tools: tools(["git", "g++", "make", "apt-get", "pip3"]), platform: "linux", arch: "x64" };
  const roomy = async () => ({ bsize: 4096, bavail: (500 * GiB) / 4096, blocks: (900 * GiB) / 4096 });
  await buildLlamaCpp({ hw, run: run as never, home: dir, statfs: roomy, interactive: false });
  assert.ok(calls.includes(join(homedir(), ".local", "bin", "cmake")));
  assert.ok(!calls.includes("cmake"));
  await rm(dir, { recursive: true, force: true });
});

// ── network preflight ───────────────────────────────────────────────────────

test("an unreachable repository is reported before the tools install or the clone starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llc-"));
  const calls: string[][] = [];
  const run = async (f: string, a: string[]) => {
    calls.push([f, ...a]);
    if (a[0] === "ls-remote") throw new Error("fatal: unable to access: Could not resolve host: github.com");
    return "";
  };
  const hw: Hardware = { cpuCount: 4, ramTotalBytes: 16 * GiB, ramAvailableBytes: 12 * GiB, gpus: [], gpuBackend: "none", canBuildCuda: false,
    tools: tools(["git", "cmake", "g++", "make"]), platform: "linux", arch: "x64" };
  const roomy = async () => ({ bsize: 4096, bavail: (500 * GiB) / 4096, blocks: (900 * GiB) / 4096 });
  await assert.rejects(buildLlamaCpp({ hw, run: run as never, home: dir, statfs: roomy }), /연결할 수 없어.*Could not resolve host/s);
  assert.ok(!calls.some((c) => c[1] === "clone"), "no clone attempted");
  await rm(dir, { recursive: true, force: true });
});

// ── ROCm ────────────────────────────────────────────────────────────────────

const hwOf = (o: object) => ({ gpuBackend: "none" as const, canBuildCuda: false, canBuildVulkan: false, platform: "linux", arch: "x64", ...o });

test("AMD with hipcc builds ROCm, told where the compiler is and which GPUs to target", () => {
  const t = chooseBuildTarget(hwOf({ gpuBackend: "rocm", canBuildRocm: true }), null, undefined, { compiler: "/opt/rocm/llvm/bin/clang", targets: "gfx1100;gfx1030" });
  assert.equal(t.backend, "rocm");
  assert.equal(t.dir, "build-rocm");
  assert.deepEqual(t.flags, ["-DGGML_HIP=ON", "-DCMAKE_HIP_COMPILER=/opt/rocm/llvm/bin/clang", "-DAMDGPU_TARGETS=gfx1100;gfx1030"]);
  assert.ok(buildDiskBytes("rocm") >= 6 * GiB);
});

test("ROCm flags that could not be read are omitted, not guessed", () => {
  const t = chooseBuildTarget(hwOf({ gpuBackend: "rocm", canBuildRocm: true }), null, undefined, {});
  assert.deepEqual(t.flags, ["-DGGML_HIP=ON"]);
});

test("forced cpu beats ROCm; NVIDIA still wins over ROCm", () => {
  assert.equal(chooseBuildTarget(hwOf({ canBuildRocm: true }), null, "cpu").backend, "cpu");
  assert.equal(chooseBuildTarget(hwOf({ canBuildCuda: true, canBuildRocm: true }), "75").backend, "cuda");
});

test("hip info is read from hipconfig and rocminfo; absence is tolerated", async () => {
  const info = await detectHipInfo((async (f: string) => {
    if (f === "hipconfig") return "/opt/rocm/llvm/bin\n";
    return "Name: gfx1100\nName: gfx1100\nName: gfx1030\n";
  }) as never);
  assert.deepEqual(info, { compiler: "/opt/rocm/llvm/bin/clang", targets: "gfx1100;gfx1030" });
  assert.deepEqual(await detectHipInfo((async () => { throw new Error("nope"); }) as never), { targets: null });
});

// ── Windows non-NVIDIA, Intel Mac ───────────────────────────────────────────

test("Windows adapter names: real AMD/Intel GPUs count, Windows' software adapters do not", () => {
  assert.equal(windowsAdapterHasVulkanGpu("AMD Radeon RX 7800 XT\n"), true);
  assert.equal(windowsAdapterHasVulkanGpu("Intel(R) Arc(TM) A770 Graphics\r\n"), true);
  assert.equal(windowsAdapterHasVulkanGpu("Intel(R) UHD Graphics 630\n"), true);
  assert.equal(windowsAdapterHasVulkanGpu("Microsoft Basic Render Driver\n"), false);
  assert.equal(windowsAdapterHasVulkanGpu("Microsoft Remote Display Adapter\nMicrosoft Hyper-V Video\n"), false);
  assert.equal(windowsAdapterHasVulkanGpu(""), false);
});

test("a Windows machine with an AMD adapter and no NVIDIA gets the Vulkan backend", async () => {
  const run = (async (f: string, a: string[]) => {
    if (f === "where") throw new Error("nf");
    if (f === "powershell") return "AMD Radeon RX 7800 XT\r\n";
    throw new Error("ENOENT");
  }) as never;
  const hw = await detectHardware(run, { platform: "win32", arch: "x64", ramTotalBytes: 32 * GiB, ramAvailableBytes: 20 * GiB, cpuCount: 8, listDir: async () => [], readText: async () => null });
  assert.equal(hw.gpuBackend, "vulkan");
  assert.deepEqual(hw.gpus, []);
});

test("a Windows machine whose only adapter is Hyper-V stays CPU", async () => {
  const run = (async (f: string) => { if (f === "powershell") return "Microsoft Hyper-V Video\n"; throw new Error("x"); }) as never;
  const hw = await detectHardware(run, { platform: "win32", arch: "x64", ramTotalBytes: 8 * GiB, ramAvailableBytes: 4 * GiB, cpuCount: 4, listDir: async () => [], readText: async () => null });
  assert.equal(hw.gpuBackend, "none");
});

test("an Intel Mac gets the macOS x64 archive without being promised Metal", () => {
  const release: Release = { tag: "b1", assets: ["llama-b1-bin-macos-x64.tar.gz", "llama-b1-bin-macos-arm64.tar.gz"].map((name) => ({ name, url: name })) };
  const rungs = stockRungsFor(release, { platform: "darwin", arch: "x64", gpuBackend: "none", hasCudaToolkit: false });
  assert.deepEqual(rungs.map((r) => [r.backend, r.asset.name]), [["cpu", "llama-b1-bin-macos-x64.tar.gz"]]);
});

// ── build progress on the one-line channel ──────────────────────────────────

test("build progress goes to the redrawn line when a reporter is given, not to the log", () => {
  const logged: string[] = [];
  const reports: TransferProgress[] = [];
  let t = 0;
  const p = makeBuildProgress((l) => logged.push(l), "CUDA", () => t, 60_000, (r) => reports.push(r));
  t = 125_000;
  p("[ 42%] Building CXX object x");
  assert.deepEqual(logged, []);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].phase, "build");
  assert.equal(reports[0].percent, 42);
  assert.match(formatProgress(reports[0]), /42%.*CUDA 빌드 2분 경과/);
});

test("a transfer's progress line is unchanged by the build phase", () => {
  const line = formatProgress({ label: "m.gguf", receivedBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3, bytesPerSecond: 1024 ** 2, etaSeconds: 60, percent: 50 });
  assert.match(line, /50%/);
  assert.ok(!line.includes("빌드"));
});

// ── engine and download run side by side ────────────────────────────────────

const hw = {
  cpuCount: 12, ramTotalBytes: 30 * GiB, ramAvailableBytes: 26 * GiB,
  gpus: [{ index: 0, name: "RTX 2070", vramTotalBytes: 8 * GiB, vramFreeBytes: 7 * GiB }],
  gpuBackend: "cuda" as const, canBuildCuda: true, tools: {}, platform: "linux",
};
const emptyEnv = (dir: string) => ({ HOME: join(dir, "home"), PATH: "" }) as NodeJS.ProcessEnv;
const hubStub = (fileSize: number) => (async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes("/api/models/ornith-ai/Ornith-1.5-35B-A3B-GGUF")) {
    return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ornith-1.5-35B-A3B-Q4_K_M.gguf", size: fileSize }] }) } as any;
  }
  return { ok: false, status: 404, json: async () => ({}), headers: new Headers() } as any;
}) as unknown as typeof fetch;

test("the model download starts while the engine is still being acquired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-par-"));
  try {
    const events: string[] = [];
    let releaseEngine!: () => void;
    const engineGate = new Promise<void>((r) => (releaseEngine = r));
    const modelsDir = join(dir, "models");
    await mkdir(modelsDir, { recursive: true });
    // The model is already on disk, so the "download" step is a no-op — what is being
    // asserted is ordering: the download part must not wait for the engine to finish.
    await writeFile(join(modelsDir, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), Buffer.alloc(4096));
    const p = ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free", modelsDir,
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      fetchImpl: hubStub(4096),
      log: (l) => { if (l.includes("모델 이미 있음")) { events.push("download-seen"); releaseEngine(); } },
      acquireStock: (async () => { events.push("engine-start"); await engineGate; events.push("engine-end"); return { binPath: "/fake/llama-server", backend: "cuda", source: "downloaded", attempts: [] }; }) as never,
    });
    await p;
    assert.deepEqual(events, ["engine-start", "download-seen", "engine-end"],
      "the download step ran while the engine was still pending");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("if the engine cannot be had, the in-flight model download is aborted and says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-par-"));
  try {
    const modelsDir = join(dir, "models");
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("/api/models/ornith-ai/Ornith-1.5-35B-A3B-GGUF")) {
        return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ornith-1.5-35B-A3B-Q4_K_M.gguf", size: 5_000_000 }] }) } as any;
      }
      if (u.includes("/resolve/main/")) {
        sawSignal = init?.signal;
        if (init?.signal?.aborted) throw new Error("download aborted");
        // A transfer that only ends when it is aborted.
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("download aborted"))));
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free", modelsDir,
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      fetchImpl,
      acquireStock: (async () => null) as never,
    });
    assert.ok(sawSignal, "the download was started with an abort signal");
    const dl = report.steps.find((s) => s.name === "모델 다운로드");
    assert.equal(dl?.ok, false);
    assert.match(dl?.detail ?? "", /이어받습니다/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── second launch with the new install location: no network, no acquisition ──

test("a second launch finds the prebuilt that the first one installed and acquires nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-again-"));
  try {
    const home = join(dir, "home");
    const bin = join(home, ".llamacli", "llama.cpp-prebuilt", "cpu", "llama-server");
    await mkdir(join(home, ".llamacli", "llama.cpp-prebuilt", "cpu"), { recursive: true });
    await writeFile(bin, "#!/bin/sh\necho 'version: 1 (abc)'\n");
    await chmod(bin, 0o755);
    const model = join(dir, "a", "b", "c", "d", "Ornith-1.5-9B-Q4_K_M.gguf");
    await mkdir(join(dir, "a", "b", "c", "d"), { recursive: true });
    await writeFile(model, Buffer.alloc(4096));
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    await writeFile(join(dir, ".llamacli", "config.yaml"), `model: ${model}\nllama:\n  modelPath: ${model}\n`);
    let acquired = 0;
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv, probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      fetchImpl: (async () => { throw new Error("must not touch the network"); }) as never,
      acquireStock: (async () => { acquired++; return null; }) as never,
    });
    assert.equal(acquired, 0);
    assert.equal(report.llama?.binPath, bin);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
