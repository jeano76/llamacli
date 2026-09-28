import { test } from "node:test";
import assert from "node:assert/strict";
import { tuneForHardware, budgetVramGiB, ramBudgetGiB } from "./tuning.js";
import { pickPrimaryGpu, totalVram, type Hardware } from "./hardware.js";

// The invariants below are the ones a wrong answer would violate in a way the
// user finds out about hours later: a context that OOMs at load, threads
// fighting each other, or a "GPU first" decision that silently didn't happen.

const GiB = 1024 ** 3;

function machine(o: {
  cpuCount: number;
  ramGiB: number;
  gpu?: { name: string; totalGiB: number; freeGiB: number } | null;
  platform?: string;
}): Hardware {
  return {
    cpuCount: o.cpuCount,
    ramTotalBytes: o.ramGiB * GiB,
    ramAvailableBytes: o.ramGiB * GiB,
    gpus: o.gpu ? [{ index: 0, name: o.gpu.name, vramTotalBytes: o.gpu.totalGiB * GiB, vramFreeBytes: o.gpu.freeGiB * GiB }] : [],
    gpuBackend: o.gpu ? "cuda" : "none",
    canBuildCuda: Boolean(o.gpu),
    tools: {},
    platform: o.platform ?? "linux",
  } as Hardware;
}

test("threads never exceed the core count, on any core count, with or without a GPU", () => {
  // TC-08, and the bug the environment sweep found: the GPU branch used
  // `Math.max(2, ...)`, so a 1-core box was handed `-t 2 -tb 2` — more threads
  // than the machine has cores. The dev box is 12 cores, where `max(2, 6)`
  // lands on a legal value by accident, which is why the suite never saw it.
  for (const cpuCount of [1, 2, 3, 4, 5, 6, 8, 12, 16, 32, 64]) {
    for (const gpu of [null, { name: "RTX 2070 SUPER", totalGiB: 8, freeGiB: 7.2 }] as const) {
      const t = tuneForHardware(machine({ cpuCount, ramGiB: 30, gpu }));
      const tag = `cpu=${cpuCount} gpu=${gpu?.name ?? "none"}`;
      assert.ok(t.threads >= 1, `${tag}: threads ${t.threads} < 1`);
      assert.ok(t.threadsBatch >= 1, `${tag}: threadsBatch ${t.threadsBatch} < 1`);
      assert.ok(t.threads <= cpuCount, `${tag}: threads ${t.threads} > ${cpuCount} cores`);
      assert.ok(t.threadsBatch <= cpuCount, `${tag}: threadsBatch ${t.threadsBatch} > ${cpuCount} cores`);
    }
  }
});

test("a 1-core machine gets exactly 1 thread, not 2", () => {
  const withGpu = tuneForHardware(machine({ cpuCount: 1, ramGiB: 8, gpu: { name: "GTX 1050 Ti", totalGiB: 4, freeGiB: 3.5 } }));
  assert.equal(withGpu.threads, 1);
  assert.equal(withGpu.threadsBatch, 1);
  const cpuOnly = tuneForHardware(machine({ cpuCount: 1, ramGiB: 8 }));
  assert.equal(cpuOnly.threads, 1);
  assert.equal(cpuOnly.threadsBatch, 1);
});

test("the known-good 12-core tuning is unchanged by the clamp", () => {
  // The hand-tuned working config on the reference box was `-t 6`; the fix must
  // not have moved it.
  const t = tuneForHardware(machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "RTX 2070 SUPER", totalGiB: 8, freeGiB: 7.2 } }));
  assert.equal(t.threads, 6);
  assert.equal(t.threadsBatch, 11);
  assert.equal(t.parallel, 1);
});

