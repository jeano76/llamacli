import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalStack } from "./bootstrap.js";

// The engine (llama-server) used to be acquired BEFORE the running-server check and
// BEFORE the model choice. These pin the new order: engine last, and only the one
// the model needs.

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-engine-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const hw = {
  cpuCount: 12, ramTotalBytes: 30 * 1024 ** 3, ramAvailableBytes: 26 * 1024 ** 3,
  gpus: [{ index: 0, name: "RTX 2070", vramTotalBytes: 8 * 1024 ** 3, vramFreeBytes: 7 * 1024 ** 3 }],
  gpuBackend: "cuda" as const, canBuildCuda: true, tools: {}, platform: "linux",
};

/** An env in which no llama-server can be found anywhere. */
const emptyEnv = (dir: string) => ({ HOME: join(dir, "home"), PATH: "" }) as NodeJS.ProcessEnv;

function spies() {
  const calls = { stock: 0, ternary: 0 };
  return {
    calls,
    acquireStock: (async () => { calls.stock++; return { binPath: "/fake/stock/llama-server", backend: "cuda", source: "downloaded", attempts: [] }; }) as never,
    acquireTernary: (async () => { calls.ternary++; return { binPath: "/fake/prism/llama-server", backend: "cuda", attempts: [] }; }) as never,
  };
}

test("a running server means NO engine is downloaded or compiled, even with no llama-server installed", () =>
  withTempDir(async (dir) => {
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "found" as const, server: { baseUrl: "http://127.0.0.1:8080", model: "/m/x.gguf" } }),
      fetchImpl: (async () => { throw new Error("no network"); }) as never,
      acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
    });
    assert.ok(report.ok);
    assert.deepEqual(s.calls, { stock: 0, ternary: 0 });
  }));

test("an ordinary configured model with no engine installed gets the STOCK engine only", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    // Nested deep: the model-adjacent search climbs a few levels, and must stay inside
    // this temp dir rather than wander into /tmp and find another test's leftovers.
    const mdir = join(dir, "a", "b", "c", "d");
    await mkdir(mdir, { recursive: true });
    const model = join(mdir, "Ornith-1.5-9B-Q4_K_M.gguf");
    await writeFile(model, Buffer.alloc(4096));
    await writeFile(join(dir, ".llamacli", "config.yaml"), `model: ${model}\nllama:\n  modelPath: ${model}\n`);
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
    });
    assert.deepEqual(s.calls, { stock: 1, ternary: 0 }, JSON.stringify(report.steps.map((x) => [x.name, x.ok, x.detail])));
    assert.equal(report.llama?.binPath, "/fake/stock/llama-server");
  }));

test("first launch where the CHOSEN model is Bonsai acquires only the fork — stock is never built and thrown away", () =>
  withTempDir(async (dir) => {
    // No config at all: the engine used to be settled before any model was chosen, so this
    // compiled stock llama.cpp and then fetched the fork on top of it.
    const modelsDir = join(dir, "models");
    await mkdir(modelsDir, { recursive: true });
    await writeFile(join(modelsDir, "Ternary-Bonsai-2-27B-PTQ1_0.gguf"), Buffer.alloc(4096));
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.includes("/api/models/prism-ml/Ternary-Bonsai-2-27B-gguf")) {
        return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", size: 4096 }] }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;
    const s = spies();
    await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      modelsDir, fetchImpl, acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
    });
    assert.equal(s.calls.stock, 0, "stock llama.cpp must not be acquired for a ternary model");
    assert.ok(s.calls.ternary >= 1);
  }));

test("offline with no engine reports it, and acquires nothing", () =>
  withTempDir(async (dir) => {
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), offline: true, probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }),
      acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
    });
    assert.deepEqual(s.calls, { stock: 0, ternary: 0 });
    assert.ok(report.steps.some((x) => x.name === "llama.cpp" && !x.ok));
  }));
