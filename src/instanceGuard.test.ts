import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOtherInstances, terminateInstance } from "./instanceGuard.js";

test("finds another process running the same script in the same project, and terminates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-guard-"));
  const other = await mkdtemp(join(tmpdir(), "llamacli-guard-other-"));
  const script = join(dir, "fake-llamacli.js");
  await writeFile(script, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(findOtherInstances(dir, process.pid, script), [child.pid]);
    // Same script, different project: not a conflict.
    assert.deepEqual(findOtherInstances(other, process.pid, script), []);
    // A process doesn't count itself.
    assert.deepEqual(findOtherInstances(dir, child.pid!, script), []);

    assert.equal(await terminateInstance(child.pid!), true);
    assert.deepEqual(findOtherInstances(dir, process.pid, script), []);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
