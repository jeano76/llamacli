import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCrashReport, writeCrashLogSync, installCrashHandlers } from "./crashHandler.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-crash-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("formatCrashReport includes the timestamp, kind, and the error's stack", () => {
  const err = new Error("boom");
  const report = formatCrashReport("uncaughtException", err);
  assert.match(report, /uncaughtException/);
  assert.match(report, /boom/);
  assert.match(report, /Error: boom/); // the stack, not just the message
  assert.match(report, /\d{4}-\d{2}-\d{2}T/, "expected an ISO timestamp");
});

test("formatCrashReport handles a non-Error rejection value (e.g. a thrown string)", () => {
  const report = formatCrashReport("unhandledRejection", "just a string reason");
  assert.match(report, /unhandledRejection/);
  assert.match(report, /just a string reason/);
});

test("writeCrashLogSync appends to .llamacli/crash.log, creating the directory if needed", () =>
  withTempDir(async (dir) => {
    writeCrashLogSync(dir, "first report\n");
    writeCrashLogSync(dir, "second report\n");
    const content = await readFile(join(dir, ".llamacli", "crash.log"), "utf8");
    assert.match(content, /first report/);
    assert.match(content, /second report/);
    assert.ok(content.indexOf("first report") < content.indexOf("second report"), "appends, doesn't overwrite");
  }));

test("writeCrashLogSync never throws even when the directory can't be created (e.g. projectRoot doesn't exist)", () => {
  assert.doesNotThrow(() => writeCrashLogSync("/definitely/does/not/exist/anywhere", "report\n"));
});

test("installCrashHandlers: an uncaughtException calls onBeforeExit, writes the crash log, and exits(1) — never crashes the process silently", () =>
  withTempDir(async (dir) => {
    let beforeExitCalled = false;
    let exitCode: number | undefined;
    const originalExit = process.exit;
    // installCrashHandlers calls process.exit(1) for real — stub it so this
    // test process itself doesn't actually exit.
    (process as any).exit = (code?: number) => {
      exitCode = code;
      throw new Error("__test_process_exit__");
    };
    try {
      installCrashHandlers(dir, () => {
        beforeExitCalled = true;
      });
      const handlers = process.listeners("uncaughtException");
      const ours = handlers[handlers.length - 1] as (err: unknown) => void;
      assert.throws(() => ours(new Error("simulated crash")), /__test_process_exit__/);
      assert.equal(beforeExitCalled, true);
      assert.equal(exitCode, 1);
      const log = await readFile(join(dir, ".llamacli", "crash.log"), "utf8");
      assert.match(log, /simulated crash/);
      assert.match(log, /uncaughtException/);
    } finally {
      process.exit = originalExit;
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  }));
