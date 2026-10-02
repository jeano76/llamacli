import { test } from "node:test";
import assert from "node:assert/strict";
import { describeReset, describeInForce } from "./resetDiff.js";

// `/reset` has to answer one of two questions honestly: "what changed", or
// "nothing changed — you were already optimal". Both produce a working app, so
// without this the user cannot tell which one happened.

test("a reset that changed nothing reports no changes", () => {
  const cfg = { model: "/m/a.gguf", llama: { contextSize: 16384, threads: 6, gpuLayers: 999 } };
  assert.deepEqual(describeReset(cfg, { ...cfg }), []);
});

test("a reset that changes the context size says so, with both values", () => {
  const lines = describeReset(
    { model: "/m/a.gguf", llama: { contextSize: 8192, threads: 6 } },
    { model: "/m/a.gguf", llama: { contextSize: 16384, threads: 6 } }
  );
  assert.equal(lines.length, 1, `expected exactly one changed line, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /컨텍스트/);
  assert.match(lines[0], /8,192/, `expected the before value: ${lines[0]}`);
  assert.match(lines[0], /16,384/, `expected the after value: ${lines[0]}`);
});

test("user-owned keys are never listed as changed, because /reset keeps them", () => {
  // Listing them would be a lie; the whole point of keepUserOwnedKeys is that a
  // reset preserves them, and the diff must not imply otherwise.
  const before = { apiKey: "sk", verify: { a: 1 }, browser: { debugPort: 1 }, compaction: { autoTriggerRatio: 0.5 } };
  const after = { ...before, llama: { contextSize: 16384 } };
  const lines = describeReset(before as any, after as any);
  for (const l of lines) {
    assert.doesNotMatch(l, /apiKey|verify|browser|compaction/, `user-owned key reported as changed: ${l}`);
  }
});

test("a model change is reported, and a missing value reads as (없음)", () => {
  const lines = describeReset({ llama: {} } as any, { model: "/m/new.gguf", llama: {} } as any);
  assert.equal(lines.length, 1);
  // Both sides are shown, and the absent one is a readable placeholder rather
  // than "undefined" or an empty gap.
  assert.match(lines[0], /^모델: \(없음\) → \/m\/new\.gguf$/, `got: ${lines[0]}`);
});

test("gpuLayers 0 is described as CPU-only, not as a layer count", () => {
  const lines = describeReset(
    { llama: { gpuLayers: 999 } } as any,
    { llama: { gpuLayers: 0 } } as any
  );
  assert.match(lines.join("\n"), /CPU 전용/, `got: ${JSON.stringify(lines)}`);
});

test("missing configs on either side do not throw", () => {
  // A reset on a fresh project has nothing to compare against.
  assert.doesNotThrow(() => describeReset(undefined, undefined));
  assert.doesNotThrow(() => describeReset(null, { model: "/m/a.gguf" }));
  assert.doesNotThrow(() => describeInForce(undefined));
});

test("describeInForce states what is now in force, whether or not anything changed", () => {
  const lines = describeInForce({
    model: "/m/a.gguf",
    llama: { contextSize: 16384, gpuLayers: 999, threads: 6 },
  } as any);
  const text = lines.join("\n");
  assert.match(text, /\/m\/a\.gguf/);
  assert.match(text, /16,384/);
  assert.match(text, /오프로드/);
  assert.match(text, /6개/);
});

test("numeric formatting survives the thousands separator", () => {
  // A locale-formatted 16384 must not be compared as a string elsewhere; this
  // guards the display only, and asserts the thousands separator is present so
  // a regression to a bare number is visible.
  const lines = describeInForce({ llama: { contextSize: 24576 } } as any);
  assert.match(lines.join("\n"), /24,576/);
});