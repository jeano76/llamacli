import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, summarizeErrorForDisplay } from "./loop.js";
import { readCheckpoint, writeCheckpoint, Checkpoint } from "../compaction/checkpoint.js";
import { clearFailureLog } from "../hermes/selfHeal.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ModelBackend,
} from "../backend/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A backend whose /chat behavior is scripted by call count, distinguishing
 *  the main agent turn (called with `tools`) from compactor.ts's internal
 *  summary request (called without `tools`). `tokenize` is scripted
 *  separately so context-usage thresholds can be hit deterministically
 *  without depending on real message content length. */
function scriptedBackend(opts: {
  turnResponses: ChatCompletionResponse[];
  tokenCounts: number[];
  summaryText?: string;
}): { backend: ModelBackend; turnRequests: ChatCompletionRequest[] } {
  let turnIndex = 0;
  let tokenizeIndex = 0;
  const turnRequests: ChatCompletionRequest[] = [];
  const backend: ModelBackend = {
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      if (!req.tools) {
        // compactor.ts's internal "summarize the old turns" request
        return {
          choices: [{ message: { role: "assistant", content: opts.summaryText ?? "summary" }, finish_reason: "stop" }],
        };
      }
      turnRequests.push(req);
      const res = opts.turnResponses[turnIndex];
      turnIndex++;
      if (!res) throw new Error(`scriptedBackend: no turn response scripted for call ${turnIndex}`);
      return res;
    },
    async listModels() {
      return ["fake-model"];
    },
    async tokenize() {
      const count = opts.tokenCounts[tokenizeIndex] ?? opts.tokenCounts[opts.tokenCounts.length - 1];
      tokenizeIndex++;
      return count;
    },
  };
  return { backend, turnRequests };
}

function assistantMessage(content: string | null, tool_calls?: ChatMessage["tool_calls"]): ChatCompletionResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) },
        finish_reason: tool_calls ? "tool_calls" : "stop",
      },
    ],
  };
}

test("AgentLoop.send() reports context usage on every measurement", () =>
  withTempProject(async (dir) => {
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [3],
    });
    const usageCalls: Array<[number, number]> = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
      onContextUsage: (used, total) => usageCalls.push([used, total]),
    });
    await loop.send("hi");
    assert.deepEqual(usageCalls, [[3, 100]]);
  }));

test("AgentLoop captures pendingToolCall when compaction fires mid-batch, and abandons the rest of that batch", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step1", status: "in_progress" }] }) },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step2", status: "in_progress" }] }) },
    };
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call1, call2])],
      // 1: top-of-loop check (before the turn) -> low, no compact
      // 2: before call1 -> low, no compact, call1 runs
      // 3: before call2 -> high, compacts and abandons call2
      tokenCounts: [1, 1, 1000],
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
      // This test is specifically about the checkpoint left behind for
      // manual resume (the next test covers the default autoResume: true
      // path, which would otherwise fold the resume context back in and
      // keep going within this same send() instead of stopping here).
      autoResume: false,
    });
    await loop.send("do the thing");

    assert.ok(statusMessages.some((s) => s.includes("compaction complete")));
    // A mid-batch abandonment must say the turn is over — otherwise it's
    // indistinguishable from the CLI having hung (reported directly: "진행
    // 중인지 멈춘건지 모르겠네" / "can't tell if this is still running").
    assert.ok(statusMessages.some((s) => s.includes("[turn ended]")));

    const checkpoint = await readCheckpoint(dir);
    assert.ok(checkpoint, "expected a checkpoint to have been written");
    assert.deepEqual(checkpoint!.pendingToolCall, {
      name: "update_plan",
      argumentsJson: call2.function.arguments,
      reason: "compaction threshold hit before this call could run",
    });
    // call1 ran (plan has step1) but call2 never did (no step2 in the plan)
    assert.equal(checkpoint!.steps.length, 1);
    assert.equal(checkpoint!.steps[0].description, "step1");
  }));

test("a checkpoint left by mid-session compaction is picked up automatically by the NEXT send(), not just on process restart", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step1", status: "in_progress" }] }) },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step2", status: "in_progress" }] }) },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [
        assistantMessage(null, [call1, call2]), // first send(): abandoned mid-batch by compaction
        assistantMessage("continuing now"), // second send(): should see the resume context first
      ],
      tokenCounts: [1, 1, 1000, 1], // 4th measurement (start of 2nd send's turn) stays low, no further compaction
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
      // Exercising the manual-resume path on purpose (see previous test);
      // autoResume: true is covered by its own test below.
      autoResume: false,
    });

    await loop.send("do the thing"); // leaves a checkpoint behind (see previous test)
    assert.ok(await readCheckpoint(dir), "expected a checkpoint after the first send()");

    statusMessages.length = 0;
    await loop.send("are you still there?");

    // the resume prompt must have been folded in automatically, with no
    // separate resumeIfCheckpointExists() call needed
    assert.ok(statusMessages.some((s) => s.includes("resuming after compaction")));
    assert.equal(await readCheckpoint(dir), null, "checkpoint should be consumed after being resumed");

    // and the model's second request must actually contain that resume
    // context (the interrupted tool call), not just a bare "are you still
    // there?" — buildResumePrompt() reports the pending call's name/reason,
    // not its raw arguments, so check for that rather than "step2".
    const secondRequest = turnRequests[1];
    assert.ok(secondRequest.messages.some((m) => typeof m.content === "string" && m.content.includes("update_plan")));
  }));

test("with the default autoResume: true, a compaction that interrupts a tool call resumes within the SAME send() — no second send() needed", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step1", status: "in_progress" }] }) },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step2", status: "in_progress" }] }) },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [
        assistantMessage(null, [call1, call2]), // abandoned mid-batch by compaction
        assistantMessage("continuing now"), // picked up automatically, same send()
      ],
      // 1: top-of-loop -> low, 2: before call1 -> low, call1 runs,
      // 3: before call2 -> high, compacts + abandons call2,
      // 4: top-of-loop after auto-resume -> low, no further compaction.
      tokenCounts: [1, 1, 1000, 1],
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
      // autoResume left unset on purpose: exercises the actual default.
    });

    await loop.send("do the thing");

    // Never stopped and waited — no "[turn ended]" status, and the second
    // scripted turn response was consumed within this single send() call.
    assert.ok(!statusMessages.some((s) => s.includes("[turn ended]")));
    assert.equal(turnRequests.length, 2, "expected the resumed turn to have run within the same send()");
    assert.ok(statusMessages.some((s) => s.includes("resuming automatically")));

    // The checkpoint must be consumed (not left for a later manual resume)
    // once it's been folded back in automatically.
    assert.equal(await readCheckpoint(dir), null, "checkpoint should be consumed after auto-resuming");

    // And the resumed request must actually carry the interrupted call's
    // context forward, same as the manual-resume path above.
    const secondRequest = turnRequests[1];
    assert.ok(secondRequest.messages.some((m) => typeof m.content === "string" && m.content.includes("update_plan")));
  }));

test("AgentLoop does not trigger compaction when usage stays under the threshold throughout", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: "step1", status: "done" }] }) },
    };
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call1]), assistantMessage("all done")],
      tokenCounts: [1],
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });
    await loop.send("do the thing");
    assert.ok(!statusMessages.some((s) => s.includes("compaction")));
    assert.equal(await readCheckpoint(dir), null);
  }));

test("resumeIfCheckpointExists automatically continues the turn (no user input) and clears the checkpoint first", () =>
  withTempProject(async (dir) => {
    await writeCheckpoint(dir, {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      reason: "auto-threshold",
      goal: "Add dark mode",
      steps: [{ description: "Wire up toggle", status: "in_progress" }],
      files: [],
      pendingToolCall: null,
      mustPreserve: [],
    });

    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("continuing the work now")],
      tokenCounts: [1],
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    await loop.resumeIfCheckpointExists();

    // it must have actually driven a turn, not just injected a message and stopped
    assert.equal(turnRequests.length, 1);
    assert.ok(statusMessages.some((s) => s.includes("Add dark mode")));
    // consumed, so a later crash/restart doesn't replay the same resume forever
    assert.equal(await readCheckpoint(dir), null);
  }));

