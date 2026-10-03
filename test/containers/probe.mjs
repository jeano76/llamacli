#!/usr/bin/env node
// What llamacli would decide on THIS machine, from the built dist (no TUI, no network, no side effects).
// Prints one JSON object. Used identically inside a container and by the host-mode runner.
//   LLAMACLI_DIST=/opt/llamacli/dist node probe.mjs
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const dist = resolve(process.env.LLAMACLI_DIST || new URL("../../dist", import.meta.url).pathname);
const load = (p) => import(pathToFileURL(resolve(dist, p)).href);
const GiB = 1024 ** 3;

const run = (file, args = []) => new Promise((res, rej) =>
  execFile(file, args, { timeout: 8000 }, (e, so) => (e ? rej(e) : res(String(so)))));

const { detectHardware, pickPrimaryGpu } = await load("setup/hardware.js");
const { detectCudaVersion } = await load("setup/engineCommon.js");
const { stockRungsFor } = await load("setup/stockRuntime.js");
const { chooseModel } = await load("setup/modelCatalog.js");
const { tuneForHardware } = await load("setup/tuning.js");
const { planBuildEnv } = await load("setup/buildEnv.js");

const hw = await detectHardware();
const gpu = pickPrimaryGpu(hw);

// The published llama.cpp asset names (same set profiles.test.ts uses), so the ladder is deterministic offline.
const TAG = "b1";
const assets = [
  `llama-${TAG}-bin-ubuntu-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
  `llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `cudart-llama-${TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `cudart-llama-${TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
  `llama-${TAG}-bin-macos-arm64.tar.gz`,
  `llama-${TAG}-bin-win-cpu-x64.zip`, `llama-${TAG}-bin-win-cuda-12.4-x64.zip`, `llama-${TAG}-bin-win-cuda-13.4-x64.zip`,
];
const release = { tag: TAG, assets: assets.map((name) => ({ name, url: name })) };
const cudaVersion = hw.gpuBackend === "cuda" ? await detectCudaVersion(run).catch(() => null) : null;
const rungs = stockRungsFor(release, { platform: hw.platform, arch: hw.arch ?? process.arch, gpuBackend: hw.gpuBackend, cudaVersion, hasCudaToolkit: Boolean(hw.tools.nvcc) });

const cand = (filename, gib) => ({ repo: "r", filename, sizeBytes: gib * GiB, url: "u" });
const choice = chooseModel({
  vramTotalBytes: gpu?.vramTotalBytes ?? 0, vramFreeBytes: gpu?.vramFreeBytes ?? 0, ramTotalBytes: hw.ramTotalBytes,
  candidates35b: [cand("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 20.4)], candidates9b: [cand("Ornith-1.5-9B-Q4_K_M.gguf", 5.1)],
});
const moe = /35B/.test(choice.candidate.filename);
const t = tuneForHardware(hw, { modelBytes: choice.candidate.sizeBytes, moe, kvElementsPerToken: 10240, modelLayers: moe ? 41 : 32 });
const plan = planBuildEnv(hw, { isRoot: process.getuid?.() === 0 });

console.log(JSON.stringify({
  detected: {
    platform: hw.platform, arch: hw.arch, cpuCount: hw.cpuCount, ramGiB: Math.round((hw.ramTotalBytes / GiB) * 10) / 10,
    gpuBackend: hw.gpuBackend, gpus: hw.gpus.map((g) => ({ name: g.name, vramGiB: Math.round((g.vramTotalBytes / GiB) * 10) / 10 })),
    tools: Object.keys(hw.tools).filter((k) => hw.tools[k]).sort(),
  },
  engineLadder: rungs.map((r) => r.backend),
  cudaVersion,
  model: choice.candidate.filename,
  tuning: { gpuLayers: t.gpuLayers, cpuMoeLayers: t.cpuMoeLayers, contextSize: t.contextSize, threads: t.threads },
  buildPlan: { manager: plan.manager ?? null, commands: plan.commands.length, manual: Boolean(plan.manual) },
}));
