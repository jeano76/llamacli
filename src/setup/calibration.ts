/**
 * Calibrating the backend against the machine, by measuring it.
 *
 * Requested directly: "reset 이 수행이 되면 칼리브레이션을 통해서 llama.cpp의
 * 설정도 변경이 되어야 하고" — /reset must re-derive the llama.cpp settings
 * through calibration, not through a lookup table.
 *
 * ── Why a table is not enough ───────────────────────────────────────────────
 * `tuning.ts` derives flags from hardware *description*: 8 GB of VRAM, 12
 * cores, 30 GB of RAM. That is the right starting point and it is what a
 * machine's spec sheet can honestly tell you. It cannot tell you that this
 * particular card is thermally throttled, that this particular build fell back
 * to a Vulkan path, that the driver in use is slower than the one the spec
 * assumes, or that the box is currently busy with something else.
 *
 * All of those change the answer, and all of them are observable: the backend
 * reports its own timings. Measured on this project's dev box:
 *
 *     prefill 334–480 tok/s, decode 38–41 tok/s
 *
 * Those two numbers are what actually determine how long a turn takes, so they
 * are what the settings should be derived from. Everything here is a probe
 * request plus arithmetic on the answer — no guessing, and the measurement is
 * returned so the user can see the justification rather than trusting it.
 *
 * The probe is deliberately tiny (a few hundred prompt tokens, a handful of
 * output tokens). A thorough benchmark would give better numbers and would also
 * take long enough to be noticed; this one costs well under a second and is
 * enough to separate "fine" from "several times slower than expected", which is
 * the decision the context size actually turns on.
 */

import type { Hardware } from "./hardware.js";
import { tuneForHardware, type LlamaTuning } from "./tuning.js";
import { UNITS } from "./hardware.js";

/** What a probe request measured. */
export interface Throughput {
  promptTokens: number;
  promptSeconds: number;
  promptTokensPerSecond: number;
  generatedTokens: number;
  generateSeconds: number;
  decodeTokensPerSecond: number;
  /** True when the timings were missing or nonsensical and the caller must fall
   *  back to the static profile rather than acting on garbage. */
  unreliable: boolean;
}

export interface Calibration {
  throughput: Throughput;
  tuning: LlamaTuning;
  /** How the measurement changed the answer vs. the static hardware table. */
  notes: string[];
  /** True when the probe failed and everything came from hardware detection. */
  degraded: boolean;
}

/** How long a prefill may take before the first token appears.
 *
 *  2.5 s. This is the latency the user actually perceives when they press
 *  Enter, and it is what bounds the context: a context that takes 12 s to
 *  prefill is unusable no matter how many tokens it nominally holds. Below
 *  ~1 s the cost is not felt; the ceiling is what matters, not the floor. */
export const PREFILL_BUDGET_SECONDS = 2.5;

export interface ProbeResult {
  promptTokens?: number;
  promptSeconds?: number;
  promptTokensPerSecond?: number;
  generatedTokens?: number;
  generateSeconds?: number;
  decodeTokensPerSecond?: number;
}

/** Folds a llama.cpp `/v1/chat/completions` response's `timings` block into a
 *  measurement, and refuses to trust it when the numbers are missing.
 *
 *  Split out and pure so the arithmetic — including the "is this usable?"
 *  decision — is testable without a backend. The untrusted path matters most:
 *  a probe against a dead or non-llama.cpp endpoint returns a response with no
 *  timings at all, and acting on `undefined` produced `NaN` context sizes
 *  rather than falling back. */
export function readThroughput(t: ProbeResult | undefined): Throughput {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const promptTokens = num(t?.promptTokens);
  const promptSeconds = num(t?.promptSeconds);
  const generatedTokens = num(t?.generatedTokens);
  const generateSeconds = num(t?.generateSeconds);
  const prefill = num(t?.promptTokensPerSecond);
  const decode = num(t?.decodeTokensPerSecond);
  // "Unreliable" is the common case, not an edge case: any endpoint that is not
  // llama.cpp, and any llama.cpp too old to report timings.
  const unreliable =
    !t || promptSeconds <= 0 || generateSeconds <= 0 || prefill <= 0 || decode <= 0 || generatedTokens <= 0;
  return {
    promptTokens,
    promptSeconds,
    promptTokensPerSecond: prefill,
    generatedTokens,
    generateSeconds,
    decodeTokensPerSecond: decode,
    unreliable,
  };
}

