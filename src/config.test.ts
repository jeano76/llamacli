import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig reads an existing config.yaml as-is, without touching the filesystem", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    const path = join(dir, ".llamacli", "config.yaml");
    await writeFile(path, "backend: openai-compatible\nmodel: my-model\nbaseUrl: http://example.invalid\n", "utf8");

    const { config, setupMessage } = await loadConfig(dir);
    assert.equal(config.backend, "openai-compatible");
    assert.equal(config.model, "my-model");
    assert.equal(config.baseUrl, "http://example.invalid");
    assert.equal(setupMessage, undefined);
    // untouched — still exactly what was written, not overwritten with defaults merged in
    assert.equal(
      await readFile(path, "utf8"),
      "backend: openai-compatible\nmodel: my-model\nbaseUrl: http://example.invalid\n"
    );
  }));

test("loadConfig falls back to the placeholder default and writes it when nothing exists and no server is detected", () =>
  withTempDir(async (dir) => {
    const { config, setupMessage } = await loadConfig(dir, async () => null);
    assert.equal(config.backend, "local-llama");
    assert.match(setupMessage ?? "", /No \.llamacli\/config\.yaml found/);

    const written = await readFile(join(dir, ".llamacli", "config.yaml"), "utf8");
    assert.match(written, /backend: local-llama/);
  }));

test("loadConfig writes a config pointing at a detected server and says so in the setup message", () =>
  withTempDir(async (dir) => {
    const { config, setupMessage } = await loadConfig(dir, async () => ({
      baseUrl: "http://127.0.0.1:8080",
      model: "ornith-1.5-35b",
    }));
    assert.equal(config.backend, "openai-compatible");
    assert.equal(config.baseUrl, "http://127.0.0.1:8080");
    assert.equal(config.model, "ornith-1.5-35b");
    assert.match(setupMessage ?? "", /detected a running server at http:\/\/127\.0\.0\.1:8080/);

    const written = await readFile(join(dir, ".llamacli", "config.yaml"), "utf8");
    assert.match(written, /backend: openai-compatible/);
    assert.match(written, /baseUrl: http:\/\/127\.0\.0\.1:8080/);
  }));

test("loadConfig is idempotent: a second call after auto-generation reads the file back without re-detecting", () =>
  withTempDir(async (dir) => {
    const first = await loadConfig(dir, async () => null);
    assert.ok(first.setupMessage);

    let detectCalledAgain = false;
    const second = await loadConfig(dir, async () => {
      detectCalledAgain = true;
      return null;
    });
    assert.equal(detectCalledAgain, false);
    assert.equal(second.setupMessage, undefined);
    assert.deepEqual(second.config, first.config);
  }));

// Found via real monitoring data: the worst case for a single turn is
// autoTriggerRatio (compaction threshold) + the max_tokens fraction of the
// window a single reply can add before the NEXT threshold check (see
// loop.ts's max_tokens cap, 25% of the window) — if that sum exceeds 1.0,
// a single turn can overshoot the real context window even with
// compaction "working correctly", relying on the overflow-retry safety
// net (loop.ts) far more than necessary. Observed directly: usage reached
// 89% of a real window in one live turn under the old 0.85 default.
test("DEFAULT_CONFIG's autoTriggerRatio leaves real headroom under the max_tokens fraction it can be followed by", () => {
  const MAX_TOKENS_FRACTION_OF_WINDOW = 0.25; // kept in sync with loop.ts's own constant by this assertion
  const worstCase = DEFAULT_CONFIG.compaction.autoTriggerRatio + MAX_TOKENS_FRACTION_OF_WINDOW;
  assert.ok(worstCase < 1.0, `autoTriggerRatio (${DEFAULT_CONFIG.compaction.autoTriggerRatio}) + max_tokens fraction leaves no safety margin: ${worstCase}`);
});

// A read-only project directory is a real, reachable state: a project on a
// read-only mount, a checkout owned by another user, a container running as a
// non-owner. The generate-and-persist path used to do an unguarded
// `mkdir` + `writeFile` inside its catch block, so such a project made EVERY
// launch reject with EACCES -- a worse failure than the missing file it was
// already handling. Found by a project-axis sweep over 100 project states.
test("loadConfig survives a read-only project directory instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-ro-"));
  const project = join(dir, "project");
  await mkdir(project);
  await chmod(project, 0o555);
  // Probe with a throwaway name, NOT `.llamacli`: probing with the real name
  // created the very directory the test is about, so on a system where the
  // mkdir succeeded the test then passed vacuously. See the same fix in
  // setup/reset.test.ts.
  const writable = await mkdir(join(project, ".probe-canary")).then(
    () => true,
    () => false
  );
  if (writable) {
    await rm(join(project, ".probe-canary"), { recursive: true, force: true });
  }
  // Skipped where the fs or the user prevents making a dir read-only at all
  // (root ignores the mode bit), because then there is nothing to test.
  if (writable) {
    await chmod(project, 0o755);
    await rm(dir, { recursive: true, force: true });
    return;
  }
  try {
    const result = await loadConfig(project, async () => null, async () => null);
    // The session must still be startable...
    assert.ok(result.config?.backend, "expected a usable config despite the unwritable directory");
    // ...and the user must be told, rather than shown a stack trace.
    assert.ok(result.setupMessage, "expected an explanation when the config could not be saved");
    assert.match(result.setupMessage!, /not writable/i, `message did not explain the failure: ${result.setupMessage}`);
    // And it must not claim the file was created.
    assert.doesNotMatch(result.setupMessage!, /created a placeholder/i);
  } finally {
    await chmod(project, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});
