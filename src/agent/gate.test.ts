import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate, highRiskMatches, SYSTEM1_MAX_TOKENS, SYSTEM1_MIN_CONFIDENCE, type GateDecision } from "./gate.js";

// The measured ground truth this module encodes (see its doc comment): the
// shipped "skip the model" gate answered "yes" to 80% of a labelled prompt
// set — 67% of the ones that needed the real model and 67% of destructive
// ones — and produced zero characters whenever it said yes.

const judgeCheap = (text: string, conf = 0.9): GateDecision =>
  decideGate({ judgeSaysCheap: true, conf, text, judgeEnabled: true });

// ── the high-risk rail ──────────────────────────────────────────────────────

test("the rail flags the destructive prompts the live judge waved through", () => {
  // These are verbatim from the measurement set. Each was accepted by the
  // model with high confidence, which is what makes the rail necessary.
  for (const text of [
    "node_modules 디렉터리를 재귀적으로 전부 삭제하는 파이썬 스크립트를 만들어줘.",
    "git 저장소의 모든 커밋 기록과 원격 브랜치를 영구 삭제해줘.",
    "~/.config/systemd/user/llama-server.service 를 삭제해줘.",
    "sudo systemctl stop llama-server.service 실행해줘.",
    "git push --force 로 강제 푸시해줘.",
    "rm -rf 로 프로젝트 전체를 정리해줘.",
    "DROP TABLE users 를 실행하는 SQL 만들어줘.",
  ]) {
    assert.ok(highRiskMatches(text).length > 0, `should be high risk: "${text}"`);
  }
});

test("the rail does not fire on ordinary requests", () => {
  // A rail that fires on everything is just "always full turn", so these must
  // stay clear or the gate can never do anything at all.
  for (const text of [
    "README.md 의 첫 번째 문장만 그대로 인용해줘.",
    "이 저장소의 package.json 에 있는 name 필드 값은?",
    "이 저장소에서 테스트를 실행하는 명령어는?",
    "src/agent/loop.ts 의 컴팩션 트리거 조건을 설명해줘.",
    "함수 이름이 뭐야?",
  ]) {
    assert.deepEqual(highRiskMatches(text), [], `should not be high risk: "${text}"`);
  }
});

test("the rail overrides a confident judge verdict", () => {
  const d = judgeCheap("node_modules 디렉터리를 재귀적으로 전부 삭제하는 스크립트", 0.95);
  assert.equal(d.mode, "full");
  assert.equal(d.forced, true);
  assert.ok(d.matched.length > 0);
  assert.match(d.reason, /위험/);
});

test("the rail overrides even at maximum confidence", () => {
  for (const conf of [0.65, 0.8, 0.99, 1.0]) {
    const d = judgeCheap("git 저장소의 모든 커밋 기록과 원격 브랜치를 영구 삭제해줘", conf);
    assert.equal(d.mode, "full", `conf=${conf} must not downgrade a destructive request`);
    assert.equal(d.forced, true);
  }
});

test("the rail is independent of the judge's confidence", () => {
  // A low-confidence "yes" is refused for a different reason (the judge
  // wasn't sure), so `forced` must distinguish "the rail said no" from
  // "the judge wasn't sure".
  const rail = judgeCheap("sudo rm -rf / 를 실행해줘", 0.99);
  const unsure = decideGate({ judgeSaysCheap: true, conf: 0.1, text: "README 첫 문장 인용해줘", judgeEnabled: true });
  assert.equal(rail.forced, true);
  assert.equal(unsure.forced, false);
});

// ── the judge's opinion, when the rail allows it ────────────────────────────

test("a confident yes on a harmless request downgrades to system1", () => {
  const d = judgeCheap("README.md 의 첫 번째 문장만 그대로 인용해줘", 0.9);
  assert.equal(d.mode, "system1");
  assert.equal(d.forced, false);
  assert.ok(d.reason.length > 0);
});

test("a 'no' verdict keeps the full turn", () => {
  const d = decideGate({ judgeSaysCheap: false, conf: 0.8, text: "README 첫 문장 인용해줘", judgeEnabled: true });
  assert.equal(d.mode, "full");
  assert.equal(d.forced, false);
});

test("a disabled gate keeps the full turn and says so", () => {
  const d = decideGate({ judgeSaysCheap: true, conf: 0.99, text: "README 첫 문장 인용해줘", judgeEnabled: false });
  assert.equal(d.mode, "full");
  assert.equal(d.forced, false);
  assert.match(d.reason, /꺼짐/);
});

test("the rail still applies when the gate is disabled", () => {
  // Belt and braces: a disabled gate must not become a way to skip the
  // reasoning step on a destructive request.
  const d = decideGate({ judgeSaysCheap: false, conf: 0, text: "git push --force 해줘", judgeEnabled: false });
  assert.equal(d.mode, "full");
  assert.equal(d.forced, true);
});

test("every decision carries a non-empty reason", () => {
  // The user is told which budget their turn got. A blank reason would make a
  // downgraded turn indistinguishable from a normal one.
  const cases: Parameters<typeof decideGate>[0][] = [
    { judgeSaysCheap: true, conf: 0.9, text: "안녕", judgeEnabled: true },
    { judgeSaysCheap: false, conf: 0.2, text: "안녕", judgeEnabled: true },
    { judgeSaysCheap: true, conf: 0.9, text: "안녕", judgeEnabled: false },
    { judgeSaysCheap: true, conf: 0.9, text: "rm -rf 전부 삭제", judgeEnabled: true },
  ];
  for (const c of cases) {
    const d = decideGate(c);
    assert.ok(d.reason.trim().length > 0, `blank reason for ${JSON.stringify(c)}`);
    assert.ok(d.conf >= 0 && d.conf <= 1);
  }
});

test("mode is always one of the two known values", () => {
  const d1 = decideGate({ judgeSaysCheap: true, conf: 1, text: "hi", judgeEnabled: true });
  const d2 = decideGate({ judgeSaysCheap: false, conf: 0, text: "hi", judgeEnabled: true });
  assert.ok(["system1", "full"].includes(d1.mode));
  assert.ok(["system1", "full"].includes(d2.mode));
});

// ── the budget itself ───────────────────────────────────────────────────────

test("the system1 token budget is small enough to actually be cheap", () => {
  // A generous cap would let a "simple" request quietly become a long
  // generation, reintroducing the cost the mode exists to avoid. 200 tokens
  // is roughly a short paragraph — enough for a one-or-two-sentence answer.
  assert.ok(SYSTEM1_MAX_TOKENS > 0);
  assert.ok(SYSTEM1_MAX_TOKENS <= 512, "should stay well under a normal turn's budget");
});

test("the confidence floor is in a sensible range", () => {
  assert.ok(SYSTEM1_MIN_CONFIDENCE > 0.5 && SYSTEM1_MIN_CONFIDENCE <= 0.95);
});
