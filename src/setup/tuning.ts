/**
 * The one place that turns "what hardware is this" into "what llama-server
 * flags should llamacli launch with".
 *
 * Reported directly, in Korean, by the user this was written for: on a
 * multi-core machine the initial llama.cpp launch must put the NVIDIA GPU
 * first, and the whole tuning decision must be made without the user having to
 * intervene. That is a stronger requirement than it sounds — it means the
 * answer cannot be "ask the user", and it cannot be a fixed constant, because
 * a fixed `-ngl 0` (which is what the old DEFAULT_8GB_PROFILE shipped) is
 * exactly what produced a 12-core RTX box running a 35B model entirely on CPU.
 *
 * So the rules below are all *derived* from measured facts about the machine,
 * and every one of them is stated as the reason it exists. `rationale` is
 * returned alongside the numbers so a user who wants to know why a flag is
 * what it is can ask, rather than having to read this file.
 */

import { Hardware, Gpu, totalVram, pickPrimaryGpu, UNITS } from "./hardware.js";
import { kvBytesPerElement } from "./ggufMeta.js";

export interface LlamaTuning {
  /** -ngl: layers offloaded to the GPU. 999 = "all of them" (llama.cpp clamps
   *  to the model's actual layer count), 0 = CPU only. */
  gpuLayers: number;
  /** -t: generation threads. */
  threads: number;
  /** -tb: prompt-processing threads. */
  threadsBatch: number;
  /** -c: context size in tokens. */
  contextSize: number;
  /** -b / -ub: logical and physical batch sizes. */
  batchSize: number;
  ubatchSize: number;
  /** --n-cpu-moe: keep this many MoE expert layers on the CPU. This is the
   *  single most important flag for a small-VRAM card running a MoE model, and
   *  it is why the 8 GB box in this repo's own README can run a 35B-A3B at all
   *  (the 3B "active" parameters are what must be resident; the rest of the
   *  experts stream from RAM). 0 = do not use. */
  cpuMoeLayers: number;
  /** --flash-attn on/off. */
  flashAttn: boolean;
  /** --cache-type-k / --cache-type-v. */
  cacheTypeK: string;
  cacheTypeV: string;
  /** -np: concurrent slots. */
  parallel: number;
  /** Human-readable justification for each non-obvious choice, in Korean to
   *  match the rest of the user-facing strings in this project. */
  rationale: string[];
  /** Which GPU (if any) the plan targets. */
  gpu: Gpu | null;
}

const GiB = UNITS.GiB;

/** Ceiling on the fraction of a MoE model kept on the CPU.
 *
 *  This was 0.6, which is where the binding constraint sat on the 8 GB box: a
 *  21.7 GB model against 8 GB of VRAM produced 48 expert layers, against a
 *  benchmarked 30. More CPU MoE layers buy VRAM the card does not need at that
 *  point and cost decode throughput linearly, so the cap is what decides
 *  whether a fresh machine is configured well.
 *
 *  0.4 is the value that reproduces the measured 30 at the layer count this
 *  assumes (0.4 x 80 = 32), and it is a conservative direction: erring low
 *  costs a little VRAM, erring high costs speed on every token.
 */
const MAX_CPU_MOE_FRACTION = 0.4;

/** Context bounds. The floor is llama.cpp's own practical minimum for a tool
 *  loop that has to hold a system prompt plus a few tool results; the ceiling
 *  keeps a single session from claiming a card's worth of KV on a machine whose
 *  real limit is RAM (CPU-only inference pays the same KV cost, just slower). */
const MIN_CONTEXT = 4096;
const MAX_CONTEXT = 32768;
/** Ceiling when the KV cost is EXACT (read from the model header) rather than a size guess: the largest
 *  context benchmarked end-to-end on this project's reference box (docs/model-bench-2026-10-03.md —
 *  98,304 tokens, 8 GiB card, compaction at 70% / re-prefill included). Beyond it the KV budget may allow
 *  more, but the prefill cost of a compaction is unmeasured, so it is not claimed. */
