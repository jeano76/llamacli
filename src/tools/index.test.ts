import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, setRunShellTimeoutForTests } from "./index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-tools-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Found via a scenario test simulating many long developer sessions across
// several real language toolchains: run_shell had no timeout at all, so a
// command that blocks (network stall, something waiting on stdin, a
// genuinely long-running build) would hang the entire agent loop forever
// with no way to recover — plausibly the actual cause behind more than one
// "seems stuck?" report earlier, not just the bugs already found and fixed.
test("run_shell kills a command that blocks past the configured timeout instead of hanging forever", () =>
  withTempDir(async (dir) => {
    setRunShellTimeoutForTests(300);
    try {
      const start = Date.now();
      await assert.rejects(() => executeTool("run_shell", JSON.stringify({ command: "sleep 30" }), dir));
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `expected the command to be killed near the 300ms timeout, took ${elapsed}ms`);
    } finally {
      setRunShellTimeoutForTests(60_000);
    }
  }));

test("run_shell still completes normally for a fast command well under the timeout", () =>
  withTempDir(async (dir) => {
    const result = await executeTool("run_shell", JSON.stringify({ command: "echo hello" }), dir);
    assert.match(result.content, /hello/);
  }));

// cwd was previously always process.cwd() — the whole CLI process's own
// working directory — instead of the actual project being worked on; it
// only happened to line up in normal single-project use because llamacli
// is launched from inside the project. Verify the command genuinely runs
// in the passed project root, not wherever this test process happens to be.
test("run_shell executes in the given project root, not the CLI process's own cwd", () =>
  withTempDir(async (dir) => {
    const result = await executeTool("run_shell", JSON.stringify({ command: "pwd" }), dir);
    // Resolve both sides the same way (macOS/BSD can report /private/var/...
    // for a path given as /var/...) so this isn't flaky across platforms.
    const { realpath } = await import("node:fs/promises");
    assert.equal(result.content.trim(), await realpath(dir));
  }));