/** The largest context whose prefill still fits the latency budget, rounded
 *  down to a size llama.cpp's KV allocator handles cleanly.
 *
 *  Rounded to 4096: KV cache blocks are allocated in powers of two on several
 *  builds, so a context of 23,000 fragments the cache and wastes more memory
 *  than the un-rounded size would have. A slightly smaller clean allocation
 *  beats a slightly larger ragged one. */
export function contextFromPrefillRate(tokensPerSecond: number, budgetSeconds = PREFILL_BUDGET_SECONDS): number {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return 8192;
  const affordable = Math.floor((tokensPerSecond * budgetSeconds) / 4096) * 4096;
  // Floor: below this the agent cannot hold a system prompt plus a tool result
  // and compaction fires continuously. Ceiling: a coding session that needs
  // more should raise it deliberately, not have it silently set by a probe.
  return Math.max(4096, Math.min(32768, affordable));
}

/**
 * Re-derives the llama settings from a measurement, and explains the difference.
 *
 * Order matters: the hardware profile is computed FIRST and the measurement
 * only ever TIGHTENS the context downward. Letting a probe RAISE the context
 * above what the hardware profile allows would be a way for one slow or
 * mis-reported sample to push a machine into an OOM at load — the exact
 * failure the VRAM reserve in tuning.ts exists to prevent. A slow backend
 * should make us more conservative, never less.
 */
export function calibrate(opts: {
  hw: Hardware;
  timings?: ProbeResult;
  /** The model size, so a big model's KV cache still fits. */
  modelBytes?: number;
}): Calibration {
  const hardware = tuneForHardware(opts.hw, { modelBytes: opts.modelBytes });
  const throughput = readThroughput(opts.timings);
  const notes: string[] = [];

  if (throughput.unreliable) {
    notes.push(
      "속도 측정 실패(백엔드가 timings 를 보고하지 않음) — 하드웨어 정보만으로 설정했습니다."
    );
    return { throughput, tuning: hardware, notes, degraded: true };
  }

  notes.push(
    `측정: prefill ${throughput.promptTokensPerSecond.toFixed(0)} tok/s, ` +
      `decode ${throughput.decodeTokensPerSecond.toFixed(1)} tok/s`
  );

  const measured = contextFromPrefillRate(throughput.promptTokensPerSecond);
  const chosen = Math.min(measured, hardware.contextSize);
  if (chosen === hardware.contextSize) {
    notes.push(
      `컨텍스트 ${chosen} 토큰 유지 (하드웨어 기준 상한이 측정치보다 작음 — 더 크게 올리면 로드 시 OOM 위험).`
    );
  } else {
    notes.push(
      `컨텍스트 ${hardware.contextSize} → ${chosen} 토큰으로 축소. ` +
        `prefill ${throughput.promptTokensPerSecond.toFixed(0)} tok/s 기준 ` +
        `${PREFILL_BUDGET_SECONDS}초 예산(첫 토큰 체감 시간)을 넘기기 때문입니다.`
    );
  }

  const tuning: LlamaTuning = { ...hardware, contextSize: chosen };
  // Thread count stays as the hardware profile chose it. Throughput does not
  // justify changing it: generation is GPU-bound once anything is offloaded,
  // and a slow decode usually means a weak GPU, not too few threads — so
  // "add more threads" would be the wrong remedy for the symptom we measured.
  notes.push(
    `스레드 ${tuning.threads}개는 유지합니다 — decode ${throughput.decodeTokensPerSecond.toFixed(1)} tok/s 는 ` +
      `보통 GPU/메모리 대역폭 한계라 스레드로 해결되지 않습니다.`
  );

  return { throughput, tuning, notes, degraded: false };
}

/** Issues the probe request and returns its `timings`.
 *
 *  Small on purpose: ~400 prompt tokens and 16 output tokens. That is enough
 *  for the prefill rate to be meaningful and costs about a second. It is NOT a
 *  benchmark and does not claim to be.
 *
 *  Never throws — a failed probe means "calibrate from hardware instead", and
 *  a backend that is down must not also prevent /reset from running. */
export async function probeBackend(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; model?: string; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ProbeResult | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = "Measure the prefill and decode rate. ".repeat(14);
  try {
    const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      body: JSON.stringify({
        model: opts.model ?? "calibration",
        messages: [
          { role: "user", content: body + "\nReply with one word." },
        ],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { timings?: ProbeResult };
    return json.timings;
  } catch {
    return undefined; // down, refused, timed out — all mean "use the hardware profile"
  }
}

export { UNITS };