const EXACT_KV_MAX_CONTEXT = 98304;

/**
 * Bytes of KV cache per token of context, from the model file size alone.
 *
 * This is the FALLBACK, used only when the GGUF header cannot be read (a model that is not
 * downloaded yet): the exact figure comes from `readGgufKvShape` and replaces it. It assumes every
 * layer keeps a cache, which over-states a hybrid model (Qwen3.6-35B-A3B: ~29x).
 *
 * The true figure is `2 * n_layer * n_kv_head * head_dim * bytes_per_element`,
 * which needs the GGUF header to know exactly. This is an estimate keyed on model size — deliberately, because the failure
 * mode it replaces was worse: the previous code ignored the model entirely and
 * keyed only on card size, so the LARGEST model (the one that OOMs) got the
 * same generous context as a small one.
 *
 * The constants are calibrated against the reference model, a 35B-A3B Q4_K_M,
 * whose measured KV cost at q8_0 is ~0.3 MiB/token — the same figure this file
 * already used inline in the MoE deficit formula, so the two calculations stay
 * consistent with each other. Smaller models get proportionally less per token,
 * which is what lets a 9B on the same 8 GiB card carry a longer context than a
 * 35B without OOMing.
 *
 * The floor matters more than it looks: at q4_0 (chosen below 3 GiB of budget)
 * the real cost is roughly half, but under-estimating here would over-commit a
 * card that is already the tightest case on the machine.
 */
function kvBytesPerToken(modelBytes?: number): number {
  const MiB = UNITS.MiB;
  if (!modelBytes || modelBytes <= 0) return 0.3 * MiB; // ~35B class, q8_0
  const gib = modelBytes / GiB;
  if (gib <= 6) return 0.08 * MiB; // ~7-9B dense
  if (gib <= 12) return 0.13 * MiB; // ~12-14B
  if (gib <= 20) return 0.18 * MiB; // ~20B dense
  if (gib <= 30) return 0.24 * MiB; // ~30B dense
  return 0.3 * MiB; // 35B-class MoE and up
}

