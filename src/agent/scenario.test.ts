import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile as readFileFs, writeFile as writeFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import { clearFailureLog } from "../hermes/selfHeal.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

/**
 * A stress/scenario test, not a unit test: simulates several "developers"
 * (independent AgentLoop instances, each with their own project directory)
 * running many long, tool-heavy turns concurrently against a fake backend
 * — the same kind of realistic load (constant tool calls, growing history,
 * repeated compaction, occasional backend hiccups) that every bug fixed
 * earlier in this project was actually found under, live, one at a time.
 * The backend here is entirely virtual (no real llama-server involved) —
 * only the *shape* of its behavior (tool-call cycles, occasional mid-stream
 * errors, big outputs) is modeled after what real usage produced. The goal
 * is to catch the next one of these before a user does, by exercising many
 * more turns/combinations in one run than any single manual session would.
 *
 * Real tools (read_file/write_file/edit_file/run_shell) execute for real
 * against each developer's own temp directory — only the *model* is fake.
 */

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-scenario-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assistantToolCall(name: string, args: Record<string, unknown>): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `c${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function assistantDone(text: string): ChatCompletionResponse {
  return { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] };
}

/** One simulated developer's fake model: cycles through realistic tool
 *  usage for a few steps, then ends the turn — deterministic per developer
 *  (seeded by index) so a failure is reproducible, but different enough
 *  across developers to exercise a spread of tool combinations, sizes, and
 *  the two known-tricky failure shapes (mid-stream error, oversized output)
 *  at different points in each one's history. */
function fakeDeveloperBackend(devIndex: number, projectDir: string, contextWindowTokens: number): ModelBackend {
  let step = 0;
  const bigFile = join(projectDir, "generated-big.txt");
  // A real backend rejection only happens when the request is genuinely
  // too big — tying the injected failure to an arbitrary step count
  // instead of actual accumulated size (an earlier version of this
  // scenario did exactly that) tests something that can't really happen:
  // proactive compaction had already legitimately shrunk the real history
  // down, and the arbitrary trigger then fired on an already-minimal
  // conversation with nothing left to compact, permanently "failing" every
  // single developer even though nothing was actually wrong. Condition it
  // on the request's own real size instead, just past where the client's
  // own estimate would already be triggering proactive compaction — this
  // is what an actual (small) client/server tokenization mismatch looks
  // like, not an unconditional fault.
  const overflowCharThreshold = contextWindowTokens * 4 * 0.97;

  return {
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      if (!req.tools) {
        // compactor.ts's internal summary request
        return assistantDone(`summary of dev ${devIndex}'s earlier work`);
      }

      step++;
      const cycle = step % 6;

      // Simulate the real mid-stream SSE error class of bug
      // (openaiClient.ts / loop.ts fix) whenever the request is actually
      // close to the configured window — exercising the forced-compaction
      // retry under genuinely large (not arbitrary) history.
      const realSize = JSON.stringify(req.messages).length;
      if (realSize > overflowCharThreshold) {
        throw new Error(
          `chat stream error: request (${Math.ceil(realSize / 4)} tokens) exceeds the available context size (${contextWindowTokens} tokens)`
        );
      }

      switch (cycle) {
        case 0:
          return assistantToolCall("read_file", { path: join(projectDir, "README.md") });
        case 1:
          // Some real, some deliberately failing (nonexistent file/bad
          // command) — real tool errors are a normal part of long
          // sessions, not something to special-case away in the scenario.
          return step % 7 === 1
            ? assistantToolCall("run_shell", { command: "exit 1" })
            : assistantToolCall("run_shell", { command: `echo "dev ${devIndex} step ${step}"` });
        case 2:
          return assistantToolCall("write_file", {
            path: join(projectDir, `scratch-${devIndex}.txt`),
            content: `content from dev ${devIndex} at step ${step}\n`.repeat(5),
          });
        case 3:
          // Every ~4th time this case comes up, make it genuinely huge —
          // exercises capToolResult() and the tool_calls-aware token
          // estimate under a real large payload, not just a unit-test stub.
          if (step % 20 === 3) {
            return assistantToolCall("write_file", {
              path: bigFile,
              content: "x".repeat(50_000),
            });
          }
          if (step % 9 === 3) {
            // edit_file against text that was never actually there — a
            // routine real failure (the model misremembering file
            // contents), not an edge case to avoid.
            return assistantToolCall("edit_file", {
              path: join(projectDir, `scratch-${devIndex}.txt`),
              old_text: "this text was never actually written",
              new_text: "replacement",
            });
          }
          return assistantToolCall("read_file", { path: join(projectDir, `scratch-${devIndex}.txt`) });
        case 4:
          return assistantToolCall("update_plan", {
            steps: [
              { description: "investigate", status: "done" },
              { description: `apply change ${step}`, status: "in_progress" },
            ],
          });
        default:
          if (step % 13 === 5) {
            // The browser tools are never configured in this scenario —
            // exercises the real executeTool() catch path for a tool that
            // legitimately can't run (no attached debug port), same as a
            // user invoking it without --remote-debugging-port running.
            return assistantToolCall("browser_list_tabs", {});
          }
          if (step % 8 === 5) {
            // A model reply carrying both content AND tool_calls at once —
            // real APIs do this; nothing in the loop should assume they're
            // mutually exclusive.
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Let me check the file first.",
                    tool_calls: [
                      {
                        id: `c${Math.random().toString(36).slice(2)}`,
                        type: "function",
                        function: { name: "read_file", arguments: JSON.stringify({ path: join(projectDir, "README.md") }) },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
          }
          return assistantDone(`done with step ${step} for dev ${devIndex}`);
      }
    },
    async listModels() {
      return ["fake-model"];
    },
    // No tokenize(): lets the real char-based fallback (now tool_calls-
    // aware) run against real, growing message history — this is what
    // actually drives realistic, repeated compaction under long sessions.
  };
}

