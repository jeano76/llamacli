import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ensureLocalStack } from "./bootstrap.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-order-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const hw = {
  cpuCount: 12, ramTotalBytes: 30 * 1024 ** 3, ramAvailableBytes: 26 * 1024 ** 3,
  gpus: [{ index: 0, name: "RTX 2070", vramTotalBytes: 8 * 1024 ** 3, vramFreeBytes: 7 * 1024 ** 3 }],
  gpuBackend: "cuda" as const, canBuildCuda: true, tools: {}, platform: "linux",
};

// ── The ordering bug, as it actually happened ───────────────────────────────

test("a running server short-circuits BEFORE any Hub lookup — no download is attempted", () =>
  withTempDir(async (dir) => {
    // A fetchImpl that FAILS on any use stands in for "the network is not
    // there / is very slow". If model resolution happened before the adoption
    // check, this would throw or hang instead of quietly adopting.
    let fetches = 0;
    const explodingFetch = (async (u: any) => {
      fetches++;
      throw new Error(`unexpected network access: ${u}`);
    }) as unknown as typeof fetch;

    const report = await ensureLocalStack({
      projectRoot: dir,
      hardware: hw,
      probe: async () => "free",
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "/media/usb/models/Ornith-A3B-Q4_K_M.gguf" }),
      fetchImpl: explodingFetch,
    });

    assert.equal(fetches, 0, "no Hub search, no model probe, no download");
    assert.ok(report.steps.some((s) => s.name === "기존 서버 연결"));
    const cfg = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.equal(cfg.model, "/media/usb/models/Ornith-A3B-Q4_K_M.gguf",
      "the model comes from the running server, not from a Hub search");
    assert.equal(cfg.backend, "openai-compatible");
  }));

test("the adoption path is taken even when the served model file is NOT in the models directory", () =>
  withTempDir(async (dir) => {
    // This is the exact shape that caused a 20 GB re-download: the file the
    // server is serving has a different name and byte count from the one the
    // Hub publishes, so no on-disk "equivalent" check can ever match it — while
    // the server serving it is up the whole time.
    const report = await ensureLocalStack({
      projectRoot: dir,
      hardware: hw,
      probe: async () => "free",
      modelsDir: "/nowhere/empty",
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "/some/other/place/old-build.gguf" }),
      fetchImpl: (async () => { throw new Error("must not reach the network"); }) as unknown as typeof fetch,
    });
    assert.ok(report.ok);
    assert.equal(report.ports?.llamaPort, 8080);
    const cfg = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.equal(cfg.model, "/some/other/place/old-build.gguf");
  }));

// ── Idempotence: the question actually asked ───────────────────────────────

test("a second launch with everything in place does no network work at all", () =>
  withTempDir(async (dir) => {
    const run = () => ensureLocalStack({
      projectRoot: dir, hardware: hw, probe: async () => "free",
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "/models/m.gguf" }),
      fetchImpl: (async () => { throw new Error("must not reach the network on a set-up machine"); }) as unknown as typeof fetch,
    });
    await run();
    const first = await readFile(join(dir, ".llamacli", "config.yaml"), "utf8");
    await run();
    const second = await readFile(join(dir, ".llamacli", "config.yaml"), "utf8");
    assert.equal(second, first, "byte-identical: a set-up machine does no work on launch");
  }));

