/**
 * T1 / A8 — rule injection: how much of an always-on rule block is POLICY,
 * and how much is reference material the model can read on demand?
 *
 * Rules are injected in full on every request, capped at 32,000 chars
 * (~8,000 tokens). No model is involved in the question "does the model need
 * the fenced examples to obey the rule?" — so the first thing to measure is
 * whether a deterministic reduction is safe, before considering any classifier.
 *
 * Uses this machine's real rule file (~/.claude/CLAUDE.md, 12 KB) rather than
 * a synthetic one: the repo's own rules are 325 chars, which would make any
 * measurement here vacuous.
 */
import { readFileSync } from "node:fs";

const CHARS_PER_TOKEN = 3248 / 626; // llama.cpp measured anchor (compactor.ts:171)

function tok(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x4e00 && c <= 0x9fff)) cjk++;
  }
  return Math.ceil(cjk * 1.5 + (s.length - cjk) * 0.25);
}

const files = [
  "/home/jeano/.claude/CLAUDE.md",
  "/home/jeano/llamacli/.llamacli/rules/00-core.md",
];

/** Splits a rule file into (prose lines, fenced-block lines), tracking fences
 *  so a policy line can never be silently dropped with the examples. */
function splitFences(text: string): { prose: string[]; fenced: string[]; fenceStarts: number } {
  const prose: string[] = [];
  const fenced: string[] = [];
  let inFence = false;
  let fenceStarts = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (inFence) fenceStarts++;
      continue;
    }
    (inFence ? fenced : prose).push(line);
  }
  return { prose, fenced, fenceStarts };
}

/** An imperative the model is expected to obey. If any of these live INSIDE a
 *  fence, dropping fences would drop a rule — which is the check that makes
 *  this reduction safe to consider rather than merely small. */
const IMPERATIVE = /\b(must|never|always|should|prefer|avoid|do not|don't|require[sd]?|mandatory|금지|해야|하지\s*마|절대|항상)\b/i;

console.log("=".repeat(92));
console.log("T1/A8 — rule injection: policy vs reference material in an always-on prompt block");
console.log("=".repeat(92));

for (const f of files) {
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const { prose, fenced, fenceStarts } = splitFences(text);
  const proseText = prose.join("\n");
  const fencedText = fenced.join("\n");
  const imperativesInFence = fenced.filter((l) => IMPERATIVE.test(l));

  console.log(`\n${f}`);
  console.log(
    `  as injected      ${String(text.length).padStart(7)} chars  ${String(tok(text)).padStart(5)} tok` +
      `   <- paid on EVERY request`
  );
  console.log(
    `  fenced examples  ${String(fencedText.length).padStart(7)} chars  ${String(tok(fencedText)).padStart(5)} tok` +
      `   (${fenceStarts} block(s))`
  );
  console.log(
    `  prose only       ${String(proseText.length).padStart(7)} chars  ${String(tok(proseText)).padStart(5)} tok`
  );
  const saved = tok(text) - tok(proseText);
  console.log(
    `  saving           ${String(saved).padStart(7)}         ${String(saved).padStart(5)} tok` +
      `   ${((saved / tok(text)) * 100).toFixed(1)}% of the block`
  );
  console.log(
    `  SAFETY: imperative lines inside fences: ${imperativesInFence.length}` +
      (imperativesInFence.length ? `  <-- dropping fences would drop a rule` : `  (none — prose-only is lossless)`)
  );
  for (const l of imperativesInFence.slice(0, 3)) console.log(`      ${l.trim().slice(0, 90)}`);
}

const cap = 32_000;
console.log(`\n${"-".repeat(92)}`);
console.log(`MAX_RULE_PROMPT_CHARS = ${cap.toLocaleString()} chars = ~${Math.round(cap / CHARS_PER_TOKEN).toLocaleString()} tokens`);
console.log(`A project carrying rules at that cap pays it on every request, every turn.`);
console.log(`Reference: one capped tool result costs ~${Math.round(24000 / CHARS_PER_TOKEN).toLocaleString()} tokens;`);
console.log(`a measured main turn was 7,244 prompt tokens / 75.9 s.`);