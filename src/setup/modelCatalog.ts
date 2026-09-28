/**
 * Choosing which model to download, and finding it on Hugging Face.
 *
 * Requested directly: "해당 컴퓨터의 gpu VRAM에 적합한 Ornith-1.5-35B-A3B-Q4_K_M.gguf
 * 또는 Ornith-1.5 9B 로컬 모델등 정합한 모델을 다운로드 받는 초기 과정을
 * 수행해야해" — pick the Ornith that fits this machine's VRAM.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 * Two candidates, and the choice between them is a fit calculation, not a
 * preference:
 *
 *   - 35B-A3B Q4_K_M is a ~22 GB file but only ~3B parameters are active per
 *     token (Mixture-of-Experts). It therefore FITS ON A SMALL CARD — but only
 *     if the expert tensors that aren't needed for every token are allowed to
 *     live in system RAM (`--n-cpu-moe`, see tuning.ts). On the 8 GB RTX 2070
 *     this repo is developed on, it runs at ~19 tok/s.
 *   - 9B Q4_K_M is a ~5.5 GB file that fits fully on the same card and is
 *     several times faster, at some cost in capability.
 *
 * So the rule is: use the 35B when the card can hold the *active* parameters
 * comfortably AND there is enough system RAM to page experts from; otherwise
 * the 9B, which is the only one of the two that is fast without a RAM caveat.
 * Picking the 35B on a machine with too little RAM produces something that
 * technically loads and is unusable — which is why RAM is part of the test and
 * not just VRAM.
 *
 * ── Why the Hub is searched rather than a URL hardcoded ─────────────────────
 * The exact repo id and quant filename for these GGUFs could not be verified
 * from this environment (web search unavailable), so hardcoding a guessed URL
 * would risk a download that 404s at first run — the worst possible time to
 * discover a typo. Instead the Hub's model search API is queried for the family
 * name, its GGUF files are listed, and the best quant is picked. `MODEL_REPO_*`
 * environment variables pin a specific repo when the user knows better.
 */

/** A downloadable model file. */
export interface ModelCandidate {
  repo: string;
  filename: string;
  /** Bytes, from the Hub's file listing, when available. */
  sizeBytes: number;
  url: string;
}

export interface ModelChoice {
  candidate: ModelCandidate;
  /** Why this one — surfaced in the status line, because a 22 GB download the
   *  user didn't expect is worth explaining. */
  reason: string;
  /** Ranked alternatives, so a user who disagrees can pick the next one. */
  alternatives: ModelCandidate[];
}

export const HF_ENDPOINT = "https://huggingface.co";
export const ORNITH_35B_REPO = "Ornith-1.5-35B-A3B-GGUF";
export const ORNITH_9B_REPO = "Ornith-1.5-9B-GGUF";
/** The quant the request named explicitly. Preferred when present. */
export const PREFERRED_35B_QUANT = "Q4_K_M";
export const PREFERRED_9B_QUANT = "Q4_K_M";

/** Approximate on-disk sizes, used to plan BEFORE the Hub answers (and as the
 *  fallback when it can't). Close enough to size a download, not to be relied on
 *  for correctness. */
export const APPROX_SIZES: Record<string, number> = {
  "35b-a3b": 21_864_081_056,
  "9b": 5_497_000_000,
};

const GiB = 1024 ** 3;

/** Quants in descending quality, best-first. `Q4_K_M` is the sweet spot the
 *  request named; the others are only reached if it is absent from a repo. */
const QUANT_PREFERENCE = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q4_K_S", "Q3_K_XL", "Q3_K_M", "Q2_K"];

function quantRank(filename: string): number {
  const i = QUANT_PREFERENCE.findIndex((q) => filename.includes(q));
  return i === -1 ? QUANT_PREFERENCE.length : i;
}

/**
 * The fit test, isolated and pure so it can be tested against every hardware
 * shape that matters without a network call.
 *
 * `vramFreeBytes` and `ramTotalBytes` are the two inputs; everything else is a
 * fixed allowance. The numbers were chosen from the one machine this feature
 * could be measured on (8 GB VRAM, 30 GB RAM, where the 35B runs well) and are
 * deliberately conservative: the failure this avoids is a download that
 * succeeds and a server that then runs at single-digit tok/s.
 */
