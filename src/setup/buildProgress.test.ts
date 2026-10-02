import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuildPercent, makeBuildProgress, defaultRun } from "./llamaCpp.js";

test("parseBuildPercent reads Makefile and Ninja progress, and ignores everything else", () => {
  assert.equal(parseBuildPercent("[ 42%] Building CXX object ggml/src/x.o"), 42);
  assert.equal(parseBuildPercent("[100%] Built target llama-server"), 100);
  assert.equal(parseBuildPercent("[  7%] Linking"), 7);
  assert.equal(parseBuildPercent("[12/340] Building C object a.o"), 3);
  assert.equal(parseBuildPercent("cc1plus: warning: [-Wfoo]"), null);
  assert.equal(parseBuildPercent("-- Configuring done"), null);
  assert.equal(parseBuildPercent("[0/0] weird"), null);
});

test("progress logs once per decile, not once per compiled file", () => {
  const out: string[] = [];
  let t = 0;
  const p = makeBuildProgress((l) => out.push(l), "CUDA", () => t, 60_000);
  for (let i = 0; i <= 100; i++) { t += 1000; p(`[${String(i).padStart(3)}%] Building`); }
  assert.ok(out.length <= 12, `got ${out.length} lines`);
  assert.ok(out[0].includes("0%") || out[0].includes("CUDA"));
  assert.ok(out[out.length - 1].includes("100%"));
});

test("a long silent step produces a heartbeat with elapsed minutes, not silence", () => {
  const out: string[] = [];
  let t = 0;
  const p = makeBuildProgress((l) => out.push(l), "CUDA", () => t, 60_000);
  p("[ 50%] Building CUDA object big.cu.o");
  assert.equal(out.length, 1);
  t += 30_000; p("nvcc warning: something");
  assert.equal(out.length, 1, "too soon for a heartbeat");
  t += 45_000; p("nvcc warning: something else");
  assert.equal(out.length, 2);
  assert.match(out[1], /1분 경과/);
  assert.match(out[1], /50%/);
});

test("defaultRun streams lines as they are produced and still returns", async () => {
  const lines: string[] = [];
  const out = await defaultRun("sh", ["-c", "echo '[ 10%] a'; echo '[ 55%] b' 1>&2; echo done"], { onLine: (l) => lines.push(l) });
  // stdout and stderr are separate pipes, so only the SET of lines is deterministic.
  assert.deepEqual([...lines].sort(), ["[ 10%] a", "[ 55%] b", "done"]);
  assert.match(out, /done/);
});

test("defaultRun with onLine rejects on a non-zero exit and says why from the tail", async () => {
  await assert.rejects(
    defaultRun("sh", ["-c", "echo compiling; echo 'c++: Killed' 1>&2; exit 3"], { onLine: () => {} }),
    /Killed/
  );
});
