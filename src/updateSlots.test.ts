import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSlot, pruneSlots, listSlots, restoreSlot, VERSION_SLOTS } from "./updateSlots.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-slots-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeDist(dir: string, marker: string): Promise<string> {
  const dist = join(dir, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.js"), `// ${marker}`, "utf8");
  await writeFile(join(dist, ".self-update-sha256"), "a".repeat(64), "utf8");
  return dist;
}

test("save → restore round-trips the whole tree", () =>
  withTempDir(async (dir) => {
    const dist = await makeDist(dir, "v1");
    const root = join(dir, "slots");
    const { slot, created } = await saveSlot(dist, { version: "0.1.0", sha256: "a".repeat(64), slotsRoot: root });
    assert.equal(created, true);
    await writeFile(join(dist, "index.js"), "// v2-broken", "utf8");
    const r = await restoreSlot(dist, slot.split("/").pop()!, { slotsRoot: root });
    assert.equal(r.ok, true, r.detail);
    assert.equal(await readFile(join(dist, "index.js"), "utf8"), "// v1");
  }));

test("same version slot is idempotent; only newest 3 survive", () =>
  withTempDir(async (dir) => {
    const dist = await makeDist(dir, "v1");
    const root = join(dir, "slots");
    const first = await saveSlot(dist, { version: "0.1.0", sha256: "a".repeat(64), slotsRoot: root });
    const second = await saveSlot(dist, { version: "0.1.0", sha256: "a".repeat(64), slotsRoot: root });
    assert.equal(second.created, false);
    assert.equal(first.slot, second.slot);
    assert.equal(VERSION_SLOTS, 3);
    for (let i = 0; i < 5; i++) {
      await saveSlot(dist, { version: `9.9.${i}`, sha256: `${i}`.repeat(64), slotsRoot: root });
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal((await listSlots(root)).length, 3, "must prune to 3 newest");
  }));

test("restore refuses a missing slot and a slot without an entry point", () =>
  withTempDir(async (dir) => {
    const dist = await makeDist(dir, "v1");
    const root = join(dir, "slots");
    assert.equal((await restoreSlot(dist, "nope", { slotsRoot: root })).ok, false);
    await mkdir(join(root, "v-empty-abc"), { recursive: true });
    const r = await restoreSlot(dist, "v-empty-abc", { slotsRoot: root });
    assert.equal(r.ok, false, "entry-less slot must not restore");
    assert.equal(await readFile(join(dist, "index.js"), "utf8"), "// v1", "failed restore must leave dist/ alone");
  }));
