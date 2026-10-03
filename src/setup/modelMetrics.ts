/**
 * Local-model metrics: which models this machine can actually run, and why.
 *
 * ── Why this is not just a size list ────────────────────────────────────────
 * "Will it run on my PC" is not a question about file size alone, and answering
 * it with a size column is how people end up with a 22 GB download that OOMs
 * on load. Three things decide it, and all three are measured here:
 *
 *   1. Does the WEIGHTS fit in VRAM? → full offload, GPU-bound decode.
 *   2. If not, is there RAM to stream the MoE experts from? → runs, slower.
 *      This is the case that matters most in practice: an 8 GB card running a
 *      35B-A3B works precisely because only the ~3B active parameters are
 *      resident and the rest pages from RAM (`--n-cpu-moe`, see tuning.ts).
 *   3. If neither, does it fit in RAM at all? → CPU-only, very slow, or no.
 *
 * The VRAM budget deliberately reuses `budgetVramGiB` rather than repeating the
 * reserve arithmetic. That function holds back 1 GiB for the compositor and
 * load-time allocations, measured against gnome-shell holding 150 MiB on this
 * box; a second copy of that arithmetic here would be free to drift from the one
 * the tuner actually launches with, and the table would then promise a fit that
 * the launch does not honour.
 *
 * Deliberately NOT here: tokens/second estimates. They depend on the quant, the
 * build, the card's clocks and what else is running, and a confident-looking
 * number that is wrong by 3x is worse than no number.
 */

import stringWidth from "string-width";
import { pickPrimaryGpu, type Hardware } from "./hardware.js";
import { budgetVramGiB } from "./tuning.js";
import { APPROX_SIZES, ORNITH_35B_REPO, ORNITH_9B_REPO } from "./modelCatalog.js";

const GiB = 1024 ** 3;

export type Fit = "vram" | "stream" | "ram" | "no";

export interface ModelRung {
  /** Stable identifier, what `/models <id>` takes. */
  id: string;
  /** What a human calls it. */
  label: string;
  /** Total parameters, for display. */
  params: string;
  /** Parameters active per token — the number that decides MoE residency. */
  /** Parameters active per token, in billions — the number that decides MoE
   *  residency. Present only for MoE models, where it is the difference between
   *  "this fits" and "this runs by streaming experts from RAM". */
  activeParamB?: number;
  /** Display form of `activeParamB`, e.g. "3B 활성 (MoE)". */
  activeParams?: string;
  /** Quantisation label. */
  quant: string;
  /** On-disk bytes. From a measured file where one exists, else an estimate —
   *  which is why these are flagged as approximate below. */
  sizeBytes: number;
  /** True when `sizeBytes` is an estimate rather than a measured file. */
  approximate?: boolean;
  repo: string;
}

/** The rungs offered, largest first — the order a user scans when deciding what
 *  they can trade away. Sizes are the measured files where this machine has
 *  them. */
export const MODEL_RUNGS: ModelRung[] = [
  {
    id: "ornith-35b",
    label: "Ornith-1.5-35B-A3B",
    params: "35B",
    activeParamB: 3,
    activeParams: "3B 활성 (MoE)",
    quant: "Q4_K_M",
    sizeBytes: APPROX_SIZES["35b-a3b"],
    repo: ORNITH_35B_REPO,
  },
  {
    id: "ornith-9b",
    label: "Ornith-1.5-9B",
    params: "9B",
    quant: "Q4_K_M",
    sizeBytes: APPROX_SIZES["9b"],
    approximate: true,
    repo: ORNITH_9B_REPO,
  },
];

export interface FitReport {
  rung: ModelRung;
  fit: Fit;
  /** Plain Korean, one line. */
  verdict: string;
  /** Usable VRAM this decision was made against, in GiB. */
  budgetGiB: number;
  /**
   * The largest context that still fits alongside the weights, in tokens.
   *
   * Honest about being approximate: the KV cost per token depends on the
   * architecture, which is unknown before the file is downloaded, so this uses
   * the same ~0.3 MB/token at q8_0 figure tuning.ts budgets with.
   */
  maxContext?: number;
}

const KV_GIB_PER_TOKEN = 0.3 / (1024 * 1024); // ~0.3 MB/token at q8_0

