import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCiOverride, restoreCiValue } from "./ciEnv.js";

test("on a terminal CI is forced to 'false' (Ink would otherwise stop redrawing) and the original is returned", () => {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  const original = applyCiOverride(env, true);
  assert.equal(env.CI, "false");
  assert.equal(original, "true");
  restoreCiValue(env, original);
  assert.equal(env.CI, "true", "the agent's child processes see the user's real value again");
});

test("an unset CI is unset again after the restore", () => {
  const env: NodeJS.ProcessEnv = {};
  const original = applyCiOverride(env, true);
  assert.equal(env.CI, "false");
  restoreCiValue(env, original);
  assert.equal("CI" in env, false);
});

test("off a terminal (pipes, tests) nothing is touched", () => {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  assert.equal(applyCiOverride(env, false), "true");
  assert.equal(env.CI, "true");
});
