import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGgufArchInfo, readGgufArchInfo, isMoeModelFile, isMoeModel } from "./ggufMeta.js";
import { tuneForHardware } from "./tuning.js";
import { LlamaServerManager } from "../backend/llamaServer.js";
import { isKnownDenseFamily } from "./modelCatalog.js";
import type { Hardware } from "./hardware.js";

// ── a minimal GGUF writer, enough to build headers of either kind ───────────
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const kvStr = (k: string, v: string) => Buffer.concat([str(k), u32(8), str(v)]);
const kvU32 = (k: string, v: number) => Buffer.concat([str(k), u32(4), u32(v)]);
const kvStrArr = (k: string, vs: string[]) => Buffer.concat([str(k), u32(9), u32(8), u64(vs.length), ...vs.map(str)]);
const kvF32Arr = (k: string, n: number) => Buffer.concat([str(k), u32(9), u32(6), u64(n), Buffer.alloc(4 * n)]);

function gguf(kvs: Buffer[]) {
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length), ...kvs]);
}
const dense = () => gguf([kvStr("general.architecture", "qwen35"), kvU32("qwen35.block_count", 64), kvStrArr("tokenizer.ggml.tokens", ["a", "b"])]);
const moe = () => gguf([kvStr("general.architecture", "qwen35moe"), kvU32("qwen35moe.expert_count", 256), kvU32("qwen35moe.block_count", 40), kvStrArr("tokenizer.ggml.tokens", ["a"])]);

test("a header with expert_count is MoE", () => {
  assert.deepEqual(parseGgufArchInfo(moe()), { arch: "qwen35moe", expertCount: 256, conclusive: true });
});

test("a header with no expert_count is dense — the 27B that ran with --n-cpu-moe 32", () => {
  const r = parseGgufArchInfo(dense());
  assert.equal(r.conclusive, true);
  assert.equal(r.expertCount, undefined);
});

test("keys before the tokenizer are skipped correctly whatever their type, including arrays", () => {
  const buf = gguf([
    kvStr("general.architecture", "x"),
    kvStrArr("general.tags", ["one", "two", "three"]),
    kvF32Arr("x.some.floats", 7),
    kvU32("x.expert_count", 8),
    kvStrArr("tokenizer.ggml.tokens", ["huge"]),
  ]);
  assert.equal(parseGgufArchInfo(buf).expertCount, 8);
});

test("anything that is not a readable GGUF is inconclusive, never a guess", () => {
  assert.equal(parseGgufArchInfo(Buffer.from("not a gguf at all, just text....")).conclusive, false);
  assert.equal(parseGgufArchInfo(dense().subarray(0, 30)).conclusive, false, "truncated mid-key");
  assert.equal(parseGgufArchInfo(Buffer.alloc(0)).conclusive, false);
});

