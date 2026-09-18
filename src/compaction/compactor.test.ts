import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, shouldCompact, buildResumePrompt, runCompaction } from "./compactor.js";
import { writeCheckpoint, Checkpoint } from "./checkpoint.js";
import type { ChatCompletionRequest, ChatMessage, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

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

/** Simulates a real backend (confirmed against a real llama-server) that
 *  rejects a completion request whose messages contain any tool_calls or
 *  role:"tool" entries ("Cannot continue an assistant message that
 *  contains tool calls"), OR that ends with 2+ consecutive assistant
 *  messages ("Cannot have 2 or more assistant messages at the end of the
 *  list") — both were hit in production by the same sanitization gap. */
function strictNoToolsBackend(): { backend: ModelBackend; lastRequest: () => ChatCompletionRequest | undefined } {
  let lastRequest: ChatCompletionRequest | undefined;
  const backend: ModelBackend = {
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      lastRequest = req;
      const hasToolArtifact = req.messages.some(
        (m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0)
      );
      if (hasToolArtifact) {
        throw new Error(
          '400 {"error":{"code":400,"message":"Cannot continue an assistant message that contains tool calls.","type":"invalid_request_error"}}'
        );
      }
      const msgs = req.messages;
      if (msgs.length >= 2 && msgs[msgs.length - 1].role === "assistant" && msgs[msgs.length - 2].role === "assistant") {
        throw new Error(
          '400 {"error":{"code":400,"message":"Cannot have 2 or more assistant messages at the end of the list.","type":"invalid_request_error"}}'
        );
      }
      return { choices: [{ message: { role: "assistant", content: "summary text" }, finish_reason: "stop" }] };
    },
    async listModels() {
      return [];
    },
  };
  return { backend, lastRequest: () => lastRequest };
}

test("runCompaction sanitizes tool_calls/tool-role messages so a strict backend never rejects the summary request", () =>
  (async () => {
    const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
    try {
      // Reproduces the exact production scenario: messages.slice(0, -6) cuts
      // right after an assistant message with tool_calls, leaving its
      // matching tool-role response in the kept tail — a dangling tool call
      // at the end of what gets sent for summarization.
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "answer1" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "run_shell", arguments: '{"command":"date"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "Thu Sep 18" },
        { role: "assistant", content: "answer2" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "answer3" },
        { role: "user", content: "q3" },
        { role: "assistant", content: "answer4" },
      ];

      const { backend, lastRequest } = strictNoToolsBackend();
      const partial = {
        reason: "manual" as const,
        goal: "test",
        steps: [],
        files: [],
        pendingToolCall: null,
        mustPreserve: [],
      };

      // must not throw — this is the exact bug being fixed
      const result = await runCompaction(dir, messages, backend, "m", partial);

      const sent = lastRequest();
      assert.ok(sent);
      assert.ok(
        sent!.messages.every((m) => m.role !== "tool" && !(m.tool_calls && m.tool_calls.length > 0)),
        "summary request must not contain any tool_calls or role:tool messages"
      );
      // the tool call's intent is still preserved as readable text, not silently dropped
      assert.ok(sent!.messages.some((m) => typeof m.content === "string" && m.content.includes("run_shell")));
      // converting the dangling tool_calls message to role:"assistant" put
      // it right after another assistant message ("answer1") — must have
      // been merged into one, not left as 2 consecutive assistant messages
      // (the injected summarization system prompt + the original system
      // message are both legitimately role:"system" and untouched by this —
      // only consecutive *assistant* messages triggered the real 400).
      for (let i = 1; i < sent!.messages.length; i++) {
        assert.ok(
          !(sent!.messages[i].role === "assistant" && sent!.messages[i - 1].role === "assistant"),
          `messages[${i - 1}] and messages[${i}] are both role "assistant" — should have been merged`
        );
      }

      assert.equal(result.messages[0].content, "[Compacted history summary]\nsummary text");
      // the tool's matching result (index 4) landed in the kept tail (last 6
      // messages), verbatim and untouched — sanitization only applies to
      // what's actually sent for summarization, never to the preserved tail
      assert.ok(result.messages.some((m) => m.role === "tool" && m.content === "Thu Sep 18"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })());
