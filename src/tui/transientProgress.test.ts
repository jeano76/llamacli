import { test } from "node:test";
import assert from "node:assert/strict";
import { transientProgress } from "./transientProgress.js";
import { createTransientLine } from "./transientLine.js";
import type { TransferProgress } from "../setup/download.js";

const p = (n: number): TransferProgress => ({
  label: "m.gguf", receivedBytes: n * 1e8, totalBytes: 5.5e9, bytesPerSecond: 3e7, etaSeconds: 100, percent: (n * 1e8 * 100) / 5.5e9,
});

test("a whole download occupies ONE log row, however many updates it reports", () => {
  // The real transient line, driven through the real factory the TUI uses.
  let rows: { id: number; text: string }[] = [];
  let id = 0;
  const line = createTransientLine(() => rows, (r) => { rows = r; }, (text) => ({ id: -1, text }), () => id++, 500);
  const reporter = transientProgress(() => ({ setTransient: (t) => line.update(t) }))(() => {});
  for (let i = 1; i <= 55; i++) reporter(p(i));
  assert.equal(rows.length, 1, "the download must not append a row per update");
  assert.match(rows[0].text, /100%|\d+%/);
  assert.ok(rows[0].text.includes("MB") || rows[0].text.includes("GB"));
});

test("the reporter never releases the row — that is what made every update a new row", () => {
  const calls: string[] = [];
  const ui = { setTransient: () => calls.push("set"), endTransient: () => calls.push("end") };
  const reporter = transientProgress(() => ui)(() => {});
  reporter(p(1)); reporter(p(2));
  assert.deepEqual(calls, ["set", "set"]);
});

test("no UI yet is not an error", () => {
  assert.doesNotThrow(() => transientProgress(() => undefined)(() => {})(p(1)));
});