test("no GPU means CPU-only, and a GPU always wins over the CPU", () => {
  for (const cpuCount of [1, 4, 8, 32]) {
    const cpuOnly = tuneForHardware(machine({ cpuCount, ramGiB: 16 }));
    assert.equal(cpuOnly.gpuLayers, 0, `cpu=${cpuCount}: no GPU must mean -ngl 0`);
    assert.ok(cpuOnly.rationale.some((r) => r.includes("CPU 전용")), "CPU-only decision must be explained");

    const withGpu = tuneForHardware(machine({ cpuCount, ramGiB: 16, gpu: { name: "RTX 4090", totalGiB: 24, freeGiB: 23 } }));
    assert.ok(withGpu.gpuLayers > 0, `cpu=${cpuCount}: a present GPU must be offloaded to`);
  }
});

test("context size stays inside the derived floor/ceiling on every machine", () => {
  for (const ramGiB of [2, 4, 8, 16, 30, 64, 128]) {
    for (const gpu of [null, { name: "small", totalGiB: 4, freeGiB: 3.5 }, { name: "big", totalGiB: 24, freeGiB: 23 }] as const) {
      for (const modelBytes of [0, 4 * GiB, 20 * GiB, 70 * GiB]) {
        const t = tuneForHardware(machine({ cpuCount: 8, ramGiB, gpu }), { modelBytes });
        const tag = `ram=${ramGiB} gpu=${gpu?.name ?? "none"} model=${modelBytes / GiB}G`;
        assert.ok(Number.isFinite(t.contextSize), `${tag}: contextSize ${t.contextSize}`);
        assert.ok(t.contextSize >= 4096, `${tag}: contextSize ${t.contextSize} below floor`);
        assert.ok(t.contextSize <= 32768, `${tag}: contextSize ${t.contextSize} above ceiling`);
        assert.equal(t.contextSize % 4096, 0, `${tag}: contextSize ${t.contextSize} not 4096-aligned`);
      }
    }
  }
});

test("every derived numeric flag is finite and non-negative", () => {
  // The pathological case matters most: a card reporting 0 free VRAM, which is
  // what a stuck process or a compositor holding everything looks like.
  const busy = machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "RTX 2070 SUPER", totalGiB: 8, freeGiB: 0 } });
  for (const hw of [busy, machine({ cpuCount: 1, ramGiB: 2 }), machine({ cpuCount: 64, ramGiB: 256, gpu: { name: "A100", totalGiB: 80, freeGiB: 78 } })]) {
    for (const modelBytes of [0, 20 * GiB, 70 * GiB]) {
      const t = tuneForHardware(hw, { modelBytes });
      for (const k of ["gpuLayers", "threads", "threadsBatch", "contextSize", "batchSize", "ubatchSize", "cpuMoeLayers", "parallel"] as const) {
        const v = t[k];
        assert.ok(Number.isFinite(v), `${hw.cpuCount} cores / ${hw.gpus[0]?.name ?? "no gpu"}: ${k} = ${v}`);
        assert.ok(v >= 0, `${k} = ${v} is negative`);
      }
      assert.ok(t.cpuMoeLayers <= 80, `cpuMoeLayers ${t.cpuMoeLayers} exceeds the layer-count estimate`);
    }
  }
});

test("batch sizes are powers of two with ubatch <= batch", () => {
  // llama.cpp's own constraint: a non-power-of-two -b/-ub is rejected or silently
  // rounded, so a wrong value here is a launch-time surprise, not a slow path.
  for (const freeGiB of [0.5, 1, 3, 6, 10, 20, 40]) {
    const hw = machine({ cpuCount: 8, ramGiB: 32, gpu: { name: "x", totalGiB: 8, freeGiB } });
    const t = tuneForHardware(hw);
    assert.ok(Number.isInteger(Math.log2(t.batchSize)), `batchSize ${t.batchSize} is not a power of two`);
    assert.ok(Number.isInteger(Math.log2(t.ubatchSize)), `ubatchSize ${t.ubatchSize} is not a power of two`);
    assert.ok(t.ubatchSize <= t.batchSize, `ubatchSize ${t.ubatchSize} > batchSize ${t.batchSize}`);
  }
});

