import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeImprovement, writeProposedRule, appendImprovementLog } from "./selfImprove.js";
import type { FailureLogEntry } from "./selfHeal.js";
import type { ChatCompletionResponse, ModelBackend } from "../backend/types.js";

function fakeBackend(reply: string): ModelBackend {
  return {
    async chat(): Promise<ChatCompletionResponse> {
      return { choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] };
    },
    async listModels() {
      return ["fake-model"];
    },
  };
}

function failure(toolName: string, errorMessage: string, timestamp = "2026-01-01T00:00:00.000Z"): FailureLogEntry {
  return { timestamp, summary: `tool ${toolName} failed`, toolName, errorMessage };
}

test("proposeImprovement returns null for an empty failure log", async () => {
  const result = await proposeImprovement([], fakeBackend("# should not be called"), "m");
  assert.equal(result, null);
});

test("proposeImprovement returns null when no pattern repeats enough (all one-offs)", async () => {
  const log = [failure("edit_file", "old_text not found in /a.ts"), failure("run_shell", "permission denied")];
  const result = await proposeImprovement(log, fakeBackend("# should not be called"), "m");
  assert.equal(result, null);
});

test("proposeImprovement drafts a rule once a pattern recurs, using the model's output verbatim", async () => {
  const log = [
    failure("edit_file", "old_text not found in /a.ts"),
    failure("edit_file", "old_text not found in /b.ts"),
    failure("edit_file", "old_text not found in /c.ts"),
  ];
  const ruleText = "# Always read before edit\n\nCheck the file first.";
  const result = await proposeImprovement(log, fakeBackend(ruleText), "m");
  assert.ok(result);
  assert.equal(result!.failureCount, 3);
  assert.equal(result!.ruleMarkdown, ruleText);
  assert.match(result!.summary, /edit_file/);
  assert.match(result!.summary, /3/);
  assert.match(result!.signature, /edit_file/);
});

test("proposeImprovement's signature stays stable as the same pattern recurs more times (for dedup)", async () => {
  const base = [failure("edit_file", "old_text not found in /a.ts"), failure("edit_file", "old_text not found in /b.ts")];
  const withOneMore = [...base, failure("edit_file", "old_text not found in /c.ts")];

  const first = await proposeImprovement(base, fakeBackend("# rule"), "m");
  const second = await proposeImprovement(withOneMore, fakeBackend("# rule"), "m");
  assert.ok(first && second);
  assert.equal(first!.signature, second!.signature);
});

test("proposeImprovement normalizes paths/numbers so near-identical errors group together", async () => {
  // Same underlying failure, but with different file paths and line numbers —
  // should still be recognized as the same recurring pattern.
  const log = [
    failure("edit_file", "old_text not found in /project/src/a.ts at line 12"),
    failure("edit_file", "old_text not found in /project/src/b.ts at line 44"),
  ];
  const result = await proposeImprovement(log, fakeBackend("# rule"), "m");
  assert.ok(result, "expected the two errors to be grouped as one recurring pattern");
  assert.equal(result!.failureCount, 2);
});

test("proposeImprovement keeps failures from different tools in separate buckets", async () => {
  const log = [
    failure("edit_file", "old_text not found"),
    failure("run_shell", "old_text not found"), // same message, different tool — must not merge
  ];
  const result = await proposeImprovement(log, fakeBackend("# rule"), "m");
  assert.equal(result, null, "2 failures split across 2 different tools should not count as one recurring pattern");
});

test("proposeImprovement returns null if the model's draft is empty/whitespace", async () => {
  const log = [failure("edit_file", "x"), failure("edit_file", "x")];
  const result = await proposeImprovement(log, fakeBackend("   \n  "), "m");
  assert.equal(result, null);
});

test("writeProposedRule writes a new timestamped file under .llamacli/rules/ and never touches existing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const path = await writeProposedRule(dir, {
      summary: "test",
      ruleMarkdown: "# Rule content\n",
      failureCount: 2,
      signature: "edit_file:old_text not found",
    });
    assert.match(path, /\.llamacli[/\\]rules[/\\]hermes-proposed-\d+\.md$/);
    assert.equal(await readFile(path, "utf8"), "# Rule content\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendImprovementLog writes to .llamacli/state/improvement-log.md, not the rules directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const path = await appendImprovementLog(dir, {
      summary: "edit_file failed 3 times",
      ruleMarkdown: "# Read before edit\n\nAlways read first.",
      failureCount: 3,
      signature: "edit_file:old_text not found",
    });
    assert.match(path, /\.llamacli[/\\]state[/\\]improvement-log\.md$/);
    const content = await readFile(path, "utf8");
    assert.match(content, /edit_file failed 3 times/);
    assert.match(content, /Read before edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendImprovementLog appends (doesn't overwrite) on repeated calls, preserving prior entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const path = await appendImprovementLog(dir, {
      summary: "first finding",
      ruleMarkdown: "# First\n",
      failureCount: 2,
      signature: "sig-1",
    });
    await appendImprovementLog(dir, {
      summary: "second finding",
      ruleMarkdown: "# Second\n",
      failureCount: 2,
      signature: "sig-2",
    });
    const content = await readFile(path, "utf8");
    assert.match(content, /first finding/);
    assert.match(content, /second finding/);
    // first entry still appears before the second — nothing was clobbered
    assert.ok(content.indexOf("first finding") < content.indexOf("second finding"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
