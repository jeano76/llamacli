/**
 * PROMPT.md §3: self-healing retry loop with a mandatory circuit breaker.
 * Modeled after the loop-runaway incident documented in the user's CLINE
 * delegation rules (~/.claude/CLAUDE.md) — a repeating read/edit/read/edit
 * pattern must be detected and killed, not left to run indefinitely.
 */

export interface CallRecord {
  toolName: string;
  argsSignature: string; // stable hash/string of args, used for repeat detection
}

export interface CircuitBreakerConfig {
  windowSize: number; // how many recent calls to look at
  maxDistinct: number; // if distinct calls in window <= this, treat as a loop
  hardTimeoutMs: number;
}

export const DEFAULT_BREAKER: CircuitBreakerConfig = {
  windowSize: 12,
  maxDistinct: 3,
  hardTimeoutMs: 30 * 60_000,
};

export class CircuitBreaker {
  private history: CallRecord[] = [];
  // Tracks time since the *last actual progress* (a tool call completing),
  // not since the turn started. A long turn that keeps genuinely completing
  // tool calls — e.g. many rounds against a slow local model — can easily
  // run past hardTimeoutMs in total without ever being stuck; only a gap
  // with zero progress for that long indicates something is actually hung.
  // See the loop-runaway incident in the class doc comment above.
  private lastProgressAt = Date.now();

  constructor(private config: CircuitBreakerConfig = DEFAULT_BREAKER) {}

  record(call: CallRecord): void {
    this.history.push(call);
    if (this.history.length > this.config.windowSize) {
      this.history.shift();
    }
    this.lastProgressAt = Date.now();
  }

  /** Returns a reason string if the loop/timeout should be killed, else null. */
  shouldStop(): string | null {
    if (Date.now() - this.lastProgressAt > this.config.hardTimeoutMs) {
      return `hard timeout exceeded (${this.config.hardTimeoutMs}ms with no progress)`;
    }
    if (this.history.length < this.config.windowSize) return null;

    const distinct = new Set(this.history.map((c) => `${c.toolName}:${c.argsSignature}`));
    if (distinct.size <= this.config.maxDistinct) {
      return `repetitive tool-call loop detected (${distinct.size} distinct calls in last ${this.history.length})`;
    }
    return null;
  }

  reset(): void {
    this.history = [];
    this.lastProgressAt = Date.now();
  }
}

/** Failure patterns worth logging for later self-improvement proposals (§3). */
export interface FailureLogEntry {
  timestamp: string;
  summary: string;
  toolName: string;
  errorMessage: string;
}

const failureLog: FailureLogEntry[] = [];

export function logFailure(entry: FailureLogEntry): void {
  failureLog.push(entry);
}

export function getFailureLog(): readonly FailureLogEntry[] {
  return failureLog;
}

/** Exposed mainly for tests: this log is module-level (shared across every
 *  AgentLoop in the process), so tests that assert on it need a clean
 *  slate rather than accumulating entries left behind by earlier tests. */
export function clearFailureLog(): void {
  failureLog.length = 0;
}