test("the VRAM budget stays positive even on a nonsense card, and tracks free memory", () => {
  const busy = machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "busy", totalGiB: 8, freeGiB: 0 } });
  // 0 free means the driver reported "N/A" (see parseNvidiaSmiCsv), so the
  // budget falls back to TOTAL rather than to 0. Deliberate: a card reporting
  // nothing usable must not be planned as though it were empty.
  assert.ok(budgetVramGiB(busy, pickPrimaryGpu(busy)) > 0, "an unreadable card must still yield a positive budget");
  const half = machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "half", totalGiB: 8, freeGiB: 4 } });
  const full = machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "full", totalGiB: 8, freeGiB: 7.2 } });
  assert.ok(
    budgetVramGiB(full, pickPrimaryGpu(full)) > budgetVramGiB(half, pickPrimaryGpu(half)),
    "more free VRAM must mean a larger budget"
  );
  // And the fallback is bounded by the card's actual capacity, not unbounded.
  assert.ok(
    budgetVramGiB(busy, pickPrimaryGpu(busy)) <= 8,
    `fallback budget ${budgetVramGiB(busy, pickPrimaryGpu(busy))} must not exceed the card's VRAM`
  );
  const noGpu = machine({ cpuCount: 8, ramGiB: 16 });
  assert.ok(budgetVramGiB(noGpu, null) > 0, "no GPU must still yield a positive budget");
  // A 2 GB box scaled on RAM must not collapse to zero.
  const tiny = machine({ cpuCount: 2, ramGiB: 2 });
  assert.ok(budgetVramGiB(tiny, null) >= 0.5, `2GiB box budget ${budgetVramGiB(tiny, null)}`);
  assert.ok(ramBudgetGiB(tiny, 70 * GiB) >= 0, "ramBudgetGiB must never be negative");
});

test("the KV cache precision follows the documented budget rule", () => {
  // q8_0 at >= 3 GiB of budget, q4_0 below it — the halving is what lets an
  // 8 GB card hold 16k of context instead of 8k.
  for (const freeGiB of [0.5, 1, 2.9, 3, 6, 12, 23]) {
    const hw = machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "x", totalGiB: 8, freeGiB } });
    const budget = budgetVramGiB(hw, pickPrimaryGpu(hw));
    const t = tuneForHardware(hw);
    const expected = budget >= 3 ? "q8_0" : "q4_0";
    assert.equal(t.cacheTypeK, expected, `budget ${budget.toFixed(2)} GiB should use ${expected}`);
    assert.equal(t.cacheTypeV, expected, "K and V cache types must agree");
  }
});

test("MoE expert offload is proportional to the shortfall and bounded", () => {
  // A model that fits needs no CPU expert layers; one that badly does not gets
  // some, but never so many that decode collapses.
  const fits = tuneForHardware(machine({ cpuCount: 12, ramGiB: 64, gpu: { name: "A100", totalGiB: 80, freeGiB: 78 } }), { modelBytes: 4 * GiB });
  assert.equal(fits.cpuMoeLayers, 0, "a model that fits must not be offloaded to the CPU");
  const huge = tuneForHardware(machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "small", totalGiB: 4, freeGiB: 3.5 } }), { modelBytes: 70 * GiB });
  assert.ok(huge.cpuMoeLayers >= 1, "a badly-fitting model must offload some experts");
  assert.ok(huge.cpuMoeLayers <= 80, `cpuMoeLayers ${huge.cpuMoeLayers} exceeds the 60% cap`);
});

test("every rationale line is non-empty, and every decision is explained", () => {
  for (const hw of [machine({ cpuCount: 12, ramGiB: 30, gpu: { name: "RTX 2070 SUPER", totalGiB: 8, freeGiB: 7.2 } }), machine({ cpuCount: 2, ramGiB: 4 })]) {
    const t = tuneForHardware(hw, { modelBytes: 20 * GiB });
    assert.ok(t.rationale.length >= 4, "a tuning decision must carry several explanations");
    for (const r of t.rationale) assert.ok(r.trim().length > 0, "no rationale line may be blank");
  }
});
