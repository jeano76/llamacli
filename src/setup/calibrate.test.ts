import { test } from "node:test";
import assert from "node:assert/strict";
import { startCalibrated, calibrationKey, OOM_PATTERN, type ServerLike } from "./calibrate.js";
import type { LlamaServerConfig } from "../backend/llamaServer.js";

const GiB = 1024 ** 3;
const cfg = (over: Partial<LlamaServerConfig> = {}): LlamaServerConfig => ({
  binPath: "/b/llama-server", modelPath: "/m/Ornith-1.5-35B-A3B-Q4_K_M.gguf", host: "127.0.0.1", port: 8084,
  contextSize: 98304, threads: 6, gpuLayers: 999, cpuMoeLayers: 32, ...over,
});
// 20 GiB model, 40 layers -> ~460 MiB per expert layer.
const info = { moe: true, moeLayers: 40, modelBytes: 20 * GiB };

/** Fake servers: `behaviour(cpuMoe)` decides whether that launch loads, fails with OOM, or fails otherwise. */
function rig(behaviour: (moe: number) => "ok" | "oom" | "other", freeMiB: number | undefined) {
  const events: string[] = [];
  const make = (c: LlamaServerConfig): ServerLike => ({
    start: async () => {
      const b = behaviour(c.cpuMoeLayers ?? 0);
      events.push(`start:${c.cpuMoeLayers}:${b}`);
      if (b === "oom") throw new Error("llama-server 가 준비되지 않았습니다: cudaMalloc failed: out of memory");
      if (b === "other") throw new Error("port already in use");
    },
    stop: () => events.push(`stop:${c.cpuMoeLayers}`),
    logTail: () => "",
  });
  return { events, make, base: { readVramFreeMiB: async () => freeMiB, waitReleased: async () => {}, info, gpuName: "GPU" } };
}

test("OOM at load: more experts go to the CPU and the load is retried until it works", async () => {
  const r = rig((m) => (m < 36 ? "oom" : "ok"), 100);
  const lines: string[] = [];
  const out = await startCalibrated(cfg(), { make: r.make, say: (l) => lines.push(l), calibrate: true, ...r.base });
  assert.ok((out.cfg.cpuMoeLayers ?? 0) >= 36);
  assert.equal(out.calibration?.outcome, "raised");
  assert.ok(lines.some((l) => /GPU 메모리 부족/.test(l)));
  assert.ok(r.events.some((e) => e.startsWith("stop:")), "the failed server is stopped before the retry");
});

test("a non-OOM failure is thrown at once — no retry, no guessing", async () => {
  const r = rig(() => "other", 4000);
  await assert.rejects(startCalibrated(cfg(), { make: r.make, calibrate: true, ...r.base }), /port already in use/);
  assert.deepEqual(r.events, ["start:32:other"]);
});

test("OOM that persists past the retry budget is thrown, not looped on", async () => {
  const r = rig(() => "oom", 100);
  await assert.rejects(startCalibrated(cfg(), { make: r.make, calibrate: true, maxOomRetries: 2, ...r.base }), /out of memory/);
  assert.equal(r.events.filter((e) => e.startsWith("start:")).length, 3);
});

test("spare VRAM: a trial with fewer CPU layers is made, and kept when it loads", async () => {
  const r = rig(() => "ok", 1500); // (1500 - 600) / 460 -> drop 1
  const out = await startCalibrated(cfg(), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 31);
  assert.equal(out.calibration?.outcome, "lowered");
  assert.deepEqual(r.events, ["start:32:ok", "stop:32", "start:31:ok"]);
});

test("a trial that does not load restores the launch that worked", async () => {
  const r = rig((m) => (m < 32 ? "oom" : "ok"), 1500);
  const out = await startCalibrated(cfg(), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 32);
  assert.equal(out.calibration?.outcome, "lower-rejected");
  assert.deepEqual(r.events, ["start:32:ok", "stop:32", "start:31:oom", "stop:31", "start:32:ok"]);
});

test("not enough spare VRAM: the planned value is kept and nothing is restarted", async () => {
  const r = rig(() => "ok", 700);
  const out = await startCalibrated(cfg(), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 32);
  assert.equal(out.calibration?.outcome, "kept");
  assert.deepEqual(r.events, ["start:32:ok"]);
});