test("resumeIfCheckpointExists is a no-op when there's no checkpoint", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({ turnResponses: [], tokenCounts: [1] });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
    });
    await loop.resumeIfCheckpointExists();
    assert.equal(turnRequests.length, 0);
  }));

// Reproduces the crash seen when running llamacli in a directory with no
// .llamacli/config.yaml: it falls back to a default backend URL nothing is
// listening on, and the resulting ECONNREFUSED must never crash the whole
// CLI — it should surface as a status message and end the turn gracefully.
test("send() does not throw when the backend is unreachable — reports a status message instead", () =>
  withTempProject(async (dir) => {
    const backend: ModelBackend = {
      async chat(): Promise<ChatCompletionResponse> {
        const err: any = new Error(
          "request to http://127.0.0.1:8081/v1/chat/completions failed, reason: connect ECONNREFUSED 127.0.0.1:8081"
        );
        err.code = "ECONNREFUSED";
        throw err;
      },
      async listModels() {
        return [];
      },
    };
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    // must resolve, not reject — this is the whole point of the fix
    await assert.doesNotReject(() => loop.send("hello"));
    assert.ok(statusMessages.some((s) => s.includes("ECONNREFUSED")));
  }));

test("compaction summary failure doesn't crash the loop — reports a status message and keeps the (uncompacted) context", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({ steps: [{ description: "step1", status: "in_progress" }] }),
      },
    };
    let summaryAttempted = false;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          summaryAttempted = true;
          throw new Error("connect ECONNREFUSED (summary request)");
        }
        return {
          choices: [{ message: { role: "assistant", content: null, tool_calls: [call1] }, finish_reason: "tool_calls" }],
        };
      },
      async listModels() {
        return [];
      },
      async tokenize() {
        return 1000; // always over threshold, forces compaction on the very first check
      },
    };
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("hello"));
    assert.ok(summaryAttempted);
    assert.ok(statusMessages.some((s) => s.includes("compaction failed")));
    // the checkpoint must still have been written even though the summary failed
    assert.ok(await readCheckpoint(dir));
  }));

