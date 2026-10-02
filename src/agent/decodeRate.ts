/**
 * Live decode speed (tokens per second) of one streamed model response.
 *
 * Measured from the FIRST streamed chunk, not from the request: the wait before that
 * is prompt processing, which on a 20k-token context is many seconds and says nothing
 * about how fast the model writes. Counting from the request would show 5 t/s for a
 * model that decodes at 40.
 *
 * llama-server streams one token per chunk, so while the response is still arriving the
 * chunk count stands in for the token count. Once the response has finished the
 * server's own `usage.completion_tokens` replaces it, which is exact (a chunk can carry
 * more than one token when the server batches).
 *
 * The first token is the start of the interval, not part of it — `(n - 1)` tokens over
 * the time between the first and the last — the same convention benchmark tools use.
 */
export class DecodeRateTracker {
  private first: number | null = null;
  private last = 0;
  private chunks = 0;
  private lastEmit = -Infinity;

  constructor(
    private readonly now: () => number = Date.now,
    /** Minimum gap between live updates; the UI re-renders on each one. */
    private readonly emitEveryMs = 250,
    /** Below this window the rate is dominated by timer jitter and reads as nonsense. */
    private readonly minWindowMs = 400
  ) {}

  /** Records one streamed chunk that carried output. */
  chunk(): void {
    const t = this.now();
    if (this.first === null) this.first = t;
    this.last = t;
    this.chunks++;
  }

  private rateOf(tokens: number, endMs: number): number | null {
    if (this.first === null) return null;
    const windowMs = endMs - this.first;
    if (tokens < 2 || windowMs < this.minWindowMs) return null;
    return ((tokens - 1) / windowMs) * 1000;
  }

  /** The rate to show right now, or null when it is too early to mean anything or
   *  an update was already emitted within `emitEveryMs`. */
  live(): number | null {
    const t = this.now();
    if (t - this.lastEmit < this.emitEveryMs) return null;
    const r = this.rateOf(this.chunks, this.last);
    if (r !== null) this.lastEmit = t;
    return r;
  }

  /** The rate for the finished response. `completionTokens` is the server's exact
   *  count when it reported one. */
  final(completionTokens?: number): number | null {
    const tokens = completionTokens && completionTokens > 0 ? completionTokens : this.chunks;
    return this.rateOf(tokens, this.last);
  }
}

/** "(40 t/s)". Whole numbers from 10 up; one decimal below, where rounding to an
 *  integer would hide the difference between 1 and 9. */
export function formatDecodeRate(tps: number): string {
  const v = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
  return `(${v} t/s)`;
}
