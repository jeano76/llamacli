import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { buildConfig, writeConfig, ensureLocalStack } from "./bootstrap.js";
import type { LlamaTuning } from "./tuning.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-bs-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const tuning: LlamaTuning = {
  gpuLayers: 999, threads: 6, threadsBatch: 11, contextSize: 16384,
  batchSize: 2048, ubatchSize: 512, cpuMoeLayers: 30, flashAttn: true,
  cacheTypeK: "q8_0", cacheTypeV: "q8_0", parallel: 1,
  rationale: [], gpu: null,
};

test("a hand-tuned config survives the bootstrap — the keys a user set by hand are not clobbered", async () => {
  // The bootstrap runs on EVERY launch, so "replace the config" would silently
  // delete a user's apiKey, verify commands and browser settings each time.
  const existing = {
    backend: "openai-compatible",
    apiKey: "sk-secret",
    verify: { afterEdit: { "*.py": "pytest" } },
    browser: { debugPort: 9333 },
    llama: { modelPath: "/data/mine.gguf", port: 18080 },
  };
  const next = buildConfig({
    existing,
    llama: { binPath: "/usr/bin/llama-server", source: "path", backend: "unknown" },
    modelPath: "/data/mine.gguf",
    plan: { llamaPort: 18080 },
    tuning,
  });
  assert.equal(next.apiKey, "sk-secret");
  assert.deepEqual(next.verify, existing.verify);
  assert.deepEqual(next.browser, existing.browser);
  // A `laya` block in an OLD config is deliberately NOT carried forward: the
  // feature it configures was removed, so preserving the block would imply
  // something can still act on it.
  assert.equal((next as any).laya, undefined, "a removed feature's config block was resurrected");
});

test("the backend only flips to local-llama when there is BOTH a binary and a model", () => {
  // Claiming a local backend with no modelPath is the state index.tsx treats as
  // "not configured" — it silently falls through to a dead default URL, which
  // is the exact confusing-ECONNREFUSED failure this bootstrap exists to stop.
  const noModel = buildConfig({
    existing: { backend: "openai-compatible", baseUrl: "http://127.0.0.1:8080" },
    llama: { binPath: "/usr/bin/llama-server", source: "path", backend: "unknown" },
    modelPath: "",
    plan: { llamaPort: 8080 },
    tuning,
  });
  assert.equal(noModel.backend, "openai-compatible", "unchanged without a model");

  const withModel = buildConfig({
    existing: {},
    llama: { binPath: "/usr/bin/llama-server", source: "path", backend: "unknown" },
    modelPath: "/m.gguf",
    plan: { llamaPort: 8080 },
    tuning,
  });
  assert.equal(withModel.backend, "local-llama");
});

test("the tuned llama flags reach the config, not just the log", () => {
  const cfg = buildConfig({
    existing: {},
    llama: { binPath: "/b", source: "built", backend: "cuda" },
    modelPath: "/m.gguf",
    plan: { llamaPort: 8080 },
    tuning,
  });
  assert.equal((cfg.llama as any).gpuLayers, 999);
  assert.equal((cfg.llama as any).threads, 6);
  assert.equal((cfg.llama as any).cpuMoeLayers, 30, "the MoE offload that makes an 8 GB card work");
  assert.equal((cfg.llama as any).contextSize, 16384);
  assert.equal((cfg.llama as any).parallel, 1);
});

test("writeConfig is atomic — a crash mid-write cannot leave an unparseable config", async () =>
  withTempDir(async (dir) => {
    await writeConfig(dir, { backend: "local-llama", llama: { port: 8080 } });
    const written = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.equal(written.backend, "local-llama");
    // No temp file left behind.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".llamacli"));
    assert.deepEqual(files, ["config.yaml"], `stray files: ${files.join(", ")}`);
  }));

test("an existing config is read back and merged, not discarded", async () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    await writeFile(join(dir, ".llamacli", "config.yaml"), "apiKey: sk-keepme\nbrowser:\n  debugPort: 9999\n");
    const report = await ensureLocalStack({
      projectRoot: dir,
      offline: true,
      allowBuild: false,
      hardware: {
        cpuCount: 4, ramTotalBytes: 16 * 1024 ** 3, ramAvailableBytes: 12 * 1024 ** 3,
        gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux",
      },
      probe: async () => "free",
    });
    const after = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.equal(after.apiKey, "sk-keepme", "the user's own key is still there after a bootstrap");
    assert.equal(after.browser.debugPort, 9999);
    assert.equal(report.ports?.llamaPort, 8080);
  }));

test("a bootstrap that cannot fully do its job still returns a report and a usable config", async () =>
  withTempDir(async (dir) => {
    // Offline, so no model can be resolved, and building is forbidden. The point
    // is that this RETURNS rather than throwing: a bootstrap that throws takes
    // down a working install, which is strictly worse than one that reports a
    // degraded setup and lets the app start.
    //
    // `detectServer: null` is load-bearing and was added during this change.
    // Without it the test adopted whatever happened to be listening on 8080 on
    // the machine running it — so on a dev box with a real llama-server up it
    // silently took the "existing server" path, wrote an openai-compatible
    // config with no `llama` block at all, and failed its own assertion. That
    // is precisely "testing the machine, not the code", the failure mode every
    // injectable seam in this codebase exists to prevent.
    const report = await ensureLocalStack({
      projectRoot: dir,
      offline: true,
      allowBuild: false,
      detectServer: async () => null,
      hardware: {
        cpuCount: 4, ramTotalBytes: 16 * 1024 ** 3, ramAvailableBytes: 12 * 1024 ** 3,
        gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux",
      },
      probe: async () => "free",
    });
    // No throw, and a well-formed report either way.
    assert.ok(Array.isArray(report.steps) && report.steps.length > 0);
    assert.ok(Array.isArray(report.errors));
    // Offline: no model can be resolved and none is downloaded, so the model
    // step is simply not attempted. The property that matters is the one
    // below — the config must not claim a local backend it cannot serve.
    const modelStep = report.steps.find((s) => /모델/.test(s.name));
    assert.ok(modelStep === undefined || modelStep.ok === false,
      "an offline bootstrap must not report a resolved model as OK");
    // No model, so it must NOT have claimed local-llama — that is the state
    // index.tsx treats as unconfigured and silently falls through to a dead
    // default URL.
    const after = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.notEqual(after.backend, "local-llama", "never claims a local backend it cannot serve");
    assert.ok(after.llama?.port, "ports were still decided and recorded");
    assert.ok(report.ports?.llamaPort);
  }));
