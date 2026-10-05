import { test } from "node:test";
import assert from "node:assert/strict";
import { runCalibration, measureCalibration } from "./calibrateCommand.js";
import type { CalibrationReading } from "./calibrateTuning.js";
import type { ParsedServerArgs } from "./modelSwitch.js";

const GiB = 1024 ** 3;

// Measured box from calibrateTuning.test.ts: Ornith 9B, -ngl 32, ctx 36864.
function box(): CalibrationReading {
  return {
    freeMiB: 2023, totalMiB: 8192, ownVramMiB: 5588,
    gpuName: "GPU", modelBytes: 5780090816, layers: 33,
    kvElementsPerToken: 16384, trainedContext: 262144, moe: false, cpuCount: 12,
  };
}
const running = (): ParsedServerArgs => ({
  modelPath: "/m/Ornith-1.5-9B-Q4_K_M.gguf", port: 8080,
  contextSize: 36864, gpuLayers: 32, threads: 6, threadsBatch: 11,
  flashAttn: true, cacheTypeK: "q8_0", cacheTypeV: "q8_0",
});
const prevTuning = { contextSize: 36864, gpuLayers: 32 } as never;

test("preview proposes changes and names the confirm command, touching nothing", async () => {
  let restarts = 0;
  const r = await runCalibration(
    { report: {} as never, running: running(), measured: box(), previousTuning: prevTuning, confirmed: false },
    { rereport: async () => { throw new Error("must not rereport on preview"); }, restart: async () => { restarts++; throw new Error("must not restart on preview"); } }
  );
  assert.equal(r.applied, false);
  assert.equal(restarts, 0);
  assert.match(r.lines.join("\n"), /-ngl/);
  assert.match(r.lines.join("\n"), /\/server calibrate confirm/);
  assert.match(r.lines.join("\n"), /컴팩션\(적응형\)/);
});

test("confirm applies via restart; a failed restart restores the previous tuning", async () => {
  const calls: unknown[] = [];
  let attempt = 0;
  const r = await runCalibration(
    { report: { port: 8080 } as never, running: running(), measured: box(), previousTuning: prevTuning, confirmed: true },
    {
      rereport: async () => ({ port: 8080 }) as never,
      restart: async (_rep, tuning) => {
        attempt++;
        calls.push(tuning);
        return attempt === 1
          ? { restarted: false, lines: ["new server would not start"] }
          : { restarted: true, lines: ["old server back"] };
      },
    }
  );
  assert.equal(r.applied, false);
  assert.equal(calls.length, 2, "expected trial + restore");
  assert.deepEqual(calls[1], prevTuning, "restore must use the previous tuning, not the failed plan");
  assert.match(r.lines.join("\n"), /되돌렸습니다/);
});

test("confirm success does not restore", async () => {
  let restarts = 0;
  const r = await runCalibration(
    { report: {} as never, running: running(), measured: box(), previousTuning: prevTuning, confirmed: true },
    {
      rereport: async () => { throw new Error("must not rereport on success"); },
      restart: async () => { restarts++; return { restarted: true, lines: ["up"] }; },
    }
  );
  assert.equal(r.applied, true);
  assert.equal(restarts, 1);
});

test("measureCalibration reports unknowns as undefined, never zero", async () => {
  const m = await measureCalibration({ modelPath: "/nonexistent/model.gguf" } as ParsedServerArgs, {
    readGpu: async () => undefined,
    readOwnVramMiB: async () => 0,
    statModel: async () => { throw new Error("no file"); },
  });
  assert.equal(m.freeMiB, undefined);
  assert.equal(m.modelBytes, 0, "modelBytes 0 is a measured stat failure, distinct from unknown VRAM");
  assert.equal(m.kvElementsPerToken, undefined);
});
