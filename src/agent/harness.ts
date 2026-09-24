import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/* ------------------------------------------------------------------ *
 * No-progress guard                                                   *
 * ------------------------------------------------------------------ */

export interface ProgressGuardOptions {
  /** Minutes without progress before the model is nudged. */
  minutes: number;
  /** Compactions without progress before the model is nudged. Both this and
   *  `minutes` must be reached: a slow machine alone, or a few compactions
   *  from reading big files, isn't a stall. */
  compactions: number;
}

export const DEFAULT_PROGRESS_GUARD: ProgressGuardOptions = { minutes: 15, compactions: 4 };

export type ProgressVerdict = "ok" | "nudge" | "stop";

/** Tracks whether a turn is getting anywhere. The existing guards only catch
 *  exact repetition (the same tool call or the same response); live, a
 *  session spent 40 minutes writing t2.js … t59.js analysis scripts, each
 *  slightly different, with no edit to the file it was meant to fix and no
 *  plan step completed, and nothing stopped it.
 *
 *  Progress is an edit to a file that already existed, or a plan step
 *  becoming done. Without any for the configured time AND number of
 *  compactions, check() says "nudge" once; if the same span passes again
 *  after the nudge, it says "stop". */
export class ProgressTracker {
  private lastProgressAt: number;
  private compactionsSinceProgress = 0;
  private nudged = false;

  constructor(
    private readonly opts: ProgressGuardOptions = DEFAULT_PROGRESS_GUARD,
    now: number = Date.now()
  ) {
    this.lastProgressAt = now;
  }

  reset(now: number): void {
    this.lastProgressAt = now;
    this.compactionsSinceProgress = 0;
    this.nudged = false;
  }

  markProgress(now: number): void {
    this.reset(now);
  }

  onCompaction(): void {
    this.compactionsSinceProgress++;
  }

  check(now: number): ProgressVerdict {
    const stalled =
      now - this.lastProgressAt >= this.opts.minutes * 60_000 && this.compactionsSinceProgress >= this.opts.compactions;
    if (!stalled) return "ok";
    if (!this.nudged) {
      // Give the nudge a full window of its own before stopping.
      this.nudged = true;
      this.lastProgressAt = now;
      this.compactionsSinceProgress = 0;
      return "nudge";
    }
    return "stop";
  }

  minutesSinceProgress(now: number): number {
    return Math.round((now - this.lastProgressAt) / 60_000);
  }
}

export function progressNudgeText(minutes: number, compactions: number): string {
  return (
    `[progress check] About ${minutes} minutes and ${compactions} context compactions have passed with no edit to an ` +
    "existing file and no plan step completed. Stop investigating. Record what you have established with note() — " +
    "notes survive compaction, the conversation does not. Then state the most likely root cause in one or two " +
    "sentences and either apply a fix now, or ask the user for the information you are missing. If you have been " +
    "writing a series of one-off test/debug scripts, that is itself a sign of this — delete them and change approach " +
    "rather than writing another one."
  );
}

/* ------------------------------------------------------------------ *
 * Post-edit verification                                              *
 * ------------------------------------------------------------------ */

/** Per-extension check commands, keyed "*.ext". `{file}` is replaced with the
 *  quoted path. "json" is checked in-process. Projects can add or override
 *  entries with `verify.afterEdit` in .llamacli/config.yaml, or set it to
 *  false to turn checks off. */
export const DEFAULT_VERIFIERS: Record<string, string> = {
  "*.js": "node --check {file}",
  "*.mjs": "node --check {file}",
  "*.cjs": "node --check {file}",
  "*.json": "json",
  "*.py": "python3 -m py_compile {file}",
  "*.sh": "bash -n {file}",
};

export type VerifyConfig = Record<string, string> | false | undefined;

export function verifierFor(path: string, config: VerifyConfig): string | null {
  if (config === false) return null;
  const table = { ...DEFAULT_VERIFIERS, ...(config ?? {}) };
  const cmd = table[`*${extname(path)}`];
  return cmd ? cmd : null;
}

const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_OUTPUT_MAX_CHARS = 1500;

/** Runs the check for `path` and returns a line to append to the tool
 *  result, or null when there's no check for this file type. The model
 *  once marked "embedded JS confirmed valid" as done after checking the
 *  wrong thing; a real check result after every edit leaves less room for
 *  that. */
export async function runPostEditCheck(path: string, cwd: string, config: VerifyConfig, chunked = false): Promise<string | null> {
  const cmd = verifierFor(path, config);
  if (!cmd) return null;
  const chunkNote = chunked ? " (if you are still writing this file in chunks, a failure here may just mean it is incomplete)" : "";
  if (cmd === "json") {
    try {
      JSON.parse(await readFile(path, "utf8"));
      return "[auto-check: JSON parse] OK";
    } catch (err: any) {
      return `[auto-check: JSON parse] FAILED${chunkNote} — fix this before moving on:\n${String(err.message).slice(0, VERIFY_OUTPUT_MAX_CHARS)}`;
    }
  }
  const full = cmd.replace(/\{file\}/g, JSON.stringify(path));
  try {
    await execAsync(full, { cwd, timeout: VERIFY_TIMEOUT_MS });
    return `[auto-check: ${cmd.replace(/\s*\{file\}/g, "")}] OK`;
  } catch (err: any) {
    const out = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || err.message;
    return `[auto-check: ${cmd.replace(/\s*\{file\}/g, "")}] FAILED${chunkNote} — fix this before moving on:\n${String(out).slice(0, VERIFY_OUTPUT_MAX_CHARS)}`;
  }
}
