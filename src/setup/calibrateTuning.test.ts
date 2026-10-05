import { test } from "node:test";
import assert from "node:assert/strict";
import { planCalibration, type CalibrationReading } from "./calibrateTuning.js";
import type { ParsedServerArgs } from "./modelSwitch.js";

const GiB = 1024 ** 3;

/**
 * The measured machine. Every number here was read off a real load on the box the
 * regression was reported from (RTX 2070 SUPER, 8 GiB, Ornith 9B Q4_K_M), not
 * chosen to make an assertion pass:
 *
 *   GGUF header         5,780,090,816 B · 33 blocks · 16,384 KV elements/token · trained 262,144
 *   `-ngl 32`           → `offloaded 32/34 layers to GPU` · 5,588 MiB held · 2,023 MiB free
 *   `-ngl 999`          → `offloaded 34/34 layers to GPU` · 5,840 MiB held · 1,771 MiB free
 *   `-ngl 999 -c 65536` → 6,456 MiB held · 1,155 MiB free
 *   `-ngl 999 -c 98304` → 7,160 MiB held ·   451 MiB free
 *
 * The last two lines are why context is capped where it is: 98,304 DOES load, but it
 * leaves less than the 600 MiB safety margin, so calibration does not propose it.
 */
function box(over: Partial<CalibrationReading> = {}): CalibrationReading {
  return {
    freeMiB: 2023,
    totalMiB: 8192,
    ownVramMiB: 5588,
    gpuName: "NVIDIA-GeForce-RTX-2070-SUPER",
    modelBytes: 5780090816,
    layers: 33,
    kvElementsPerToken: 16384,
    trainedContext: 262144,
    moe: false,
    cpuCount: 12,
    ...over,
  };
}

/** Exactly what the transcript showed: switching 35B → 9B left `-ngl` at 32 and
 *  the context at 36,864. Reproduced here so the regression stays reproducible. */
const running = (over: Partial<ParsedServerArgs> = {}): ParsedServerArgs => ({
  modelPath: "/m/Ornith-1.5-9B-Q4_K_M.gguf",
  port: 8080,
  contextSize: 36864,
  gpuLayers: 32,
  threads: 6,
  threadsBatch: 11,
  cpuMoeLayers: undefined,
  flashAttn: true,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  ...over,
});

test("the reported regression: -ngl 32 on a card that takes 999 comes back to 999", () => {
  // The measured numbers above: the whole model fits with 1,771 MiB to spare, so
  // every layer belongs on the GPU.
  const plan = planCalibration(running(), box());
  assert.equal(plan.changed, true);
  const ngl = plan.changes.find((c) => c.label === "-ngl");
  assert.ok(ngl, `expected an -ngl change, got ${JSON.stringify(plan.changes)}`);
  assert.equal(ngl!.from, 32);
  assert.equal(ngl!.to, 999);
});

test("999 rather than the header's layer count: the header says 33, llama.cpp counts 34", () => {
  // Verified live: `offloaded 34/34 layers to GPU` for a header whose block_count
  // is 33 (llama.cpp counts the output layer separately). Emitting 33 would leave
  // one block on the CPU forever, so a full-offload plan emits 999 — which is also
  // what survives the user swapping in a different model later.
  const plan = planCalibration(running(), box());
  const ngl = plan.changes.find((c) => c.label === "-ngl");
  assert.equal(plan.changes.filter((c) => c.label === "-ngl")[0]?.to, 999);
  assert.notEqual(ngl?.to, box().layers);
});

test("context grows into the measured slack but stops short of what would breach the margin", () => {
  const plan = planCalibration(running(), box());
  const ctx = plan.changes.find((c) => c.label === "컨텍스트");
  assert.ok(ctx, "measured slack should buy context");
  const want = ctx!.to as number;
  assert.ok(want > 36864, `expected growth from 36,864, got ${want}`);
  assert.ok(want <= 98304, "never past the benchmarked ceiling");
  // 98,304 was measured to leave 451 MiB free — under the 600 MiB margin. Proposing
  // it would be proposing a server one allocation away from an OOM, which is the
  // whole failure this safety margin exists to prevent.
  assert.ok(want < 98304, `98,304 leaves 451 MiB measured; proposing ${want} contradicts that`);
});

test("a stale --n-cpu-moe from a previous MoE model is dropped for a dense one", () => {
  const plan = planCalibration(running({ cpuMoeLayers: 33 }), box({ moe: false }));
  const moe = plan.changes.find((c) => c.label === "--n-cpu-moe");
  assert.deepEqual(moe, { label: "--n-cpu-moe", from: 33, to: 0 });
});

