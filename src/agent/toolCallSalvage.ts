/**
 * Recovers as much of a truncated write_file/append_file tool call's
 * arguments as possible when generation got cut off mid-JSON-string by
 * max_tokens (see loop.ts's "tool call truncated" catch branch).
 *
 * Reported live: asking the model to just "retry with shorter content"
 * routinely produced the exact same oversized content again, hitting the
 * exact same cutoff — pure prompt-level regeneration is unreliable and
 * wastes everything already generated. This instead extracts the `path`
 * and whatever prefix of `content` DID stream successfully before the
 * break, straight from the raw (invalid-as-a-whole) accumulated JSON
 * arguments string — so that prefix can be written to disk for real
 * (nothing lost) and the model only needs to generate the remainder, a
 * strictly smaller and therefore more tractable task each time.
 */

export interface SalvagedFileWrite {
  path: string;
  /** Whatever prefix of the `content` argument streamed successfully
   *  before the cutoff, already JSON-unescaped back to real text. */
  partialContent: string;
}

/** A truncation can land mid-escape-sequence (e.g. the string ends in a
 *  lone `\`, or partway through `\uXXXX`) — that fragment can never be
 *  valid JSON on its own, so it's dropped rather than salvaged. Losing a
 *  handful of trailing characters is a fine trade for recovering
 *  everything before them instead of nothing at all. */
function trimDanglingEscape(raw: string): string {
  let backslashRun = 0;
  let i = raw.length;
  while (i > 0 && raw[i - 1] === "\\") {
    backslashRun++;
    i--;
  }
  // An odd run means the very last backslash starts an escape sequence
  // that never got a chance to specify what it's escaping.
  let trimmed = backslashRun % 2 === 1 ? raw.slice(0, raw.length - 1) : raw;
  const incompleteUnicodeEscape = trimmed.match(/\\u([0-9a-fA-F]{0,3})$/);
  if (incompleteUnicodeEscape) {
    trimmed = trimmed.slice(0, trimmed.length - 2 - incompleteUnicodeEscape[1].length);
  }
  return trimmed;
}

/** Turns a raw (possibly-truncated-but-now-escape-safe) JSON string body
 *  back into real text. Wrapping in quotes and running it back through
 *  JSON.parse is simpler and more correct than hand-rolling every escape
 *  rule (\n, \t, \uXXXX surrogate pairs, ...) — it's exactly what a
 *  complete JSON string literal would need anyway. Returns null rather
 *  than throwing if something about it still doesn't parse (a truly
 *  unexpected shape) — salvage is best-effort, never worth crashing over. */
function unescapeJsonStringBody(rawBody: string): string | null {
  try {
    return JSON.parse(`"${rawBody}"`);
  } catch {
    return null;
  }
}

/**
 * Attempts to recover `path` and a usable (already-unescaped) prefix of
 * `content` from a write_file/append_file call's raw, truncated JSON
 * arguments string. Returns null when recovery isn't possible — no `path`
 * field found, no non-empty `content` field found, or what's there
 * doesn't actually unescape to valid text — so the caller can fall back
 * to its own non-salvage recovery strategy instead.
 */
export function salvagePartialFileWrite(rawArgumentsJson: string): SalvagedFileWrite | null {
  // Assumes `path` comes before `content` in generation order, matching
  // both tools' declared parameter order (tools/index.ts) — reasonable
  // since a model follows the schema it was given, and this only needs to
  // work for the common case; a genuinely reordered/malformed payload
  // simply fails to salvage and falls back, not a wrong result.
  const pathMatch = rawArgumentsJson.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!pathMatch) return null;
  const path = unescapeJsonStringBody(pathMatch[1]);
  if (!path) return null;

  // The closing quote is OPTIONAL, not absent — this same salvage path
  // also needs to handle a complete, well-formed call correctly (not just
  // a truncated one). `(?:[^"\\]|\\.)*` already stops at the first
  // unescaped `"` on its own when one exists; when generation was cut off
  // mid-string there simply isn't one, so it greedily consumes to the end
  // of the raw string instead — exactly the truncated case this exists
  // for. An earlier version anchored to end-of-string unconditionally,
  // which broke the ordinary complete-call case by also swallowing the
  // trailing `"}` that closes the whole JSON object.
  const contentFieldMatch = rawArgumentsJson.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
  if (!contentFieldMatch) return null;
  const partialContent = unescapeJsonStringBody(trimDanglingEscape(contentFieldMatch[1]));
  if (!partialContent) return null; // empty or unparseable — nothing worth salvaging

  return { path, partialContent };
}
