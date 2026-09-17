import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, shouldCompact, buildResumePrompt } from "./compactor.js";
import { writeCheckpoint, Checkpoint } from "./checkpoint.js";
import type { ChatMessage, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

function fakeBackendWithTokenizer(tokensPerCall: number | ((text: string) => number)): ModelBackend {
  return {
    async chat(): Promise<ChatCompletionResponse> {
      throw new Error("not used in these tests");
    },
    async listModels() {
      return [];
    },
    async tokenize(text: string) {
      return typeof tokensPerCall === "function" ? tokensPerCall(text) : tokensPerCall;
    },
  };
}

test("estimateTokens approximates chars/4 across all messages when no tokenizer is available", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "a".repeat(40) },
    { role: "assistant", content: "b".repeat(20) },
  ];
  assert.equal(await estimateTokens(messages), 15); // (40+20)/4
});

test("estimateTokens ignores non-string content (e.g. tool_calls-only messages)", async () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: null as any }];
  assert.equal(await estimateTokens(messages), 0);
});

test("estimateTokens uses the backend's real tokenizer when one is available", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }]; // char/4 estimate would be 100
  const backend = fakeBackendWithTokenizer(7); // but the "real" tokenizer says 7
  assert.equal(await estimateTokens(messages, backend), 7);
});

test("estimateTokens falls back to the char-based estimate when the tokenizer throws", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "a".repeat(40) }];
  const backend: ModelBackend = {
    async chat(): Promise<ChatCompletionResponse> {
      throw new Error("not used");
    },
    async listModels() {
      return [];
    },
    async tokenize() {
      throw new Error("tokenizer endpoint not implemented by this server");
    },
  };
  assert.equal(await estimateTokens(messages, backend), 10); // 40/4, the fallback
});

test("shouldCompact is false below the threshold and true at/above it", async () => {
  const thresholds = { autoTriggerRatio: 0.5, contextWindowTokens: 100 };
  const small: ChatMessage[] = [{ role: "user", content: "x".repeat(4 * 40) }]; // 40 tokens, < 50
  const big: ChatMessage[] = [{ role: "user", content: "x".repeat(4 * 60) }]; // 60 tokens, >= 50
  assert.equal(await shouldCompact(small, thresholds), false);
  assert.equal(await shouldCompact(big, thresholds), true);
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