/** Fire-and-forget background work (the real-time improvement check) has
 *  no promise the test can await directly — poll for its effect instead
 *  of a blind sleep, so the test is both fast and not flaky under load. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a repeated real tool failure triggers a real-time improvement-log entry, not just on /improve", () =>
  withTempProject(async (dir) => {
    // getFailureLog() is module-level, shared across every AgentLoop in
    // the process — without clearing it, an unrelated failure another
    // test logged earlier could outrank this test's own pattern and this
    // test would assert on the wrong recurring failure.
    clearFailureLog();
    // Two read_file calls on paths that don't exist — a real fs failure,
    // not a scripted one, so this exercises the actual executeTool() catch
    // path in runUntilIdle() that calls triggerRealtimeImprovementCheck().
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, "missing-a.txt") }) },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, "missing-b.txt") }) },
    };
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call1, call2]), assistantMessage("done")],
      tokenCounts: [1], // never crosses the compaction threshold — isolates this to the improvement check
    });
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    await loop.send("read two files");

    await waitUntil(() => statusMessages.some((s) => s.includes("[auto-improve]")));
    const logPath = join(dir, ".llamacli", "state", "improvement-log.md");
    const content = await readFile(logPath, "utf8");
    assert.match(content, /read_file/);
  }));

test("the real-time improvement check never fires until the turn's own loop has fully finished", () =>
  withTempProject(async (dir) => {
    // Found by analyzing real llama-server logs: this backend has only one
    // inference slot (-np 1), so a background improvement-check call
    // firing WHILE a turn is still in flight races that turn's own next
    // request for the single slot and can delay the user's response.
    clearFailureLog();
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, "missing-a.txt") }) },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, "missing-b.txt") }) },
    };
    const events: string[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        // proposeImprovement()'s request is identifiable by its system prompt.
        if (req.messages.some((m) => typeof m.content === "string" && m.content.includes("draft a short project rule"))) {
          events.push("improvement-check-call");
          return { choices: [{ message: { role: "assistant", content: "# rule\nsomething" }, finish_reason: "stop" } ] };
        }
        turnCallCount++;
        events.push(`turn-call-${turnCallCount}`);
        return turnCallCount === 1 ? assistantMessage(null, [call1, call2]) : assistantMessage("done");
      },
      async listModels() {
        return [];
      },
      async tokenize() {
        return 1; // stays well under threshold; isolates this to the improvement check
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100 },
    });

    await loop.send("read two files");
    await waitUntil(() => events.includes("improvement-check-call"));

    const idxCheck = events.indexOf("improvement-check-call");
    const idxSecondTurnCall = events.indexOf("turn-call-2");
    assert.ok(idxSecondTurnCall !== -1, `expected a second turn call, got: ${events.join(", ")}`);
    assert.ok(
      idxCheck > idxSecondTurnCall,
      `expected the improvement check strictly after the turn finished, got order: ${events.join(", ")}`
    );
  }));

test("every chat request sent to the backend caps max_tokens instead of leaving it unbounded", () =>
  withTempProject(async (dir) => {
    // Found live via the real backend's GET /slots: a request with no
    // max_tokens set (llama-server default -1, unbounded) generated past
    // 22k tokens with no end in sight, pinning the single inference slot.
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 8000 },
    });

    await loop.send("hello");

    assert.equal(turnRequests.length, 1);
    // computeMaxTokens: available = 8000 - 1(used) - 2048(margin) = 5951,
    // ceiling = 8000*0.75 = 6000 -> min(5951, 6000) = 5951.
    assert.equal(turnRequests[0].max_tokens, 5951);
  }));

// Reported live: a request with only 6,400 tokens of real history (9,984
// tokens of genuinely free room in a 16,384-token window) still got capped
// at a flat 25%-of-window 4,096, truncating a write_file tool call's
// arguments — a long generated document — mid-JSON-string. The server's
// grammar-constrained tool-call parser then rejected the resulting
// unterminated string as invalid JSON (500 "missing closing quote"),
// which looked like the whole turn had silently stopped. max_tokens must
// scale with the room actually left, not a flat fraction of the window.
test("max_tokens gives a small conversation real headroom instead of a flat fraction of the window", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [6400], // matches the real incident's conversation size
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await loop.send("hello");

    // available = 16384 - 6400 - 2048(margin) = 7936; ceiling = 16384*0.75
    // = 12288 -> min(7936, 12288) = 7936. The old flat formula would have
    // given 4096 here — nearly double what this fix provides, which is
    // exactly the gap that truncated the real tool call.
    assert.equal(turnRequests[0].max_tokens, 7936);
    assert.ok(turnRequests[0].max_tokens! > 4096, "expected more headroom than the old flat 25% formula would have given");
  }));

// Reported live (a second, distinct incident from the one above): a real
// request's prompt ALONE — per the server's own token count — came in
// ~1,200 tokens larger than what estimateTokens() had told computeMaxTokens()
// the conversation was. With the old 256-token margin, max_tokens (set
// generously, since the underestimate made room look more plentiful than
// it really was) plus the now-underestimated prompt together summed past
// the real context window — the server hard-truncated at exactly 16,384
// tokens (`truncated=1`) independent of max_tokens entirely (the
// generation itself, 2,504 tokens, was genuinely under its own cap).
// Simulates that same estimate-vs-real gap and checks the wider margin
// leaves enough slack to keep prompt+reply under the window.
test("max_tokens leaves enough margin to absorb a real gap between estimateTokens() and the backend's own tokenizer", () =>
  withTempProject(async (dir) => {
    const REAL_PROMPT_TOKENS = 13_880; // what the server actually counted, live
    const ESTIMATE_GAP = 1_200; // how far short estimateTokens() fell of that, live
    const WINDOW = 16_384;
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [REAL_PROMPT_TOKENS - ESTIMATE_GAP], // the client's (under)estimate
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: WINDOW },
    });

    await loop.send("hello");

    const maxTokens = turnRequests[0].max_tokens!;
    // The real-world failure mode: REAL_PROMPT_TOKENS + maxTokens ended up
    // at/over WINDOW. This must leave real slack even against the observed
    // gap, not just barely clear it.
    assert.ok(
      REAL_PROMPT_TOKENS + maxTokens < WINDOW,
      `expected prompt(${REAL_PROMPT_TOKENS}) + max_tokens(${maxTokens}) to stay under the window(${WINDOW}), got ${REAL_PROMPT_TOKENS + maxTokens}`
    );
  }));

test("max_tokens still has a ceiling even when the conversation is nearly empty, so it never becomes effectively unbounded again", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [0],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 65536 },
    });

    await loop.send("hello");

    // available would be ~65280 (nearly the whole window) without a
    // ceiling — clamped to 65536*0.75 = 49152 instead.
    assert.equal(turnRequests[0].max_tokens, 49152);
  }));

test("max_tokens never goes below its floor even when almost no room is left", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [7900], // leaves only ~-156 tokens of "available" room in an 8000 window
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.999, contextWindowTokens: 8000 }, // high enough that compaction doesn't intervene first
    });

    await loop.send("hello");

    assert.equal(turnRequests[0].max_tokens, 512);
  }));

test("an oversized tool result is truncated before it's sent to the backend, not passed through raw", () =>
  withTempProject(async (dir) => {
    // Nothing previously capped a single tool result's size — a large
    // read_file (or noisy shell output) went straight from executeTool()
    // into `this.messages` and from there, uncapped, into the next request
    // body sent to llama.cpp. Write a file well past the cap and assert the
    // "tool" message that actually reaches the backend is bounded.
    const bigPath = join(dir, "big.txt");
    const bigContent = "x".repeat(50_000);
    await writeFile(bigPath, bigContent, "utf8");

    const call = {
      id: "c1",
      type: "function" as const,
      function: { name: "read_file", arguments: JSON.stringify({ path: bigPath }) },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call]), assistantMessage("done")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100 },
    });

    await loop.send("read the big file");

    // The second turn request is the one that includes the tool result from
    // the first call — check what was actually sent, not what executeTool()
    // produced internally.
    const secondRequest = turnRequests[1];
    const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "expected a tool-role message in the follow-up request");
    const sentContent = toolMessage!.content as string;
    assert.ok(sentContent.length < bigContent.length, "the sent tool content should be shorter than the raw file");
    assert.match(sentContent, /truncated/);
  }));

test("a context-overflow error forces compaction and retries instead of just ending the turn", () =>
  withTempProject(async (dir) => {
    // Found live: two consecutive real turns both failed with the backend's
    // own "exceeds the available context size" 400, back to back, because
    // nothing had shrunk the history in between (the estimate said there
    // was still room). Simulate that exact backend error and verify the
    // loop compacts and retries on its own instead of reporting a plain
    // error and leaving the next message to hit the same wall again.
    //
    // No `tokenize()` on this fake backend — deliberately, so estimateTokens
    // falls back to the real char-based estimate against real message
    // content instead of a constant test stub, since the retry logic now
    // depends on compaction *genuinely* shrinking the history (a stub like
    // `async tokenize() { return 1 }` would make every compaction look like
    // zero progress and immediately trip the give-up path below).
    let turnCallCount = 0;
    let compactionCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          // compactor.ts's internal summary request — short, so it
          // actually shrinks the bulky history built up below.
          compactionCallCount++;
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnCallCount++;
        if (turnCallCount <= 10) {
          // Build up real, compactable bulk first — a couple-message test
          // fixture has nothing for compaction to actually shrink, which
          // isn't representative of when this real bug occurs (a long
          // session with real accumulated history). Needs to be enough
          // that even a size-based kept tail (see compactor.ts
          // selectKeptTail) still leaves genuine older content to
          // summarize away, not just re-keep almost everything verbatim.
          return assistantMessage("y".repeat(2000));
        }
        if (turnCallCount === 11) {
          const err: any = new Error(
            'chat stream failed: 400 {"error":{"code":400,"message":"request (65636 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":65636,"n_ctx":65536}}'
          );
          throw err;
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      // Big enough that proactive auto-compaction never kicks in while
      // building up history below (0.99 * 8000 tokens ~= 31,680 chars,
      // comfortably above the ~20,000 chars built up) — the overflow below
      // is injected directly by the fake backend regardless of real size,
      // and the point of this test is what happens on the FORCED
      // compaction once that hits, not the ordinary auto-trigger path. But
      // NOT so big that the forced compaction's own size-based kept-tail
      // budget (40% of the window) just re-keeps the entire built-up
      // history verbatim, which would show zero progress and immediately
      // (and correctly, for that hypothetical) trip the give-up path this
      // test isn't exercising.
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 8_000 },
      onStatus: (s) => statusMessages.push(s),
    });

    for (let i = 0; i < 10; i++) await loop.send(`build up history ${i}`);
    await assert.doesNotReject(() => loop.send("do something"));

    assert.equal(turnCallCount, 12, "expected exactly one retry after the overflow, not zero or a loop");
    assert.equal(compactionCallCount, 1, "expected exactly one forced compaction");
    assert.ok(statusMessages.some((s) => s.includes("context overflow")));
    // Must not also report this as a generic unrecovered error once the retry succeeded.
    assert.ok(!statusMessages.some((s) => s.includes("[error] couldn't reach the model backend")));
  }));

test("a context-overflow error that persists even after tightening the kept-context budget down to the floor is reported, not retried forever", () =>
  withTempProject(async (dir) => {
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const overflowError = () => {
      const err: any = new Error(
        'chat stream failed: 400 {"error":{"code":400,"message":"request (99999 tokens) exceeds the available context size (65536 tokens)","type":"exceed_context_size_error"}}'
      );
      return err;
    };
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          // Always returns the exact same short summary regardless of
          // which tail budget was requested — a genuinely unrecoverable
          // case (nothing shrinks no matter how tightly the tail is
          // squeezed) — so the loop should tighten a bounded number of
          // times (see MIN_TAIL_BUDGET_FRACTION) and then give up, rather
          // than retrying forever.
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnCallCount++;
        throw overflowError();
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("do something"));

    // Tightens 0.4 -> 0.2 -> 0.1 -> 0.05 (floor) before giving up: the
    // initial chat() call plus one retry per tightening step. Asserted as
    // a bounded range, not an exact count — the precise number shifts
    // with TOOL_DEFS_JSON's size (adding/removing a tool changes every
    // estimateTokens() call's output against this test's tiny 100-token
    // window), which isn't what this test is actually about; what matters
    // is that it retries more than once and still eventually stops.
    assert.ok(
      turnCallCount > 1 && turnCallCount <= 9, // 1 initial call + loop.ts's own MAX_OVERFLOW_RETRIES(8) hard cap
      `expected the loop to retry across each tail-budget tightening step, then stop — not once, not forever. Got ${turnCallCount} calls.`
    );
    assert.ok(statusMessages.some((s) => s.includes("smaller kept-context budget")));
    assert.ok(statusMessages.some((s) => s.includes("[error]")));
  }));

test("a compaction that stops helping at the default tail budget still recovers by retrying with a smaller one", () =>
  withTempProject(async (dir) => {
    // Reported live: a real session hit "no longer fits even after
    // compaction" after just ONE non-improving pass at the default 40%
    // tail budget, on a window where the tail + the next reply's own
    // max_tokens reservation + the system prompt + tool schema together
    // left no real room — even though a SMALLER tail alone would have been
    // enough to fit. This is the success path for that exact scenario: the
    // summary itself shrinks with each retry (simulating a smaller kept
    // tail genuinely producing a smaller request each time), so the turn
    // should recover instead of giving up.
    let turnCallCount = 0;
    let compactionCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          compactionCallCount++;
          // Shrinks each time — simulates a tighter tail budget genuinely
          // reducing what's kept, unlike the "stuck forever" test above.
          return {
            choices: [
              { message: { role: "assistant", content: "s".repeat(Math.max(1, 50 - compactionCallCount * 10)) }, finish_reason: "stop" },
            ],
          };
        }
        turnCallCount++;
        if (turnCallCount <= 3) {
          const err: any = new Error(
            'chat stream failed: 400 {"error":{"code":400,"message":"request (99999 tokens) exceeds the available context size (65536 tokens)","type":"exceed_context_size_error"}}'
          );
          throw err;
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 8_000 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("do something"));

    assert.ok(statusMessages.some((s) => s.includes("smaller kept-context budget")));
    // Recovered — must not have reported the "no longer fits" give-up message.
    assert.ok(!statusMessages.some((s) => s.includes("no longer fits the context window")));
  }));

test("update_plan persists a checkpoint immediately, independent of compaction, so a hard kill mid-task doesn't lose it", () =>
  withTempProject(async (dir) => {
    // Requested directly: before this, a checkpoint only ever got written
    // when a compaction happened — a process killed mid-task (Ctrl-C at
    // the OS level, a crash) with no compaction yet lost the whole plan
    // with nothing to resume from. autoTriggerRatio here is 0.99 with a
    // huge window, so compaction never triggers in this test at all —
    // proving the checkpoint comes purely from update_plan itself.
    //
    // Checked mid-turn (from inside the backend's own second call, before
    // the turn's own final response), not just after send() resolves —
    // that's exactly the "killed mid-task" moment the fix is for, and
    // it's the only way to observe it without racing a real process kill.
    // An array, not a reassigned `let` — TS's flow analysis for a plain
    // `let` mutated only inside an async closure still treats it as its
    // literal initial value at any point in the enclosing function it
    // can't prove runs after that mutation, which narrows the later
    // assert.ok(...) check down to `never` and fails to typecheck.
    const checkpointsDuringTurn: Checkpoint[] = [];
    const call = {
      id: "c1",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({
          steps: [
            { description: "step one", status: "done" },
            { description: "step two", status: "in_progress" },
          ],
        }),
      },
    };
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        if (turnCallCount === 1) return assistantMessage(null, [call]);
        const cp = await readCheckpoint(dir);
        if (cp) checkpointsDuringTurn.push(cp);
        return assistantMessage("still working on step two");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
    });

    await loop.send("start the task");

    assert.equal(checkpointsDuringTurn.length, 1, "expected a checkpoint to already exist mid-turn, before the turn even finished");
    assert.equal(checkpointsDuringTurn[0].reason, "plan-progress");
    assert.equal(checkpointsDuringTurn[0].steps.length, 2);
  }));

test("a plan left incomplete at the end of a turn stays on disk for the next process to resume", () =>
  withTempProject(async (dir) => {
    const call = {
      id: "c1",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({
          steps: [
            { description: "step one", status: "done" },
            { description: "step two", status: "todo" },
          ],
        }),
      },
    };
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call]), assistantMessage("I'll continue this next time")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
    });

    await loop.send("start the task");
    const checkpoint = await readCheckpoint(dir);
    assert.ok(checkpoint, "expected the checkpoint to survive since step two is still incomplete");
    assert.equal(checkpoint!.reason, "plan-progress");
    assert.equal(checkpoint!.steps.length, 2);
    assert.equal(
      checkpoint!.steps.find((s) => s.description === "step two")?.status,
      "todo"
    );
  }));

test("onPlanProgress reports done/total as the plan updates, and (0, 0) once everything is done", () =>
  withTempProject(async (dir) => {
    const call1 = {
      id: "c1",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({
          steps: [
            { description: "step one", status: "in_progress" },
            { description: "step two", status: "todo" },
          ],
        }),
      },
    };
    const call2 = {
      id: "c2",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({
          steps: [
            { description: "step one", status: "done" },
            { description: "step two", status: "done" },
          ],
        }),
      },
    };
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call1]), assistantMessage(null, [call2]), assistantMessage("all done")],
      tokenCounts: [1],
    });
    const progressEvents: Array<{ done: number; total: number }> = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
      onPlanProgress: (done, total) => progressEvents.push({ done, total }),
    });

    await loop.send("do the multi-step task");

    assert.deepEqual(progressEvents, [
      { done: 0, total: 2 }, // after call1
      { done: 2, total: 2 }, // after call2
      { done: 0, total: 0 }, // turn ended with everything done — indicator cleared
    ]);
  }));

test("a plan-progress checkpoint (no compaction involved) resumes with its own wording, not \"after compaction\"", () =>
  withTempProject(async (dir) => {
    // Write directly, simulating a process that got killed right after an
    // update_plan call with real remaining work — this is the checkpoint
    // shape applyStateTool() now produces.
    await writeCheckpoint(dir, {
      version: 1,
      timestamp: new Date().toISOString(),
      reason: "plan-progress",
      goal: "refactor the auth module",
      steps: [
        { description: "extract helper", status: "done" },
        { description: "update call sites", status: "todo" },
      ],
      files: [],
      pendingToolCall: null,
      mustPreserve: [],
    });

    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage("continuing")],
      tokenCounts: [1],
    });
    const statusMessages: string[] = [];
    const progressEvents: Array<{ done: number; total: number }> = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
      onStatus: (s) => statusMessages.push(s),
      onPlanProgress: (done, total) => progressEvents.push({ done, total }),
    });

    await loop.resumeIfCheckpointExists();

    assert.ok(statusMessages.some((s) => s.includes("resuming previous session")));
    assert.ok(!statusMessages.some((s) => s.includes("resuming after compaction")));
    assert.ok(progressEvents.some((e) => e.done === 1 && e.total === 2), `expected a (1, 2) progress event, got: ${JSON.stringify(progressEvents)}`);
  }));

test("the circuit breaker's 30-minute hard timeout resets each turn, instead of permanently tripping once a session has been open that long", () =>
  withTempProject(async (dir) => {
    // Caught live: a real session open longer than 30 minutes (completely
    // normal) hit "[stopped] self-healing circuit breaker tripped: hard
    // timeout exceeded" on its very next tool call — the breaker is
    // created once per AgentLoop (once per process) and, before this fix,
    // was never reset, so its timer measured time since PROCESS STARTUP
    // rather than since the current task began. Without a reset, every
    // subsequent tool call for the rest of the process's life would trip
    // the same way, permanently breaking the session.
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"] });
    try {
      const call = {
        id: "c1",
        type: "function" as const,
        function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, "missing.txt") }) },
      };
      // Each turn needs TWO scripted responses: the tool_calls message
      // (where shouldStop() is actually checked, per call, before it
      // runs) and a follow-up plain response that ends the turn — an
      // earlier version of this test only scripted one response per
      // "turn", so the second send() failed for an unrelated reason
      // (scripted responses exhausted) before ever reaching a second
      // shouldStop() check, and the test passed even with the underlying
      // bug still present. turnRequests.length is asserted at the end to
      // guard against that exact class of silently-vacuous test again.
      const { backend, turnRequests } = scriptedBackend({
        turnResponses: [assistantMessage(null, [call]), assistantMessage("turn 1 done"), assistantMessage(null, [call]), assistantMessage("turn 2 done")],
        tokenCounts: [1],
      });
      const statusMessages: string[] = [];
      const loop = new AgentLoop({
        projectRoot: dir,
        model: "m",
        backend,
        systemPrompt: "sys",
        thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
        onStatus: (s) => statusMessages.push(s),
      });

      await loop.send("do something");
      assert.ok(
        !statusMessages.some((s) => s.includes("circuit breaker tripped")),
        "should not trip on the very first turn"
      );

      mock.timers.tick(31 * 60_000); // simulate the session staying open 31 minutes
      statusMessages.length = 0;
      await loop.send("do something else");

      assert.ok(
        !statusMessages.some((s) => s.includes("circuit breaker tripped")),
        `a new turn must reset the hard-timeout clock, not inherit process-startup time: ${statusMessages.join(" | ")}`
      );
      assert.equal(turnRequests.length, 4, "expected both turns to run their full two-call script, not fail early for an unrelated reason");
    } finally {
      mock.timers.reset();
    }
  }));

// Requested directly: quitting should save current progress to disk
// immediately, the same way compaction already does before/after
// summarizing, so the next launch can resume — not just when a plan was
// explicitly declared (the existing plan-progress checkpoint only covers
// that case), but for any real conversation at all.
test("saveStateOnQuit() runs a real compaction (writes a checkpoint, gets a model summary) when there's real conversation", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage("here's what I found")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
    });

    await loop.send("investigate the bug"); // real conversation now exists
    await loop.saveStateOnQuit();

    const checkpoint = await readCheckpoint(dir);
    assert.ok(checkpoint, "expected a checkpoint to have been written on quit");
    assert.equal(checkpoint!.reason, "manual");
    // turnRequests only counts calls WITH tools (the main loop) — the
    // compaction summary request itself omits tools, so a second entry
    // here would mean saveStateOnQuit() incorrectly started a whole new
    // agent turn instead of just compacting the existing one.
    assert.equal(turnRequests.length, 1);
  }));

test("saveStateOnQuit() is a no-op when there's nothing but the initial system prompt", () =>
  withTempProject(async (dir) => {
    const { backend } = scriptedBackend({ turnResponses: [], tokenCounts: [1] });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 100_000 },
    });

    // Never sent anything — should not throw, and should not call the
    // backend at all (no scripted responses exist, so it would throw if
    // it tried).
    await assert.doesNotReject(() => loop.saveStateOnQuit());
    assert.equal(await readCheckpoint(dir), null, "expected no checkpoint for an empty conversation");
  }));

// Requested directly: the "[compaction complete] ..." log line got pushed
// out of view by later scrolling activity before it was ever actually
// noticed — onCompactionStatus exists so the UI can show a persistent
// indicator (the status bar) instead of relying on the scrolling log.
test("onCompactionStatus fires running then complete for a successful compaction, with a real ISO timestamp", () =>
  withTempProject(async (dir) => {
    const { backend } = scriptedBackend({
      turnResponses: [assistantMessage("done")],
      tokenCounts: [1000], // over threshold immediately
    });
    const events: Array<{ status: string; timestamp: string }> = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onCompactionStatus: (status, timestamp) => events.push({ status, timestamp }),
    });

    await loop.send("do something");

    assert.equal(events.length, 2);
    assert.equal(events[0].status, "running");
    assert.equal(events[1].status, "complete");
    for (const e of events) assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }));

test("onCompactionStatus fires running then failed when the compaction summary request itself fails", () =>
  withTempProject(async (dir) => {
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) throw new Error("summary request failed");
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
      async tokenize() {
        return 1000; // over threshold immediately
      },
    };
    const events: Array<{ status: string }> = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onCompactionStatus: (status) => events.push({ status }),
    });

    await loop.send("do something");

    assert.deepEqual(
      events.map((e) => e.status),
      ["running", "failed"]
    );
  }));

// cancelCurrentTurn() backs the TUI's Esc → Y ("cancel and save for later")
// flow. Two things must both be true: the turn ends cleanly (not surfaced
// as a failure/error status) once the backend's chat() call is aborted, and
// a checkpoint is written that a later resumeIfCheckpointExists() can pick
// back up — the same mechanism a mid-batch compaction interruption already
// uses (see the "captures pendingToolCall when compaction fires mid-batch"
// test above), reused here rather than inventing a second resume path.
test("cancelCurrentTurn() ends the turn cleanly and writes a resumable checkpoint, instead of surfacing a failure", () =>
  withTempProject(async (dir) => {
    let cancelled = false;
    let rejectChat: ((err: Error) => void) | null = null;
    const backend: ModelBackend = {
      async chat(): Promise<ChatCompletionResponse> {
        // Mirrors the real OpenAICompatibleClient: chat() hangs until
        // cancel() is called, then rejects — it never resolves on its own
        // in this test, so reaching a clean end-of-turn can only happen
        // via the cancellation path being exercised, not by coincidence.
        return new Promise((_resolve, reject) => {
          rejectChat = reject;
        });
      },
      async listModels() {
        return [];
      },
      async tokenize() {
        return 1;
      },
      cancel() {
        cancelled = true;
        rejectChat?.(new Error("cancelled by user"));
      },
    };
    const statusMessages: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
      onStatus: (s) => statusMessages.push(s),
    });

    const sendPromise = loop.send("do the thing");
    // Let send() actually reach the in-flight chat() call before cancelling.
    await new Promise((r) => setTimeout(r, 10));
    await loop.cancelCurrentTurn();

    // Must resolve cleanly — cancellation is not a thrown/unhandled error.
    await sendPromise;

    assert.ok(cancelled, "expected backend.cancel() to have been called");
    assert.ok(
      statusMessages.some((s) => s.includes("[cancelled]")),
      `expected a [cancelled] status message, got: ${JSON.stringify(statusMessages)}`
    );

    const checkpoint = await readCheckpoint(dir);
    assert.ok(checkpoint, "expected a checkpoint to have been written");
    assert.equal(checkpoint!.goal, "do the thing");
  }));

test("cancelCurrentTurn() is safe to call when no turn is currently running (no-op past the checkpoint write)", () =>
  withTempProject(async (dir) => {
    const { backend } = scriptedBackend({ turnResponses: [], tokenCounts: [1] });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100 },
    });
    await assert.doesNotReject(() => loop.cancelCurrentTurn());
  }));

// Reported live twice: a tool call generating a long document/source file
// (a write_file call) got cut off by max_tokens mid-JSON-string — NOT a
// context overflow (llama-server's own `truncated` flag was 0 both
// times) — and the server rejected the resulting unterminated string with
// a 500 "Failed to parse tool call arguments as JSON". This is
// recoverable: nothing about the conversation is too large, the single
// upcoming reply just needs to be shorter/split up.
test("a tool call truncated by max_tokens (not a context overflow) is recovered by nudging the model to split content, not surfaced as a dead end", () =>
  withTempProject(async (dir) => {
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnCallCount++;
        if (turnCallCount === 1) {
          const err: any = new Error(
            'chat stream error: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 3828: syntax error while parsing value - invalid string: missing closing quote'
          );
          throw err;
        }
        return assistantMessage("done, wrote a shorter file this time");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    assert.equal(turnCallCount, 2, "expected exactly one retry after the truncated tool call, not zero or a loop");
    assert.ok(
      statusMessages.some((s) => s.includes("[tool call truncated]")),
      `expected a [tool call truncated] status, got: ${JSON.stringify(statusMessages)}`
    );
    assert.ok(!statusMessages.some((s) => s.includes("[error]")), "must not also report this as a dead-end error once recovered");
  }));

test("a tool call that keeps getting truncated even after being told to split it up eventually surfaces as a real failure, not an infinite retry", () =>
  withTempProject(async (dir) => {
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const truncationError = () => {
      const err: any = new Error(
        'chat stream error: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] missing closing quote'
      );
      return err;
    };
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnCallCount++;
        throw truncationError();
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    // 1 initial call + MAX_TOOL_CALL_TRUNCATION_RETRIES(5) retries = 6, then gives up.
    assert.equal(turnCallCount, 6, `expected a bounded number of retries, not an infinite loop, got ${turnCallCount} calls`);
    assert.ok(statusMessages.some((s) => s.includes("[error]")), "expected a final [error] status once retries are exhausted");
    // The exact same error message every time means every retry after the
    // first is a "repeat" — the shrink-and-force-smaller path, not the
    // plain first-attempt nudge.
    assert.ok(
      statusMessages.some((s) => s.includes("exact same cutoff")),
      `expected the repeat-detection status to fire, got: ${JSON.stringify(statusMessages)}`
    );
  }));

// Reported live: the text nudge alone was NOT enough — a real retry
// regenerated the EXACT same content (byte-identical, per the server's own
// error text embedding it) and got cut off at the exact same character
// column, twice in a row, because computeMaxTokens() gave the identical
// max_tokens both times and the model simply ignored the chunking
// instruction. The fix: detect a verbatim-repeated error and force
// max_tokens smaller for the retry regardless of what the model does —
// a real server-enforced cap it cannot ignore, unlike a prompt
// instruction. These tests exercise that mechanism directly.
test("a verbatim-repeated tool-call-truncation error halves max_tokens for the retry, not just the prompt text", () =>
  withTempProject(async (dir) => {
    const SAME_ERROR =
      'chat stream error: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 3420: syntax error while parsing value - invalid string: missing closing quote';
    let turnCallCount = 0;
    const turnRequests: ChatCompletionRequest[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnRequests.push(req);
        turnCallCount++;
        if (turnCallCount <= 2) {
          const err: any = new Error(SAME_ERROR); // identical both times — a repeat
          throw err;
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    assert.equal(turnCallCount, 3);
    const [firstAttempt, secondAttempt, thirdAttempt] = turnRequests;
    // First attempt: normal computeMaxTokens(), no shrink applied yet.
    // Second attempt: the FIRST error hadn't repeated anything yet either
    // (nothing to compare against), so it's also unshrunk...
    assert.equal(firstAttempt.max_tokens, secondAttempt.max_tokens, "the first failure has nothing to repeat yet — no shrink on the 2nd attempt");
    // ...but the second attempt's error is IDENTICAL to the first, so the
    // THIRD attempt (after that repeat is detected) must be forced smaller.
    assert.ok(
      thirdAttempt.max_tokens! < secondAttempt.max_tokens!,
      `expected max_tokens to shrink after a verbatim-repeated failure: 2nd=${secondAttempt.max_tokens}, 3rd=${thirdAttempt.max_tokens}`
    );
    assert.equal(thirdAttempt.max_tokens, Math.floor(secondAttempt.max_tokens! * 0.5), "expected exactly a 50% shrink on the first repeat");
  }));

test("the shrink factor keeps halving on further consecutive repeats, down to a floor, instead of shrinking only once", () =>
  withTempProject(async (dir) => {
    const SAME_ERROR = 'chat stream error: Failed to parse tool call arguments as JSON: missing closing quote';
    const turnRequests: ChatCompletionRequest[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnRequests.push(req);
        turnCallCount++;
        throw new Error(SAME_ERROR); // always identical — every retry after the first is a repeat
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    // Shrink factor sequence applied to each attempt: 1 (1st, nothing to
    // repeat yet), 1 (2nd, still nothing — the 1st error becomes the
    // baseline), 0.5, 0.25, 0.125, 0.125 (floor — MIN is 0.125, does not
    // go to 0.0625). max_tokens is monotonically non-increasing and never
    // drops below the 512 floor.
    const maxTokensSequence = turnRequests.map((r) => r.max_tokens);
    for (let i = 1; i < maxTokensSequence.length; i++) {
      assert.ok(
        maxTokensSequence[i]! <= maxTokensSequence[i - 1]!,
        `expected a non-increasing max_tokens sequence, got: ${JSON.stringify(maxTokensSequence)}`
      );
      assert.ok(maxTokensSequence[i]! >= 512, `max_tokens must never drop below its 512 floor, got: ${JSON.stringify(maxTokensSequence)}`);
    }
    // With MIN_TOOL_CALL_MAX_TOKENS_SHRINK_FACTOR = 0.125, it must stop
    // shrinking (plateau) before reaching the end of the bounded retries —
    // confirms there IS a floor, not an unbounded halve-forever.
    const last = maxTokensSequence[maxTokensSequence.length - 1]!;
    const secondToLast = maxTokensSequence[maxTokensSequence.length - 2]!;
    assert.equal(last, secondToLast, "expected the shrink factor to have already hit its floor and plateaued by the last retry");
  }));

test("a tool-call-truncation error that's DIFFERENT from the previous one resets the shrink factor, instead of compounding an unrelated failure", () =>
  withTempProject(async (dir) => {
    const turnRequests: ChatCompletionRequest[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnRequests.push(req);
        turnCallCount++;
        if (turnCallCount <= 2) {
          // Same message twice — a genuine repeat, forces a shrink for the 3rd attempt.
          throw new Error('chat stream error: Failed to parse tool call arguments as JSON: column 100 missing closing quote');
        }
        if (turnCallCount === 3) {
          // A DIFFERENT failure this time (different column/content) — the
          // model DID produce something different, even though it still
          // failed. This should not be punished as if it ignored guidance.
          throw new Error('chat stream error: Failed to parse tool call arguments as JSON: column 42 missing closing quote');
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    assert.equal(turnCallCount, 4);
    const [, secondAttempt, thirdAttempt, fourthAttempt] = turnRequests;
    // 3rd attempt (after the genuine repeat of the 1st/2nd) is shrunk.
    assert.ok(thirdAttempt.max_tokens! < secondAttempt.max_tokens!, "expected a shrink after the genuine repeat");
    // 4th attempt (after a DIFFERENT failure than the 3rd) resets back to
    // the full, un-shrunk computeMaxTokens() value — same as the 1st/2nd.
    assert.equal(fourthAttempt.max_tokens, secondAttempt.max_tokens, "expected the shrink factor to reset once the failure stopped repeating verbatim");
  }));

test("the tool-call-truncation shrink factor does not leak across separate send() turns", () =>
  withTempProject(async (dir) => {
    const SAME_ERROR = 'chat stream error: Failed to parse tool call arguments as JSON: missing closing quote';
    const turnRequests: ChatCompletionRequest[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) {
          return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        }
        turnRequests.push(req);
        turnCallCount++;
        // First turn: fail twice (a genuine repeat, forces a shrink), then succeed.
        // Second turn: succeed immediately — its first request must NOT
        // still carry the shrink forced by the first turn's failures.
        if (turnCallCount <= 2) throw new Error(SAME_ERROR);
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file")); // turn 1: fails, fails, recovers (shrunk on the 3rd attempt)
    await assert.doesNotReject(() => loop.send("write another file")); // turn 2: a fresh send() call

    assert.equal(turnCallCount, 4);
    const [firstTurnAttempt1, , firstTurnAttempt3, secondTurnAttempt1] = turnRequests;
    assert.ok(
      firstTurnAttempt3.max_tokens! < firstTurnAttempt1.max_tokens!,
      "sanity check: the first turn's 3rd attempt should indeed have been shrunk"
    );
    assert.equal(
      secondTurnAttempt1.max_tokens,
      firstTurnAttempt1.max_tokens,
      "expected the second turn to start fresh at the full budget, not inherit the first turn's shrink"
    );
  }));

// Requested directly: don't just discard a truncated write_file call and
// ask the model to regenerate everything from memory — recover whatever
// prefix DID stream successfully (openaiClient.ts attaches it to the
// thrown error as `partialToolCalls`) and save it to the REAL file, then
// only ask the model for the remainder. These integration tests drive
// AgentLoop end to end with a fake backend that attaches partialToolCalls
// the same way the real client does, and check the actual file on disk —
// not just status text — since that's the thing that must never be lost.
function truncatedToolCallError(message: string, toolName: string, argsJson: string): Error {
  const err: any = new Error(message);
  err.partialToolCalls = [{ id: "c1", name: toolName, arguments: argsJson }];
  return err;
}

test("a truncated write_file call is salvaged: the generated prefix is saved to the real file, not discarded", () =>
  withTempProject(async (dir) => {
    const targetPath = join(dir, "salvaged.txt");
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        if (turnCallCount === 1) {
          throw truncatedToolCallError(
            "chat stream error: Failed to parse tool call arguments as JSON: missing closing quote",
            "write_file",
            JSON.stringify({ path: targetPath, content: "first half of the file " }).slice(0, -2) // cut before the closing quote+brace
          );
        }
        return assistantMessage("done, continuing with append_file next turn conceptually");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    const onDisk = await readFile(targetPath, "utf8");
    assert.equal(onDisk, "first half of the file ", "expected the salvaged prefix to actually be written to disk, not discarded");
    assert.ok(
      statusMessages.some((s) => s.includes("recovered and saved")),
      `expected a salvage status message, got: ${JSON.stringify(statusMessages)}`
    );
    assert.ok(
      statusMessages.some((s) => s.includes(`${"first half of the file ".length}`)),
      "expected the status message to report the actual salvaged character count"
    );
  }));

test("a second truncation on the SAME path appends to what was already salvaged, instead of overwriting it", () =>
  withTempProject(async (dir) => {
    const targetPath = join(dir, "multi-salvage.txt");
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        if (turnCallCount === 1) {
          throw truncatedToolCallError(
            "chat stream error: Failed to parse tool call arguments as JSON: cut 1",
            "write_file",
            JSON.stringify({ path: targetPath, content: "AAA-" }).slice(0, -2)
          );
        }
        if (turnCallCount === 2) {
          // The model followed instructions this time and used append_file
          // with only the remainder — but that ALSO gets cut off.
          throw truncatedToolCallError(
            "chat stream error: Failed to parse tool call arguments as JSON: cut 2",
            "append_file",
            JSON.stringify({ path: targetPath, content: "BBB-" }).slice(0, -2)
          );
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    const onDisk = await readFile(targetPath, "utf8");
    assert.equal(onDisk, "AAA-BBB-", `expected both salvaged chunks concatenated in order, got: ${JSON.stringify(onDisk)}`);
  }));

test("salvage recovery's nudge tells the model to use append_file for the specific path and not repeat already-saved content", () =>
  withTempProject(async (dir) => {
    const targetPath = join(dir, "instructed.txt");
    let turnCallCount = 0;
    const sentMessages: ChatMessage[][] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        sentMessages.push([...req.messages]); // snapshot — `this.messages` is mutated in place on later turns
        if (turnCallCount === 1) {
          throw truncatedToolCallError(
            "chat stream error: Failed to parse tool call arguments as JSON: cut",
            "write_file",
            JSON.stringify({ path: targetPath, content: "partial data" }).slice(0, -2)
          );
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    const secondRequestMessages = sentMessages[1];
    const nudge = secondRequestMessages[secondRequestMessages.length - 1];
    assert.equal(nudge.role, "user");
    assert.match(nudge.content as string, /append_file/);
    assert.match(nudge.content as string, /do not (repeat|use write_file)/i);
    assert.match(nudge.content as string, new RegExp(targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }));

test("falls back to the shrink-and-nudge strategy when the truncated call isn't a salvageable file write (e.g. no recognizable path/content fields)", () =>
  withTempProject(async (dir) => {
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        if (turnCallCount === 1) {
          // A run_shell call, not a file write — nothing to salvage.
          throw truncatedToolCallError(
            "chat stream error: Failed to parse tool call arguments as JSON: cut",
            "run_shell",
            '{"command":"echo something really lo'
          );
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("run a command"));

    assert.equal(turnCallCount, 2, "expected the normal (non-salvage) retry to still happen");
    assert.ok(!statusMessages.some((s) => s.includes("recovered and saved")), "must not claim a salvage that didn't happen");
    assert.ok(
      statusMessages.some((s) => s.includes("[tool call truncated]") && !s.includes("recovered and saved")),
      `expected the ordinary fallback status, got: ${JSON.stringify(statusMessages)}`
    );
  }));

test("falls back to the shrink-and-nudge strategy when there is no partialToolCalls data at all (e.g. a non-openaiClient backend)", () =>
  withTempProject(async (dir) => {
    let turnCallCount = 0;
    const statusMessages: string[] = [];
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        turnCallCount++;
        if (turnCallCount === 1) {
          // No partialToolCalls attached at all.
          const err: any = new Error("chat stream error: Failed to parse tool call arguments as JSON: cut");
          throw err;
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      onStatus: (s) => statusMessages.push(s),
    });

    await assert.doesNotReject(() => loop.send("write a large file"));

    assert.equal(turnCallCount, 2);
    assert.ok(!statusMessages.some((s) => s.includes("recovered and saved")));
  }));

// THE root cause behind a long run of "the model never finished writing
// the file" failures, found by probing the real backend directly instead
// of guessing — same 420-token budget, same prompt:
//     thinking ON  -> 420 reasoning_content deltas, 0 tool_calls deltas
//     thinking OFF ->   0 reasoning_content deltas, 362 tool_calls deltas
// With it on, the whole budget went to invisible chain-of-thought before
// the tool call even began: nothing got written, the salvage path had no
// tool-call deltas to recover, and the UI rendered nothing the entire
// time (it only draws `content` deltas) — which is what the repeated
// "it looks stuck" reports actually were.
test("chain-of-thought is disabled by default so the token budget goes to the actual work, not invisible reasoning", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({ turnResponses: [assistantMessage("done")], tokenCounts: [10] });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await loop.send("hi");

    assert.deepEqual(
      turnRequests[0].chat_template_kwargs,
      { enable_thinking: false },
      "expected thinking to be disabled by default on every turn request"
    );
  }));

test("enableThinking: true opts back in, sending no disable flag at all", () =>
  withTempProject(async (dir) => {
    const { backend, turnRequests } = scriptedBackend({ turnResponses: [assistantMessage("done")], tokenCounts: [10] });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
      enableThinking: true,
    });

    await loop.send("hi");

    assert.equal(turnRequests[0].chat_template_kwargs, undefined, "expected no thinking override when explicitly opted in");
  }));

// Measured on a real session: three generated source files sat in the
// conversation as ~8,000 tokens of write_file tool-call ARGUMENTS — 49%
// of a 16,384-token window — on top of those files already existing on
// disk. Tool RESULTS were capped (capToolResult); arguments never were,
// and compaction's kept tail preserves recent messages verbatim, so this
// is what "compaction barely shrinks anything" actually was.
test("a completed write_file's content is dropped from the conversation, since the file itself is now the source of truth", () =>
  withTempProject(async (dir) => {
    const bigContent = "X".repeat(5000);
    const target = join(dir, "big.txt");
    const sentRequests: ChatCompletionRequest[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        sentRequests.push(JSON.parse(JSON.stringify(req))); // deep snapshot
        turnCallCount++;
        if (turnCallCount === 1) {
          return assistantMessage(null, [
            { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: target, content: bigContent }) } },
          ]);
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await loop.send("write a big file");

    // The file really was written in full — eliding must never cost data.
    assert.equal(await readFile(target, "utf8"), bigContent);

    // ...but the SECOND request must no longer carry those 5,000 chars.
    const followUp = JSON.stringify(sentRequests[1].messages);
    assert.ok(!followUp.includes(bigContent), "the written content must not still be sitting in the conversation");
    assert.match(followUp, /characters written to disk/);
    assert.ok(followUp.includes(target), "the path must be kept — the conversation should still read as 'I wrote this file'");
  }));

test("a FAILED write_file keeps its content in the conversation (it's the only copy left)", () =>
  withTempProject(async (dir) => {
    const content = "Y".repeat(3000);
    const sentRequests: ChatCompletionRequest[] = [];
    let turnCallCount = 0;
    const backend: ModelBackend = {
      async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
        if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
        sentRequests.push(JSON.parse(JSON.stringify(req)));
        turnCallCount++;
        if (turnCallCount === 1) {
          return assistantMessage(null, [
            // A path that can't be written (a directory component that is a file)
            { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "/proc/version/nope.txt", content }) } },
          ]);
        }
        return assistantMessage("done");
      },
      async listModels() {
        return [];
      },
    };
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.99, contextWindowTokens: 16384 },
    });

    await loop.send("write a file that fails");

    assert.ok(
      JSON.stringify(sentRequests[1].messages).includes(content),
      "a failed write's content must be preserved — nothing else has it"
    );
  }));

test("the checkpoint goal stays the user's real goal across repeated compactions, instead of nesting the previous resume message", () =>
  withTempProject(async (dir) => {
    const plan = (id: string, d: string) => ({
      id,
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: d, status: "in_progress" }] }) },
    });
    const { backend } = scriptedBackend({
      turnResponses: [
        assistantMessage(null, [plan("c1", "s1"), plan("c2", "s2")]), // compaction fires before c2
        assistantMessage(null, [plan("c3", "s3"), plan("c4", "s4")]), // and again before c4
        assistantMessage("done"),
      ],
      // top, c1, c2(HIGH), budget, top, c3, c4(HIGH), budget, top
      tokenCounts: [1, 1, 1000, 1, 1, 1, 1000, 1, 1],
    });
    const statuses: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.5, contextWindowTokens: 100 },
      onStatus: (s) => statuses.push(s),
    });

    await loop.send("do the thing");

    const resumes = statuses.filter((s) => s.includes("previous goal:"));
    assert.equal(resumes.length, 2, `expected two resumes, got: ${JSON.stringify(statuses)}`);
    for (const r of resumes) {
      assert.equal(r.match(/previous goal:/g)!.length, 1, `nested resume text: ${r}`);
      assert.match(r, /previous goal: do the thing/);
    }
  }));

test("summarizeErrorForDisplay caps a raw backend error dump instead of showing it in full", () => {
  const short = "connection refused";
  assert.equal(summarizeErrorForDisplay(short), short);

  const huge = "chat failed: 500 " + JSON.stringify({ error: { code: 500, message: "x".repeat(5000), type: "server_error" } });
  const shown = summarizeErrorForDisplay(huge);
  assert.ok(shown.length < 400, `expected a capped message, got ${shown.length} chars`);
  assert.match(shown, /more characters truncated/);
});

test("a raw multi-KB backend error (e.g. a truncated write_file dump) never reaches onStatus in full, after retries are exhausted", () =>
  withTempProject(async (dir) => {
    // Simulates the real production shape: every retry attempt throws the
    // exact same "Failed to parse tool call arguments as JSON" error whose
    // message embeds several KB of the model's own generated content (the
    // server's "last read: ..." diagnostic) — reproduced live with a
    // truncated write_file call on a multi-KB test file. Once
    // MAX_TOOL_CALL_TRUNCATION_RETRIES is exhausted, this used to fall
    // through to a generic status line that dumped the raw error verbatim.
    const hugeMessage = "chat stream error: Failed to parse tool call arguments as JSON: " + "x".repeat(6000);
    const backend: ModelBackend = {
      async chat() {
        const err: any = new Error(hugeMessage);
        throw err;
      },
      async listModels() {
        return ["fake-model"];
      },
      async tokenize() {
        return 1;
      },
    };
    const statuses: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100000 },
      onStatus: (s) => statuses.push(s),
    });

    await loop.send("write a big file");

    const longest = Math.max(...statuses.map((s) => s.length));
    assert.ok(longest < 500, `expected every status line capped, longest was ${longest} chars: ${statuses.find((s) => s.length === longest)?.slice(0, 80)}`);
    assert.ok(statuses.some((s) => s.includes("more characters truncated")), `expected a truncation marker among: ${JSON.stringify(statuses)}`);
  }));

test("a failing tool's error output is capped like a successful result, not pushed into the history in full", () =>
  withTempProject(async (dir) => {
    // run_shell reports a non-zero exit by throwing with the full output.
    const call = {
      id: "c1",
      type: "function" as const,
      function: { name: "run_shell", arguments: JSON.stringify({ command: "node -e \"process.stdout.write('x'.repeat(50000)); process.exit(1)\"" }) },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call]), assistantMessage("done")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 4096 },
    });
    await loop.send("run it");
    const toolMsg = turnRequests[1].messages.find((m) => m.role === "tool")!;
    assert.match(String(toolMsg.content), /^ERROR:/);
    assert.ok(String(toolMsg.content).length < 5000, `expected a capped error result, got ${String(toolMsg.content).length} chars`);
    assert.match(String(toolMsg.content), /truncated/);
  }));

test("an over-long read_file result is cut at a line boundary and says which start_line to continue from", () =>
  withTempProject(async (dir) => {
    const path = join(dir, "big.js");
    await writeFile(path, Array.from({ length: 1000 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n");
    const call1 = { id: "r1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path }) } };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call1]), assistantMessage("done")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 4096 },
    });
    await loop.send("read it");
    const toolMsg = String(turnRequests[1].messages.find((m) => m.role === "tool")!.content);
    const m = toolMsg.match(/\[showing lines 1-(\d+) of 1000 — call read_file with path=.* and start_line=(\d+) to continue\]$/);
    assert.ok(m, `expected a continuation marker, got tail: ${toolMsg.slice(-160)}`);
    const lastShown = Number(m![1]);
    assert.equal(Number(m![2]), lastShown + 1);
    // The body ends with a complete line, the one the marker names.
    const body = toolMsg.slice(0, toolMsg.lastIndexOf("\n\n[showing"));
    assert.ok(body.endsWith(`const line${lastShown} = ${lastShown};`), `body ends with: ${body.slice(-40)}`);
  }));

test("a write_file whose content is the elided-write placeholder is refused, and the file is left intact", () =>
  withTempProject(async (dir) => {
    // The live shape: the model copied its own earlier (elided) call and
    // overwrote wrangler.toml with the placeholder text, seven times.
    const path = join(dir, "wrangler.toml");
    const original = 'name = "netproxy"\nmain = "src/workers/proxy.js"\ncompatibility_date = "2024-01-01"\n';
    await writeFile(path, original);
    const call = {
      id: "w1",
      type: "function" as const,
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path, content: "[70 characters written to disk — read the file if you need them again]" }),
      },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage(null, [call]), assistantMessage("ok")],
      tokenCounts: [1],
    });
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 24576 },
    });
    await loop.send("fix the config");
    assert.equal(await readFile(path, "utf8"), original, "the file must not be overwritten with the placeholder");
    const toolMsg = String(turnRequests[1].messages.find((m) => m.role === "tool")!.content);
    assert.match(toolMsg, /^ERROR: refused/);
    assert.match(toolMsg, /read_file/);
  }));

test("an unfinished plan does not re-inject a 'resuming previous session' message on every new message in the same process", () =>
  withTempProject(async (dir) => {
    // The live shape: a plan with a step that needs manual work stays
    // incomplete at the end of every turn, so its plan-progress checkpoint
    // stays on disk — and each new send() in the same process folded it
    // back in as if resuming a previous session, repeating the same
    // resume text before every user message.
    const plan = {
      id: "p1",
      type: "function" as const,
      function: {
        name: "update_plan",
        arguments: JSON.stringify({ steps: [{ description: "deploy", status: "done" }, { description: "DNS setup (manual)", status: "in_progress" }] }),
      },
    };
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [assistantMessage(null, [plan]), assistantMessage("Please set up DNS manually."), assistantMessage("Still waiting on DNS.")],
      tokenCounts: [1],
    });
    const statuses: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 24576 },
      onStatus: (s) => statuses.push(s),
    });
    await loop.send("deploy it");
    await loop.send("continue");
    const resumeMessages = turnRequests[2].messages.filter((m) => typeof m.content === "string" && m.content.startsWith("[resuming"));
    assert.equal(resumeMessages.length, 0, "the plan is live in this process; nothing to resume");
    assert.ok(!statuses.some((s) => s.startsWith("[resuming")), `unexpected resume status: ${statuses.join(" | ")}`);
    // ...while the checkpoint still stays on disk for crash recovery.
    assert.ok(await readCheckpoint(dir));
  }));

test("the same assistant response repeated within a turn stops the turn, even when each comes with a different tool call", () =>
  withTempProject(async (dir) => {
    const step = (n: number) => ({
      id: `u${n}`,
      type: "function" as const,
      function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ description: `try ${n}`, status: "in_progress" }] }) },
    });
    const same = "I'll set up DNS through the dashboard now.";
    const { backend, turnRequests } = scriptedBackend({
      turnResponses: [1, 2, 3, 4, 5].map((n) => assistantMessage(same, [step(n)])),
      tokenCounts: [1],
    });
    const statuses: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 24576 },
      onStatus: (s) => statuses.push(s),
    });
    await loop.send("set up DNS");
    assert.equal(turnRequests.length, 3, "should stop right after the third identical response");
    assert.ok(statuses.some((s) => s.startsWith("[stopped] the model gave the same response 3 times")), statuses.join(" | "));
  }));
