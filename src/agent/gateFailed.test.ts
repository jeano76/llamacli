import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate } from "./gate.js";

// ── A dead gate must not look like a verdict ────────────────────────────────
// Confirmed live: laya-serve was listening on :8000 while every health probe
// polled :8099, so every turn burned the full 30 s timeout, hit the catch in
// runLayaGate, and returned a bare `{judgeSaysCheap:false}`. That rendered as
// `gate: 전체 턴 필요로 판단 (conf=0.000)` — indistinguishable from the judge
// genuinely having decided. The user could not tell a broken gate from a
// working one, and reported exactly that.

test("a failed gate is reported as a failure, not as a 'full turn needed' verdict", () => {
  const d = decideGate({ judgeSaysCheap: false, conf: 0, text: "hello", judgeEnabled: false, gateFailed: true });
  assert.match(d.reason, /판정 실패/);
  assert.match(d.reason, /연결하지 못/);
  assert.doesNotMatch(d.reason, /conf=0\.000/, "must not present a confidence it never got");
  assert.equal(d.mode, "full", "no judge to disagree, so the full turn runs");
});

test("a failed gate is not reported as a high-risk hold", () => {
  // The risk rail did NOT fire. Marking it `forced` would claim a safety hold
  // that never happened, and would be a second kind of lie.
  const d = decideGate({ judgeSaysCheap: false, conf: 0, text: "hello", judgeEnabled: false, gateFailed: true });
  assert.equal(d.forced, false);
  assert.deepEqual(d.matched, []);
});

test("a real 'not cheap' verdict is still reported as a verdict", () => {
  const d = decideGate({ judgeSaysCheap: false, conf: 0.812, text: "hello", judgeEnabled: true });
  assert.match(d.reason, /전체 턴 필요로 판단/);
  assert.match(d.reason, /conf=0\.812/);
});

test("the failure reason differs from both the off and the verdict states", () => {
  const failed = decideGate({ judgeSaysCheap: false, conf: 0, text: "hi", judgeEnabled: false, gateFailed: true });
  const off = decideGate({ judgeSaysCheap: false, conf: 0, text: "hi", judgeEnabled: false });
  const cheap = decideGate({ judgeSaysCheap: true, conf: 0.9, text: "hi", judgeEnabled: true });
  const full = decideGate({ judgeSaysCheap: false, conf: 0.9, text: "hi", judgeEnabled: true });
  const reasons = new Set([failed.reason, off.reason, cheap.reason, full.reason]);
  assert.equal(reasons.size, 4, `reasons collided: ${[...reasons].join(" | ")}`);
});

test("the risk rail still overrides a failed gate — a destructive request is never downgraded", () => {
  // Uses a phrase the rail actually matches. ("rm -rf /" on its own is NOT in
  // the rail's vocabulary — checked against highRiskMatches rather than assumed,
  // so this test asserts real behaviour instead of an invented one.)
  const d = decideGate({
    judgeSaysCheap: true, conf: 0.99, text: "sudo rm -rf /", judgeEnabled: true, gateFailed: true,
  });
  assert.equal(d.forced, true, "even a judge that said 'cheap' cannot downgrade this");
  assert.match(d.reason, /위험 작업/);
  assert.doesNotMatch(d.reason, /판정 실패/, "the rail's reason wins; the failure is secondary");
});
