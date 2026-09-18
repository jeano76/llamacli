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

test("estimateTokens counts 0 for a message with neither string content nor tool_calls", async () => {
  const messages: ChatMessage[] = [{ role: "assistant", content: null as any }];
  assert.equal(await estimateTokens(messages), 0);
});

// Found live: two consecutive real turns both failed with "exceeds the
// available context size" at ~65,636 tokens against a 65,536-token window,
// in a tool-heavy session (run_shell/read_file calls throughout) —
// shouldCompact() kept saying there was room right up until the backend
// hard-rejected the request. Root cause: an assistant message requesting
// tool calls has `content: null`; the real payload sent to the backend
// lives in `tool_calls[].function.arguments` instead, which the estimate
// was treating as empty, undercounting a large fraction of the real
// conversation in exactly this kind of session.
test("estimateTokens counts tool_calls arguments, not just string content — this is what silently let real usage exceed the context window", async () => {
  const withoutToolCalls: ChatMessage[] = [{ role: "assistant", content: null as any }];
  const withToolCalls: ChatMessage[] = [
    {
      role: "assistant",
      content: null as any,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "run_shell", arguments: "x".repeat(400) },
        },
      ],
    },
  ];
  const withoutCount = await estimateTokens(withoutToolCalls);
  const withCount = await estimateTokens(withToolCalls);
  assert.equal(withoutCount, 0);
  assert.ok(withCount >= 100, `expected the 400-char tool_calls argument to be counted, got ${withCount}`); // 400/4
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

      // must not throw — this is the exact bug being fixed. contextWindowTokens
      // chosen so the size-based kept-tail selection lands on the same
      // boundary the old fixed "last 6 messages" rule did for this fixture
      // (cutting right after the tool_calls message) — a smaller window
      // would keep even less, a much larger one would keep more of the
      // (here, deliberately tiny) history than intended.
      const result = await runCompaction(dir, messages, backend, "m", partial, 30);

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

// Found by a scenario test simulating many long, tool-heavy developer
// sessions: the previous "keep the last 6 messages" rule was a fixed
// COUNT, not a size budget. If those 6 happen to be individually large
// (routine in a tool-heavy turn — sizable tool_calls arguments and tool
// results), the kept tail alone could already fill the entire context
// window, so compaction never actually shrank the conversation no matter
// how aggressively older history got summarized away — turns failed
// permanently instead of recovering. The tail must be sized against the
// real configured context window instead.
test("runCompaction sizes the kept tail against the real context window, not a fixed message count", () =>
  (async () => {
    const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
    try {
      // 10 messages, each ~2000 chars — under the old fixed rule, all 6
      // of the last messages (12,000 chars) would be kept verbatim
      // regardless of how small the configured window is.
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        ...Array.from({ length: 9 }, (_, i): ChatMessage => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(2000) })),
      ];
      const { backend } = strictNoToolsBackend();
      const partial = {
        reason: "manual" as const,
        goal: "test",
        steps: [],
        files: [],
        pendingToolCall: null,
        mustPreserve: [],
      };

      // A small window (500 tokens ~= 2000 chars budget at the 40% ratio)
      // can't afford to keep 6 such messages verbatim (12,000 chars) —
      // the kept tail should come back much smaller than that.
      const smallWindowResult = await runCompaction(dir, messages, backend, "m", partial, 500);
      const smallTailChars = smallWindowResult.messages
        .slice(1) // skip the injected "[Compacted history summary]" message
        .reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
      assert.ok(smallTailChars < 12_000, `expected a small window to keep a much smaller tail, got ${smallTailChars} chars`);

      // A large window should be able to afford keeping most/all of the
      // same messages — proving the tail size actually tracks the window,
      // not some other unrelated fixed limit.
      const largeWindowResult = await runCompaction(dir, messages, backend, "m", partial, 50_000);
      const largeTailChars = largeWindowResult.messages
        .slice(1)
        .reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
      assert.ok(
        largeTailChars > smallTailChars,
        `expected a larger window to keep a larger tail (small=${smallTailChars}, large=${largeTailChars})`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })());

test("runCompaction's kept tail always includes at least the single most recent message, even if it alone exceeds the window budget", () =>
  (async () => {
    const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "x".repeat(10_000) }, // alone, already way past a tiny window
      ];
      const { backend } = strictNoToolsBackend();
      const partial = {
        reason: "manual" as const,
        goal: "test",
        steps: [],
        files: [],
        pendingToolCall: null,
        mustPreserve: [],
      };

      // Tiny window (10 tokens) — nothing meaningfully "fits", but the
      // result must still be usable (a turn with zero kept context isn't),
      // not an empty tail or a thrown error.
      const result = await runCompaction(dir, messages, backend, "m", partial, 10);
      assert.ok(
        result.messages.some((m) => typeof m.content === "string" && m.content.includes("x".repeat(100))),
        "expected the single most recent message to still be kept even though it alone exceeds the budget"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })());

// Found live: real usage (per llama-server's own reported n_tokens) kept
// running measurably past this project's compaction threshold before a
// compaction ever fired. Root cause: the tools schema JSON (TOOL_DEFS in
// loop.ts, sent as the `tools` field on every main-loop request) tokenizes
// to hundreds of real tokens on its own — sent on every single request,
// and never counted at all before this, silently undercounting every
// threshold check by that much.
test("estimateTokens counts extraText (the tools schema payload) in addition to the messages themselves", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "a".repeat(40) }];
  const withoutExtra = await estimateTokens(messages);
  const withExtra = await estimateTokens(messages, undefined, "x".repeat(400));
  assert.equal(withoutExtra, 10); // 40/4
  assert.equal(withExtra, 110); // (40+400)/4
});

test("shouldCompact accounts for extraText too — a request that fits without it can still be over threshold with it included", async () => {
  const thresholds = { autoTriggerRatio: 0.5, contextWindowTokens: 100 };
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(4 * 30) }]; // 30 tokens alone, < 50
  assert.equal(await shouldCompact(messages, thresholds), false);
  assert.equal(await shouldCompact(messages, thresholds, undefined, "y".repeat(4 * 30)), true); // 30+30=60 >= 50
});