export function tuneForHardware(
  hw: Hardware,
  opts?: {
    modelBytes?: number;
    /**
     * A `--n-cpu-moe` value that came from MEASUREMENT on this machine, rather
     * than from the formula below. It wins outright.
     *
     * This is the one field in this file that a person can genuinely know better
     * than arithmetic, and the arithmetic is demonstrably wrong by a factor of
     * 1.6 on the hardware this was written for. The bootstrap passes the
     * configured value through so a benchmarked machine keeps its benchmark.
     */
    cpuMoeLayers?: number;
    /**
     * VRAM already held by llamacli's own running llama-server. Added back to
     * the free reading before the context budget is derived — see
     * budgetVramGiB for why this is load-bearing rather than cosmetic.
     */
    ownServerVramGiB?: number;
    /**
     * Is the model a Mixture-of-Experts? `false` means DENSE: there are no expert tensors, so
     * `--n-cpu-moe` does nothing — and neither a measured value carried over from a previous
     * (MoE) model nor the VRAM-shortfall formula may produce one. `undefined` (unknown, e.g. a
     * model not yet downloaded and not in the catalogue) keeps the previous behaviour.
     */
    moe?: boolean;
    /**
     * K+V elements stored per token of context, read from the model's GGUF header
     * (`readGgufKvShape`). When given, the KV cost is EXACT and replaces the size-based guess
     * below, which assumes every layer keeps a cache and over-states a hybrid model ~29x.
     * Absent (model not downloaded yet, header unreadable) keeps the old estimate.
     */
    kvElementsPerToken?: number;
    /** The model's trained context length from its header; the exact-KV ceiling never exceeds it. */
    trainedContext?: number;
    /** Transformer block count from the header; lets a dense model that exceeds VRAM be offloaded partially. */
    modelLayers?: number;
    /**
     * A context size already chosen — in config.yaml, or measured. It is honoured when it is LARGER
     * than the one derived here: a person who raised it did so on purpose (the derived value is a
     * conservative bound, and the measured limits of a specific card can be far above it), whereas
     * a smaller recorded value is just an earlier derivation and is replaced by the better one.
     * Hardware that shrank since is `/reset`'s job, which drops recorded llama values.
     */
    contextSize?: number;
    /**
     * `/reset` path: the context the user had before the reset. Unlike `contextSize` it is NOT trusted
     * blindly — the hardware may have shrunk, which is what a reset is for — so it is re-applied only
     * when the KV budget of THIS machine still supports it. (The ceiling below is a default for models
     * whose KV cost is a guess; a 98,304-token context that was benchmarked on this card is not
     * something a reset should quietly cut to 32,768.)
     */
    reapplyContext?: number;
  }
): LlamaTuning {
  const rationale: string[] = [];
  const gpu = pickPrimaryGpu(hw);
  const vram = totalVram(hw);
  const cpuCount = Math.max(1, hw.cpuCount);
  const ramGiB = hw.ramTotalBytes / GiB;
  const modelBytes = opts?.modelBytes;
  // Clamped to the card so a stale or oversized measurement can never inflate
  // the budget past the hardware. 0 means "no server of ours identified",
  // which is the correct conservative reading on a first run.
  const oursGiB =
    gpu && opts?.ownServerVramGiB ? Math.min(opts.ownServerVramGiB, gpu.vramTotalBytes / GiB) : 0;

  // --- GPU first ---------------------------------------------------------- //
  // "cpu가 여러개인 경우에는 Nvidia gpu를 우선" — on a multi-core machine the
  // NVIDIA GPU is the priority. The old default was gpuLayers: 0 (CPU only)
  // on a box that has 8 GB of VRAM and 12 cores, which is precisely backwards.
  //
  // 999 rather than a counted layer total: llama.cpp treats -ngl >= the model's
  // layer count as "offload everything", and 999 survives the user swapping in
  // a different model later (a hardcoded 48 would silently under-offload a
  // 60-layer model). Where VRAM is genuinely too small for the whole thing we
  // drop below 999 — see cpuMoeLayers for the partial-offload path.
  let gpuLayers = 999;
  if (!gpu) {
    gpuLayers = 0;
    rationale.push("NVIDIA GPU 미검출 → CPU 전용(-ngl 0)으로 실행합니다.");
  } else {
    // The NVIDIA wording is kept byte-for-byte: it is what every existing machine
    // has seen, and a test pins it. Other vendors get an honest label instead of
    // being called NVIDIA.
    const vendorLabel = !gpu.vendor || gpu.vendor === "nvidia" ? "NVIDIA GPU" : `${gpu.vendor.toUpperCase()} GPU`;
    rationale.push(
      `${vendorLabel} ${gpu.index}번 (${gpu.name}, ${gpu.unifiedMemory ? "GPU 사용 가능 통합 메모리" : "VRAM"} ${(gpu.vramTotalBytes / GiB).toFixed(1)} GiB) 우선 오프로드(-ngl 999)를 사용합니다.`
    );
  }

  // --- Context size: the thing users actually notice ---------------------- //
  // A coding agent's context is its working memory; too small and compaction
  // fires mid-task (the config-vs-server drift bug in index.tsx's own comments
  // caused an endless compact/resume loop at 8k against a 24k server), too
  // large and the KV cache eats the VRAM the weights need.
  //
  // KV cache cost for a GGUF is roughly 2 * n_layer * n_kv_head * head_dim *
  // bytes_per_token, which for a 35B-A3B Q4 class model is ~0.6 MB/token at
  // f16 and ~0.3 MB/token at q8_0. We don't know the exact architecture before
  // the file is downloaded, so this is a deliberately conservative table keyed
  // on the *budget* (free VRAM), not on the model — and the per-token constant
  // is scaled by the number of parallel slots, because KV is per-slot.
  const budgetGiB = budgetVramGiB(hw, gpu, oursGiB * GiB);
  // KV cache cost scales with the model's OWN shape, not with the card. A 35B
  // and a 9B on the same GPU differ by roughly 4x per token, so sizing the
  // context from VRAM alone systematically over-commits the big model — the
  // one case that actually OOMs. We don't parse the GGUF here (see
  // kvBytesPerToken's caller), so the model size stands in for it, which is
  // monotonic in the true cost across the sizes llamacli ships.
  // The KV precision depends only on the budget, so it is decided here, before it is needed to turn
  // an exact element count into bytes (the rationale for it is pushed where it always was).
  const cacheTypeK = budgetGiB >= 3 ? "q8_0" : "q4_0";
  const cacheTypeV = cacheTypeK;
  const exactKv = opts?.kvElementsPerToken !== undefined && opts.kvElementsPerToken > 0;
  const kvPerToken = exactKv
    ? opts!.kvElementsPerToken! * kvBytesPerElement(cacheTypeK)
    : kvBytesPerToken(modelBytes);
  // Reserve for the weights and load-time overhead, then spend what's left on
  // the KV cache.
  //
  // This is deliberately a FRACTION of the budget rather than the model file
  // size, because the file size is a bad proxy for what is resident: llama.cpp
  // memory-maps the weights and (with --n-cpu-moe, below) pages MoE experts
  // from system RAM, so only the active slice is ever truly on the card. An
  // earlier version of this reserved `min(modelSize, budget * 0.75)`, which
  // reserved essentially the whole card on the reference box and collapsed a
  // configuration that demonstrably runs to the 4096 floor.
  //
  // Calibrated against the reference box's own live server, which has been
  // running `-c 16384` on a 6.28 GiB budget with a 21.4 GiB 35B-A3B Q4_K_M at
  // ~0.3 MiB/token. Solving that measurement back gives a reserve of ~25% of
  // the budget. Anchoring on a configuration known to work — rather than on
  // whatever the arithmetic happens to produce — is the point: a tuner that
  // disagrees with a working server by 25% is not "more optimal", it is
  // inventing a setting nobody has ever run.
  const RESERVE_FRACTION = 0.25;
  const RESERVE_FLOOR_GIB = 0.5;
  let reserveGiB = gpu ? Math.max(RESERVE_FLOOR_GIB, budgetGiB * RESERVE_FRACTION) : 0;
  // A DENSE model keeps every weight resident, so the 25% fraction (calibrated on a MoE whose experts
  // stream from RAM) under-reserves it. That was hidden while the context was capped at 32,768; with the
  // larger exact-KV ceiling the KV term can otherwise claim the room the weights need.
  if (gpu && exactKv && opts?.moe === false && modelBytes) {
    reserveGiB = Math.max(reserveGiB, Math.min(modelBytes / GiB + 0.5, budgetGiB * 0.9));
  }
  const kvBudgetGiB = Math.max(0.25, budgetGiB - reserveGiB);
  const kvBudgetTokens = (kvBudgetGiB * GiB) / kvPerToken;
  // 4096-aligned because llama.cpp's practical granularity for a coding
  // agent's prompt shapes is a coarse block, and a round number is legible in
  // /props and the logs when diagnosing "why did compaction fire".
  let contextSize = Math.floor(kvBudgetTokens / 4096) * 4096;
  const ceiling = exactKv
    ? Math.min(EXACT_KV_MAX_CONTEXT, opts?.trainedContext ? Math.floor(opts.trainedContext / 4096) * 4096 : Infinity)
    : MAX_CONTEXT;
  contextSize = Math.max(MIN_CONTEXT, Math.min(ceiling, contextSize));
  rationale.push(
    `컨텍스트는 ${contextSize} 토큰으로 설정했습니다 (사용 가능 VRAM ≈ ${budgetGiB.toFixed(1)} GiB, ` +
      `KV 예산 ≈ ${kvBudgetGiB.toFixed(1)} GiB ÷ ${(kvPerToken / 1024).toFixed(1)} KiB/토큰` +
      `${exactKv ? " — 모델 헤더에서 읽은 실제 값" : " — 모델 크기로 추정한 값"}). ` +
      `이 값이 실제 서버보다 작으면 컴팩션이 과하게 자주, 크면 KV 캐시가 가중치 자리를 침범합니다.`
  );
  if (opts?.contextSize !== undefined && opts.contextSize > contextSize) {
    rationale.push(
      `config 에 기록된 컨텍스트 ${opts.contextSize} 이(가) 계산값 ${contextSize} 보다 커서 그대로 유지합니다 ` +
        `(직접 키운 값은 덮어쓰지 않습니다. 하드웨어가 바뀌었다면 /reset 으로 다시 계산하세요).`
    );
    contextSize = opts.contextSize;
  }

  if (contextSize < 8192) {
    rationale.push(
      `⚠ 컨텍스트가 ${contextSize} 토큰으로 매우 작습니다. 시스템 프롬프트와 도구 결과만으로 금방 차서 컴팩션이 잦아집니다 — ` +
        "VRAM/RAM 이 더 큰 머신이나 더 작은 모델을 권장합니다."
    );
  }
  if (opts?.reapplyContext !== undefined && opts.reapplyContext > contextSize) {
    if (opts.reapplyContext <= kvBudgetTokens) {
      rationale.push(
        `이전 컨텍스트 ${opts.reapplyContext} 이(가) 이 머신의 KV 예산(${Math.floor(kvBudgetTokens)} 토큰) 안이라 유지합니다.`
      );
      contextSize = opts.reapplyContext;
    } else {
      rationale.push(
        `이전 컨텍스트 ${opts.reapplyContext} 은(는) 이 머신의 KV 예산(${Math.floor(kvBudgetTokens)} 토큰)을 넘어 ${contextSize} 로 줄입니다.`
      );
    }
  }

  // A DENSE model has no experts to stream: the weights either fit on the card or the layers that do not
  // fit run on the CPU. `-ngl 999` on a 5.1 GiB model and a 4 GiB card is a load-time OOM, not an
  // optimisation, so offload only the share of layers the card can hold beside the KV cache.
  if (gpu && opts?.moe === false && modelBytes && opts.modelLayers && opts.modelLayers > 0) {
    const modelGiB = modelBytes / GiB;
    const kvGiB = (contextSize * kvPerToken) / GiB;
    const room = budgetGiB - 0.5 - kvGiB;
    if (room < modelGiB) {
      const share = Math.max(0, room / modelGiB);
      gpuLayers = Math.floor(opts.modelLayers * share);
      rationale.push(
        `밀집 모델(${modelGiB.toFixed(1)} GiB)이 VRAM 여유(${Math.max(0, room).toFixed(1)} GiB)보다 커서 ` +
          `${opts.modelLayers}층 중 ${gpuLayers}층만 GPU 로 올립니다 (나머지는 CPU) — -ngl 999 는 로드 시 메모리 부족이 됩니다.`
      );
    }
  }

  // --- KV cache precision -------------------------------------------------- //
  // q8_0 halves the KV cache versus f16 at a speed cost small enough to be
  // invisible next to MoE expert offloading, and on an 8 GB card that halved
  // cache is the difference between 16k and 32k of context. Below 3 GiB we go
  // to q4_0, which is a further halving and is where the small-VRAM boxes stop
  // fitting anything useful otherwise.
  rationale.push(
    `KV 캐시를 ${cacheTypeK}로 두어 캐시 점유를 절반으로 줄였습니다. (f16 대비 정확도 손실은 미니, 효과는 그대로)`
  );

  // --- Threads ------------------------------------------------------------- //
  // Generation is GPU-bound once anything is offloaded, so oversubscribing CPU
  // threads buys nothing and measurably hurts (more contention on the MoE
  // offload path). The split is: leave physical half the cores for the OS and
  // the offloaded expert compute. On the 12-core box this yields 6, which is
  // exactly what the hand-tuned working config in this repo used (`-t 6`).
  //
  // The `Math.max(2, …)` floor on the GPU branch was the bug: on a 1-core box
  // it produced `-t 2 -tb 2`, i.e. MORE threads than the machine has cores,
  // which is precisely what the rule above says must never happen. TC-08 caught
  // it by sweeping 1/2/3-core machines — the dev box is 12 cores, where
  // `max(2, 6)` accidentally lands on a legal value and hides the bug entirely.
  // The floor is now clamped to the core count rather than assuming >= 2.
  const threads = gpu
    ? Math.min(cpuCount, Math.max(2, Math.floor(cpuCount / 2)))
    : Math.min(cpuCount, Math.max(1, cpuCount - 1));
  // Prompt processing is not GPU-bound in the same way (it's a big batched
  // matmul that does use the GPU, but is far more sensitive to thread count),
  // so it gets the full complement when there's a GPU to share with.
  const threadsBatch = gpu
    ? Math.min(cpuCount, Math.max(2, cpuCount - 1))
    : Math.min(cpuCount, Math.max(1, cpuCount - 1));
  rationale.push(
    gpu
      ? `스레드는 생성 ${threads} / 프롬프트 처리 ${threadsBatch} 로 나눴습니다 (코어 ${cpuCount}개, GPU가 계산하므로 CPU 스레드 과할당은 역효과).`
      : `CPU 전용 실행이므로 스레드는 ${threads}개 (코어 ${cpuCount}개 중 1개는 OS에 양보).`
  );

  // --- Batch sizes --------------------------------------------------------- //
  // 2048/512 is llama.cpp's own default and is a good match for a coding
  // agent's prompt shape (a system prompt + a handful of tool results). Larger
  // only helps on very large prompts, and costs activation VRAM we may not have.
  const batchSize = 2048;
  const ubatchSize = budgetGiB >= 6 ? 512 : 256;
  rationale.push(`배치 크기는 -b ${batchSize} / -ub ${ubatchSize} (코딩 에이전트의 프롬프트 형태에 맞춘 값).`);

  // --- MoE expert offload: the 8 GB card's whole survival strategy --------- //
  // The repo's own README documents the constraint directly: "GPU VRAM 7.4GB/8GB
  // 거의 독점" with a 35B-A3B resident. A 3B-active MoE model *can* run on 8 GB,
  // but only if the expert tensors that aren't needed for every token are kept
  // in system RAM. --n-cpu-moe N moves N expert layers to the CPU; larger N =
  // less VRAM, slower MoE routing.
  //
  // We pick N from the shortfall: how much model doesn't fit in the free VRAM.
  // The model file size is the honest proxy for "how much has to live somewhere"
  // and is passed in as `modelBytes` by the caller (which knows the download).
  //
  // A value that came from MEASUREMENT beats this formula, and the caller passes
  // it in as `cpuMoeLayers`. That is not a preference: the arithmetic below has
  // one unvalidated constant in it (`estimatedLayers`), and on the 8 GB machine
  // this was developed on it produced 48 where a benchmark produced 30 — a
  // 1.6x overshoot, with the difference measured at +136% decode for the smaller
  // number. A guess must not silently outrank a measurement on every launch.
  let cpuMoeLayers = 0;
  const measuredCpuMoe = opts?.cpuMoeLayers;
  if (opts?.moe === false) {
    // Dense: no experts to move. A value recorded for a previous MoE model (the config of a
    // machine that ran Ornith keeps `cpuMoeLayers: 32`) is dropped for the same reason.
    rationale.push(
      measuredCpuMoe && measuredCpuMoe > 0
        ? `밀집(dense) 모델이라 expert 가 없어 이전 모델의 --n-cpu-moe ${measuredCpuMoe} 을(를) 쓰지 않습니다.`
        : "밀집(dense) 모델이라 MoE expert 가 없어 --n-cpu-moe 를 쓰지 않습니다."
    );
  } else if (measuredCpuMoe !== undefined && measuredCpuMoe > 0) {
    cpuMoeLayers = measuredCpuMoe;
    rationale.push(
      `--n-cpu-moe ${cpuMoeLayers} 은(는) 이 머신에서 실측된 값이라 그대로 유지합니다 (자동 계산값으로 덮지 않습니다).`
    );
  } else if (gpu?.unifiedMemory) {
    // Nothing to page: "VRAM" and system RAM are the same pool, so moving expert
    // layers to the CPU frees no memory and only costs speed. A model that does not
    // fit is a model-choice problem (chooseModel), not a tuning one.
    rationale.push("통합 메모리라 MoE expert 를 CPU 로 옮겨도 메모리가 늘지 않아 --n-cpu-moe 를 쓰지 않습니다.");
  } else if (gpu && modelBytes) {
    // The KV term: exact when the header was read, otherwise the legacy 0.3 MiB/token (unchanged).
    const kvBytes = exactKv ? kvPerToken * contextSize : 0.3 * GiB * (contextSize / 1024);
    const deficit = modelBytes + kvBytes - gpu.vramTotalBytes;
    if (deficit > 0) {
      // Each MoE expert layer moved to CPU buys back ~ (fileBytes/layers) of
      // VRAM but costs latency proportional to the fraction moved. We convert
      // the deficit into a layer count, then clamp: 0 if it already fits, and
      // never more than MAX_CPU_MOE_FRACTION of the model offloaded.
      const estimatedLayers = 80; // typical for a 35B-class MoE GGUF
      const fraction = Math.min(MAX_CPU_MOE_FRACTION, deficit / modelBytes);
      cpuMoeLayers = Math.max(1, Math.round(fraction * estimatedLayers));
      rationale.push(
        `VRAM이 모델(${(modelBytes / GiB).toFixed(1)} GiB)에 비해 부족해 MoE expert ${cpuMoeLayers}개 층을 CPU로 유지합니다 (--n-cpu-moe ${cpuMoeLayers}). ` +
          `활성 파라미터(3B급)만 GPU에 남기 때문에 8 GB급 카드에서도 35B가 동작합니다. ` +
          `이 값은 자동 계산이며, config 에 실측값이 있으면 그 값을 씁니다.`
      );
    }
  }

  // --- Parallel slots ------------------------------------------------------ //
  // This is a *coding agent*, one conversation per process, so the number of
  // slots we need is 1. The reason below was WRONG, and correcting it matters
  // beyond tidiness because it was cited as a load-time OOM argument:
  //
  //   "Every extra slot multiplies the KV cache and the batch buffer ...
  //    would silently quadruple the memory a config-sized context actually costs"
  //
  // That is false for an EXPLICIT -np, which is the only thing this file emits.
  // Verified against llama.cpp source and a live server:
  //
  //   src/llama-context.cpp:294   n_ctx_seq = n_ctx / n_seq_max   (kv_unified=false)
  //   src/llama-model.cpp:2600    attn_kv_size = n_ctx_seq
  //   common/common.cpp:1722      n_seq_max  = n_parallel
  //
  // So the KV pool is allocated ONCE at n_ctx/n_parallel. Adding a slot
  // SHRINKS it. The "quadruples the memory" scenario requires kv_unified=true.
  //
  // kv_unified is the one case where the old warning is right, and it is a
  // real trap — but it is triggered by OMITTING -np, not by raising it:
  //
  //   tools/server/server.cpp:156-160
  //     if (n_parallel < 0) { n_parallel = 4; kv_unified = true; }
  //
  // Leave -np at llama.cpp's default (auto) and the server silently picks 4
  // slots AND turns on unified KV — which is precisely the 4x multiplication
  // this comment used to blame on raising -np. Passing -np explicitly is what
  // keeps kv_unified off (llama-context.cpp:290-292 takes the other branch).
  // So the flag is load-bearing for a reason, just not the stated one.
  //
  // What the extra slot actually costs, stated honestly:
  //   - per-slot context becomes n_ctx / n_parallel (a REAL cost, and silent)
  //   - host-side batch/output bookkeeping scales with n_seq_max (CPU, not VRAM)
  //   - VRAM: no increase under kv_unified=false
  //
  // The per-slot halving is why buildServerArgs now multiplies -c by the slot
  // count (see there) — without that, raising `parallel` in config.yaml would
  // quietly halve the user's working memory.
  const parallel = 1;
  rationale.push(
    "--parallel 1: 에이전트는 세션 1개이므로 슬롯이 필요 없습니다. " +
      "명시적으로 지정하는 이유는 llama.cpp 의 auto(-1) 기본값이 슬롯 4개 + kv_unified 를 함께 켜서 " +
      "KV 캐시를 공유 풀로 늘리기 때문입니다 (tools/server/server.cpp). " +
      "명시적 -np 에서는 슬롯을 늘려도 KV 캐시가 곱해지지 않습니다 — 총 -c 를 슬롯 수로 나눕니다. " +
      "단, 슬롯 수를 늘리면 슬롯당 컨텍스트도 그만큼 줄어드므로 -c 를 함께 늘려야 합니다."
  );

  return {
    gpuLayers,
    threads,
    threadsBatch,
    contextSize,
    batchSize,
    ubatchSize,
    cpuMoeLayers,
    flashAttn: true,
    cacheTypeK,
    cacheTypeV,
    parallel,
    rationale,
    gpu,
  };
}

