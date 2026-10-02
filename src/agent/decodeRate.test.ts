import { test } from "node:test";
import assert from "node:assert/strict";
import { DecodeRateTracker, formatDecodeRate } from "./decodeRate.js";
import { withDecodeRate } from "../tui/App.js";

function clock() {
  let t = 0;
  return { now: () => t, set: (v: number) => { t = v; } };
}

test("rate is measured from the first chunk, so prompt processing is not counted", () => {
  const c = clock();
  const r = new DecodeRateTracker(c.now, 0);
  c.set(20_000); r.chunk();            // 20 s of prefill before the first token
  for (let i = 1; i <= 40; i++) { c.set(20_000 + i * 25); r.chunk(); } // 40 tok/s afterwards
  assert.equal(Math.round(r.live()!), 40);
});

test("too early to mean anything: no rate from a single chunk or a sub-window burst", () => {
  const c = clock();
  const r = new DecodeRateTracker(c.now, 0, 400);
  c.set(1000); r.chunk();
  assert.equal(r.live(), null);
  c.set(1100); r.chunk(); c.set(1150); r.chunk();
  assert.equal(r.live(), null, "150 ms of data is jitter, not a speed");
});

test("live updates are throttled", () => {
  const c = clock();
  const r = new DecodeRateTracker(c.now, 250, 400);
  c.set(0); r.chunk();
  for (let i = 1; i <= 100; i++) { c.set(i * 25); r.chunk(); }
  assert.notEqual(r.live(), null);
  c.set(2500 + 100); r.chunk();
  assert.equal(r.live(), null, "asked again 100 ms after the last emit");
  c.set(2500 + 400); r.chunk();
  assert.notEqual(r.live(), null);
});

test("final uses the server's exact token count when it has one", () => {
  const c = clock();
  const r = new DecodeRateTracker(c.now, 0);
  c.set(0); r.chunk();
  // 20 chunks but the server batched: it generated 41 tokens in 1 s.
  for (let i = 1; i <= 19; i++) { c.set(i * 50); r.chunk(); }
  c.set(1000); r.chunk();
  assert.equal(Math.round(r.final(41)!), 40);
  assert.equal(Math.round(r.final()!), 20, "without usage it falls back to the chunk count");
});

test("formatting: whole numbers from 10, one decimal below", () => {
  assert.equal(formatDecodeRate(40.4), "(40 t/s)");
  assert.equal(formatDecodeRate(38.5), "(39 t/s)");
  assert.equal(formatDecodeRate(9.46), "(9.5 t/s)");
  assert.equal(formatDecodeRate(0.8), "(0.8 t/s)");
});

test("the tag goes after the last word, on the last row that has text", () => {
  assert.deepEqual(withDecodeRate(["안녕하세요"], 40, 80, false), ["안녕하세요 (40 t/s)"]);
  assert.deepEqual(withDecodeRate(["a", "b", ""], 40, 80, false), ["a", "b (40 t/s)", ""]);
});

test("no rate, no change; and the original rows are never mutated", () => {
  const rows = ["hello"];
  assert.strictEqual(withDecodeRate(rows, undefined, 80), rows);
  const out = withDecodeRate(rows, 40, 80, false);
  assert.deepEqual(rows, ["hello"]);
  assert.notStrictEqual(out, rows);
});

test("when the last row is full the tag takes its own row instead of being cut", () => {
  const full = "x".repeat(20);
  assert.deepEqual(withDecodeRate([full], 40, 20, false), [full, "(40 t/s)"]);
});

test("ANSI colour on the last row does not count toward its width", () => {
  const coloured = "\x1b[31m" + "x".repeat(10) + "\x1b[39m";
  const out = withDecodeRate([coloured], 40, 30, false);
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith(" (40 t/s)"));
});

test("styled form wraps the tag in dim, bare form does not (shimmer slices by index)", () => {
  assert.match(withDecodeRate(["a"], 40, 80, true)[0], /\x1b\[2m\(40 t\/s\)\x1b\[22m$/);
  assert.ok(!withDecodeRate(["a"], 40, 80, false)[0].includes("\x1b"));
});

import { foldedWithRate, foldedReasoningSummary } from "../tui/App.js";

test("a folded reasoning row gets the rate only when it still fits on one row", () => {
  const base = foldedReasoningSummary("x".repeat(162));
  assert.equal(foldedWithRate(base, 22, 100), `${base} (22 t/s)`);
  assert.equal(foldedWithRate(base, 22, 40), base, "narrow terminal: the summary stays one whole row");
  assert.equal(foldedWithRate(base, undefined, 100), base);
});
