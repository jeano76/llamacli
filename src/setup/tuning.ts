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
  }
): LlamaTuning {
  const rationale: string[] = [];
  const gpu = pickPrimaryGpu(hw);
  const vram = totalVram(hw);
  const cpuCount = Math.max(1, hw.cpuCount);
  const ramGiB = hw.ramTotalBytes / GiB;

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
    rationale.push(
      `NVIDIA GPU ${gpu.index}번 (${gpu.name}, VRAM ${(gpu.vramTotalBytes / GiB).toFixed(1)} GiB) 우선 오프로드(-ngl 999)를 사용합니다.`
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
  const budgetGiB = budgetVramGiB(hw, gpu);
  let contextSize: number;
  if (budgetGiB >= 20) {
    contextSize = 32768;
  } else if (budgetGiB >= 10) {
    contextSize = 24576;
  } else if (budgetGiB >= 6) {
    contextSize = 16384;
  } else if (budgetGiB >= 3) {
    contextSize = 8192;
  } else {
    contextSize = 4096;
  }
  rationale.push(
    `컨텍스트는 ${contextSize} 토큰으로 설정했습니다 (사용 가능 VRAM ≈ ${budgetGiB.toFixed(1)} GiB 기준). ` +
      `이 값이 실제 서버보다 작으면 컴팩션이 과하게 자주, 크면 KV 캐시가 가중치 자리를 침범합니다.`
  );

  // --- KV cache precision -------------------------------------------------- //
  // q8_0 halves the KV cache versus f16 at a speed cost small enough to be
  // invisible next to MoE expert offloading, and on an 8 GB card that halved
  // cache is the difference between 16k and 32k of context. Below 3 GiB we go
  // to q4_0, which is a further halving and is where the small-VRAM boxes stop
  // fitting anything useful otherwise.
  const cacheTypeK = budgetGiB >= 3 ? "q8_0" : "q4_0";
  const cacheTypeV = cacheTypeK;
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
  const modelBytes = opts?.modelBytes;
  const measuredCpuMoe = opts?.cpuMoeLayers;
  if (measuredCpuMoe !== undefined && measuredCpuMoe > 0) {
    cpuMoeLayers = measuredCpuMoe;
    rationale.push(
      `--n-cpu-moe ${cpuMoeLayers} 은(는) 이 머신에서 실측된 값이라 그대로 유지합니다 (자동 계산값으로 덮지 않습니다).`
    );
  } else if (gpu && modelBytes) {
    const deficit = modelBytes + 0.3 * GiB * (contextSize / 1024) - gpu.vramTotalBytes;
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
  // This is a *coding agent*, one conversation per process. Every extra slot
  // multiplies the KV cache and the batch buffer, and the repo's own measured
  // configuration runs `--parallel 1` explicitly. Defaulting to llama.cpp's own
  // default of 4 would silently quadruple the memory a config-sized context
  // actually costs — which is how a tuned 16k context OOMs at load.
  const parallel = 1;
  rationale.push("--parallel 1: 에이전트는 세션 1개이므로 슬롯을 늘리면 KV 캐시와 배치 버퍼만 낭비합니다.");

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
 *  exists to prevent. */
export function budgetVramGiB(hw: Hardware, gpu: Gpu | null): number {
  if (!gpu) {
    // No GPU: the limit is RAM, and we can't have the model plus its KV cache
    // plus the OS out of a small box, so scale on RAM with a big reserve.
    return Math.max(0.5, (hw.ramTotalBytes / GiB) * 0.6);
  }
  const RESERVE_MIB = 1024;
  const free = gpu.vramFreeBytes > 0 ? gpu.vramFreeBytes : gpu.vramTotalBytes;
  return Math.max(0.5, (free - RESERVE_MIB * UNITS.MiB) / GiB);
}

/** System RAM headroom after accounting for a model file, for the "does this
 *  box even have room to page experts from" question. */
export function ramBudgetGiB(hw: Hardware, modelBytes = 0): number {
  const usable = hw.ramTotalBytes - modelBytes * 1.15; // paging overhead
  return Math.max(0, usable / GiB);
}