async function withFile(buf: Buffer, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "gg-"));
  try { const p = join(dir, "m.gguf"); await writeFile(p, buf); await fn(p); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("isMoeModelFile: MoE true, dense false, missing file undefined", async () => {
  await withFile(moe(), async (p) => assert.equal(await isMoeModelFile(p), true));
  await withFile(dense(), async (p) => assert.equal(await isMoeModelFile(p), false));
  assert.equal(await isMoeModelFile("/nonexistent/m.gguf"), undefined);
});

test("isMoeModel: header beats catalogue; catalogue beats name; unknown stays unknown", async () => {
  await withFile(dense(), async (p) => assert.equal(await isMoeModel({ path: p, activeParamB: 3 }), false, "the file says dense"));
  assert.equal(await isMoeModel({ path: "/nonexistent", activeParamB: 3 }), true);
  assert.equal(await isMoeModel({ dense: true }), false);
  assert.equal(await isMoeModel({ filename: "Ornith-1.5-35B-A3B-Q4_K_M.gguf" }), true);
  assert.equal(await isMoeModel({ filename: "Ornith-1.5-35B-Q6_K.gguf" }), undefined, "the same MoE, but nothing in the name says so");
  assert.equal(await isMoeModel({}), undefined);
});

test("known dense families", () => {
  assert.equal(isKnownDenseFamily("Ternary-Bonsai-2-27B-PTQ1_0.gguf"), true);
  assert.equal(isKnownDenseFamily("Ornith-1.5-9B-Q4_K_M.gguf"), true);
  assert.equal(isKnownDenseFamily("Ornith-1.5-35B-A3B-Q4_K_M.gguf"), false);
});

// ── the tuner ───────────────────────────────────────────────────────────────
const GiB = 1024 ** 3;
const hw: Hardware = {
  cpuCount: 12, ramTotalBytes: 31 * GiB, ramAvailableBytes: 20 * GiB, gpuBackend: "cuda", canBuildCuda: false, tools: {}, platform: "linux",
  gpus: [{ index: 0, name: "RTX 2070 SUPER", vramTotalBytes: 8 * GiB, vramFreeBytes: 8 * GiB }],
};

test("a dense model on a small card gets NO --n-cpu-moe (this was 32 for the 5.5 GiB 27B)", () => {
  const t = tuneForHardware(hw, { modelBytes: 5.54 * GiB, moe: false });
  assert.equal(t.cpuMoeLayers, 0);
  assert.ok(t.rationale.some((r) => /밀집\(dense\)/.test(r)));
});

test("the same card and a MoE model still gets expert streaming — behaviour unchanged", () => {
  assert.ok(tuneForHardware(hw, { modelBytes: 20.4 * GiB, moe: true }).cpuMoeLayers > 0);
  assert.ok(tuneForHardware(hw, { modelBytes: 20.4 * GiB }).cpuMoeLayers > 0, "unknown keeps the old behaviour");
});

test("a measured value carried over from a previous MoE model is dropped for a dense one", () => {
  const t = tuneForHardware(hw, { modelBytes: 5.54 * GiB, cpuMoeLayers: 32, moe: false });
  assert.equal(t.cpuMoeLayers, 0);
  assert.ok(t.rationale.some((r) => /이전 모델의 --n-cpu-moe 32/.test(r)));
});

test("a measured value for a MoE model is still honoured", () => {
  assert.equal(tuneForHardware(hw, { modelBytes: 20.4 * GiB, cpuMoeLayers: 30, moe: true }).cpuMoeLayers, 30);
});

// ── the launch guard: every path goes through LlamaServerManager.start ──────
async function launchedArgs(modelBuf: Buffer, cpuMoeLayers: number): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "mgr-"));
  try {
    const model = join(dir, "m.gguf");
    await writeFile(model, modelBuf);
    const bin = join(dir, "fake-llama-server");
    // Records its arguments and exits at once: start() then rejects, which is fine here.
    await writeFile(bin, `#!/bin/sh\necho "$@" > ${join(dir, "args.txt")}\nexit 1\n`);
    await chmod(bin, 0o755);
    const m = new LlamaServerManager({ binPath: bin, modelPath: model, host: "127.0.0.1", port: 59123, contextSize: 4096, threads: 2, gpuLayers: 99, cpuMoeLayers });
    await m.start().catch(() => {});
    return (await readFile(join(dir, "args.txt"), "utf8")).trim().split(/\s+/);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("launch: a stale cpuMoeLayers is NOT passed to a dense model", async () => {
  assert.ok(!(await launchedArgs(dense(), 32)).includes("--n-cpu-moe"));
});

test("launch: a MoE model still gets the flag", async () => {
  const args = await launchedArgs(moe(), 32);
  assert.equal(args[args.indexOf("--n-cpu-moe") + 1], "32");
});

test("launch: a file whose header cannot be read is left as configured (unknown ≠ dense)", async () => {
  assert.ok((await launchedArgs(Buffer.from("garbage"), 32)).includes("--n-cpu-moe"));
});