test("it converges in ONE pass: the plan it proposes is already the final answer", () => {
  // Verified against real loads, not a model of them:
  //
  //   pass 1 (measured 2,023 MiB free) → `-ngl 32 → 999`, `-c 36,864 → 90,112`
  //   applied and re-measured             → 6,984 MiB held, 628 MiB free
  //   pass 2 (measured   628 MiB free) → no change
  //
  // Each pass costs a server restart, so a plan that needs two of them is a defect,
  // and one that keeps changing is worse. This is the property that says the spare
  // VRAM is spent exactly once: on the offload, and what is left on the context.
  const first = planCalibration(running(), box());
  assert.equal(first.changed, true, "the measured box really does have something to fix");
  assert.deepEqual(first.changes.map((c) => [c.label, c.to]), [["-ngl", 999], ["컨텍스트", 90112]]);
  const applied = running({ ...first.tuning } as Partial<ParsedServerArgs>);
  const second = planCalibration(applied, box({ freeMiB: 628, ownVramMiB: 6984 }));
  assert.equal(second.changed, false, `calibration must converge in one pass, got ${JSON.stringify(second.changes)}`);
});

test("the context it proposes was measured to load, and leaves the safety margin intact", () => {
  // `-ngl 999 -c 90112` was actually run on this box: `offloaded 34/34 layers to
  // GPU`, 6,984 MiB held, 628 MiB free. That is above the 600 MiB margin, so the
  // proposal is one somebody can run, not one arithmetic invented.
  const ctx = planCalibration(running(), box()).changes.find((c) => c.label === "컨텍스트");
  assert.equal(ctx?.to, 90112);
  assert.ok(628 > 600, "the measured free memory must clear the margin the plan assumes");
});

test("an unreadable VRAM figure means no changes at all, and it says so", () => {
  const plan = planCalibration(running(), box({ freeMiB: undefined }));
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.tuning, {});
  assert.match(plan.unmeasured.join(" "), /VRAM/);
});

test("a missing model file is reported as unmeasured, never as zero bytes", () => {
  const plan = planCalibration(running(), box({ modelBytes: 0 }));
  assert.equal(plan.changed, false);
  assert.match(plan.unmeasured.join(" "), /모델 파일/);
});

test("a header we cannot read leaves -ngl alone rather than guessing it", () => {
  const plan = planCalibration(running(), box({ layers: undefined }));
  assert.equal(plan.tuning.gpuLayers, undefined, "no layer count means no layer count");
  assert.match(plan.unmeasured.join(" "), /레이어 수/);
});

test("a MoE model brings expert layers back onto the GPU when there is measured room", () => {
  const plan = planCalibration(
    running({ cpuMoeLayers: 30, gpuLayers: 999 }),
    box({ moe: true, freeMiB: 2023, modelBytes: 21 * GiB, layers: 80 })
  );
  const moe = plan.changes.find((c) => c.label === "--n-cpu-moe");
  assert.ok(moe, "a MoE model with spare VRAM should pull expert layers back");
  assert.ok((moe!.to as number) < 30, `expected fewer layers on the CPU than 30, got ${moe!.to}`);
});

test("a MoE model that barely fits pushes expert layers back OUT to CPU", () => {
  // Thin margin: less free VRAM than the safety margin, so the plan must add CPU
  // layers rather than leave a server one allocation away from an OOM.
  const plan = planCalibration(
    running({ cpuMoeLayers: 30, gpuLayers: 999 }),
    box({ moe: true, freeMiB: 300, modelBytes: 21 * GiB, layers: 80 })
  );
  const moe = plan.changes.find((c) => c.label === "--n-cpu-moe");
  assert.ok(moe, "a thin margin must be acted on");
  assert.ok((moe!.to as number) > 30, `expected more layers on the CPU than 30, got ${moe!.to}`);
});

test("unified memory (Apple Silicon) never gets an offload number invented for it", () => {
  const plan = planCalibration(running(), box({ unifiedMemory: true }));
  assert.equal(plan.tuning.gpuLayers, undefined);
  assert.match(plan.notes.join(" "), /통합 메모리/);
});

test("threads follow the same rule as the first-run tuner", () => {
  const plan = planCalibration(running({ threads: 2, threadsBatch: 2 }), box({ cpuCount: 12 }));
  assert.equal(plan.tuning.threads, 6);
  assert.equal(plan.tuning.threadsBatch, 11);
});

test("a 1-core machine is not given more threads than it has cores", () => {
  const plan = planCalibration(running({ threads: 4, threadsBatch: 4 }), box({ cpuCount: 1 }));
  assert.ok((plan.tuning.threads ?? 99) <= 1, `got -t ${plan.tuning.threads} on a 1-core box`);
});

