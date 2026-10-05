/**
 * 추론(reasoning) 예산 상한 — **정본은 여기 하나**다.
 *
 * 상한 없이 thinking 을 켜면 "생각만 하다가 아무것도 안 하는" 상태로 돌아간다
 * (§5.3 실측: 420토큰 예산에서 reasoning 이 전부 써서 tool_call 0개).
 * 상한을 넘으면 그 턴의 남은 요청은 thinking 없이 간다(강제 전환).
 *
 * 토큰 추정은 여기서 만들지 않는다 — `estimateTextTokens`
 * (`src/compaction/compactor.ts`) 하나만 쓴다.
 */

/** 추론 예산 기본 상한 (35B 모델의 실제 작업 분량 기준). */
export const DEFAULT_MAX_REASONING = 4096;

/** 허용 상한. */
export const MAX_REASONING_CEILING = 8192;

/** 허용 하한. */
export const MIN_REASONING_FLOOR = 64;

/**
 * 사용자가 준 값을 **여기로 좁힌다.** 규칙은 정본에 있고, **한 군데만** 좁힌다.
 *
 * **숫자가 아니면 기본값으로 돌린다.** 조용히 `NaN` 을 예산으로 삼으면 추론이
 * **영원히 안 끝나거나** 즉시 초과로 취급된다.
 */
export function clampReasoningBudget(value: unknown): number {
  // **`null`·`""`·`undefined` 를 0 으로 바꾸지 않는다.**
  // `Number(null)` 은 **0** 이고 `Number("")` 도 0 이다. 그대로 좁히면 최소값이
  // 되어 사고가 거의 즉시 잘린다 — "값이 없다" 는 "아무것도 하지 않는다" 로 읽는다.
  if (value === null || value === undefined) return DEFAULT_MAX_REASONING;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_MAX_REASONING;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_REASONING;
  return Math.max(MIN_REASONING_FLOOR, Math.min(MAX_REASONING_CEILING, Math.round(n)));
}
