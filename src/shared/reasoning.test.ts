import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_REASONING, MAX_REASONING_CEILING, MIN_REASONING_FLOOR, clampReasoningBudget } from "./reasoning.js";

test("clamp keeps the default for missing/non-numeric input — never NaN or 0", () => {
  assert.equal(clampReasoningBudget(undefined), DEFAULT_MAX_REASONING);
  assert.equal(clampReasoningBudget(null), DEFAULT_MAX_REASONING);
  assert.equal(clampReasoningBudget(""), DEFAULT_MAX_REASONING);
  assert.equal(clampReasoningBudget("전부"), DEFAULT_MAX_REASONING);
  assert.equal(clampReasoningBudget(NaN), DEFAULT_MAX_REASONING);
});

test("clamp narrows to [floor, ceiling] and rounds", () => {
  assert.equal(clampReasoningBudget(1), MIN_REASONING_FLOOR);
  assert.equal(clampReasoningBudget(999999), MAX_REASONING_CEILING);
  assert.equal(clampReasoningBudget(2048.7), 2049);
  assert.equal(clampReasoningBudget("512"), 512);
});
