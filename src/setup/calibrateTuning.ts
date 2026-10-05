/**
 * `/server calibrate` — **재현된 재계산** (the reproduced re-derivation).
 *
 * ── 왜 이것이 별도 단계인가 ───────────────────────────────────────────────────
 * `tuneForHardware` 는 **예측**이다. 카드 크기와 모델 크기로부터
 * `-ngl 999`, 컨텍스트 N, `--n-cpu-moe M` 을 산술로 낸 값이고, 실측과 어긋난다.
 * 그랬던 예가 붙잡힌 화면 한 줄이다:
 *
 *     · -ngl: 999 → 32
 *     · --n-cpu-moe: 33 → 0
 *
 * 35B-A3B 를 9B 로 바꾸는 건데 `-ngl` 이 999 에서 **32** 로 떨어진다. 산술이
 * "9B 는 8 GiB 카드에 안 들어간다" 고 판단한 결과지만, 실제로 올려보면 들어간다.
 * 그리고 이건 **빈 곳에서 나온 말이 아니다**: 그 직전에 35B 가 `-ngl 999` 로
 * 돌고 있었다. 예전 계산이 9B 에 대해 틀렸다는 뜻이다.
 *
 * 게다가 `calibrate.ts` 의 기존 보정은 **MoE 의 `--n-cpu-moe` 만** 본다
 * (`infoFor` 이 dense 면 `undefined` 를 돌려준다). 그래서 dense 인 9B 위의
 * `-ngl 32` 는 아무도 확인하지 못한 채 config 에 기록되고, 다음 부팅마다
 * 그대로 재사용된다. **틀린 값이 측정 없이 영구화된다.**
 *
 * ── 이 모듈이 하는 일 ───────────────────────────────────────────────────────
 * 실제로 올라간 서버에서 **재현된 값**을 읽어, 그 값에 맞는 최적으로 다시 잡는다:
 *
 *   1. `nvidia-smi` 로 카드에 **실제로 남은** VRAM 을 읽는다 (예측 아님).
 *   2. GGUF 헤더로 **정확한** KV 비용·레이어 수·훈련 컨텍스트를 읽는다
 *      (`tuning.ts` 가 헤더를 못 읽을 때 쓰는 0.3 MiB/token 추정의 29배 오차 소거).
 *   3. 위 두 실측으로 `-ngl` · `--n-cpu-moe` · 컨텍스트 · KV 타입 · 스레드를 다시 계산한다.
 *      산식은 `tuneForHardware` **그 자체** — 규칙이 둘로 갈라지지 않게.
 *   4. 바뀔 것이 있으면 **미리보기 → confirm** 을 거치고, 실패하면 **직전 설정으로 되돌린다**.
 *
 * 계산만 하는 순수 함수(`planCalibration`)와 실행하는 껍데기(`runServerCalibrate`)를
 * 나눴다. 전자는 하드웨어·프로세스·파일 없이 검증되고, 후자는 의존성을 주입받아
 * 서버를 띄우지 않고 테스트된다.
 */

import { tuneForHardware, threadPlan, type LlamaTuning } from "./tuning.js";
import { kvBytesPerElement } from "./ggufMeta.js";
import { recommendThresholds } from "../compaction/compactor.js";
import type { Hardware } from "./hardware.js";
import type { ParsedServerArgs } from "./modelSwitch.js";

const MiB = 1024 * 1024;
const GiB = 1024 ** 3;

export interface CalibrationReading {
  /** Free VRAM (MiB) on the primary GPU **as the running server leaves it**. */
  freeMiB?: number;
  /** Total VRAM (MiB) on that card. */
  totalMiB?: number;
  /** VRAM (MiB) held by OUR OWN llama-server, from `nvidia-smi`'s per-pid
   *  compute-app list. Added back to `freeMiB`: we are asking what a FRESH launch
   *  would have, and a fresh launch gets this memory back. */
  ownVramMiB?: number;
  /** The card's name, for the record and for the calibration key. */
  gpuName?: string;
  /** The model file's size in bytes. 0 when it cannot be stat'd. */
  modelBytes?: number;
  /** Transformer block count from the GGUF header. */
  layers?: number;
  /** K+V elements per token of context, from the header. Exact when present. */
  kvElementsPerToken?: number;
  /** The model's trained context length from the header. */
  trainedContext?: number;
  /** true = MoE, false = dense, undefined = unknown. */
  moe?: boolean;
  /** True on Apple Silicon: VRAM and system RAM are one pool, so the
   *  offload arithmetic below must not treat them as separate budgets. */
  unifiedMemory?: boolean;
  /** Logical cores, for the thread split. */
  cpuCount?: number;
}

