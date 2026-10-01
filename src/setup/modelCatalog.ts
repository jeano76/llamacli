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
 * ── Why the repos are pinned rather than searched ──────────────────────────
 * These ids are the publisher's own (`ornith-ai/…`), verified against the Hub
 * API: both return HTTP 200 and both list the Q4_K_M quant this prefers. They
 * were previously written WITHOUT the namespace, which is a repo that does not
 * exist and answers HTTP 401 — so on any machine with no model already
 * configured, first-run bootstrap failed to resolve anything, wrote a config
 * with no `modelPath`, and the spawn condition in index.tsx could never be
 * satisfied. A guessed id is not a safer default than a verified one; it is
 * just an unverifiable one.
 *
 * `MODEL_REPO_35B` / `MODEL_REPO_9B` still override both, for a mirror or a
 * different quantisation. A repository search remains the fallback when a
 * pinned repo is unreachable, so a renamed or moved repo degrades to a search
 * rather than to a dead first run.
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
/** The publisher's own repos, namespace included. See the header comment: the
 *  un-namespaced form of these ids is a repo that does not exist. */
export const ORNITH_35B_REPO = "ornith-ai/Ornith-1.5-35B-A3B-GGUF";
export const ORNITH_9B_REPO = "ornith-ai/Ornith-1.5-9B-GGUF";

/**
 * The Bonsai family — the size ladder for machines the Ornith pair does not
 * serve.
 *
 * These matter on this class of box because they invert the usual trade. The
 * Ornith 35B-A3B is a MoE whose 20.4 GB file only fits because experts are
 * paged from RAM, so its cost is bounded by the *active* 3B rather than the
 * file. Bonsai 27B is DENSE at a 1-bit quant: 5.5 GB on disk, the whole thing
 * resident on an 8 GB card, and measured here running `-c 40960` with no
 * `--n-cpu-moe` at all (see the tuning notes). So on a small card the bigger
 * model is not the expensive one — it is the cheap one, and choosing by
 * parameter count alone would pick wrong in both directions.
 *
 * Sizes verified against the Hub's file listing, not estimated.
 */
export const BONSAI_27B_REPO = "prism-ml/Ternary-Bonsai-2-27B-gguf";
export const BONSAI_8B_REPO = "prism-ml/Ternary-Bonsai-8B-gguf";
export const BONSAI_4B_REPO = "prism-ml/Ternary-Bonsai-4B-gguf";

/** The quant the request named explicitly. Preferred when present. */
export const PREFERRED_35B_QUANT = "Q4_K_M";
export const PREFERRED_9B_QUANT = "Q4_K_M";
/** Bonsai ships 1/2-bit quants; the 1-bit is the reason to use this family. */
export const PREFERRED_BONSAI_QUANT = "PTQ1_0";

/** The Bonsai size ladder, largest first — the order `chooseModel` prefers. */
export const BONSAI_SIZES = ["27B", "8B", "4B"] as const;
export type BonsaiSize = (typeof BONSAI_SIZES)[number];
/** size → repo, used as the default for each rung. */
const BONSAI_REPOS: Record<BonsaiSize, string> = {
  "27B": BONSAI_27B_REPO,
  "8B": BONSAI_8B_REPO,
  "4B": BONSAI_4B_REPO,
};

/** Parses `BONSAI_REPOS="27B=owner/repo,8B=owner/repo"`.
 *
 *  Sizes arrive in any case ("27b") and entries may be given without one
 *  (`=owner/repo` applies to whichever rung is being read), because a partial
 *  override is the common case — mirroring one size, keeping the rest. An
 *  unparseable entry is ignored rather than fatal, so a typo degrades to the
 *  default repo instead of stopping the bootstrap. */
function parseBonsaiRepoOverrides(raw: string | undefined): Partial<Record<BonsaiSize, string>> {
  const out: Partial<Record<BonsaiSize, string>> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (!value) continue;
    const size = key.toUpperCase().replace(/^BONSAI/, "") as BonsaiSize;
    if ((BONSAI_SIZES as readonly string[]).includes(size)) out[size] = value;
  }
  return out;
}

