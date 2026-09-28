import { test } from "node:test";
import assert from "node:assert/strict";
import { keepUserOwnedKeys, buildConfig } from "./bootstrap.js";
import { ensureLocalStack } from "./bootstrap.js";
import { parse } from "yaml";
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeReset } from "./resetDiff.js";

const hw = {
  cpuCount: 8, ramTotalBytes: 32 * 1024 ** 3, ramAvailableBytes: 28 * 1024 ** 3,
  gpus: [{ index: 0, name: "Test GPU", vramTotalBytes: 8 * 1024 ** 3, vramFreeBytes: 7 * 1024 ** 3 }],
  gpuBackend: "cuda" as const, canBuildCuda: true, tools: {}, platform: "linux",
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-reset-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// ── What /reset must and must not throw away ────────────────────────────────

test("reset keeps the keys a human typed, and drops only the machine-derived ones", () => {
  const before = {
    apiKey: "sk-mine",
    verify: { afterEdit: { "*.py": "pytest" } },
    browser: { debugPort: 9333 },
    enableThinking: true,
    checkpoint: { git: true },
    compaction: { autoTriggerRatio: 0.5, autoResume: false, summaryMaxTokens: 2048 },
    laya: { enabled: true, port: 9999, confidenceThreshold: 0.9 },
    model: "/old/model.gguf",
    backend: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080",
    llama: { contextSize: 65536, gpuLayers: 0, threads: 32, port: 8081 },
  };
  const kept = keepUserOwnedKeys(before)!;
  // User-owned: preserved.
  assert.equal(kept.apiKey, "sk-mine");
  assert.deepEqual(kept.verify, before.verify);
  assert.deepEqual(kept.browser, before.browser);
  assert.equal(kept.enableThinking, true);
  assert.deepEqual(kept.checkpoint, before.checkpoint);
  assert.equal(kept.compaction?.autoTriggerRatio, 0.5);
  assert.equal(kept.compaction?.summaryMaxTokens, 2048);
  // The laya gate is a deliberate toggle, not a derived value.
  assert.equal(kept.laya?.enabled, true);
  // Machine-derived: gone — this is the feature.
  assert.equal(kept.model, undefined);
  assert.equal(kept.backend, undefined);
  assert.equal(kept.baseUrl, undefined);
  assert.equal(kept.llama, undefined);
  assert.equal(kept.laya?.port, undefined, "the port is re-derived");
  assert.equal(kept.laya?.confidenceThreshold, undefined);
});

test("reset on a config with nothing in it is safe", () => {
  assert.equal(keepUserOwnedKeys(undefined), undefined);
  assert.deepEqual(keepUserOwnedKeys({}), {});
});

// ── End to end through the real bootstrap ───────────────────────────────────

test("/reset recomputes the llama settings from the current hardware", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    await writeFile(
      join(dir, ".llamacli", "config.yaml"),
      "apiKey: sk-keepme\nmodel: /stale/model.gguf\nllama:\n  contextSize: 65536\n  gpuLayers: 0\n  threads: 32\n"
    );
    // Offline so no 20 GB transfer is attempted; the point is the settings.
    await ensureLocalStack({ projectRoot: dir, offline: true, allowBuild: false, hardware: hw, probe: async () => "free", detectServer: async () => null });
    const before = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    // NOTE: a normal launch ALSO re-derives the llama tuning — the bootstrap is
    // authoritative over those fields, which is what "시스템에 맞는 설정으로"
    // asks for. So /reset's distinguishing work is re-resolving the MODEL and
    // the ports, not the flags. Asserted here so the distinction is on record
    // rather than assumed.
    assert.notEqual(before.llama.contextSize, 65536, "a normal launch re-derives context too");

    await ensureLocalStack({ projectRoot: dir, offline: true, allowBuild: false, force: true, hardware: hw, probe: async () => "free", detectServer: async () => null });
    const after = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));

    assert.equal(after.apiKey, "sk-keepme", "the user's key survives a reset");
    assert.notEqual(after.llama.contextSize, 65536, "the hand-tuned context was re-derived");
    assert.notEqual(after.llama.threads, 32, "so was the thread count");
    assert.equal(after.llama.gpuLayers, 999, "an 8 GB card with a GPU offloads to it, not 0");
    assert.ok(after.llama.port, "and a port is recorded");
  }));

test("reset is a no-op on an already-optimal machine, and says so rather than failing", () =>
  withTempDir(async (dir) => {
    const run = () => ensureLocalStack({ projectRoot: dir, offline: true, allowBuild: false, force: true, hardware: hw, probe: async () => "free", detectServer: async () => null });
    await run();
    const first = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    await run();
    const second = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    // Idempotent: a second reset on the same hardware changes nothing. This is
    // the "already optimal" case the UI reports, and it must be genuinely
    // stable rather than drifting a little on each run.
    assert.deepEqual(second.llama, first.llama);
  }));