/** How much VRAM is actually spendable on this machine right now. */
export function usableVramGiB(hw: Hardware, ownServerVramGiB = 0): number {
  const gpu = pickPrimaryGpu(hw);
  // ZERO when there is no GPU — deliberately, and this is the fix for a bug the
  // bare-environment harness found.
  //
  // `budgetVramGiB` falls back to `RAM * 0.6` when no GPU is present. That
  // fallback is CORRECT for its caller: the tuner needs a non-zero number to
  // size a CPU-only launch sanely, and returning 0 there collapses the context
  // to nothing on exactly the machines that need it sized most conservatively.
  //
  // It is wrong HERE. This function answers "how much VRAM may I spend", and the
  // table then labels the answer "✅ GPU에 완전히 올라갑니다" — fully resident on
  // the GPU. On a machine with no GPU at all that reported 4.8 GiB and told the
  // user a 1.9 GiB model loads entirely onto a GPU that does not exist. A
  // fallback meant for one caller was silently inherited by another, and the
  // headline verdict of `/models` was false.
  //
  // So the two are deliberately different numbers, and only the tuner gets the
  // RAM fallback. With 0 here, every rung correctly falls through to the RAM or
  // CPU tiers, which is the truth on a machine without a GPU.
  if (!gpu) return 0;
  // `ownServerVramGiB`: the running llama-server's share of the card. A model switch stops that server before
  // loading the new model, so for "will the NEW model fit" its memory counts as spendable.
  return budgetVramGiB(hw, gpu, ownServerVramGiB * GiB);
}

/**
 * Decides how a rung runs on this machine.
 *
 * The three-way split mirrors what llama.cpp actually does:
 *   - weights ≤ budget          → `-ngl 999`, everything on the GPU
 *   - weights ≤ budget + RAM    → `--n-cpu-moe N` pages experts from RAM
 *   - weights ≤ RAM only        → `-ngl 0`, CPU-only, honest about being slow
 *   - otherwise                 → does not run, and says so
 */
export interface FitOptions {
  /** VRAM held by the llama-server that a selection would REPLACE (see usableVramGiB). */
  ownServerVramGiB?: number;
}

export function evaluateFit(rung: ModelRung, hw: Hardware, opts: FitOptions = {}): FitReport {
  const budget = usableVramGiB(hw, opts.ownServerVramGiB ?? 0);
  const ramGiB = hw.ramTotalBytes / GiB;
  const sizeGiB = rung.sizeBytes / GiB;

  // What has to be RESIDENT differs by architecture, and conflating the two is
  // how a table ends up promising a full offload that then streams.
  //
  // For a DENSE model that is the whole file: every weight is touched every
  // token, so all of it wants to be on the GPU.
  //
  // For a MoE model it is the ACTIVE parameters only. The inactive experts are
  // touched rarely enough that llama.cpp pages them from RAM (`--n-cpu-moe`),
  // and it is exactly this that lets a 35B-A3B run on an 8 GB card — measured
  // on this box as `-ngl 999 --n-cpu-moe 30`.
  //
  // The first version of this used a flat "15% of the file" guess, and the
  // version after that tested only the ACTIVE size against the budget. Both
  // reported the 21.9 GiB 35B-A3B as a ✅ FULL VRAM fit on a 7 GiB budget,
  // because neither asked whether the WHOLE FILE fits. An explicit active count
  // fixes the guess; asking about the total is what fixes the verdict.
  const bitsPerWeight = 4.8; // Q4-class: 4.5 for the quant plus GGUF metadata
  const activeGiB = rung.activeParamB ? (rung.activeParamB * 1e9 * (bitsPerWeight / 8)) / GiB : sizeGiB;

  // Full offload requires the WHOLE file to be resident, which is the one
  // question that decides "vram" vs "stream".
  if (sizeGiB <= budget) {
    const spare = budget - sizeGiB;
    const ctx = Math.floor(spare / KV_GIB_PER_TOKEN / 1024) * 1024;
    return {
      rung,
      fit: "vram",
      budgetGiB: budget,
      maxContext: Math.max(4096, Math.min(32768, ctx)),
      verdict:
        `✅ GPU에 완전히 올라갑니다 (모델 ${sizeGiB.toFixed(1)} GiB ≤ 여유 VRAM ${budget.toFixed(1)} GiB). ` +
        `GPU가 전부 계산하므로 가장 빠릅니다.`,
    };
  }

  // The file does not fit. A MoE model can still run if the active parameters
  // are what stay resident; a dense one cannot, because every weight is needed
  // every token.
  if (rung.activeParamB && activeGiB <= budget && sizeGiB <= ramGiB * 0.7) {
    return {
      rung,
      fit: "stream",
      budgetGiB: budget,
      verdict:
        `⚠️ 모델 전체(${sizeGiB.toFixed(1)} GiB)는 VRAM(${budget.toFixed(1)} GiB)에 안 올라갑니다. ` +
        `하지만 활성 파라미터 약 ${rung.activeParamB}B만 GPU에 남기고 나머지 expert 를 ` +
        `RAM(${ramGiB.toFixed(0)} GiB)에서 스트리밍하면 실행됩니다. 느리지만 동작합니다.`,
    };
  }

  if (sizeGiB <= ramGiB * 0.7) {
    return {
      rung,
      fit: "ram",
      budgetGiB: budget,
      verdict:
        `⚠️ GPU는 사용하지 않고 CPU 전용(-ngl 0)으로만 실행됩니다. ` +
        `RAM(${ramGiB.toFixed(0)} GiB)에는 들어가지만 생성 속도가 매우 느립니다.`,
    };
  }

  return {
    rung,
    fit: "no",
    budgetGiB: budget,
    verdict:
      `❌ 이 머신에서는 실행되지 않습니다 (RAM ${ramGiB.toFixed(0)} GiB, 여유 VRAM ${budget.toFixed(1)} GiB).`,
  };
}

