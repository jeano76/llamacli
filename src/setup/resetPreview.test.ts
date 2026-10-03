import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewReset } from "./resetPreview.js";

const GiB = 1024 ** 3;
const hw8 = {
  cpuCount: 12, ramTotalBytes: 32 * GiB, ramAvailableBytes: 24 * GiB,
  gpus: [{ index: 0, name: "NVIDIA RTX 2070", vramTotalBytes: 8 * GiB, vramFreeBytes: 7.5 * GiB }],
  gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
} as never;

test("preview shows a hand-raised context being re-derived, and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-prev-"));
  try {
    const f = join(dir, "Ornith-1.5-9B-Q4_K_M.gguf");
    await writeFile(f, Buffer.alloc(4096));
    const config = { model: f, llama: { modelPath: f, contextSize: 98304, gpuLayers: 999, threads: 6, port: 8084 } };
    const before = JSON.stringify(config);
    const p = await previewReset({ config, hardware: hw8 });
    assert.equal(p.repicksModel, false);
    assert.equal(p.keepsModel, f, "the selected model is not part of what changes");
    assert.ok(p.changes.some((c) => /컨텍스트: 98,304 토큰 →/.test(c)), p.changes.join("\n"));
    assert.equal(JSON.stringify(config), before, "the config object is untouched");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preview with no model file says the reset would pick one", async () => {
  const p = await previewReset({ config: { model: "/gone/x.gguf", llama: { modelPath: "/gone/x.gguf" } }, hardware: hw8 });
  assert.equal(p.repicksModel, true);
  assert.deepEqual(p.changes, []);
});
