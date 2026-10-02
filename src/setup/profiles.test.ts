import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHardware, pickPrimaryGpu, type HostProbe } from "./hardware.js";
import { stockRungsFor, type Release } from "./stockRuntime.js";
import { planBuildEnv } from "./buildEnv.js";
import { chooseBuildTarget } from "./buildTarget.js";
import { chooseModel, type ModelCandidate } from "./modelCatalog.js";

// The §4.1 matrix: one synthetic machine per row, run through detection → engine →
// build plan → model, asserting the whole chain. Not a benchmark: it pins WHICH
// decisions each kind of machine gets, so a change that moves one is visible.

const GiB = 1024 ** 3;
const TAG = "b1";
const assets = [
  `llama-${TAG}-bin-ubuntu-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `cudart-llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `llama-${TAG}-bin-macos-arm64.tar.gz`,
  `llama-${TAG}-bin-win-cpu-x64.zip`, `llama-${TAG}-bin-win-cuda-12.4-x64.zip`, `llama-${TAG}-bin-win-cuda-13.4-x64.zip`,
  `cudart-llama-bin-win-cuda-12.4-x64.zip`, `cudart-llama-bin-win-cuda-13.4-x64.zip`,
];
const release: Release = { tag: TAG, assets: assets.map((name) => ({ name, url: name })) };

const cand = (filename: string, gib: number): ModelCandidate => ({ repo: "r", filename, sizeBytes: gib * GiB, url: "u" });
const catalog = {
  candidates35b: [cand("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21.4)],
  candidates9b: [cand("Ornith-1.5-9B-Q4_K_M.gguf", 5.4)],
  bonsai: {
    "27B": [cand("Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5.5)],
    "8B": [cand("Ternary-Bonsai-8B-PQ2_0.gguf", 2.0)],
    "4B": [cand("Ternary-Bonsai-4B-PQ2_0.gguf", 1.0)],
  },
};

interface Row {
  name: string; platform: string; arch?: string; ramGiB: number;
  tools: string[]; cmds?: Record<string, string>; drm?: { vendor: string; vramGiB: number };
  expectBackend: string; expectRungs: string[]; expectModel: RegExp; expectPlan: "none" | string;
}
const base = ["git", "cmake", "g++", "make"];
const rows: Row[] = [
  { name: "nvidia-small", platform: "linux", ramGiB: 30, tools: [...base, "apt-get", "sudo"], cmds: { "nvidia-smi": "0, RTX 2070 SUPER, 8192, 7456\n" },
    expectBackend: "cuda", expectRungs: ["cuda", "vulkan", "cpu"], expectModel: /Bonsai-2-27B/, expectPlan: "none" },
  { name: "nvidia-large", platform: "linux", ramGiB: 64, tools: [...base, "apt-get", "sudo"], cmds: { "nvidia-smi": "0, RTX 4090, 24564, 24000\n" },
    expectBackend: "cuda", expectRungs: ["cuda", "vulkan", "cpu"], expectModel: /Bonsai-2-27B/, expectPlan: "none" },
  { name: "cpu-only", platform: "linux", ramGiB: 16, tools: [...base, "apt-get"],
    expectBackend: "none", expectRungs: ["cpu"], expectModel: /Ornith-1.5-9B/, expectPlan: "none" },
  { name: "amd", platform: "linux", ramGiB: 32, tools: [...base, "dnf", "sudo"], drm: { vendor: "0x1002", vramGiB: 20 },
    expectBackend: "vulkan", expectRungs: ["vulkan", "cpu"], expectModel: /Bonsai-2-27B/, expectPlan: "none" },
  { name: "apple", platform: "darwin", arch: "arm64", ramGiB: 24, tools: [...base, "brew"],
    expectBackend: "metal", expectRungs: ["metal"], expectModel: /Bonsai-2-27B/, expectPlan: "none" },
  { name: "fedora-nodeps", platform: "linux", ramGiB: 16, tools: ["dnf", "sudo"],
    expectBackend: "none", expectRungs: ["cpu"], expectModel: /Ornith-1.5-9B/, expectPlan: "dnf" },
  { name: "alpine-min", platform: "linux", ramGiB: 4, tools: ["apk"],
    expectBackend: "none", expectRungs: ["cpu"], expectModel: /Bonsai-8B/, expectPlan: "manual" },
  { name: "win-nvidia", platform: "win32", ramGiB: 32, tools: ["winget", "git", "cmake"], cmds: { "nvidia-smi": "0, RTX 3060, 12288, 11000\n" },
    expectBackend: "cuda", expectRungs: ["cuda", "cpu"], expectModel: /Bonsai-2-27B/, expectPlan: "winget" },
];

for (const r of rows) {
  test(`profile ${r.name}: engine → build plan → model`, async () => {
    const run = (async (file: string, args: string[]) => {
      if (file === "sh" || file === "where") {
        const t = file === "sh" ? args[1].replace("command -v ", "") : args[0];
        if (r.tools.includes(t) || (r.cmds && t in r.cmds)) return `/bin/${t}`;
        throw new Error("nf");
      }
      if (r.cmds && file in r.cmds) return r.cmds[file];
      throw new Error("ENOENT");
    }) as never;
    const dev = "/sys/class/drm/card0/device";
    const host: Partial<HostProbe> = {
      platform: r.platform, arch: r.arch ?? "x64", ramTotalBytes: r.ramGiB * GiB, ramAvailableBytes: r.ramGiB * GiB * 0.8, cpuCount: 8,
      readText: async (p) => r.drm ? ({ [`${dev}/vendor`]: r.drm.vendor, [`${dev}/mem_info_vram_total`]: String(r.drm.vramGiB * GiB) } as Record<string, string>)[p] ?? null : null,
      listDir: async (p) => (r.drm && p === "/sys/class/drm" ? ["card0"] : []),
    };
    const hw = await detectHardware(run, host);
    assert.equal(hw.gpuBackend, r.expectBackend, "backend");

    const rungs = stockRungsFor(release, {
      platform: hw.platform, arch: hw.arch!, gpuBackend: hw.gpuBackend, cudaVersion: hw.gpuBackend === "cuda" ? "13.4" : null, hasCudaToolkit: Boolean(hw.tools.nvcc),
    });
    const got = rungs.map((x) => x.backend);
    assert.deepEqual(got, r.expectRungs, "engine ladder");
    // The machine's own accelerator is always tried before any fallback.
    if (hw.gpuBackend !== "none") assert.equal(got[0], hw.gpuBackend);

    const plan = planBuildEnv(hw, { isRoot: false });
    if (r.expectPlan === "none") assert.deepEqual(plan.commands, [], "nothing to install");
    else if (r.expectPlan === "manual") assert.ok(plan.manual || plan.commands.length > 0);
    else assert.equal(plan.manager, r.expectPlan);

    // A CUDA card must never select a non-CUDA backend for a source build and vice versa.
    const target = chooseBuildTarget(hw);
    if (hw.gpuBackend === "none") assert.equal(target.backend, "cpu");

    const gpu = pickPrimaryGpu(hw);
    const choice = chooseModel({
      vramTotalBytes: gpu?.vramTotalBytes ?? 0, vramFreeBytes: gpu?.vramFreeBytes ?? 0, ramTotalBytes: hw.ramTotalBytes, ...catalog,
    });
    assert.match(choice.candidate.filename, r.expectModel);
  });
}
