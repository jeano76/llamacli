import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, shouldCompact, buildResumePrompt } from "./compactor.js";
import { writeCheckpoint, Checkpoint } from "./checkpoint.js";
import type { ChatMessage } from "../backend/types.js";

test("estimateTokens approximates chars/4 across all messages", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "a".repeat(40) },
    { role: "assistant", content: "b".repeat(20) },
  ];
  assert.equal(estimateTokens(messages), 15); // (40+20)/4
});

test("estimateTokens ignores non-string content (e.g. tool_calls-only messages)", () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: null as any }];
  assert.equal(estimateTokens(messages), 0);
});

test("shouldCompact is false below the threshold and true at/above it", () => {
  const thresholds = { autoTriggerRatio: 0.5, contextWindowTokens: 100 };
  const small: ChatMessage[] = [{ role: "user", content: "x".repeat(4 * 40) }]; // 40 tokens, < 50
  const big: ChatMessage[] = [{ role: "user", content: "x".repeat(4 * 60) }]; // 60 tokens, >= 50
  assert.equal(shouldCompact(small, thresholds), false);
  assert.equal(shouldCompact(big, thresholds), true);
});

test("buildResumePrompt returns null when there's no checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    assert.equal(await buildResumePrompt(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildResumePrompt summarizes goal, remaining steps, pending tool call, and files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const checkpoint: Checkpoint = {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      reason: "auto-threshold",
      goal: "Add dark mode toggle",
      steps: [
        { description: "Add settings flag", status: "done" },
        { description: "Wire up toggle UI", status: "in_progress" },
        { description: "Persist preference", status: "todo" },
      ],
      files: [{ path: "src/settings.ts", status: "modified" }],
      pendingToolCall: { name: "edit_file", argumentsJson: "{}", reason: "mid-edit when compaction fired" },
      mustPreserve: [],
    };
    await writeCheckpoint(dir, checkpoint);

    const prompt = await buildResumePrompt(dir);
    assert.ok(prompt);
    assert.match(prompt!, /Add dark mode toggle/);
    assert.match(prompt!, /Wire up toggle UI/);
    assert.match(prompt!, /Persist preference/);
    // the already-done step should not appear in "remaining steps"
    assert.doesNotMatch(prompt!, /Add settings flag/);
    assert.match(prompt!, /edit_file/);
    assert.match(prompt!, /src\/settings\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildResumePrompt says all steps were done when nothing remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const checkpoint: Checkpoint = {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      reason: "manual",
      goal: "Fix typo",
      steps: [{ description: "Fix typo", status: "done" }],
      files: [],
      pendingToolCall: null,
      mustPreserve: [],
    };
    await writeCheckpoint(dir, checkpoint);
    const prompt = await buildResumePrompt(dir);
    assert.match(prompt!, /already done|re-verifying/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