test("a normal launch does NOT force a reset — the bootstrap stays idempotent", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    await writeFile(join(dir, ".llamacli", "config.yaml"), "llama:\n  port: 18080\nlaya:\n  port: 18099\n");
    await ensureLocalStack({ projectRoot: dir, offline: true, allowBuild: false, hardware: hw, probe: async () => "free", detectServer: async () => null });
    const after = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    // Ports are inherited, not re-picked: an established install must not be
    // migrated to a different port on a routine launch. (The llama FLAGS are
    // re-derived on every launch - see the note in the test above.)
    assert.equal(after.llama?.port, 18080, "a normal launch keeps the established port");
    assert.equal(after.laya?.port, 18099);
  }));

test("the config diff names the fields that actually changed", () => {
  const changed = describeReset(
    { model: "/new.gguf", llama: { gpuLayers: 999, threads: 6, contextSize: 16384, port: 8080 }, laya: { port: 8099 }, baseUrl: "http://127.0.0.1:8080" },
    { model: "/old.gguf", llama: { gpuLayers: 0, threads: 32, contextSize: 65536, port: 8080 }, laya: { port: 8000 }, baseUrl: "http://127.0.0.1:8080" }
  );
  assert.equal(changed.length, 5, "model, 3 llama flags, laya.port");
  assert.ok(changed.some((c) => c.includes("gpuLayers: 0 → 999")));
  assert.ok(changed.some((c) => c.includes("threads: 32 → 6")));
  assert.ok(changed.some((c) => c.includes("모델: /old.gguf → /new.gguf")));
  // An unchanged field is not reported.
  assert.ok(!changed.some((c) => c.includes("baseUrl")));
});

test("an unchanged reset reports no differences at all, so 'nothing changed' is legible", () => {
  const same = { model: "/m.gguf", llama: { gpuLayers: 999, threads: 6, contextSize: 16384, port: 8080 }, laya: { port: 8099 }, baseUrl: "http://127.0.0.1:8080", backend: "local-llama" };
  assert.deepEqual(describeReset(same, same), []);
});

// `writeConfig` was the one call in ensureLocalStack that was not wrapped in
// the error-catching `step()` helper, so it could throw straight out of the
// function — contradicting this module's own contract that a bootstrap
// "degrades instead of failing". A read-only project directory made
// `mkdir .llamacli` fail with EACCES and the entire bootstrap reject, taking
// down a working install. Found by a project-axis sweep over 100 project
// states. Same defect, one layer up, was in config.ts's loadConfig.
test("ensureLocalStack reports an unwritable project instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-ro-"));
  const project = join(dir, "project");
  await mkdir(project);
  await chmod(project, 0o555);
  // Probe with a THROWAWAY name, not `.llamacli`. The first version of this
  // test probed with the real name, so on any system where the mkdir SUCCEEDED
  // it left a real `.llamacli` behind and the bootstrap then wrote to it
  // successfully -- the test passed without ever exercising an unwritable
  // directory. It now verifies the precondition without disturbing the thing
  // under test.
  const writable = await mkdir(join(project, ".probe-canary")).then(
    () => true,
    () => false
  );
  if (writable) {
    await rm(join(project, ".probe-canary"), { recursive: true, force: true });
  }
  // Where the mode bit cannot be enforced (root ignores it, or an fs that does
  // not honour it) there is no unwritable directory to test against, so the
  // case is skipped rather than asserted vacuously.
  if (writable) {
    await chmod(project, 0o755);
    await rm(dir, { recursive: true, force: true });
    return;
  }
  try {
    const report = await ensureLocalStack({
      projectRoot: project,
      offline: true,
      allowBuild: false,
      hardware: hw,
      probe: async () => "free",
      detectServer: async () => null,
    });
    // A report must still come back, and it must be usable.
    assert.ok(report.config, "expected the derived config to be returned even when it cannot be saved");
    assert.ok(Array.isArray(report.steps) && report.steps.length > 0);
    // The failure must be reported, not swallowed: losing the write means the
    // next launch redoes all of this work.
    const saveStep = report.steps.find((s) => s.name === "설정 저장");
    assert.ok(saveStep, "expected a config-write step");
    assert.equal(saveStep.ok, false, "expected the config write to be reported as failed");
    assert.ok(report.errors.some((e) => /설정 저장/.test(e)), `errors did not mention the failure: ${JSON.stringify(report.errors)}`);
  } finally {
    await chmod(project, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});
