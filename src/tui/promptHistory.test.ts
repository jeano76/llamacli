import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptHistory, savePromptHistory, MAX_PROMPT_HISTORY } from "./promptHistory.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-history-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadPromptHistory returns an empty list when no history file exists yet", () =>
  withTempDir(async (dir) => {
    assert.deepEqual(await loadPromptHistory(dir), []);
  }));

test("savePromptHistory then loadPromptHistory round-trips the same list", () =>
  withTempDir(async (dir) => {
    await savePromptHistory(dir, ["first prompt", "second prompt"]);
    assert.deepEqual(await loadPromptHistory(dir), ["first prompt", "second prompt"]);
  }));

test("savePromptHistory creates the .llamacli/state directory if it doesn't exist yet", () =>
  withTempDir(async (dir) => {
    // No .llamacli dir at all in this fresh project — must not throw ENOENT.
    await savePromptHistory(dir, ["a"]);
    assert.deepEqual(await loadPromptHistory(dir), ["a"]);
  }));

test("savePromptHistory caps what's written to MAX_PROMPT_HISTORY, not just what appendHistory already capped client-side", () =>
  withTempDir(async (dir) => {
    const oversized = Array.from({ length: MAX_PROMPT_HISTORY + 20 }, (_, i) => `p${i}`);
    await savePromptHistory(dir, oversized);
    const loaded = await loadPromptHistory(dir);
    assert.equal(loaded.length, MAX_PROMPT_HISTORY);
    assert.equal(loaded[loaded.length - 1], `p${MAX_PROMPT_HISTORY + 19}`);
  }));

// A corrupted/manually-edited history file must never crash CLI startup —
// same "reuse what's there, else start fresh" resilience as config.ts's
// own loadConfig() applies to a malformed config.yaml.
test("loadPromptHistory returns an empty list instead of throwing when the file is corrupt JSON", () =>
  withTempDir(async (dir) => {
    const path = join(dir, ".llamacli", "state", "prompt-history.json");
    await mkdir(join(dir, ".llamacli", "state"), { recursive: true });
    await writeFile(path, "{not valid json", "utf8");
    assert.deepEqual(await loadPromptHistory(dir), []);
  }));

test("loadPromptHistory returns an empty list instead of throwing when the file is valid JSON but not an array of strings", () =>
  withTempDir(async (dir) => {
    const path = join(dir, ".llamacli", "state", "prompt-history.json");
    await mkdir(join(dir, ".llamacli", "state"), { recursive: true });
    await writeFile(path, JSON.stringify({ not: "an array" }), "utf8");
    assert.deepEqual(await loadPromptHistory(dir), []);
  }));
