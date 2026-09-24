import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressTracker, verifierFor, runPostEditCheck, DEFAULT_VERIFIERS } from "./harness.js";

const MIN = 60_000;

test("ProgressTracker nudges only when BOTH the time and the compaction thresholds are reached", () => {
  const t = new ProgressTracker({ minutes: 15, compactions: 4 }, 0);
  for (let i = 0; i < 10; i++) t.onCompaction();
  assert.equal(t.check(10 * MIN), "ok", "many compactions but not enough time");
  const u = new ProgressTracker({ minutes: 15, compactions: 4 }, 0);
  u.onCompaction();
  assert.equal(u.check(60 * MIN), "ok", "plenty of time but only one compaction");
  for (let i = 0; i < 3; i++) u.onCompaction();
  assert.equal(u.check(60 * MIN), "nudge");
});

test("ProgressTracker stops after a second stalled window, and progress resets it", () => {
  const t = new ProgressTracker({ minutes: 15, compactions: 4 }, 0);
  const stall = (from: number) => {
    for (let i = 0; i < 4; i++) t.onCompaction();
    return t.check(from + 15 * MIN);
  };
  assert.equal(stall(0), "nudge");
  assert.equal(t.check(16 * MIN), "ok", "the nudge gets a fresh window");
  assert.equal(stall(15 * MIN), "stop");

  const p = new ProgressTracker({ minutes: 15, compactions: 4 }, 0);
  for (let i = 0; i < 4; i++) p.onCompaction();
  p.markProgress(14 * MIN);
  assert.equal(p.check(20 * MIN), "ok");
});

test("verifierFor uses built-in checks, lets config override or add, and can be turned off", () => {
  assert.equal(verifierFor("/x/a.js", undefined), DEFAULT_VERIFIERS["*.js"]);
  assert.equal(verifierFor("/x/a.txt", undefined), null);
  assert.equal(verifierFor("/x/a.ts", { "*.ts": "npx tsc --noEmit {file}" }), "npx tsc --noEmit {file}");
  assert.equal(verifierFor("/x/a.js", { "*.js": "eslint {file}" }), "eslint {file}");
  assert.equal(verifierFor("/x/a.js", false), null);
});

test("runPostEditCheck reports OK for valid files and the real error for broken ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-harness-"));
  try {
    const ok = join(dir, "ok.js");
    const bad = join(dir, "bad.js");
    const json = join(dir, "c.json");
    await writeFile(ok, "const a = 1;\n");
    // The live bug: a // comment inside a script built without newlines.
    await writeFile(bad, "function f() {if (x) {// comment} else {y();}}\n");
    await writeFile(json, '{"a": 1,}');
    assert.match((await runPostEditCheck(ok, dir, undefined))!, /OK$/);
    const badResult = (await runPostEditCheck(bad, dir, undefined))!;
    assert.match(badResult, /FAILED/);
    assert.match(badResult, /SyntaxError/);
    assert.match((await runPostEditCheck(json, dir, undefined))!, /JSON parse\] FAILED/);
    assert.equal(await runPostEditCheck(join(dir, "notes.txt"), dir, undefined), null);
    assert.match((await runPostEditCheck(bad, dir, undefined, true))!, /may just mean it is incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
