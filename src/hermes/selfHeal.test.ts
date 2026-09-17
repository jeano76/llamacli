import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./selfHeal.js";

test("CircuitBreaker allows distinct calls under the window size", () => {
  const breaker = new CircuitBreaker({ windowSize: 12, maxDistinct: 3, hardTimeoutMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    breaker.record({ toolName: "read_file", argsSignature: `{"path":"f${i}.ts"}` });
  }
  assert.equal(breaker.shouldStop(), null);
});

test("CircuitBreaker trips when the recent window has too few distinct calls", () => {
  const breaker = new CircuitBreaker({ windowSize: 6, maxDistinct: 3, hardTimeoutMs: 60_000 });
  // Only 2 distinct calls, repeated to fill the window — a stuck read/edit loop.
  for (let i = 0; i < 6; i++) {
    breaker.record({ toolName: i % 2 === 0 ? "read_file" : "edit_file", argsSignature: "same-args" });
  }
  const reason = breaker.shouldStop();
  assert.ok(reason, "expected the breaker to trip");
  assert.match(reason!, /repetitive tool-call loop/);
});

test("CircuitBreaker does not evaluate the loop condition before the window fills", () => {
  const breaker = new CircuitBreaker({ windowSize: 6, maxDistinct: 3, hardTimeoutMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    breaker.record({ toolName: "read_file", argsSignature: "same-args" });
  }
  assert.equal(breaker.shouldStop(), null);
});

test("CircuitBreaker trips on hard timeout regardless of call pattern", async () => {
  const breaker = new CircuitBreaker({ windowSize: 12, maxDistinct: 3, hardTimeoutMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const reason = breaker.shouldStop();
  assert.ok(reason, "expected the breaker to trip on timeout");
  assert.match(reason!, /hard timeout/);
});

test("CircuitBreaker.reset() clears history and restarts the timeout clock", async () => {
  const breaker = new CircuitBreaker({ windowSize: 6, maxDistinct: 3, hardTimeoutMs: 60_000 });
  for (let i = 0; i < 6; i++) {
    breaker.record({ toolName: "read_file", argsSignature: "same-args" });
  }
  assert.ok(breaker.shouldStop());
  breaker.reset();
  assert.equal(breaker.shouldStop(), null);
});

test("CircuitBreaker only keeps the most recent windowSize calls", () => {
  const breaker = new CircuitBreaker({ windowSize: 4, maxDistinct: 3, hardTimeoutMs: 60_000 });
  // 4 distinct calls, but the window only holds the last 4, and the first
  // one recorded should have been evicted by the time we add a 5th distinct one.
  breaker.record({ toolName: "a", argsSignature: "1" });
  breaker.record({ toolName: "b", argsSignature: "1" });
  breaker.record({ toolName: "c", argsSignature: "1" });
  breaker.record({ toolName: "d", argsSignature: "1" });
  // window is now [a,b,c,d] — 4 distinct, above maxDistinct(3), no trip
  assert.equal(breaker.shouldStop(), null);
  breaker.record({ toolName: "d", argsSignature: "1" });
  // window is now [b,c,d,d] — 3 distinct == maxDistinct, trips
  assert.ok(breaker.shouldStop());
});
