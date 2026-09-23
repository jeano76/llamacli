import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, setRunShellTimeoutForTests, configureSkills } from "./index.js";

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

// Backs the fixed-size chunking recovery path (agent/loop.ts's "tool call
// truncated" retry): write_file for the first chunk, append_file for each
// remaining one — this is what makes that actually possible instead of
// only ever being able to overwrite a file wholesale in one shot.
test("append_file appends to an existing file's content rather than overwriting it", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "chunked.txt");
    await executeTool("write_file", JSON.stringify({ path, content: "chunk1-" }), dir);
    const result = await executeTool("append_file", JSON.stringify({ path, content: "chunk2-" }), dir);
    assert.match(result.content, /appended/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "chunk1-chunk2-");
  }));

test("append_file creates the file (and missing parent directories) when it doesn't exist yet", () =>
  withTempDir(async (dir) => {
    // Mirrors write_file's own directory-creation fix — an append_file
    // call must be able to serve as the FIRST call too (e.g. if a prior
    // write_file attempt was the one that got truncated and never ran).
    const path = join(dir, "new", "nested", "file.txt");
    const result = await executeTool("append_file", JSON.stringify({ path, content: "first" }), dir);
    assert.match(result.content, /appended/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "first");
  }));

test("append_file called multiple times in sequence reconstructs the full content in order", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "multi.txt");
    await executeTool("write_file", JSON.stringify({ path, content: "part1-" }), dir);
    await executeTool("append_file", JSON.stringify({ path, content: "part2-" }), dir);
    await executeTool("append_file", JSON.stringify({ path, content: "part3" }), dir);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "part1-part2-part3");
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

// The skill system (8 builtin skills shipped under src/skills/builtin/)
// had loadSkillBody() defined but no caller anywhere in the codebase — the
// model had no way to ever read a skill's body, only a human via the
// /skills UI list. load_skill is the tool that actually connects it.
test("load_skill returns the body of a configured skill by name", () =>
  withTempDir(async (dir) => {
    configureSkills([{ name: "planning", trigger: "when planning multi-step work", path: join(dir, "planning.md") }]);
    try {
      await writeFile(join(dir, "planning.md"), "# Planning skill body", "utf8");
      const result = await executeTool("load_skill", JSON.stringify({ name: "planning" }), dir);
      assert.equal(result.content, "# Planning skill body");
    } finally {
      configureSkills([]); // don't leak into other tests
    }
  }));

test("load_skill rejects an unknown skill name and lists what's actually available", () =>
  withTempDir(async (dir) => {
    configureSkills([{ name: "security", trigger: "t", path: join(dir, "security.md") }]);
    try {
      await assert.rejects(
        () => executeTool("load_skill", JSON.stringify({ name: "nonexistent" }), dir),
        /unknown skill: nonexistent.*Available: security/s
      );
    } finally {
      configureSkills([]);
    }
  }));

// run_shell previously used `stdout || stderr`, silently dropping stderr
// whenever stdout was non-empty — losing diagnostics from any tool (tsc,
// pytest, cargo) that writes them to stderr alongside normal output.
test("run_shell includes both stdout and stderr, not just whichever is non-empty first", () =>
  withTempDir(async (dir) => {
    const result = await executeTool("run_shell", JSON.stringify({ command: "echo out; echo err >&2" }), dir);
    assert.match(result.content, /out/);
    assert.match(result.content, /err/);
  }));

// A failing command previously surfaced only err.message ("Command failed:
// ..."), discarding err.stdout/err.stderr entirely — the model had no way
// to learn WHY a "succeeded" command actually failed, making it prone to
// blindly retrying the same command (exactly what the circuit breaker in
// selfHeal.ts exists to catch as an unrecoverable loop).
test("run_shell surfaces the failing command's actual output, not just its exit message", () =>
  withTempDir(async (dir) => {
    await assert.rejects(
      () => executeTool("run_shell", JSON.stringify({ command: "echo something specific went wrong >&2; exit 1" }), dir),
      /something specific went wrong/
    );
  }));

// read_file previously loaded the entire file into memory before
// capToolResult() (loop.ts) got a chance to truncate it — a large file
// (accidentally pointed at a bundled asset, a log, a data dump) could
// exhaust memory before any cap ever applied.
test("read_file truncates a file larger than the size cap instead of loading it all into memory", () =>
  withTempDir(async (dir) => {
    const path = join(dir, "big.txt");
    // Write just over 5MB (READ_FILE_MAX_BYTES) of a repeating, greppable pattern.
    const chunk = "0123456789".repeat(100); // 1000 bytes
    const fh = await (await import("node:fs/promises")).open(path, "w");
    try {
      for (let i = 0; i < 5300; i++) await fh.write(chunk); // ~5.3MB
    } finally {
      await fh.close();
    }
    const result = await executeTool("read_file", JSON.stringify({ path }), dir);
    assert.ok(result.content.length < 5.3 * 1024 * 1024, "result should be smaller than the original file");
    assert.match(result.content, /truncated.*only the first/s);
  }));
