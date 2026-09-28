import { test } from "node:test";
import assert from "node:assert/strict";
import { readThroughput, calibrate, contextFromPrefillRate, PREFILL_BUDGET_SECONDS } from "./calibration.js";
import type { Hardware } from "./hardware.js";

const hw: Hardware = {
  cpuCount: 12, ramTotalBytes: 30 * 1024 ** 3, ramAvailableBytes: 26 * 1024 ** 3,
  gpus: [{ index: 0, name: "RTX 2070 SUPER", vramTotalBytes: 8 * 1024 ** 3, vramFreeBytes: 7 * 1024 ** 3 }],
  gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
};

/** The numbers measured on this project's dev box against a real server. */
const MEASURED = {
  promptTokens: 500, promptSeconds: 1.25, promptTokensPerSecond: 400,
  generatedTokens: 16, generateSeconds: 0.42, decodeTokensPerSecond: 38,
};

// ── Reading a measurement ───────────────────────────────────────────────────

test("a real timings block is read into a usable measurement", () => {
  const t = readThroughput(MEASURED);
  assert.equal(t.unreliable, false);
  assert.equal(t.promptTokensPerSecond, 400);
  assert.equal(t.decodeTokensPerSecond, 38);
});

test("a missing timings block is reported as UNRELIABLE, not as zeros to act on", () => {
  // The common case, not an edge case: any endpoint that is not llama.cpp, and
  // any build too old to report timings. Acting on `undefined` produced NaN
  // context sizes instead of falling back to the hardware profile.
  for (const bad of [undefined, {}, { promptTokensPerSecond: 0 }, { promptSeconds: 0 }]) {
    assert.equal(readThroughput(bad as any).unreliable, true, JSON.stringify(bad));
  }
});

test("garbage in a timings block cannot become a garbage context size", () => {
  const t = readThroughput({ ...MEASURED, promptTokensPerSecond: NaN, promptSeconds: NaN });
  assert.equal(t.unreliable, true);
  assert.equal(t.promptTokensPerSecond, 0, "not NaN — NaN would flow into the arithmetic below");
});

// ── Context from a measured prefill rate ────────────────────────────────────

test("the context is bounded by the prefill rate and the first-token latency budget", () => {
  // 400 tok/s * 2.5 s = 1000 tokens' worth of prefill, rounded down to a
  // multiple of 4096 and floored at 4096.
  assert.equal(contextFromPrefillRate(400), 4096);
  // A genuinely fast machine earns more: 4800 tok/s * 2.5 s = 12000 tokens of
  // prefill, which is 2 whole 4096-blocks (12288 would need more than 12288
  // tok/s to reach the third block).
  assert.equal(contextFromPrefillRate(4800), 8192);
  assert.equal(contextFromPrefillRate(8192), 20480, "8192 tok/s * 2.5 s = 20480 -> exactly 5 blocks");
  // And an absurdly fast one is still capped, so a bad sample cannot ask for
  // an unbounded window.
  assert.equal(contextFromPrefillRate(1_000_000), 32768);
});

test("a slow backend earns a SMALLER context, and the result is a clean 4096 multiple", () => {
  const slow = contextFromPrefillRate(50);
  assert.ok(slow < contextFromPrefillRate(4800), "slower => smaller");
  assert.equal(slow % 4096, 0, "rounded to a block boundary: a ragged KV allocation wastes memory");
});

test("an unmeasurable rate falls back rather than producing a nonsense size", () => {
  assert.equal(contextFromPrefillRate(0), 8192);
  assert.equal(contextFromPrefillRate(NaN), 8192);
  assert.ok(PREFILL_BUDGET_SECONDS > 0);
});

// ── Calibrating ─────────────────────────────────────────────────────────────

test("calibration uses a good measurement to shrink the context, and says why", () => {
  const c = calibrate({ hw, timings: MEASURED, modelBytes: 21_864_081_056 });
  assert.equal(c.degraded, false);
  // The hardware profile alone would have chosen 16384 for this 7 GiB-free
  // card; the measurement says prefill is 400 tok/s, which does not afford it.
  assert.equal(c.tuning.contextSize, 4096);
  assert.ok(c.notes.some((n) => /prefill 400 tok\/s/.test(n)), c.notes.join(" | "));
  assert.ok(c.notes.some((n) => /축소/.test(n)), "the change is explained, not just made");
});

test("calibration NEVER raises the context above what the hardware allows", () => {
  // The asymmetry is the whole safety property: a slow or mis-reported sample
  // must make us more conservative, never less. A fast-looking probe must not
  // be able to talk a machine into an OOM at load.
  const c = calibrate({
    hw,
    timings: { ...MEASURED, promptTokensPerSecond: 100_000, promptSeconds: 0.005 },
    modelBytes: 21_864_081_056,
  });
  const hardwareOnly = calibrate({ hw, modelBytes: 21_864_081_056 });
  assert.equal(c.tuning.contextSize, hardwareOnly.tuning.contextSize,
    "a very fast probe does not exceed the hardware-derived ceiling");
});

test("a failed probe degrades to the hardware profile and says so plainly", () => {
  const c = calibrate({ hw, timings: undefined });
  assert.equal(c.degraded, true);
  assert.equal(c.tuning.contextSize, 16384, "the hardware table's answer, unchanged");
  assert.ok(c.notes.some((n) => /측정 실패/.test(n)));
});

test("calibration leaves the GPU-first decision and thread count alone", () => {
  // Thread count is deliberately not "optimized" from a decode measurement:
  // a slow decode is almost always GPU/memory-bandwidth, not thread starvation,
  // so "add threads" would be the wrong remedy for what was measured.
  const c = calibrate({ hw, timings: MEASURED });
  const hardwareOnly = calibrate({ hw });
  assert.equal(c.tuning.gpuLayers, 999, "still GPU-first");
  assert.equal(c.tuning.threads, hardwareOnly.tuning.threads);
  assert.equal(c.tuning.cpuMoeLayers, hardwareOnly.tuning.cpuMoeLayers);
  assert.ok(c.notes.some((n) => /스레드/.test(n)), "and that choice is stated");
});
