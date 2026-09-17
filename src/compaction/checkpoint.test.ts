import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckpoint, readCheckpoint, clearCheckpoint, Checkpoint } from "./checkpoint.js";

function sample(): Checkpoint {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    reason: "manual",
    goal: "test goal",
    steps: [{ description: "step 1", status: "todo" }],
    files: [{ path: "a.ts", status: "read" }],
    pendingToolCall: null,
    mustPreserve: ["keep this"],
  };
}

test("readCheckpoint returns null when nothing was ever written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    assert.equal(await readCheckpoint(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCheckpoint then readCheckpoint round-trips the exact data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    const checkpoint = sample();
    await writeCheckpoint(dir, checkpoint);
    const read = await readCheckpoint(dir);
    assert.deepEqual(read, checkpoint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCheckpoint creates .llamacli/state/ if it doesn't exist yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    // no .llamacli directory exists at all in this fresh temp dir
    await writeCheckpoint(dir, sample());
    const read = await readCheckpoint(dir);
    assert.ok(read);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearCheckpoint deletes the file so readCheckpoint returns null afterward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    await writeCheckpoint(dir, sample());
    assert.ok(await readCheckpoint(dir));
    await clearCheckpoint(dir);
    assert.equal(await readCheckpoint(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearCheckpoint on a project with no checkpoint yet is a no-op, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    await assert.doesNotReject(() => clearCheckpoint(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