export interface CalibrationChange {
  label: string;
  from: unknown;
  to: unknown;
}

export interface CalibrationPlan {
  /** True when at least one field would change. */
  changed: boolean;
  changes: CalibrationChange[];
  /** The tuning to launch with. Fields the tuner does not decide are absent. */
  tuning: Partial<ParsedServerArgs>;
  /** Why, in Korean — the tuner's own rationale plus what the measurement settled. */
  notes: string[];
  /** Fields the measurement could NOT settle, so they were left alone. Named,
   *  because "nothing changed" and "we could not measure it" must not look alike. */
  unmeasured: string[];
}

/** `-ngl` below this means "almost nothing on the GPU"; calibrating from it is
 *  meaningless noise (one layer of a 40-layer model is 2.5% of throughput). */
const MIN_USEFUL_LAYERS = 4;

/** VRAM left unspent on purpose: the compositor (measured live: gnome-shell holds
 *  ~150 MiB) plus what a load allocates transiently before it settles. The same
 *  margin `calibrate.ts` uses for its `--n-cpu-moe` trial — two places, one number. */
const SAFETY_MARGIN_MIB = 600;

/** Fraction of a GGUF that is transformer-block weights rather than embeddings,
 *  tokenizer and metadata. 0.9 matches `calibrate.ts`'s expert-tensor ratio; the
 *  remainder is what keeps the per-block cost an over-estimate, i.e. erring toward
 *  leaving blocks on the CPU. */
const WEIGHT_SHARE = 0.9;

/** Ceiling for a MEASURED context, identical to `tuning.ts`'s `EXACT_KV_MAX_CONTEXT`:
 *  98,304 tokens is the largest context benchmarked end-to-end on an 8 GiB card in
 *  this project (docs/model-bench-2026-10-03.md). Beyond it the prefill cost of a
 *  compaction is unmeasured, so it is not claimed — a card with room does not get
 *  to invent a number nobody has run. */
const MEASURED_MAX_CONTEXT = 98304;

/** Floor, matching `tuneForHardware`: below this a coding agent cannot hold a
 *  system prompt and a few tool results. */
const MIN_CONTEXT = 4096;

/** Held back when GROWING the context, on top of the safety margin.
 *
 *  The GGUF header states the KV cache exactly, but not everything that scales with
 *  context length: llama.cpp's compute buffer grows with it too. Measured on the box
 *  above — 236 MiB at `-c 36864`, 536 MiB at `-c 98304`, i.e. ~300 MiB across a
 *  61,440-token span, which is ~29% on top of the KV figure the header gives. A plan
 *  that spends the header's number exactly therefore over-commits by that much, and
 *  the first long prompt is where it shows up. 384 MiB is the measured 300 rounded up
 *  to a block. */
const COMPUTE_GROWTH_MIB = 384;

/**
 * The plan: given what is running and what is measurable, what should run instead?
 *
 * Pure. No I/O, no process, no clock — so the arithmetic that decides a user's
 * throughput can be tested against a synthetic machine instead of whatever box
 * the suite runs on.
 *
 * `measured` absent fields are NOT treated as zero. A missing reading is an
 * unknown, and an unknown substituted with 0 is how a tuner talks itself into
 * `-ngl 0` on a card it never measured.
 */