async function runOneDeveloper(devIndex: number, turnsPerDeveloper: number): Promise<{ dir: string; turnErrors: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), `llamacli-scenario-dev${devIndex}-`));
  await writeFileFs(join(dir, "README.md"), `# dev ${devIndex} project\n\nSome initial content.\n`.repeat(20), "utf8");

  const CONTEXT_WINDOW_TOKENS = 6000;
  const statusMessages: string[] = [];
  const loop = new AgentLoop({
    projectRoot: dir,
    model: "fake-model",
    backend: fakeDeveloperBackend(devIndex, dir, CONTEXT_WINDOW_TOKENS),
    systemPrompt: `You are a coding agent for developer ${devIndex}'s project.`,
    thresholds: { autoTriggerRatio: 0.7, contextWindowTokens: CONTEXT_WINDOW_TOKENS },
    onStatus: (s) => statusMessages.push(s),
  });

  for (let turn = 0; turn < turnsPerDeveloper; turn++) {
    // send() must never itself throw — every expected failure mode
    // (backend errors, tool errors, overflow) is caught and reported via
    // onStatus internally. If it rejects here, that's exactly the class of
    // unhandled-crash bug this scenario exists to catch.
    await loop.send(`please continue with task ${turn} on the project`);
  }

  const turnErrors = statusMessages.filter((s) => s.startsWith("[error]"));
  return { dir, turnErrors };
}

test(
  "many concurrent long-running developer sessions against a fake backend never produce an unhandled crash",
  { timeout: 60_000 },
  async () => {
    clearFailureLog();
    const DEVELOPERS = 60; // "수십명의 개발자" (dozens of developers)
    const TURNS_PER_DEVELOPER = 40; // long-running, not a single request

    const dirs: string[] = [];
    try {
      const results = await Promise.all(
        Array.from({ length: DEVELOPERS }, (_, i) => runOneDeveloper(i, TURNS_PER_DEVELOPER))
      );
      for (const r of results) dirs.push(r.dir);

      // Every context-overflow injected above (step % 11 === 0) is meant to
      // be fully recovered from by the forced-compaction-and-retry path —
      // none of them should surface as a final, unrecovered [error] status
      // given the fake backend always succeeds on the very next call.
      const unrecovered = results.flatMap((r, i) => r.turnErrors.map((e) => `dev ${i}: ${e}`));
      assert.deepEqual(unrecovered, [], "expected every simulated overflow to be auto-recovered, not reported as a final error");

      // Sanity: the real filesystem side effects actually happened for at
      // least one developer (proves tools genuinely executed, not just
      // that the loop quietly no-op'd through every turn).
      const scratch = await readFileFs(join(dirs[0], "scratch-0.txt"), "utf8").catch(() => null);
      assert.ok(scratch, "expected at least one developer's write_file calls to have actually landed on disk");
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  }
);
