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

test("/reset still re-derives, and is NOT short-circuited by a running server", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    await writeFile(join(dir, ".llamacli", "config.yaml"), "llama:\n  contextSize: 65536\n");
    // force + a running server: adoption must be skipped, otherwise /reset
    // could never change anything on a machine that already has llamacli up —
    // which is the normal case for a user running it.
    await ensureLocalStack({
      projectRoot: dir, offline: true, allowBuild: false, force: true, hardware: hw,
      probe: async () => "free",
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "/x.gguf" }),
    });
    const cfg = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    assert.notEqual(cfg.llama?.contextSize, 65536, "/reset actually re-derived the flags");
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

// ── /reset must not transfer inside a live session ─────────────────────────

test("/reset re-derives settings without ever starting a download", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli"), { recursive: true });
    let transfers = 0;
    // A fetchImpl that counts body requests and fails them: a real transfer
    // would go through here, and the test's point is that it never does.
    const countingFetch = (async (u: any, init: any) => {
      if (init?.headers?.Range || init?.method === "POST") transfers++;
      // Serve a tiny "model list" so resolution can succeed.
      return {
        ok: true, status: 200, url: String(u),
        json: async () => ({ siblings: [{ rfilename: "M-Q4_K_M.gguf", size: 1024 }] }),
        arrayBuffer: async () => new ArrayBuffer(8),
        headers: { get: () => null },
        body: null,
      };
    }) as unknown as typeof fetch;

    await ensureLocalStack({
      projectRoot: dir,
      force: true,
      noDownload: true,
      hardware: hw,
      probe: async () => "free",
      detectServer: async () => null,
      fetchImpl: countingFetch,
    });
    assert.equal(transfers, 0, "no model bytes were transferred during a /reset");
    const cfg = parse(await readFile(join(dir, ".llamacli", "config.yaml"), "utf8"));
    // The settings ARE re-derived — that is the feature.
    assert.equal(cfg.llama?.gpuLayers, 999, "flags still re-derived");
  }));
