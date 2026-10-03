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
import { EXE, writeFakeExe } from "../testSupport.js";

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
    const bin = join(dir, `fake-llama-server${EXE}`);
    // Records its arguments and exits at once: start() then rejects, which is fine here.
    await writeFakeExe(bin, { argsFile: join(dir, "args.txt"), exit: 1 });
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

// ── KV shape (what the cache really costs) ──────────────────────────────────
import { parseGgufKeys, kvShapeFromKeys, kvBytesPerElement, readGgufKvShape } from "./ggufMeta.js";


const kvU32Arr = (k: string, vs: number[]) => Buffer.concat([str(k), u32(9), u32(4), u64(vs.length), ...vs.map(u32)]);

const hybridKeys = () => parseGgufKeys(gguf([
  kvStr("general.architecture", "qwen35moe"),
  kvU32("qwen35moe.block_count", 40), kvU32("qwen35moe.attention.head_count", 16), kvU32("qwen35moe.attention.head_count_kv", 2),
  kvU32("qwen35moe.attention.key_length", 256), kvU32("qwen35moe.attention.value_length", 256),
  kvU32("qwen35moe.full_attention_interval", 4), kvStrArr("tokenizer.ggml.tokens", ["a"]),
]))!;

test("a hybrid keeps a KV cache on only every Nth layer — Qwen3.6-35B-A3B: 10 of 40", () => {
  const s = kvShapeFromKeys(hybridKeys())!;
  assert.equal(s.attentionLayers, 10);
  assert.equal(s.hybrid, true);
  assert.equal(s.elementsPerToken, 10 * 2 * (256 + 256));        // 10240
  assert.ok(Math.abs(s.elementsPerToken * kvBytesPerElement("q8_0") / 1024 - 10.6) < 0.1, "10.6 KB/token at q8_0");
});

test("a plain transformer counts every layer", () => {
  const keys = parseGgufKeys(gguf([
    kvStr("general.architecture", "llama"), kvU32("llama.block_count", 32), kvU32("llama.attention.head_count", 32),
    kvU32("llama.attention.head_count_kv", 8), kvU32("llama.embedding_length", 4096), kvStrArr("tokenizer.ggml.tokens", ["a"]),
  ]))!;
  const s = kvShapeFromKeys(keys)!;
  assert.equal(s.hybrid, false);
  assert.equal(s.elementsPerToken, 32 * 8 * (128 + 128), "head dim falls back to embedding_length / head_count");
});

test("no head_count_kv means multi-head attention: every head keeps a cache", () => {
  const keys = parseGgufKeys(gguf([
    kvStr("general.architecture", "x"), kvU32("x.block_count", 4), kvU32("x.attention.head_count", 8), kvU32("x.embedding_length", 1024),
    kvStrArr("tokenizer.ggml.tokens", ["a"]),
  ]))!;
  assert.equal(kvShapeFromKeys(keys)!.elementsPerToken, 4 * 8 * (128 + 128));
});

test("a per-layer head_count_kv array is summed exactly (a layer with 0 heads keeps nothing)", () => {
  const keys = parseGgufKeys(gguf([
    kvStr("general.architecture", "x"), kvU32("x.block_count", 4), kvU32("x.attention.head_count", 8),
    kvU32Arr("x.attention.head_count_kv", [2, 0, 2, 0]), kvU32("x.attention.key_length", 64), kvU32("x.attention.value_length", 64),
    kvStrArr("tokenizer.ggml.tokens", ["a"]),
  ]))!;
  assert.equal(kvShapeFromKeys(keys)!.elementsPerToken, (2 + 0 + 2 + 0) * 128);
});

test("a header missing what is needed gives undefined, never a made-up number", () => {
  assert.equal(kvShapeFromKeys({ "general.architecture": "x" }), undefined);
  assert.equal(kvShapeFromKeys({ "general.architecture": "x", "x.block_count": 4 }), undefined);
  assert.equal(parseGgufKeys(Buffer.from("not gguf at all, nothing to read here....")), null);
});

test("bytes per element of the KV cache types", () => {
  assert.equal(kvBytesPerElement("f16"), 2);
  assert.equal(kvBytesPerElement("q8_0"), 34 / 32);
  assert.equal(kvBytesPerElement("q4_0"), 18 / 32);
  assert.equal(kvBytesPerElement("something-new"), 2, "unknown assumes the largest sane one");
});

test("readGgufKvShape on a missing file is undefined, not a throw", async () => {
  assert.equal(await readGgufKvShape("/nonexistent/m.gguf"), undefined);
});

// ── the tuner ───────────────────────────────────────────────────────────────
const QWEN_ELEMENTS = 10240, DENSE_ELEMENTS = 32768;

