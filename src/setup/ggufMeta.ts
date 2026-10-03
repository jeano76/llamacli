/**
 * What kind of model is this file — read from the GGUF header, not guessed from its name.
 *
 * `--n-cpu-moe` moves MoE *expert* tensors to the CPU. On a dense model there are none, so the
 * flag does nothing — except that the tuner reported a layer count for it and the config kept
 * recording one (a dense 27B ran with `--n-cpu-moe 32`). The model's own header settles it: an
 * MoE model declares `<arch>.expert_count`. A filename cannot: `Ornith-1.5-35B-Q6_K.gguf` is the
 * same 35B-A3B MoE as `Ornith-1.5-35B-A3B-Q4_K_M.gguf`, and nothing in it says so.
 */

import { open } from "node:fs/promises";

export interface GgufArchInfo {
  arch?: string;
  /** Number of experts; absent or 0 for a dense model. */
  expertCount?: number;
  /** True only when the header was parsed far enough to be sure of the answer. */
  conclusive: boolean;
}

// GGUF value type ids.
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 } as const;
const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Reader {
  off = 0;
  constructor(private buf: Buffer) {}
  need(n: number) {
    if (this.off + n > this.buf.length) throw new RangeError("header truncated");
  }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { this.need(8); const v = Number(this.buf.readBigUInt64LE(this.off)); this.off += 8; return v; }
  str() {
    const len = this.u64();
    if (len > 1 << 20) throw new RangeError("implausible string length");
    this.need(len);
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }
  skip(n: number) { this.need(n); this.off += n; }
  value(type: number): number | string | number[] | undefined {
    switch (type) {
      case T.U8: case T.I8: case T.BOOL: { this.need(1); const v = this.buf[this.off]; this.off += 1; return v; }
      case T.U16: case T.I16: { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
      case T.U32: return this.u32();
      case T.I32: { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
      case T.F32: this.skip(4); return undefined;
      case T.U64: return this.u64();
      case T.I64: { this.need(8); const v = Number(this.buf.readBigInt64LE(this.off)); this.off += 8; return v; }
      case T.F64: this.skip(8); return undefined;
      case T.STR: return this.str();
      case T.ARR: {
        const et = this.u32();
        const n = this.u64();
        if (FIXED_SIZE[et] !== undefined) {
          // Per-layer arrays (e.g. head_count_kv on a hybrid) are short and carry information; the
          // vocabulary arrays are huge but come after the keys that matter, so only small ones are kept.
          if (n <= 4096 && (et === T.U32 || et === T.I32 || et === T.U64 || et === T.I64 || et === T.U16 || et === T.U8)) {
            const out: number[] = [];
            for (let i = 0; i < n; i++) out.push(this.value(et) as number);
            return out;
          }
          this.skip(n * FIXED_SIZE[et]);
        } else for (let i = 0; i < n; i++) this.value(et);
        return undefined;
      }
      default: throw new RangeError(`unknown value type ${type}`);
    }
  }
}

/** Every scalar / small-numeric-array key before the tokenizer, by name. */
export function parseGgufKeys(buf: Buffer): Record<string, number | string | number[]> | null {
  try {
    if (buf.length < 24 || buf.toString("latin1", 0, 4) !== "GGUF") return null;
    const r = new Reader(buf);
    r.off = 4;
    if (r.u32() < 2) return null;
    r.u64();
    const kvCount = r.u64();
    const out: Record<string, number | string | number[]> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      if (key.startsWith("tokenizer.")) break;
      const v = r.value(r.u32());
      if (v !== undefined) out[key] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export interface KvShape {
  /** K + V elements stored per token of context, summed over the layers that keep a KV cache. */
  elementsPerToken: number;
  /** Layers that actually keep a KV cache (all of them, unless the model is a hybrid). */
  attentionLayers: number;
  layers: number;
  /** True for hybrids: only every Nth layer is full attention, the rest keep a fixed-size state. */
  hybrid: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const sum = (v: number[]): number => v.reduce((a, b) => a + b, 0);

/**
 * KV elements per token, from the header — what the cache really costs, instead of a guess from
 * the file size.
 *
 *   per attention layer: n_kv_heads * (key_length + value_length)
 *   attention layers:    block_count, or block_count / full_attention_interval on a hybrid
 *
 * The size-based guess assumed every layer keeps a cache; on Qwen3.6-35B-A3B only 10 of 40 do, so it
 * over-stated the cost ~29x and capped the context at a fraction of what the card holds.
 * Sliding-window layers are conservatively counted as full attention (over-stating, never under).
 * Returns undefined when any needed field is missing — the caller then keeps the old estimate.
 */
export function kvShapeFromKeys(keys: Record<string, number | string | number[]>): KvShape | undefined {
  const arch = typeof keys["general.architecture"] === "string" ? (keys["general.architecture"] as string) : undefined;
  if (!arch) return undefined;
  const k = (name: string) => keys[`${arch}.${name}`];
  const layers = num(k("block_count"));
  if (!layers) return undefined;
  const heads = num(k("attention.head_count"));
  const kvRaw = k("attention.head_count_kv");
  // head_count_kv may be one number or one per layer.
  const kvHeadsPerLayer = Array.isArray(kvRaw) ? kvRaw : undefined;
  const kvHeads = Array.isArray(kvRaw) ? undefined : num(kvRaw) ?? heads;
  const embd = num(k("embedding_length"));
  const keyLen = num(k("attention.key_length")) ?? (embd && heads ? Math.floor(embd / heads) : undefined);
  const valLen = num(k("attention.value_length")) ?? keyLen;
  if (!keyLen || !valLen) return undefined;
  const interval = num(k("full_attention_interval"));
  const hybrid = interval !== undefined && interval > 1;
  const attentionLayers = hybrid ? Math.floor(layers / interval!) : layers;
  if (attentionLayers <= 0) return undefined;
  let elements: number;
  if (kvHeadsPerLayer) {
    // One entry per layer: a layer with 0 heads keeps no cache. Hybrids list every layer, so the sum is exact.
    elements = sum(kvHeadsPerLayer) * (keyLen + valLen);
  } else if (kvHeads) {
    elements = attentionLayers * kvHeads * (keyLen + valLen);
  } else return undefined;
  return { elementsPerToken: elements, attentionLayers, layers, hybrid };
}

/** Bytes per element of a llama.cpp KV cache type (block-quantized types amortize their scales). */
export function kvBytesPerElement(cacheType: string): number {
  switch (cacheType) {
    case "f32": return 4;
    case "f16": case "bf16": return 2;
    case "q8_0": return 34 / 32;
    case "q5_1": return 24 / 32;
    case "q5_0": return 22 / 32;
    case "q4_1": return 20 / 32;
    case "q4_0": return 18 / 32;
    default: return 2; // unknown: assume the largest sane one
  }
}

/** Reads the head of `path` and returns its KV shape, or undefined when it cannot be determined. Never throws. */
export async function readGgufKvShape(path: string, headBytes = 4 * 1024 * 1024): Promise<KvShape | undefined> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(headBytes);
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0);
    const keys = parseGgufKeys(buf.subarray(0, bytesRead));
    return keys ? kvShapeFromKeys(keys) : undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Parses the metadata of an in-memory GGUF header. Stops at the first `tokenizer.*` key:
 *  llama.cpp writes the architecture keys before the vocabulary, and the vocabulary arrays
 *  are the only part that is large. */
export function parseGgufArchInfo(buf: Buffer): GgufArchInfo {
  try {
    if (buf.length < 24 || buf.toString("latin1", 0, 4) !== "GGUF") return { conclusive: false };
    const r = new Reader(buf);
    r.off = 4;
    const version = r.u32();
    if (version < 2) return { conclusive: false };
    r.u64(); // tensor count
    const kvCount = r.u64();
    let arch: string | undefined;
    let expertCount: number | undefined;
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      if (key.startsWith("tokenizer.")) break;
      const type = r.u32();
      const v = r.value(type);
      if (key === "general.architecture" && typeof v === "string") arch = v;
      else if (/\.expert_count$/.test(key) && typeof v === "number") expertCount = v;
    }
    // Having reached the tokenizer keys with an architecture in hand and no expert_count means
    // a dense model — llama.cpp writes expert_count with the other arch keys, before them.
    return arch ? { arch, expertCount, conclusive: true } : { conclusive: false };
  } catch {
    return { conclusive: false };
  }
}

/** Reads the head of `path` and reports its architecture info. Never throws. */
export async function readGgufArchInfo(path: string, headBytes = 4 * 1024 * 1024): Promise<GgufArchInfo> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(headBytes);
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0);
    return parseGgufArchInfo(buf.subarray(0, bytesRead));
  } catch {
    return { conclusive: false };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** true = MoE, false = dense, undefined = could not tell (file absent, unreadable, not GGUF). */
export async function isMoeModelFile(path: string): Promise<boolean | undefined> {
  const info = await readGgufArchInfo(path);
  if (!info.conclusive) return undefined;
  return (info.expertCount ?? 0) > 0;
}

/**
 * MoE-ness when the file may not exist yet (a model about to be downloaded): the header if the
 * file is there, else what the catalogue says (`activeParamB` is set only on MoE rungs), else a
 * `-A<n>B` name marker. undefined when none of those can say.
 */
export async function isMoeModel(opts: { path?: string; activeParamB?: number; filename?: string; dense?: boolean }): Promise<boolean | undefined> {
  if (opts.path) {
    const fromFile = await isMoeModelFile(opts.path);
    if (fromFile !== undefined) return fromFile;
  }
  if (opts.activeParamB !== undefined) return true;
  if (opts.dense) return false;
  if (opts.filename && /-A\d+B(?:[-_.]|$)/i.test(opts.filename)) return true;
  return undefined;
}
