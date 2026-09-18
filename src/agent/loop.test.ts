import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import { readCheckpoint, writeCheckpoint } from "../compaction/checkpoint.js";
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