test("already calibrated for this model+context+card: no trial, even with spare VRAM", async () => {
  const r = rig(() => "ok", 5000);
  const key = calibrationKey(cfg(), "GPU");
  const out = await startCalibrated(cfg({ calibratedFor: key }), { make: r.make, calibrate: true, ...r.base });
  assert.deepEqual(r.events, ["start:32:ok"]);
  assert.equal(out.calibration?.calibratedFor, key);
});

test("a different context invalidates the recorded calibration", () => {
  assert.notEqual(calibrationKey(cfg({ contextSize: 32768 }), "GPU"), calibrationKey(cfg(), "GPU"));
});

test("calibrate=false: OOM retry still works, but no downward trial", async () => {
  const r = rig(() => "ok", 5000);
  await startCalibrated(cfg(), { make: r.make, calibrate: false, ...r.base });
  assert.deepEqual(r.events, ["start:32:ok"]);
});

test("an unreadable VRAM figure means no trial (never guess)", async () => {
  const r = rig(() => "ok", undefined);
  await startCalibrated(cfg(), { make: r.make, calibrate: true, ...r.base });
  assert.deepEqual(r.events, ["start:32:ok"]);
});

test("CPU-only or non-MoE: a plain start, nothing calibrated", async () => {
  const r = rig(() => "ok", 5000);
  const out = await startCalibrated(cfg({ gpuLayers: 0 }), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.calibration, undefined);
  const r2 = rig(() => "ok", 5000);
  const dense = await startCalibrated(cfg({ cpuMoeLayers: 0 }), { make: r2.make, calibrate: true, info: undefined as never, readVramFreeMiB: async () => 5000, waitReleased: async () => {}, gpuName: "GPU", ...{} });
  assert.ok(dense.server);
});

test("the OOM pattern recognises the CUDA, Vulkan and generic phrasings", () => {
  for (const t of ["cudaMalloc failed: out of memory", "ErrorOutOfDeviceMemory", "failed to allocate CUDA0 buffer of size 123", "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0"]) {
    assert.match(t, OOM_PATTERN, t);
  }
  assert.doesNotMatch("address already in use", OOM_PATTERN);
});

test("thin margin: a load that leaves less than the safety margin gets enough more CPU layers to restore it", async () => {
  const r = rig(() => "ok", 394); // (394 - 600) / 458 -> raise by 1
  const lines: string[] = [];
  const out = await startCalibrated(cfg({ cpuMoeLayers: 32 }), { make: r.make, say: (l) => lines.push(l), calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 33);
  assert.equal(out.calibration?.outcome, "margin-raised");
  assert.deepEqual(r.events, ["start:32:ok", "stop:32", "start:33:ok"]);
  assert.ok(lines.some((l) => /얇아/.test(l)));
});

test("thin margin: a bigger deficit raises by more than one layer", async () => {
  const r = rig(() => "ok", 100); // (100 - 600) / 458 -> raise by 2
  const out = await startCalibrated(cfg({ cpuMoeLayers: 32 }), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 34);
});

test("thin margin: if the raised launch does not load, the one that worked is restored", async () => {
  const r = rig((m) => (m > 32 ? "other" : "ok"), 394);
  const out = await startCalibrated(cfg({ cpuMoeLayers: 32 }), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 32);
  assert.equal(out.calibration?.outcome, "margin-raise-rejected");
  assert.deepEqual(r.events, ["start:32:ok", "stop:32", "start:33:other", "stop:33", "start:32:ok"]);
});

test("thin margin with no experts on the CPU yet: starts moving them, never above the layer count", async () => {
  const r = rig(() => "ok", 100);
  const out = await startCalibrated(cfg({ cpuMoeLayers: 0 }), { make: r.make, calibrate: true, ...r.base });
  assert.equal(out.cfg.cpuMoeLayers, 2);
  const capped = rig(() => "ok", -5000);
  const out2 = await startCalibrated(cfg({ cpuMoeLayers: 39 }), { make: capped.make, calibrate: true, ...capped.base });
  assert.equal(out2.cfg.cpuMoeLayers, 40);
});

test("thin margin is not trialled when already calibrated or when calibrate is off", async () => {
  const a = rig(() => "ok", 100);
  await startCalibrated(cfg({ calibratedFor: calibrationKey(cfg(), "GPU") }), { make: a.make, calibrate: true, ...a.base });
  const b = rig(() => "ok", 100);
  await startCalibrated(cfg(), { make: b.make, calibrate: false, ...b.base });
  assert.deepEqual(a.events, ["start:32:ok"]);
  assert.deepEqual(b.events, ["start:32:ok"]);
});
