/**
 * Back-compatibility shim. The real capability logic now lives in
 * `terminal.ts`, which answers per-feature questions (color depth, Unicode
 * glyph coverage, alt-screen, SGR mouse) instead of the single "ANSI or not"
 * bit this used to return.
 *
 * Why it moved: the reported breakage was never really "ANSI on/off". Each
 * terminal failed at a *different* feature — a 16-color console rendering
 * bright-color SGR as the wrong color, a non-UTF-8 locale turning the block
 * glyphs into `?` and desynchronizing every fixed-width calculation, an
 * `rxvt` receiving mouse reports in an encoding this app cannot parse. One
 * boolean can't distinguish any of those, so new code should use
 * `getCapabilities()` / `buildSequences()` from `terminal.ts` directly.
 *
 * This stays because it is the right question for the one remaining
 * "should we emit control sequences at all" check, and because the existing
 * tests pin down the environment-variable contract that callers rely on.
 */
import { detectTerminal, type DetectOptions } from "./terminal.js";

export function supportsAnsiTui(
  env: NodeJS.ProcessEnv = process.env,
  // Parameterized (rather than reading process.* directly) purely so this
  // is unit-testable without a real TTY/platform to run against.
  opts: DetectOptions = {}
): boolean {
  return detectTerminal(env, opts).ansi;
}
