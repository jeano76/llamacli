import { test } from "node:test";
import assert from "node:assert/strict";
import { decideToolApproval, approvalPreview, AUTO_APPROVE_TOOLS } from "./approval.js";

test("read-only tools pass without asking; writers/shell/browser/unknown ask", () => {
  for (const name of ["read_file", "note", "update_plan", "load_skill"]) {
    assert.equal(decideToolApproval(name), "allow", `${name} should not prompt`);
  }
  for (const name of ["write_file", "append_file", "edit_file", "run_shell", "browser_navigate", "some_future_tool"]) {
    assert.equal(decideToolApproval(name), "ask", `${name} must prompt`);
  }
  assert.ok(AUTO_APPROVE_TOOLS.size > 0);
});

test("always-allowed session set passes without asking", () => {
  assert.equal(decideToolApproval("run_shell", new Set(["run_shell"])), "allow");
  assert.equal(decideToolApproval("run_shell", new Set()), "ask");
});

test("approvalPreview shows path/command, never throws on bad JSON", () => {
  assert.match(approvalPreview("read_file", JSON.stringify({ path: "src/a.ts" })), /src\/a\.ts/);
  assert.match(approvalPreview("run_shell", JSON.stringify({ command: "npm test" })), /npm test/);
  assert.equal(approvalPreview("x", "not json{{{"), "x(not json{{{)");
  assert.equal(approvalPreview("x", ""), "x");
});