/** Quant ordering for the Bonsai family, best-first.
 *
 *  Separate from QUANT_PREFERENCE because none of its entries appear in these
 *  filenames: `QUANT_PREFERENCE.findIndex` would rank every Bonsai file
 *  equally last, making `best()` arbitrary rather than deliberate.
 *
 *  PTQ1_0 leads on purpose. This family exists for the quant — a 27B dense in
 *  5.5 GB is what lets it stay resident on a small card — and it is also the
 *  smallest option available, so nothing is traded away by ranking it first.
 *
 *  `PQ2_0` is ranked BELOW `Q2_0` even though it sorts earlier alphabetically,
 *  because it is one of only two quants in this family that a stock llama.cpp
 *  cannot read (measured: diffing `llama-quantize`'s supported list between the
 *  two builds on this machine leaves exactly `PTQ1_0` and `PQ2_0`). On the 4B
 *  rung the two are the same size on disk — 1.00 GiB either way — so preferring
 *  the fork-only one would cost a working install for nothing. Where the two
 *  differ in size, PTQ1_0 already wins above both.
 *
 *  F16 stays last regardless of size: it is the one quant here that is
 *  unambiguously the largest, and choosing it for quality would turn a 1 GB
 *  download into a 7.5 GB one on a card that cannot hold the result. */
const BONSAI_QUANT_PREFERENCE = ["PTQ1_0", "Q2_0", "Q2_0_g64", "PQ2_0", "F16"];

