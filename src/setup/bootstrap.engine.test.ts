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

// ── a pinned (selected) model is downloaded as chosen ───────────────────────

test("pinModelFilename: selecting the 8B downloads the 8B even though the hardware picker would take the 27B", () =>
  withTempDir(async (dir) => {
    const modelsDir = join(dir, "models");
    await mkdir(modelsDir, { recursive: true });
    // Present, so the "download" is a no-op — what is under test is WHICH model is chosen.
    await writeFile(join(modelsDir, "Ternary-Bonsai-8B-PQ2_0.gguf"), Buffer.alloc(4096));
    const siblings = (files: [string, number][]) => ({ siblings: files.map(([rfilename, size]) => ({ rfilename, size })) });
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;
      if (u.includes("Ternary-Bonsai-2-27B-gguf")) return ok(siblings([["Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5_500_000_000]]));
      if (u.includes("Ternary-Bonsai-8B-gguf")) return ok(siblings([["Ternary-Bonsai-8B-PQ2_0.gguf", 4096], ["Ternary-Bonsai-8B-F16.gguf", 16_000_000_000]]));
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      modelsDir, fetchImpl, acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
      pinModelFilename: "Ternary-Bonsai-8B-PTQ1_0.gguf",
    });
    assert.match(report.model?.candidate.filename ?? "", /^Ternary-Bonsai-8B-/, JSON.stringify(report.steps));
    assert.ok(!/27B/.test(report.model?.candidate.filename ?? ""));
    assert.match(report.model?.reason ?? "", /선택한 모델/);
  }));

test("pinModelFilename: a family the Hub does not have FAILS the step instead of downloading something else", () =>
  withTempDir(async (dir) => {
    const fetchImpl = (async (url: any) => {
      if (String(url).includes("Ternary-Bonsai-2-27B-gguf")) {
        return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", size: 5_500_000_000 }] }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      modelsDir: join(dir, "models"), fetchImpl, acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
      pinModelFilename: "Ternary-Bonsai-8B-PTQ1_0.gguf",
    });
    assert.equal(report.model, undefined, "no model was chosen on the user's behalf");
    const step = report.steps.find((x) => x.name === "모델 결정");
    assert.equal(step?.ok, false);
    assert.match(step?.detail ?? "", /다른 모델로 바꿔 받지 않습니다/);
  }));

function hub8b(resolved: string[]) {
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("/resolve/")) { resolved.push(u); return { ok: false, status: 500, json: async () => ({}), headers: new Headers() } as any; }
    if (u.includes("Ternary-Bonsai-8B-gguf")) {
      return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ternary-Bonsai-8B-PQ2_0.gguf", size: 2_000_000_000 }] }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as unknown as typeof fetch;
}

test("the same model already on ANOTHER disk is reused: no download request is made, and the config points at it", () =>
  withTempDir(async (dir) => {
    const resolved: string[] = [];
    const s = spies();
    const elsewhere = "/mnt/disk2/models/Ternary-Bonsai-8B-PQ2_0.gguf";
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }),
      // The lister is asked about every model directory; the model is in one of them.
      listExistingModels: async (d) => (d.endsWith("/models") ? [{ path: elsewhere, sizeBytes: 2_000_000_000 }] : []),
      modelsDir: join(dir, "models"), fetchImpl: hub8b(resolved), acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
      pinModelFilename: "Ternary-Bonsai-8B-PTQ1_0.gguf",
    });
    assert.deepEqual(resolved, [], "nothing was fetched");
    assert.equal(report.modelPath, elsewhere);
    const step = report.steps.find((x) => x.name === "모델 다운로드");
    assert.equal(step?.ok, true);
    assert.match(step?.detail ?? "", /재사용/);
  }));

test("when the model is NOT anywhere, the download is attempted (control for the test above)", () =>
  withTempDir(async (dir) => {
    const resolved: string[] = [];
    const s = spies();
    await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      modelsDir: join(dir, "models"), fetchImpl: hub8b(resolved), acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
      pinModelFilename: "Ternary-Bonsai-8B-PTQ1_0.gguf",
    });
    assert.ok(resolved.length > 0, "the control must reach the download, or the test above proves nothing");
  }));

test("a FAILED download leaves modelPath unset — it must not point at a file that was never written", () =>
  withTempDir(async (dir) => {
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.includes("/resolve/")) throw new Error("connection reset");
      if (u.includes("Ternary-Bonsai-8B-gguf")) {
        return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "Ternary-Bonsai-8B-PQ2_0.gguf", size: 2_000_000_000 }] }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;
    const s = spies();
    const report = await ensureLocalStack({
      projectRoot: dir, hardware: hw, env: emptyEnv(dir), probe: async () => "free",
      detectServer: async () => ({ kind: "none" as const }), listExistingModels: async () => [],
      modelsDir: join(dir, "models"), fetchImpl, acquireStock: s.acquireStock, acquireTernary: s.acquireTernary,
      pinModelFilename: "Ternary-Bonsai-8B-PTQ1_0.gguf",
    });
    const step = report.steps.find((x) => x.name === "모델 다운로드");
    assert.equal(step?.ok, false);
    assert.equal(report.modelPath ?? "", "", `modelPath must stay empty, got ${report.modelPath}`);
  }));
