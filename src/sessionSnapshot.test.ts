import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSessionSnapshot, loadSessionSnapshot, clearSessionSnapshot,
  trimSnapshotMessages, MAX_SNAPSHOT_MESSAGES, sessionFilePath,
} from "./sessionSnapshot.js";
import type { ChatMessage } from "./backend/types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-session-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const msg = (role: ChatMessage["role"], i: number): ChatMessage => ({ role, content: `${role}-${i}` });

test("save → load round-trips the conversation", () =>
  withTempDir(async (dir) => {
    const messages = [{ role: "system", content: "sys" } as ChatMessage, msg("user", 1), msg("assistant", 2)];
    await saveSessionSnapshot(dir, messages);
    assert.deepEqual(await loadSessionSnapshot(dir), messages);
  }));

test("trim keeps system + newest, drops the middle", () =>
  withTempDir(async (dir) => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < MAX_SNAPSHOT_MESSAGES + 50; i++) messages.push(msg("user", i));
    await saveSessionSnapshot(dir, messages);
    const back = (await loadSessionSnapshot(dir))!;
    assert.equal(back.length, MAX_SNAPSHOT_MESSAGES);
    assert.equal(back[0]!.role, "system");
    assert.equal(back[back.length - 1]!.content, `user-${MAX_SNAPSHOT_MESSAGES + 49}`);
  }));

test("missing and corrupt snapshots load as null, never throw", () =>
  withTempDir(async (dir) => {
    assert.equal(await loadSessionSnapshot(dir), null);
    await writeFile(sessionFilePath(dir), "not json{{{", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(sessionFilePath(dir)), { recursive: true });
      await writeFile(sessionFilePath(dir), "not json{{{", "utf8");
    });
    assert.equal(await loadSessionSnapshot(dir), null);
    await clearSessionSnapshot(dir);
    assert.equal(await loadSessionSnapshot(dir), null);
  }));