test("tuner: Qwen3.6's real KV cost lifts the context from the size-guess's 20,480 to the 98,304 exact-KV ceiling", () => {
  const guessed = tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true });
  const exact = tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true, kvElementsPerToken: QWEN_ELEMENTS });
  assert.equal(guessed.contextSize, 20480, "the old behaviour (what the field config had)");
  assert.equal(exact.contextSize, 98304);
  assert.ok(exact.rationale.some((r) => /모델 헤더에서 읽은 실제 값/.test(r)));
});

test("tuner: a dense model's weights are reserved before the (now larger) KV term, and expert streaming stays at the cap", () => {
  // 5.54 GiB resident + 98,304 tokens of a 32k-element KV (~3.4 GiB) would not fit this card; the weights come first.
  const dense = tuneForHardware(hw, { modelBytes: 5.54 * GiB, moe: false, kvElementsPerToken: DENSE_ELEMENTS }).contextSize;
  assert.ok(dense >= 4096 && dense < 98304, `dense ctx ${dense}`);
  assert.equal(tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true, kvElementsPerToken: QWEN_ELEMENTS }).cpuMoeLayers, 32);
});

test("tuner: without a header nothing changes (legacy estimate and legacy cpu-moe term)", () => {
  const t = tuneForHardware(hw, { modelBytes: 20.4 * GiB });
  assert.equal(t.contextSize, 20480);
  assert.equal(t.cpuMoeLayers, 32);
});

test("tuner: a recorded context LARGER than the derived one is kept (the measured 98,304)", () => {
  const t = tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true, kvElementsPerToken: QWEN_ELEMENTS, contextSize: 131072 });
  assert.equal(t.contextSize, 131072);
  assert.ok(t.rationale.some((r) => /131072.*그대로 유지/.test(r)));
});

test("tuner: a recorded context SMALLER than the derived one is just an old derivation and is replaced", () => {
  const t = tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true, kvElementsPerToken: QWEN_ELEMENTS, contextSize: 20480 });
  assert.equal(t.contextSize, 98304);
});

test("tuner: a MoE that barely overflows the card needs far fewer CPU experts once the KV term is exact", () => {
  // 9 GiB MoE on an 8 GiB card, 1 KB/token: the legacy term charged 9.6 GiB of KV and called it a 32-layer problem.
  const legacy = tuneForHardware(hw, { modelBytes: 9 * GiB, moe: true });
  const exact = tuneForHardware(hw, { modelBytes: 9 * GiB, moe: true, kvElementsPerToken: 1024 });
  assert.ok(exact.cpuMoeLayers > 0 && exact.cpuMoeLayers < legacy.cpuMoeLayers, `${exact.cpuMoeLayers} vs ${legacy.cpuMoeLayers}`);
});

test("tuner: the KV precision still follows the budget, and q4_0 halves the exact cost", () => {
  const small: Hardware = { ...hw, gpus: [{ index: 0, name: "tiny", vramTotalBytes: 3.5 * GiB, vramFreeBytes: 3.5 * GiB }] };
  const t = tuneForHardware(small, { modelBytes: 2 * GiB, moe: false, kvElementsPerToken: 20000 });
  assert.equal(t.cacheTypeK, "q4_0");
});

test("tuner: the exact-KV ceiling never exceeds the context the model was trained for", () => {
  const t = tuneForHardware(hw, { modelBytes: 20.61 * GiB, moe: true, kvElementsPerToken: QWEN_ELEMENTS, trainedContext: 40960 });
  assert.equal(t.contextSize, 40960);
});

test("tuner: without exact KV (no header) the conservative 32,768 ceiling still applies", () => {
  assert.ok(tuneForHardware(hw, { modelBytes: 20.4 * GiB }).contextSize <= 32768);
});

test("tuner: a dense model bigger than the card is offloaded partially, not with -ngl 999", () => {
  const card: Hardware = { ...hw, gpus: [{ index: 0, name: "NVIDIA small", vramTotalBytes: 4 * GiB, vramFreeBytes: 3.7 * GiB }] };
  const t = tuneForHardware(card, { modelBytes: 5.1 * GiB, moe: false, kvElementsPerToken: QWEN_ELEMENTS, modelLayers: 32 });
  assert.ok(t.gpuLayers > 0 && t.gpuLayers < 32, `ngl ${t.gpuLayers}`);
  assert.ok(t.rationale.some((r) => /층만 GPU/.test(r)));
  // A model that fits keeps the full offload.
  const fits = tuneForHardware(hw, { modelBytes: 5.1 * GiB, moe: false, kvElementsPerToken: QWEN_ELEMENTS, modelLayers: 32 });
  assert.equal(fits.gpuLayers, 999);
});
