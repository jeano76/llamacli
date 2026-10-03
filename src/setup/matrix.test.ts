import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseModel, type ModelCandidate } from "./modelCatalog.js";
import { tuneForHardware } from "./tuning.js";
import type { Hardware } from "./hardware.js";

// The VRAM × RAM grid of docs/provisioning-matrix-and-single-server-prompt.md §1: not one
// expected value per cell, but the INVARIANTS every cell must satisfy. A tuner change that breaks
// one of them on any machine class shows up here.

const GiB = 1024 ** 3;
const cand = (filename: string, gib: number): ModelCandidate => ({ repo: "r", filename, sizeBytes: gib * GiB, url: "u" });
const C35 = [cand("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 20.4)];
const C9 = [cand("Ornith-1.5-9B-Q4_K_M.gguf", 5.1)];
const KV = 10240; // elements/token of the real hybrid models (header-read)

const hwOf = (vram: number, ram: number): Hardware => ({
  cpuCount: 8, ramTotalBytes: ram * GiB, ramAvailableBytes: ram * GiB * 0.8,
  gpus: vram ? [{ index: 0, name: "NVIDIA X", vramTotalBytes: vram * GiB, vramFreeBytes: vram * GiB * 0.92 }] : [],
  gpuBackend: vram ? "cuda" : "none", canBuildCuda: vram > 0, tools: {}, platform: "linux",
}) as never;

for (const vram of [0, 4, 6, 8, 12, 16, 24, 48]) {
  for (const ram of [4, 8, 16, 32, 64]) {
    test(`grid vram=${vram} ram=${ram}: choice and tuning satisfy the invariants`, () => {
      const hw = hwOf(vram, ram);
      const m = chooseModel({ vramTotalBytes: vram * GiB, vramFreeBytes: vram * GiB * 0.92, ramTotalBytes: ram * GiB, candidates35b: C35, candidates9b: C9 });
      const moe = /35B/.test(m.candidate.filename);
      const t = tuneForHardware(hw, { modelBytes: m.candidate.sizeBytes, moe, kvElementsPerToken: KV, modelLayers: 32 });
      // R2: a dense model larger than the card is offloaded partially, never with -ngl 999.
      if (!moe && vram > 0 && vram * 0.92 - 0.5 < 5.1) assert.ok(t.gpuLayers < 999, `dense ${5.1} GiB on ${vram} GiB got -ngl ${t.gpuLayers}`);

      // R3: the 35B (20.4 GiB) is only chosen where its weights fit in RAM+VRAM-ish terms.
      if (moe) assert.ok(ram >= 24, `35B chosen with only ${ram} GiB RAM`);
      // R2: --n-cpu-moe is for MoE only, never for the dense 9B, never without a GPU to relieve.
      if (!moe) assert.equal(t.cpuMoeLayers, 0, "dense model must not get --n-cpu-moe");
      if (vram === 0) assert.equal(t.gpuLayers, 0, "no GPU → CPU-only");
      if (vram > 0) assert.ok(t.gpuLayers > 0, "a GPU is used when there is one");
      // A card that holds the whole model needs no expert streaming.
      if (moe && vram >= 24) assert.equal(t.cpuMoeLayers, 0);
      // R2: bounded context, and a stated reason for every non-obvious choice.
      assert.ok(t.contextSize >= 4096 && t.contextSize <= 98304, `ctx ${t.contextSize}`);
      assert.ok(t.rationale.length > 0);
      // R3: a model larger than the machine's RAM must be warned about, never chosen silently.
      if (m.candidate.sizeBytes > ram * GiB * 0.9) assert.match(m.reason, /부족|느릴|메모리|RAM/, `no warning: ${m.reason}`);
    });
  }
}
