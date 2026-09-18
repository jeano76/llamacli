import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile as readFileFs, writeFile as writeFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import { clearFailureLog } from "../hermes/selfHeal.js";
import { setRunShellTimeoutForTests } from "../tools/index.js";
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

/** A language/program-type profile a simulated developer works in. Bugs
 *  found earlier only ever surfaced from generic .txt content — real
 *  sessions span many languages and program shapes (a web API's request
 *  handler looks nothing like a CLI's argument parser or a data
 *  pipeline's batch script), with different file extensions, build/test
 *  commands, and source syntax (which matters for markdown-fenced code in
 *  assistant replies, and for tool_calls arguments containing real
 *  language-specific quoting/escaping). Requested directly: exercise a
 *  spread of these instead of one uniform shape. */
interface LanguageProfile {
  name: string;
  programType: string;
  ext: string;
  sourceFile: string;
  sampleSource: string;
  buildCommand: string;
  testCommand: string;
  lintFailCommand: string;
}

const LANGUAGE_PROFILES: LanguageProfile[] = [
  {
    name: "Python",
    programType: "a Flask REST API",
    ext: "py",
    sourceFile: "app.py",
    sampleSource: "def handler(request):\n    return {\"status\": \"ok\"}\n",
    buildCommand: "python3 -m py_compile app.py",
    testCommand: "python3 -m pytest -q || true",
    lintFailCommand: "python3 -c \"import sys; sys.exit(1)\"",
  },
  {
    name: "Go",
    programType: "a gRPC microservice",
    ext: "go",
    sourceFile: "main.go",
    sampleSource: 'package main\n\nfunc main() {\n\tprintln("ok")\n}\n',
    buildCommand: "go version",
    testCommand: "go vet ./... || true",
    lintFailCommand: "sh -c 'exit 1'",
  },
  {
    name: "Rust",
    programType: "a CLI tool",
    ext: "rs",
    sourceFile: "main.rs",
    sampleSource: 'fn main() {\n    println!("ok");\n}\n',
    buildCommand: "rustc --version",
    testCommand: "cargo test 2>/dev/null || true",
    lintFailCommand: "sh -c 'exit 1'",
  },
  {
    name: "TypeScript",
    programType: "a Node.js web server",
    ext: "ts",
    sourceFile: "server.ts",
    sampleSource: "export function handler(req: Request): Response {\n  return new Response(\"ok\");\n}\n",
    buildCommand: "node --version",
    testCommand: "npx --no-install jest 2>/dev/null || true",
    lintFailCommand: "sh -c 'exit 1'",
  },
  {
    name: "Java",
    programType: "a Spring Boot service",
    ext: "java",
    sourceFile: "Main.java",
    sampleSource: "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"ok\");\n  }\n}\n",
    buildCommand: "java -version",
    testCommand: "sh -c 'echo running tests'",
    lintFailCommand: "sh -c 'exit 1'",
  },
  {
    name: "Ruby",
    programType: "a batch data-processing pipeline",
    ext: "rb",
    sourceFile: "pipeline.rb",
    sampleSource: "def process(record)\n  record[:status] = 'ok'\nend\n",
    buildCommand: "ruby --version",
    testCommand: "sh -c 'echo running tests'",
    lintFailCommand: "sh -c 'exit 1'",
  },
];

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
function fakeDeveloperBackend(
  devIndex: number,
  projectDir: string,
  contextWindowTokens: number,
  profile: LanguageProfile
): ModelBackend {
  let step = 0;
  const bigFile = join(projectDir, `generated-big.${profile.ext}`);
  const scratchFile = join(projectDir, `scratch-${devIndex}.${profile.ext}`);
  const sourcePath = join(projectDir, profile.sourceFile);
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
          return assistantToolCall("read_file", { path: sourcePath });
        case 1:
          // Some real, some deliberately failing (nonexistent file/bad
          // command) — real tool errors are a normal part of long
          // sessions, not something to special-case away in the scenario.
          // Uses the language's own real toolchain command (compiler
          // version check, linter, etc.), not a generic echo — argument
          // quoting/escaping varies genuinely by language/shell idiom.
          return step % 7 === 1
            ? assistantToolCall("run_shell", { command: profile.lintFailCommand })
            : assistantToolCall("run_shell", { command: step % 2 === 0 ? profile.buildCommand : profile.testCommand });
        case 2:
          return assistantToolCall("write_file", {
            path: scratchFile,
            content: `// dev ${devIndex} (${profile.name}, ${profile.programType}) step ${step}\n${profile.sampleSource}`.repeat(3),
          });
        case 3:
          // Every ~4th time this case comes up, make it genuinely huge —
          // exercises capToolResult() and the tool_calls-aware token
          // estimate under a real large payload, not just a unit-test stub.
          if (step % 20 === 3) {
            return assistantToolCall("write_file", {
              path: bigFile,
              content: profile.sampleSource.repeat(2000),
            });
          }
          if (step % 9 === 3) {
            // edit_file against text that was never actually there — a
            // routine real failure (the model misremembering file
            // contents), not an edge case to avoid.
            return assistantToolCall("edit_file", {
              path: scratchFile,
              old_text: "this text was never actually written",
              new_text: "replacement",
            });
          }
          return assistantToolCall("read_file", { path: scratchFile });
        case 4:
          return assistantToolCall("update_plan", {
            steps: [
              { description: `investigate ${profile.programType}`, status: "done" },
              { description: `apply change ${step} to ${profile.sourceFile}`, status: "in_progress" },
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
                    content: `Let me check ${profile.sourceFile} first.`,
                    tool_calls: [
                      {
                        id: `c${Math.random().toString(36).slice(2)}`,
                        type: "function",
                        function: { name: "read_file", arguments: JSON.stringify({ path: sourcePath }) },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
          }
          return assistantDone(`done with step ${step} for dev ${devIndex} (${profile.name})`);
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
  const profile = LANGUAGE_PROFILES[devIndex % LANGUAGE_PROFILES.length];
  const dir = await mkdtemp(join(tmpdir(), `llamacli-scenario-dev${devIndex}-`));
  await writeFileFs(
    join(dir, "README.md"),
    `# dev ${devIndex} project (${profile.name})\n\nThis is ${profile.programType}, written in ${profile.name}.\n`.repeat(20),
    "utf8"
  );
  await writeFileFs(join(dir, profile.sourceFile), profile.sampleSource, "utf8");

  const CONTEXT_WINDOW_TOKENS = 6000;
  const statusMessages: string[] = [];
  const loop = new AgentLoop({
    projectRoot: dir,
    model: "fake-model",
    backend: fakeDeveloperBackend(devIndex, dir, CONTEXT_WINDOW_TOKENS, profile),
    systemPrompt: `You are a coding agent working on developer ${devIndex}'s project: ${profile.programType} written in ${profile.name}.`,
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
  "many concurrent long-running developer sessions, across different languages and program types, never produce an unhandled crash",
  { timeout: 60_000 },
  async () => {
    clearFailureLog();
    // Real toolchain commands (go/rustc/java/etc.) aren't necessarily
    // installed in this environment, and this scenario runs many of them
    // for real, concurrently, across many developers — keep any one call
    // bounded well below the test's own timeout instead of at the
    // (production-appropriate, but too long for a test) 60s default.
    setRunShellTimeoutForTests(5_000);
    const DEVELOPERS = 24; // "수십명의 개발자" (dozens of developers) — 4 per language profile
    const TURNS_PER_DEVELOPER = 20; // long-running, not a single request

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
      const dev0Ext = LANGUAGE_PROFILES[0 % LANGUAGE_PROFILES.length].ext;
      const scratch = await readFileFs(join(dirs[0], `scratch-0.${dev0Ext}`), "utf8").catch(() => null);
      assert.ok(scratch, "expected at least one developer's write_file calls to have actually landed on disk");
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  }
);
