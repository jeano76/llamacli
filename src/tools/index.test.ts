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

// Found auditing for the same class of gap as run_shell's missing
// timeout: write_file never created parent directories on its own,
// so writing a brand-new file into a directory that doesn't exist yet
// (routine for "create a new module/handler") threw ENOENT.
test("write_file creates missing parent directories instead of throwing ENOENT", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "a", "b", "c", "new-file.ts");
    const result = await executeTool("write_file", JSON.stringify({ path, content: "hello" }), dir);
    assert.match(result.content, /wrote/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "hello");
  }));

test("write_file still works normally for a file in an already-existing directory (no regression)", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "existing.txt");
    await executeTool("write_file", JSON.stringify({ path, content: "v1" }), dir);
    const result = await executeTool("write_file", JSON.stringify({ path, content: "v2" }), dir);
    assert.match(result.content, /wrote/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "v2");
  }));

// `.replace()` only ever touches the FIRST match — if old_text also
// appears elsewhere in the file (genuinely common: similar-looking
// functions, repeated boilerplate), the previous `.includes()` check only
// confirmed a match exists somewhere, not that it's unique, so an
// ambiguous old_text could silently edit the wrong (unintended)
// occurrence with no warning at all.
test("edit_file refuses an ambiguous old_text that matches more than once, instead of silently editing the first occurrence", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "dup.ts");
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(path, "function a() { return 1; }\nfunction b() { return 1; }\n", "utf8");

    await assert.rejects(
      () => executeTool("edit_file", JSON.stringify({ path, old_text: "return 1;", new_text: "return 2;" }), dir),
      /matches 2 places.*ambiguous/s
    );
    // must not have touched the file at all
    assert.equal(await readFile(path, "utf8"), "function a() { return 1; }\nfunction b() { return 1; }\n");
  }));

test("edit_file still edits normally when old_text uniquely matches exactly one place", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "unique.ts");
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(path, "function a() { return 1; }\nfunction b() { return 2; }\n", "utf8");

    const result = await executeTool(
      "edit_file",
      JSON.stringify({ path, old_text: "function a() { return 1; }", new_text: "function a() { return 100; }" }),
      dir
    );
    assert.match(result.content, /edited/);
    assert.equal(await readFile(path, "utf8"), "function a() { return 100; }\nfunction b() { return 2; }\n");
  }));

test("edit_file still throws its original error when old_text isn't found at all (no regression)", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "nomatch.ts");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "hello world\n", "utf8");
    await assert.rejects(
      () => executeTool("edit_file", JSON.stringify({ path, old_text: "not present", new_text: "x" }), dir),
      /old_text not found/
    );
  }));
