import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLlamaCpp } from "./llamaCpp.js";
import type { Hardware } from "./hardware.js";


const GiB = 1024 ** 3;
const hw = (o: Partial<Hardware> = {}): Hardware => ({
  cpuCount: 12, ramTotalBytes: 32 * GiB, ramAvailableBytes: 24 * GiB, gpus: [], gpuBackend: "none",
  canBuildCuda: false, tools: { git: true, cmake: true, "g++": true, make: true }, platform: "linux", arch: "x64", ...o,
});
const roomy = async () => ({ bsize: 4096, bavail: (500 * GiB) / 4096, blocks: (1000 * GiB) / 4096 });

async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), "llc-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A `run` that records calls and "produces" the binary when the build step runs. */
function fakeRun(dir: string, o: { failBuildAbove?: number } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === "git" && args[0] === "config") return "https://github.com/ggml-org/llama.cpp\n";
    if (file === "cmake" && args.includes("--build")) {
      const j = Number(args[args.indexOf("-j") + 1]);
      if (o.failBuildAbove !== undefined && j > o.failBuildAbove) throw new Error("c++: Killed");
      const bdir = args[args.indexOf("--build") + 1];
      await mkdir(join(dir, bdir, "bin"), { recursive: true });
      await writeFile(join(dir, bdir, "bin", "llama-server"), "#!/bin/sh\n");
      await chmod(join(dir, bdir, "bin", "llama-server"), 0o755);
    }
    return "";
  };
  return { run, calls };
}

const WIN_SKIP = process.platform === "win32" ? "POSIX fixtures on Windows: shell-script fake binaries without .exe, posix path literals \u2014 needs Windows fixtures (covered by test/windows/run.mjs)" : false;

test("a machine with every tool installs nothing and never touches sudo", { skip: WIN_SKIP }, async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir);
  await buildLlamaCpp({ hw: hw(), run, home: dir, statfs: roomy });
  assert.ok(!calls.some((c) => c.file === "sudo" || c.file === "apt-get"));
});

test("CPU box configures a CPU build; no CUDA flag", { skip: WIN_SKIP }, async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir);
  const bin = await buildLlamaCpp({ hw: hw(), run, home: dir, statfs: roomy });
  const cfg = calls.find((c) => c.file === "cmake" && c.args.includes("-B"))!;
  assert.ok(cfg.args.includes("build-cpu"));
  assert.ok(!cfg.args.some((a) => a.includes("CUDA") || a.includes("VULKAN")));
  assert.ok(bin.endsWith("build-cpu/bin/llama-server"));
});

test("a Vulkan-capable AMD box builds Vulkan", { skip: WIN_SKIP }, async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir);
  await buildLlamaCpp({
    hw: hw({ gpuBackend: "vulkan", canBuildVulkan: true, tools: { git: true, cmake: true, "g++": true, make: true, glslc: true } }),
    run, home: dir, statfs: roomy,
  });
  assert.ok(calls.find((c) => c.file === "cmake" && c.args.includes("-DGGML_VULKAN=ON")));
});

test("CUDA build is narrowed to the card's architecture", { skip: WIN_SKIP }, async () => {
  const dir = await checkout();
  const calls: string[][] = [];
  const inner = fakeRun(dir);
  const run = async (f: string, a: string[], o?: never) => {
    if (f === "nvidia-smi") return "7.5\n";
    calls.push([f, ...a]);
    return inner.run(f, a);
  };
  await buildLlamaCpp({ hw: hw({ gpuBackend: "cuda", canBuildCuda: true, gpus: [{ index: 0, name: "x", vramTotalBytes: 8 * GiB, vramFreeBytes: 8 * GiB }] }), run: run as never, home: dir, statfs: roomy });
  const cfg = calls.find((c) => c[0] === "cmake" && c.includes("-B"))!;
  assert.ok(cfg.includes("-DCMAKE_CUDA_ARCHITECTURES=75"));
});

test("an OOM-killed parallel build is retried once, serially", { skip: WIN_SKIP }, async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir, { failBuildAbove: 1 });
  await buildLlamaCpp({ hw: hw({ cpuCount: 8 }), run, home: dir, statfs: roomy });
  const builds = calls.filter((c) => c.args.includes("--build"));
  assert.equal(builds.length, 2);
  assert.equal(builds[1].args[builds[1].args.indexOf("-j") + 1], "1");
});

test("preflight refuses a full disk before cloning anything", async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir);
  const tight = async () => ({ bsize: 4096, bavail: (1 * GiB) / 4096, blocks: (100 * GiB) / 4096 });
  await assert.rejects(buildLlamaCpp({ hw: hw(), run, home: dir, statfs: tight }), /디스크/);
  assert.equal(calls.length, 0);
});

test("missing tools with no package manager stop the build with the manual instruction", async () => {
  const dir = await checkout();
  const { run, calls } = fakeRun(dir);
  await assert.rejects(
    buildLlamaCpp({ hw: hw({ tools: {} }), run, home: dir, statfs: roomy }),
    /패키지 관리자/
  );
  assert.ok(!calls.some((c) => c.file === "cmake"));
});