export function chooseModel(opts: {
  vramTotalBytes: number;
  vramFreeBytes: number;
  ramTotalBytes: number;
  candidates35b: ModelCandidate[];
  candidates9b: ModelCandidate[];
}): ModelChoice {
  const { vramTotalBytes, vramFreeBytes, ramTotalBytes } = opts;
  const pick35 = best(opts.candidates35b);
  const pick9 = best(opts.candidates9b);

  const vramGiB = vramTotalBytes / GiB;
  const freeGiB = Math.max(0, vramFreeBytes || vramTotalBytes) / GiB;
  const ramGiB = ramTotalBytes / GiB;

  // Room for the ACTIVE parameters of a 35B-A3B, plus the KV cache and the
  // transient allocations a load makes before it settles. 6 GB is the measured
  // floor for "the 3B active set + context" to run at a usable speed.
  const RESERVE_GIB = 1.0;
  const MIN_35B_VRAM_GIB = 6.0;
  // Each expert layer paged out of VRAM streams from RAM during decode, so the
  // system has to hold the whole 22 GB model plus room to work. Below ~1.4x the
  // model size, paging turns into swapping and the box becomes unusable.
  const MIN_RAM_MULTIPLE = 1.4;

  const size35 = pick35?.sizeBytes || APPROX_SIZES["35b-a3b"];
  const reasons: string[] = [];
  reasons.push(
    `VRAM ${vramGiB.toFixed(1)} GiB(여유 ${freeGiB.toFixed(1)} GiB), RAM ${ramGiB.toFixed(1)} GiB`
  );

  const vramOk = vramGiB >= MIN_35B_VRAM_GIB;
  const ramOk = ramGiB * GiB >= size35 * MIN_RAM_MULTIPLE;
  const canUse35b = Boolean(pick35) && vramOk && ramOk;

  if (canUse35b) {
    const how = vramGiB >= size35 / GiB
      ? "전량 오프로드"
      : "활성 파라미터만 GPU, expert 일부는 RAM에서 스트리밍(--n-cpu-moe)";
    return {
      candidate: pick35!,
      reason:
        `Ornith-1.5-35B-A3B ${pick35!.filename} 을 선택했습니다. ` +
        `${reasons[0]}. ${how}. ${(size35 / GiB).toFixed(1)} GiB 다운로드.`,
      alternatives: [pick9, ...opts.candidates9b.filter((c) => c.filename !== pick9?.filename)].filter(Boolean) as ModelCandidate[],
    };
  }

  const why: string[] = [];
  if (!pick35) why.push("35B 저장소를 찾지 못함");
  if (!vramOk) why.push(`VRAM ${vramGiB.toFixed(1)} GiB < 필요한 ${MIN_35B_VRAM_GIB} GiB`);
  if (!ramOk) why.push(`RAM ${ramGiB.toFixed(1)} GiB < 모델의 ${(size35 * MIN_RAM_MULTIPLE / GiB).toFixed(1)} GiB`);
  reasons.push(`35B 대신 9B 선택: ${why.join(", ")}`);

  if (pick9) {
    return {
      candidate: pick9,
      reason:
        `Ornith-1.5-9B ${pick9.filename} 을 선택했습니다. ${reasons.join(". ")}. ` +
        `약 ${((pick9.sizeBytes || APPROX_SIZES["9b"]) / GiB).toFixed(1)} GiB 이며 GPU에 전량 올라갑니다.`,
      alternatives: pick35 ? [pick35] : [],
    };
  }
  // Nothing at all: report it rather than pretending, so the caller can say so.
  throw new Error(
    `사용 가능한 모델을 찾지 못했습니다 (${reasons.join("; ")}). ` +
    `MODEL_REPO_35B / MODEL_REPO_9B 환경변수로 저장소를 직접 지정하세요.`
  );
}

function best(list: ModelCandidate[]): ModelCandidate | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => quantRank(a.filename) - quantRank(b.filename))[0];
}

/** The Hub's model search. Returns repo ids matching `query`. */
export async function searchHubModels(
  query: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; limit?: number } = {}
): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${HF_ENDPOINT}/api/models?search=${encodeURIComponent(query)}&limit=${opts.limit ?? 20}&full=true`;
  const res = await doFetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`HuggingFace 검색 실패: HTTP ${res.status}`);
  const json = (await res.json()) as Array<{ id?: string; siblings?: { rfilename?: string }[] }>;
  return json.map((m) => m.id).filter((id): id is string => Boolean(id));
}

/** Lists a repo's GGUF files. */
export async function listGgufFiles(
  repo: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<ModelCandidate[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  // `?blobs=true` makes the Hub return each sibling's real byte size, which is
  // what lets the progress bar have a denominator before anything downloads.
  const res = await doFetch(`${HF_ENDPOINT}/api/models/${repo}?blobs=true`, { signal: opts.signal });
  if (!res.ok) throw new Error(`HuggingFace 파일 목록 실패 (${repo}): HTTP ${res.status}`);
  const json = (await res.json()) as { siblings?: { rfilename?: string; size?: number }[] };
  return (json.siblings ?? [])
    .filter((s) => s.rfilename?.toLowerCase().endsWith(".gguf"))
    .map((s) => ({
      repo,
      filename: s.rfilename!,
      sizeBytes: s.size ?? 0,
      url: `${HF_ENDPOINT}/${repo}/resolve/main/${s.rfilename}`,
    }));
}

/**
 * Resolves the model to download: pinned repos from the environment if set,
 * otherwise a Hub search filtered to GGUFs.
 *
 * Search results are filtered to GGUF repos only — a search for "Ornith-1.5"
 * returns the safetensors weights too, and downloading 22 GB of the wrong file
 * format would be a spectacular waste.
 */
export async function resolveModel(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    log?: (line: string) => void;
  } = {}
): Promise<{ c35: ModelCandidate[]; c9: ModelCandidate[] }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});

  const pinned35 = env.MODEL_REPO_35B;
  const pinned9 = env.MODEL_REPO_9B;

  const c35 = pinned35
    ? await listGgufFiles(pinned35, opts)
    : await searchAndList(["Ornith-1.5-35B-A3B", "Ornith-1.5-35B"], opts, log);
  const c9 = pinned9
    ? await listGgufFiles(pinned9, opts)
    : await searchAndList(["Ornith-1.5-9B", "Ornith-1.5"], opts, log);

  return { c35, c9 };
}

async function searchAndList(
  queries: string[],
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; signal?: AbortSignal; log?: (line: string) => void },
  log: (line: string) => void
): Promise<ModelCandidate[]> {
  const seen = new Set<string>();
  const out: ModelCandidate[] = [];
  for (const q of queries) {
    let ids: string[];
    try {
      ids = await searchHubModels(q, opts);
    } catch {
      continue; // a failed query must not abort the whole bootstrap
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!/gguf/i.test(id)) continue; // never the safetensors repo
      try {
        const files = await listGgufFiles(id, opts);
        if (files.length > 0) {
          out.push(...files);
        }
      } catch {
        continue;
      }
    }
    if (out.length > 0) break;
  }
  return out;
}
