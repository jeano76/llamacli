import { test } from "node:test";
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCheckpoint, resetGitCheckpointCacheForTests } from "./gitCheckpoint.js";

const execAsync = promisify(exec);

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-git-"));
  await execAsync("git init -q", { cwd: dir });
  await execAsync('git config user.email "t@t.com" && git config user.name t', { cwd: dir });
  resetGitCheckpointCacheForTests();
  return dir;
}

test("gitCheckpoint commits a changed file and returns a revertable hash", async () => {
  const dir = await initRepo();
  try {
    const path = join(dir, "a.txt");
    await writeFile(path, "v1\n");
    const r1 = await gitCheckpoint(path, "wrote a.txt", dir);
    assert.equal(r1.committed, true);
    assert.match(r1.hash!, /^[0-9a-f]{7,}$/);

    // Same content again: nothing to commit.
    const r2 = await gitCheckpoint(path, "wrote a.txt again", dir);
    assert.equal(r2.committed, false);
    assert.equal(r2.reason, "no change to commit");

    await writeFile(path, "v2\n");
    const r3 = await gitCheckpoint(path, "updated a.txt", dir);
    assert.equal(r3.committed, true);
    assert.notEqual(r3.hash, r1.hash);

    const { stdout } = await execAsync("git log --oneline", { cwd: dir });
    assert.equal(stdout.trim().split("\n").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitCheckpoint no-ops outside a git repo and on a gitignored file, without throwing", async () => {
  const plain = await (async () => {
    const d = await mkdtemp(join(tmpdir(), "llamacli-nogit-"));
    resetGitCheckpointCacheForTests();
    return d;
  })();
  try {
    const path = join(plain, "a.txt");
    await writeFile(path, "v1\n");
    const r = await gitCheckpoint(path, "msg", plain);
    assert.equal(r.committed, false);
    assert.equal(r.reason, "not a git repository");
  } finally {
    await rm(plain, { recursive: true, force: true });
  }

  const dir = await initRepo();
  try {
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await execAsync("git add .gitignore && git commit -q -m init", { cwd: dir });
    const path = join(dir, "ignored.txt");
    await writeFile(path, "secret\n");
    const r = await gitCheckpoint(path, "msg", dir);
    assert.equal(r.committed, false);
    assert.equal(r.reason, "path is gitignored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