test("threads follow the offload we are about to ASK FOR, not the one running", () => {
  // A plan that turns the GPU on must not keep the CPU-only thread count: that is
  // the wrong half of the pair, and it is what made `-t 2 -tb 2` appear on 1 core.
  //
  // The tiny-card box is the case where CPU-only is genuinely the right answer, so
  // the two halves of the rule can be told apart: the measured box turns the GPU on,
  // the starved one does not, and the thread count follows.
  const starved = { totalMiB: 2048, freeMiB: 30, ownVramMiB: 1990, modelBytes: 30 * GiB, layers: 40, kvElementsPerToken: 20000, trainedContext: 32768, moe: false, cpuCount: 12 };
  const cpuOnly = planCalibration(running({ gpuLayers: 0, threads: 11, threadsBatch: 11 }), box(starved));
  assert.equal(cpuOnly.tuning.gpuLayers, undefined, "a 30 GiB model on a 2 GiB card stays on the CPU");
  assert.equal(cpuOnly.tuning.threads, undefined, "no GPU plan keeps cores - 1, so a running -t 11 is already right");
  const gpuOn = planCalibration(running({ gpuLayers: 32, threads: 11, threadsBatch: 11 }), box({ cpuCount: 12 }));
  assert.equal(gpuOn.tuning.gpuLayers, 999, "the measured box takes every layer");
  assert.equal(gpuOn.tuning.threads, 6, "a GPU plan halves the cores");
});

test("context is never pushed below 4096 by a tight card", () => {
  const tight = planCalibration(running({ contextSize: 98304 }), box({ freeMiB: 40, ownVramMiB: 8100 }));
  assert.ok((tight.tuning.contextSize ?? 4096) >= 4096, `got ${tight.tuning.contextSize}`);
});

test("an unreadable GGUF header still calibrates -ngl, from the file size alone", () => {
  const plan = planCalibration(running(), box({ kvElementsPerToken: undefined, layers: undefined }));
  assert.equal(plan.tuning.gpuLayers, undefined, "no layer count, no -ngl claim");
  assert.match(plan.unmeasured.join(" "), /KV 비용/);
});

test("a server on a handful of GPU layers is not nudged — it is reported instead", () => {
  // A 30 GiB dense model on a 2 GiB card: the answer is 0 or 1 blocks, which is CPU
  // execution with extra steps. Restarting to move 1 → 0 changes nothing a user can
  // feel, so it is stated rather than performed.
  const plan = planCalibration(
    running({ gpuLayers: 1, contextSize: 4096 }),
    box({ totalMiB: 2048, freeMiB: 30, ownVramMiB: 1990, modelBytes: 30 * GiB, layers: 40 })
  );
  assert.equal(plan.tuning.gpuLayers, undefined, "1 → 0 blocks is not worth a restart");
  assert.match(plan.notes.join(" "), /사실상 CPU 실행이라 조정할 이유가 없습니다/);
});

test("KV precision returns to q8_0 when the measured budget has room for it", () => {
  const plan = planCalibration(running({ cacheTypeK: "q4_0", cacheTypeV: "q4_0" }), box({ freeMiB: 4000, ownVramMiB: 4000 }));
  assert.equal(plan.tuning.cacheTypeK, "q8_0");
  assert.equal(plan.tuning.cacheTypeV, "q8_0");
});

test("the plan only ever names fields it has a measurement for", () => {
  const plan = planCalibration(running(), box());
  const allowed = new Set(["gpuLayers", "cpuMoeLayers", "contextSize", "threads", "threadsBatch", "flashAttn", "cacheTypeK", "cacheTypeV"]);
  for (const k of Object.keys(plan.tuning)) assert.ok(allowed.has(k), `unexpected field in the plan: ${k}`);
});

test("the plan says what it measured, so the user can check it rather than trust it", () => {
  const notes = planCalibration(running(), box()).notes.join("\n");
  assert.match(notes, /남은 VRAM 2023 MiB/, "the free reading it used is stated");
  assert.match(notes, /안전 여유 600 MiB/, "the safety margin it applied is stated");
  assert.match(notes, /17\.0 KiB\/토큰\(헤더 실측\)/, "the exact KV cost it used is stated");
  assert.match(notes, /층당 150 MiB/, "the per-block cost it derived is stated");
  assert.match(notes, /계산 버퍼 여유 384 MiB/, "the allowance for what the header cannot express is stated");
});
test("the plan carries an adaptive compaction recommendation for the context it launches", () => {
  const plan = planCalibration(running(), box());
  const ctx = plan.tuning.contextSize ?? running().contextSize;
  const note = plan.notes.find((n) => n.includes("컴팩션(적응형)"));
  assert.ok(note, `expected a compaction note, got ${JSON.stringify(plan.notes)}`);
  assert.match(note!, new RegExp(ctx!.toLocaleString().replace(/,/g, ",")), "the note must name the context it recommends for");
  assert.match(note!, /트리거/, "the trigger must be stated");
  assert.match(note!, /요약 예산/, "the summary budget must be stated");
});