/** VRAM we may actually spend: free memory on the chosen GPU, minus a reserve.
 *  The reserve covers the compositor (measured live: gnome-shell holds 150 MiB
 *  on GPU 0 on this box) and the transient allocations a load does before it
 *  settles. Without it, "free = 8192 MiB on a paper-spec card" plans a model
 *  that OOMs two seconds into loading — the failure mode this whole file
 *  exists to prevent.
 *
 *  `oursBytes` is the VRAM our OWN llama-server is holding. It is added back,
 *  and this is not a refinement — without it the budget collapses exactly when
 *  llamacli is doing its job.
 *
 *  On a first launch — the only path that actually reaches the tuner, since
 *  bootstrap returns early when it adopts an already-running server — the card
 *  is empty apart from the compositor, so plain free VRAM is nearly the truth.
 *  It stops being true the moment anything else touches the card: a
 *  hardware-accelerated browser, another CUDA process, a second llamacli. That
 *  memory is real and is still counted against the budget.
 *
 *  What must NOT be discounted is our own server's weights — they are what a
 *  context is being sized FOR. Counting them as unavailable headroom makes the
 *  tuner contradict the configuration it is about to launch with: on the
 *  reference box (RTX 2070 SUPER, 8 GiB, 35B-A3B Q4_K_M) a card reporting
 *  1.49 GiB free next to that server yields a 0.5 GiB budget and collapses the
 *  context to 4096, against a server demonstrably running `-c 16384`.
 *
 *  So `oursBytes` adds back only what is attributable to our own server — see
 *  ownLlamaServerVramGiB() in hardware.ts for how that is measured. */
export function budgetVramGiB(hw: Hardware, gpu: Gpu | null, oursBytes = 0): number {
  if (!gpu) {
    // No GPU: the limit is RAM, and we can't have the model plus its KV cache
    // plus the OS out of a small box, so scale on RAM with a big reserve.
    return Math.max(0.5, (hw.ramTotalBytes / GiB) * 0.6);
  }
  const RESERVE_MIB = 1024;
  const free = gpu.vramFreeBytes > 0 ? gpu.vramFreeBytes : gpu.vramTotalBytes;
  const usable = Math.min(gpu.vramTotalBytes, free + Math.max(0, oursBytes));
  return Math.max(0.5, (usable - RESERVE_MIB * UNITS.MiB) / GiB);
}

/** System RAM headroom after accounting for a model file, for the "does this
 *  box even have room to page experts from" question. */
export function ramBudgetGiB(hw: Hardware, modelBytes = 0): number {
  const usable = hw.ramTotalBytes - modelBytes * 1.15; // paging overhead
  return Math.max(0, usable / GiB);
}