/** Every rung, evaluated against this machine. */
export function evaluateAll(hw: Hardware, rungs: ModelRung[] = MODEL_RUNGS, opts: FitOptions = {}): FitReport[] {
  return rungs.map((r) => evaluateFit(r, hw, opts));
}

/** Finds a rung by id, case-insensitively. */
export function findRung(id: string, rungs: ModelRung[] = MODEL_RUNGS): ModelRung | undefined {
  const q = id.trim().toLowerCase();
  return rungs.find((r) => r.id === q || r.label.toLowerCase() === q);
}

/**
 * Renders the catalogue as an aligned table.
 *
 * Column widths are computed from the content rather than hard-coded, because
 * these labels mix Korean and ASCII (a Korean glyph is two columns wide) and a
 * fixed-width template is exactly how a table ends up one column off. East Asian
 * width is measured with `string-width`, the same helper the TUI uses, so a row
 * cannot disagree with what is finally rendered.
 *
 * Returns BOTH the rendered lines and the 1-based numbers shown, so the caller
 * can tell the user which number to type and the selection code uses the same
 * numbering. Deriving them separately is how "/models 3" ends up selecting a
 * different row than the one labelled 3.
 */
export function formatModelTable(reports: FitReport[], opts: { afterReplace?: boolean } = {}): { lines: string[]; numbers: number[] } {
  // `afterReplace`: a server is running, so the verdict is for the NEW model after it replaces that server —
  // not for the card as it is now (which the old model is holding).
  const head = ["#", "모델", "파라미터", "양자화", "크기", opts.afterReplace ? "판정(교체 시)" : "판정"];
  const rows = reports.map((r, i) => [
    String(i + 1),
    r.rung.label,
    r.rung.activeParams ?? r.rung.params,
    r.rung.quant,
    `${(r.rung.sizeBytes / GiB).toFixed(1)} GiB${r.rung.approximate ? " (추정)" : ""}`,
    r.fit === "vram" ? "✅ VRAM" : r.fit === "stream" ? "⚠️ RAM 스트리밍" : r.fit === "ram" ? "⚠️ CPU 전용" : "❌ 불가",
  ]);

  // stringWidth counts display columns, which is what a terminal uses.
  const widths = head.map((h, c) => Math.max(stringWidth(h), ...rows.map((r) => stringWidth(r[c] ?? ""))));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stringWidth(s)));

  const lines = [
    head.map((h, c) => pad(h, widths[c])).join("  ").trimEnd(),
    head.map((_, c) => "─".repeat(widths[c])).join("  "),
    ...rows.map((r) => r.map((cell, c) => pad(cell, widths[c])).join("  ").trimEnd()),
  ];
  return { lines, numbers: rows.map((_, i) => i + 1) };
}

// Imported late to keep the module's own imports at the top readable; it is the
// same helper the TUI measures rendered text with.