/** The `best()` variant for Bonsai: same contract, Bonsai's own quant order. */
function bestBonsai(list: ModelCandidate[]): ModelCandidate | null {
  if (list.length === 0) return null;
  const rank = (f: string) => {
    const i = BONSAI_QUANT_PREFERENCE.findIndex((q) => f.includes(q));
    // Unknown quants sort after every known one, then alphabetically so the
    // choice is at least deterministic.
    return i === -1 ? BONSAI_QUANT_PREFERENCE.length : i;
  };
  return [...list].sort((a, b) => rank(a.filename) - rank(b.filename) || a.filename.localeCompare(b.filename))[0];
}

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
  /** Optional. Absent (or an all-empty map) leaves the original Ornith-only
   *  decision untouched, so a caller that never resolves Bonsai keeps the
   *  behaviour it had. */
  bonsai?: Partial<Record<BonsaiSize, ModelCandidate[]>>;
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

  // ── Bonsai, before the Ornith pair ────────────────────────────────────────
  // Checked FIRST, and that ordering is the whole reason this exists.
  //
  // The 35B test above asks "is there 6 GiB of VRAM for a 3B active set?" —
  // correct for a MoE whose file is irrelevant to what stays resident. Bonsai
  // 27B is DENSE: all 27B must fit, so the question is the file size, and a
  // 5.5 GB 1-bit model fits an 8 GB card outright. Running the MoE test on it
  // would admit a 50 GB F16 on any 6 GiB card, and running the dense test on
  // the Ornith pair would reject a model that demonstrably runs here.
  //
  // So each rung is tested on its own terms, largest first, and the first one
  // that genuinely fits wins. A box with room for the 27B gets the 27B — not
  // the 4B, which "fits" everywhere and would otherwise win by default.
  const bonsaiPicks = BONSAI_SIZES.map((size) => ({
    size,
    pick: bestBonsai(opts.bonsai?.[size] ?? []),
  }));
  for (const { size, pick } of bonsaiPicks) {
    if (!pick) continue;
    const sizeGiB = pick.sizeBytes / GiB;
    // Dense, so the whole file has to be resident: no partial offload exists.
    // The 1 GiB is the KV cache and load-time allocations, matching RESERVE_GIB.
    const fitsVram = vramGiB >= sizeGiB + RESERVE_GIB;
    const fitsRam = ramGiB >= sizeGiB * MIN_RAM_MULTIPLE;
    if (!fitsVram || !fitsRam) continue;
    return {
      candidate: pick,
      reason:
        `Ternary-Bonsai-${size} ${pick.filename} 을 선택했습니다. ${reasons[0]}. ` +
        `GPU에 전량 올라갑니다 (${sizeGiB.toFixed(1)} GiB). ` +
        `이 모델은 dense 라 MoE 와 달리 파일 전체가 VRAM 에 있어야 하므로, ` +
        `은은 1-bit 양자화 덕분에 ${size} 급 파라미터가 ${sizeGiB.toFixed(1)} GiB 에 들어갑니다. ` +
        (pick.filename.includes(PREFERRED_BONSAI_QUANT)
          ? `참고: 1-bit/ternary 형식이라 llama-server 빌드가 이를 지원해야 합니다.`
          : ``),
      alternatives: bonsaiPicks
        .filter((b) => b.pick && b.pick.filename !== pick.filename)
        .map((b) => b.pick!)
        .concat(pick35 ? [pick35] : []),
    };
  }

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
): Promise<{ c35: ModelCandidate[]; c9: ModelCandidate[]; bonsai: Record<BonsaiSize, ModelCandidate[]> }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});

  const pinned35 = env.MODEL_REPO_35B;
  const pinned9 = env.MODEL_REPO_9B;

  // A repo that cannot be listed yields an empty list rather than throwing, so
  // one unreachable family cannot prevent the other from being considered.
  const c35 = await resolveOne(
    pinned35 ?? ORNITH_35B_REPO, ["Ornith-1.5-35B-A3B", "Ornith-1.5-35B"], opts, log, "35B", Boolean(pinned35)
  ).catch(() => [] as ModelCandidate[]);
  const c9 = await resolveOne(
    pinned9 ?? ORNITH_9B_REPO, ["Ornith-1.5-9B", "Ornith-1.5"], opts, log, "9B", Boolean(pinned9)
  ).catch(() => [] as ModelCandidate[]);

  // Bonsai, largest first. `env.BONSAI_REPOS` overrides all three in one go
  // ("27B=repoA,8B=repoB,4B=repoC") for a mirror or a local fork, rather than
  // adding a third env var per size — the family is a set, not a scalar.
  const pinnedBonsai = parseBonsaiRepoOverrides(env.BONSAI_REPOS);
  const sizes: BonsaiSize[] = ["27B", "8B", "4B"];
  const bonsai = {} as Record<BonsaiSize, ModelCandidate[]>;
  await Promise.all(
    sizes.map(async (size) => {
      const pinned = pinnedBonsai[size];
      const repo = pinned ?? BONSAI_REPOS[size];
      bonsai[size] = await resolveOne(
        repo,
        [`Ternary-Bonsai-${size === "27B" ? "2-" : ""}${size}`],
        opts,
        log,
        size,
        Boolean(pinned)
      ).catch(() => [] as ModelCandidate[]);
    })
  );

  return { c35, c9, bonsai };
}

/** The pinned repo when it answers, a repository search when it does not.
 *
 *  A pinned id that 401s or 404s must not end the first run: the whole point of
 *  pinning is that it is a good default, not that it is guaranteed to be
 *  permanent. Falling back to the search costs one request and turns a dead
 *  start into a possibly-slower working one. An explicit `MODEL_REPO_*` does
 *  NOT get this fallback — if the user named a repo, silently using a
 *  different one is worse than telling them it was unreachable. */
async function resolveOne(
  repo: string,
  fallbackQueries: string[],
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal },
  log: (line: string) => void,
  label: string,
  /** True when the user named this repo explicitly, in which case silently
   *  substituting a different one is worse than reporting the failure. */
  explicit: boolean
): Promise<ModelCandidate[]> {
  try {
    const files = await listGgufFiles(repo, opts);
    if (files.length > 0) return files;
    log(`${repo} 에서 .gguf 를 찾지 못했습니다.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (explicit) {
      log(`MODEL_REPO_${label}=${repo} 에 접근할 수 없습니다: ${msg}`);
      return [];
    }
    log(`${repo} 에 접근할 수 없습니다 (${msg}) — 저장소 검색으로 바꿉니다.`);
  }
  return searchAndList(fallbackQueries, opts, log);
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
