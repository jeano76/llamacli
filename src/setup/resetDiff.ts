/**
 * What `/reset` actually changed, as a short human-readable list.
 *
 * The reason this exists rather than just printing the new config: a reset that
 * silently rewrites `llama.contextSize`, `threads` and `gpuLayers` is
 * indistinguishable from one that did nothing. Both produce a working app. The
 * only difference the user can act on is "here is what moved, here is what is
 * now in force" — and equally "nothing moved, you were already optimal", which
 * is a real and reassuring answer rather than a failure to report.
 *
 * Machine-derived values are compared and reported. User-owned keys (apiKey,
 * verify, browser, compaction) are deliberately NOT listed: `/reset` keeps
 * them, so listing them as "changed" would be a lie, and listing them as
 * "unchanged" would be noise on every run.
 */

export interface ResetChange {
  label: string;
  before: unknown;
  after: unknown;
}

const LLAMA_KEYS: [key: string, label: string, format?: (v: unknown) => string][] = [
  ["modelPath", "모델 파일"],
  ["contextSize", "컨텍스트", (v) => `${Number(v).toLocaleString()} 토큰`],
  ["gpuLayers", "GPU 오프로드 층", (v) => (Number(v) === 0 ? "미사용 (CPU 전용)" : `${v} 층`)],
  ["threads", "스레드", (v) => `${v}개`],
  ["threadsBatch", "프롬프트 스레드", (v) => `${v}개`],
  ["cpuMoeLayers", "CPU MoE 층"],
  ["batchSize", "배치 크기"],
  ["ubatchSize", "마이크로 배치"],
  ["parallel", "슬롯 수"],
  ["cacheTypeK", "K 캐시 정밀도"],
  ["cacheTypeV", "V 캐시 정밀도"],
  ["flashAttn", "Flash Attention", (v) => (v ? "on" : "off")],
  ["port", "llama 포트"],
];

function same(a: unknown, b: unknown): boolean {
  return a === b || (a === undefined && b === undefined) || (a == null && b == null);
}

function fmt(v: unknown, format?: (x: unknown) => string): string {
  if (format) return format(v);
  if (v === undefined || v === null || v === "") return "(없음)";
  return String(v);
}

/**
 * Compares two configs and returns one line per real difference.
 *
 * Returns an EMPTY array when nothing changed — which `/reset` reports as
 * "이미 최적이었습니다" rather than as an error. That distinction matters: on a
 * machine whose hardware has not changed, "nothing to do" is the correct
 * outcome and the user should be told so plainly.
 */
export function describeReset(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): string[] {
  const lines: string[] = [];
  const b = (before ?? {}) as Record<string, any>;
  const a = (after ?? {}) as Record<string, any>;

  // Top-level: the model actually in use.
  if (!same(b.model, a.model)) {
    lines.push(`모델: ${fmt(b.model)} → ${fmt(a.model)}`);
  }
  if (!same(b.backend, a.backend)) {
    lines.push(`백엔드: ${fmt(b.backend)} → ${fmt(a.backend)}`);
  }

  // llama.* — the flags /reset exists to re-derive.
  const bl = (b.llama ?? {}) as Record<string, any>;
  const al = (a.llama ?? {}) as Record<string, any>;
  for (const [key, label, format] of LLAMA_KEYS) {
    if (same(bl[key], al[key])) continue;
    lines.push(`${label}: ${fmt(bl[key], format)} → ${fmt(al[key], format)}`);
  }

  return lines;
}

/** What is now in force, whether or not anything changed. The useful fact after
 *  a reset is which model and how large a context the machine settled on. */
export function describeInForce(config: Record<string, unknown> | null | undefined): string[] {
  const c = (config ?? {}) as Record<string, any>;
  const llama = (c.llama ?? {}) as Record<string, any>;
  const out: string[] = [];
  if (c.model) out.push(`모델: ${c.model}`);
  if (llama.contextSize) out.push(`컨텍스트: ${Number(llama.contextSize).toLocaleString()} 토큰`);
  if (llama.gpuLayers !== undefined) {
    out.push(`GPU: ${Number(llama.gpuLayers) === 0 ? "미사용 (CPU 전용)" : `오프로드 ${llama.gpuLayers} 층`}`);
  }
  if (llama.threads) out.push(`스레드: ${llama.threads}개`);
  return out;
}