export function planCalibration(
  running: ParsedServerArgs,
  measured: CalibrationReading,
  opts: { modelBytesForHeader?: number } = {}
): CalibrationPlan {
  const changes: CalibrationChange[] = [];
  const notes: string[] = [];
  const unmeasured: string[] = [];
  const before = { ...running };

  // ── What can be measured at all? ────────────────────────────────────────
  // The whole plan is VRAM arithmetic. Without a real free reading there is no
  // measurement to calibrate against, and a prediction re-derived from itself
  // is still a prediction — so we say so instead of producing confident noise.
  if (measured.freeMiB === undefined || measured.totalMiB === undefined) {
    return {
      changed: false, changes: [], tuning: {}, notes: [],
      unmeasured: ["카드의 남은 VRAM (nvidia-smi 를 읽지 못했습니다)"],
    };
  }
  if (!measured.modelBytes) {
    return {
      changed: false, changes: [], tuning: {}, notes: [],
      unmeasured: ["모델 파일 크기 (gguf 가 없거나 읽을 수 없습니다)"],
    };
  }

  // Unified memory (Apple Silicon): "free VRAM" and free RAM are the same pool,
  // and Metal decides residency itself. The discrete-card arithmetic below would
  // read a shared pool as a dedicated one and happily produce a -ngl it cannot
  // honour, so this path only fixes the thread split and says why it stopped.
  if (measured.unifiedMemory) {
    const plan = measured.cpuCount ? threadPlan(measured.cpuCount, true) : undefined;
    if (!plan) return { changed: false, changes: [], tuning: {}, notes: [], unmeasured: ["CPU 코어 수"] };
    const tuning: Partial<ParsedServerArgs> = {};
    if (before.threads !== plan.threads) {
      tuning.threads = plan.threads;
      changes.push({ label: "스레드", from: before.threads ?? "?", to: plan.threads });
    }
    if (before.threadsBatch !== undefined && before.threadsBatch !== plan.threadsBatch) {
      tuning.threadsBatch = plan.threadsBatch;
      changes.push({ label: "프롬프트 스레드", from: before.threadsBatch, to: plan.threadsBatch });
    }
    notes.push(
      "통합 메모리(Apple Silicon)라 VRAM 과 RAM 이 한 풀입니다 — Metal 이 residency 를 정하므로 오프로드 수를 산술로 다시 잡지 않습니다.",
      `스레드는 코어 ${measured.cpuCount}개 기준으로 다시 계산했습니다.`
    );
    return { changed: changes.length > 0, changes, tuning, notes, unmeasured: [] };
  }

  // ── The measured budget ────────────────────────────────────────────────
  // This is the number `tuneForHardware` was guessing at. Free VRAM measured
  // **while our server holds its weights** is the honest one: it is what a fresh
  // launch would actually start from, and the old formula's "free = paper spec"
  // assumption is exactly what produced `-ngl 32` on a card that takes 999.
  const totalMiB = measured.totalMiB;
  const freeMiB = measured.freeMiB;
  // Only the part of the free reading that is OURS may be counted back. We cannot
  // tell from `freeMiB` alone which process holds the rest, and crediting a
  // stranger's memory to our own budget is how a plan OOMs on a machine with a
  // browser open.
  const ownMiB = measured.ownVramMiB ?? 0;
  const usableMiB = Math.min(totalMiB, freeMiB + ownMiB);

  // Feed the measurement in as a synthetic `Hardware` so the rules stay in ONE
  // place. The GPU's "free" becomes what is really free once our own server
  // releases its share, which is precisely what `budgetVramGiB` derives from.
  const hw: Hardware = {
    cpuCount: measured.cpuCount ?? 1,
    ramTotalBytes: 0,
    ramAvailableBytes: 0,
    gpus: [
      {
        index: 0,
        name: measured.gpuName ?? "GPU",
        vramTotalBytes: totalMiB * MiB,
        vramFreeBytes: usableMiB * MiB,
        vendor: "nvidia",
      },
    ],
    gpuBackend: "cuda",
    canBuildCuda: false,
    tools: {},
    platform: process.platform,
  };

  const tuned: LlamaTuning = tuneForHardware(hw, {
    modelBytes: measured.modelBytes,
    moe: measured.moe,
    kvElementsPerToken: measured.kvElementsPerToken,
    trainedContext: measured.trainedContext,
    modelLayers: measured.layers,
    ownServerVramGiB: ownMiB / GiB,
    // A context the user raised by hand is honoured by `tuneForHardware`; during a
    // calibration that is the WRONG default, because the whole point is to test
    // whether the recorded value still fits. So it is not passed — the measured
    // budget decides, and a smaller recorded value is replaced rather than kept.
  });

  // ── What we can act on, and what we merely report ───────────────────────
  const tuning: Partial<ParsedServerArgs> = {};

  // ── The measured fit, NOT the predicted one ─────────────────────────────
  //
  // This is the whole point of the module, and the first live run of it proved
  // why it has to be written this way. Feeding the measurement into
  // `tuneForHardware` and using ITS answer produced `-ngl: 32 → 31` on the very
  // box the regression was reported from — i.e. it proposed making the server
  // worse, while looking confident.
  //
  // Why the prediction is wrong here, in numbers read off that machine
  // (RTX 2070 SUPER, 8 GiB, Ornith 9B Q4_K_M = 5.38 GiB, 34 layers):
  //
  //   measured at `-ngl 32` → `offloaded 32/34 layers to GPU`, 2023 MiB free
  //   measured at `-ngl 999` → `offloaded 34/34 layers to GPU`, 1771 MiB free
  //
  // So moving the last 2 layers onto the GPU costs **252 MiB**, and 1.7 GiB is
  // still free. But `tuneForHardware` reserves `min(modelBytes + 0.5, budget *
  // 0.9)` for the weights of a dense model AND then subtracts the KV and another
  // 0.5 GiB on top, so the weights are counted against the budget twice — a
  // double count worth exactly the couple of layers it lost.
  //
  // So the arithmetic below does not reuse that reserve. It uses the only two
  // numbers that are measured rather than estimated:
  //
  //   - the cost of ONE transformer block, from the model's own file and header
  //   - the VRAM that is REALLY free right now, from the card
  //
  // and asks the question directly: how many more blocks fit in what is left?
  const layers = measured.layers ?? 0;
  const cacheType = before.cacheTypeK ?? tuned.cacheTypeK ?? "q8_0";
  // MiB per transformer block. The file is ~90% weights and they are spread evenly
  // over the blocks, so this reads the model's own shape rather than guessing from
  // the card — and on the measured box it is 162 MiB against an observed 126 MiB,
  // i.e. it errs toward keeping layers on the CPU, the safe direction.
  const perLayerMiB = layers > 0 ? (measured.modelBytes * WEIGHT_SHARE) / layers / MiB : 0;
  // VRAM we will not spend: the compositor, and what a load allocates transiently
  // before it settles. The same margin `calibrate.ts` has always used for its
  // `--n-cpu-moe` trial, so the two do not disagree about what "spare" means.
  const slackMiB = freeMiB - SAFETY_MARGIN_MIB;
  const roomForBlocks = perLayerMiB > 0 ? Math.floor(slackMiB / perLayerMiB) : 0;

  // `-ngl`. `>= 999` is llama.cpp's "all of them", and it is what a full-offload
  // plan emits — deliberately NOT the layer count. The GGUF header's `block_count`
  // is 33 for a model llama.cpp reports as 34 layers (it counts the output layer
  // separately), so a counted total would silently leave one block on the CPU.
  // 999 is both correct and survives a later model swap.
  const haveLayers = before.gpuLayers;
  let wantLayers: number | undefined;
  /** VRAM the layer change itself commits — context may not spend it as well. */
  let layerCostMiB = 0;
  if (haveLayers === undefined) {
    unmeasured.push("현재 -ngl (실행 중인 서버의 명령줄에서 읽지 못했습니다)");
  } else if (layers <= 0) {
    unmeasured.push("모델 레이어 수 (헤더를 못 읽었습니다 — -ngl 을 다시 잡지 않았습니다)");
  } else {
    const have = haveLayers >= 999 ? layers : Math.min(haveLayers, layers);
    const raw = have + roomForBlocks;
    const target = Math.max(0, Math.min(layers, raw));
    wantLayers = target >= layers ? 999 : target;
    layerCostMiB = Math.max(0, target - have) * perLayerMiB;
    notes.push(
      `층당 ${perLayerMiB.toFixed(0)} MiB (모델 파일 ${(measured.modelBytes / GiB).toFixed(2)} GiB ÷ ${layers}층), ` +
        `지금 남은 VRAM ${Math.round(freeMiB)} MiB − 안전 여유 ${SAFETY_MARGIN_MIB} MiB = ${Math.round(slackMiB)} MiB → ` +
        `${roomForBlocks}층을 더(또는 덜) 올릴 수 있습니다.` +
        (layerCostMiB > 0 ? ` 그중 ${Math.round(layerCostMiB)} MiB 는 컨텍스트에 쓰지 않도록 따로 빼 둡니다.` : "")
    );
  }

  if (wantLayers !== undefined && haveLayers !== undefined && wantLayers !== haveLayers) {
    // A server sitting on a handful of layers is not a calibration target: nudging
    // 1 → 2 of 40 layers changes throughput by ~2% and costs a restart. Reported.
    const have = haveLayers >= 999 ? layers : haveLayers;
    const want = wantLayers >= 999 ? layers : wantLayers;
    if (have > 0 && have < MIN_USEFUL_LAYERS && want < MIN_USEFUL_LAYERS) {
      notes.push(
        `-ngl 이 ${haveLayers} → ${wantLayers} 로 달라지지만, ${have} 개는 사실상 CPU 실행이라 조정할 이유가 없습니다 (그대로 둡니다).`
      );
    } else {
      tuning.gpuLayers = wantLayers;
      changes.push({ label: "-ngl", from: haveLayers, to: wantLayers });
    }
  }

  // `--n-cpu-moe`. The MoE counterpart, and the same measurement: each expert
  // layer brought back from system RAM costs `perLayerMiB` of VRAM, so the spare
  // room says how many can come back. A dense model has no experts at all, and a
  // value left over from a previous MoE model has to go — it is not "harmless",
  // it is a flag telling llama.cpp to page a tensor layout that does not exist.
  if (measured.moe === true) {
    const have = before.cpuMoeLayers ?? 0;
    const target = Math.max(0, Math.min(layers || have, have - roomForBlocks));
    if (before.cpuMoeLayers !== undefined && before.cpuMoeLayers !== target) {
      tuning.cpuMoeLayers = target;
      changes.push({ label: "--n-cpu-moe", from: before.cpuMoeLayers, to: target });
    }
  } else if (measured.moe === false && before.cpuMoeLayers) {
    tuning.cpuMoeLayers = 0;
    changes.push({ label: "--n-cpu-moe", from: before.cpuMoeLayers, to: 0 });
    notes.push("밀집(dense) 모델이라 expert 가 없어 --n-cpu-moe 를 끕니다 (이전 모델의 값이 남아 있었습니다).");
  }

  // ── Context, also from the measurement ──────────────────────────────────
  //
  // The same double-counted reserve caps context at 36,864 on the measured box,
  // while the card demonstrably holds 65,536 with 1,155 MiB to spare. So the KV
  // cost — which is EXACT here, straight from the GGUF header — is multiplied by
  // the VRAM that is really spare, and no reserve is subtracted a second time.
  //
  // Two things this got wrong on the first live run, both worth stating because
  // they are the shape of every "measured" number that is really a prediction:
  //
  //  - The spare VRAM was already spent on `-ngl` above. The layer increase costs
  //    `layerCostMiB`, and context can only have what is left. (Spending the same
  //    slack twice is exactly the double count this module exists to remove.)
  //  - `freeMiB` is read from a server that ALREADY has a context allocated, so the
  //    slack is HEADROOM, not a total budget. Reading it as a total made a second
  //    pass shrink a context that fit perfectly well — calibration that oscillates
  //    is worse than calibration that does nothing.
  if (before.contextSize !== undefined) {
    if (measured.kvElementsPerToken && measured.kvElementsPerToken > 0) {
      const kvBytesPerToken = measured.kvElementsPerToken * kvBytesPerElement(cacheType);
      const afterOffloadMiB = slackMiB - layerCostMiB;
      // How far past the margin we are once the offload change is paid for. `slack`
      // is negative exactly when the RUNNING configuration already sits under the
      // margin, which is the only case that justifies shrinking.
      const deficitMiB = Math.max(0, -afterOffloadMiB);
      // What a GROWTH may spend: the margin is already inside `slack`, so only the
      // compute-buffer allowance has to come out of what is on top of it.
      const headroomMiB = afterOffloadMiB - COMPUTE_GROWTH_MIB;
      const ceiling = Math.min(
        MEASURED_MAX_CONTEXT,
        measured.trainedContext ? Math.floor(measured.trainedContext / 4096) * 4096 : MEASURED_MAX_CONTEXT
      );
      const align = (t: number) => Math.max(MIN_CONTEXT, Math.min(ceiling, Math.floor(t / 4096) * 4096));
      const tokensOf = (mib: number) => Math.floor((mib * MiB) / kvBytesPerToken);

      let target = before.contextSize;
      if (deficitMiB > 0) {
        // Under the margin: give back exactly the deficit, and nothing more.
        target = Math.min(before.contextSize, align(before.contextSize - tokensOf(deficitMiB)));
      } else if (headroomMiB >= 0) {
        // Margin intact with room to spare: grow into what is left.
        target = Math.max(before.contextSize, align(before.contextSize + tokensOf(headroomMiB)));
      }
      // Otherwise the margin is intact and the context is left exactly as it is.
      //
      // That "otherwise" is load-bearing, and getting it wrong is how the first live
      // run produced a plan that shrank a context which had just been measured at
      // 628 MiB free — i.e. one whose margin was intact — and would have grown it
      // back on the next pass. Calibration that oscillates is worse than no
      // calibration: each pass costs a server restart.
      if (target !== before.contextSize) {
        tuning.contextSize = target;
        changes.push({ label: "컨텍스트", from: before.contextSize, to: target });
      }
      notes.push(
        `컨텍스트: 여유 ${Math.round(slackMiB)} MiB − 오프로드 ${Math.round(layerCostMiB)} MiB ` +
          `= ${Math.round(afterOffloadMiB)} MiB (안전 여유 ${SAFETY_MARGIN_MIB} MiB ${deficitMiB > 0 ? "미달" : "충족"})` +
          `${deficitMiB > 0 ? ` − 부족분 ${Math.round(deficitMiB)} MiB 만큼 줄입니다` : ` − 계산 버퍼 여유 ${COMPUTE_GROWTH_MIB} MiB 후 ${Math.round(headroomMiB)} MiB 로 확장`}` +
          ` · ${(kvBytesPerToken / 1024).toFixed(1)} KiB/토큰(헤더 실측) · 결과 ${target.toLocaleString()} 토큰 ` +
          `(상한 ${ceiling.toLocaleString()}: ${ceiling === MEASURED_MAX_CONTEXT ? "이 프로젝트 실측 한계" : "모델 훈련 길이"})`
      );
    } else {
      // No header: fall back to the predicted value rather than guessing a size.
      if (tuned.contextSize !== before.contextSize) {
        tuning.contextSize = tuned.contextSize;
        changes.push({ label: "컨텍스트", from: before.contextSize, to: tuned.contextSize });
      }
      unmeasured.push("KV 비용 (헤더를 못 읽었습니다 — 컨텍스트는 모델 크기 추정값으로만 조정)");
    }
  }

  // ── Compaction follows the context ────────────────────────────────────
  //
  // The trigger/summary/tail numbers are meaningless as absolutes — they are
  // fractions of THIS window. A context change without a compaction change
  // leaves the old assumption in place (the hardcoded {0.6, 32768} this
  // replaced): a grown window then compacts far too often, a shrunk one far
  // too late. So the recommendation is recomputed from the context this plan
  // actually launches with, and recorded here — server/index.ts applies the
  // same function live, so the two cannot disagree about what "adapted" means.
  // A note, not a tuning field: ParsedServerArgs carries only llama-server
  // flags, and compaction thresholds are not one.
  {
    const ctx = tuning.contextSize ?? before.contextSize;
    if (ctx !== undefined) {
      const rec = recommendThresholds(ctx);
      notes.push(
        `컴팩션(적응형): 컨텍스트 ${ctx.toLocaleString()} 토큰 → 트리거 ${(rec.autoTriggerRatio * 100).toFixed(0)}%` +
          `(${Math.floor(ctx * rec.autoTriggerRatio).toLocaleString()} 토큰), 요약 예산 ${rec.summaryMaxTokens} 토큰` +
          `, 압축 후 목표 트리거의 ${Math.round((rec.postCompactionTargetRatio ?? 0.4) * 100)}%` +
          ` — 서버 기동 시 같은 규칙으로 자동 적용됩니다.`
      );
    } else {
      unmeasured.push("컴팩션 권장값 (컨텍스트를 정하지 못했습니다)");
    }
  }

  // KV precision. `q4_0` costs real accuracy on a model whose weights are already
  // quantised; a measured budget with room goes back to `q8_0`.
  if (tuned.cacheTypeK && before.cacheTypeK && before.cacheTypeK !== tuned.cacheTypeK) {
    tuning.cacheTypeK = tuned.cacheTypeK;
    tuning.cacheTypeV = tuned.cacheTypeV;
    changes.push({ label: "KV 캐시", from: before.cacheTypeK, to: tuned.cacheTypeK });
  }

  // Threads. Same `threadPlan` the first-run tuner uses, so the two cannot drift.
  // The GPU/CPU split follows the offload we are about to ASK FOR, not the one that
  // happens to be running — otherwise a plan that turns the GPU on would keep the
  // CPU-only thread count, which is the wrong half of the pair.
  if (measured.cpuCount) {
    const tp = threadPlan(measured.cpuCount, (tuning.gpuLayers ?? before.gpuLayers ?? 0) > 0);
    if (before.threads !== tp.threads) {
      tuning.threads = tp.threads;
      changes.push({ label: "스레드", from: before.threads ?? "?", to: tp.threads });
    }
    if (before.threadsBatch !== undefined && before.threadsBatch !== tp.threadsBatch) {
      tuning.threadsBatch = tp.threadsBatch;
      changes.push({ label: "프롬프트 스레드", from: before.threadsBatch, to: tp.threadsBatch });
    }
  } else {
    unmeasured.push("CPU 코어 수");
  }

  // `--flash-attn` is on in every plan this project has ever launched and buys
  // real memory at long context; only a server explicitly turned it off is moved.
  if (before.flashAttn === false) {
    tuning.flashAttn = true;
    changes.push({ label: "flash-attn", from: false, to: true });
  }

  notes.push(
    `측정: 카드 ${(totalMiB / 1024).toFixed(1)} GiB 중 서버가 뜬 상태로 ${(freeMiB / 1024).toFixed(2)} GiB 남음` +
      (ownMiB > 0 ? `, 우리 서버가 ${(ownMiB / 1024).toFixed(2)} GiB 보유 → 사용 가능 ${(usableMiB / 1024).toFixed(2)} GiB` : "") +
      ` · 모델 ${(measured.modelBytes / GiB).toFixed(1)} GiB` +
      (measured.kvElementsPerToken
        ? ` · KV ${((measured.kvElementsPerToken * kvBytesPerElement(tuned.cacheTypeK)) / 1024).toFixed(1)} KiB/토큰 (헤더 실측)`
        : ` · KV 비용은 모델 크기 추정값 (헤더를 못 읽었습니다)`) +
      (measured.trainedContext ? ` · 훈련 컨텍스트 ${measured.trainedContext.toLocaleString()} 토큰` : "")
  );
  // The predicted tuner's rationale is NOT repeated here, with one exception.
  //
  // It is the reasoning for a plan this function has just measured to be wrong, and
  // printing both is worse than printing neither: on the measured box it said
  // "-ngl 999 는 로드 시 메모리 부족이 됩니다" in the same breath as proposing
  // `-ngl 999`. A user cannot act on two contradictory sentences, and the wrong one
  // is the one that came from arithmetic.
  //
  // The KV-precision line is kept because calibration does NOT re-derive it — that
  // decision still belongs to the tuner, so its reason belongs with it.
  for (const line of tuned.rationale) {
    if (/^KV 캐시를/.test(line)) notes.push(line);
  }

  return { changed: changes.length > 0, changes, tuning, notes, unmeasured };
}