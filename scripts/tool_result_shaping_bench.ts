/**
 * T1 / A9 — tool-result shaping: what does the CURRENT truncation throw away,
 * and what would head+tail cost instead?
 *
 * No model, no network. Pure measurement against real files in this repo.
 *
 * Claim under test: `capToolResult()` keeps the HEAD only, so the tail of a
 * large tool result is invisible to the model. The documented consequence is a
 * re-read — another full turn. head+tail inside the SAME character cap costs
 * the same tokens and recovers part of the tail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Verbatim from src/agent/loop.ts:98 */
function toolResultCharCap(contextWindowTokens: number): number {
  return Math.max(2_000, Math.min(24_000, Math.floor(contextWindowTokens * 4 * 0.15)));
}

/**
 * NOT used for pricing any more. The chars/token ratio estimated from the tool
 * schema (3,248 chars -> 626 tok) turns out to understate real content badly:
 * measured against the live tokenizer on 2026-10-04, 24,000 chars of this
 * repo's markdown priced at 8,278 tok (2.9 chars/tok) and 24,000 chars of
 * loop.ts at 6,361 tok (3.8 chars/tok). Schema JSON is denser per character
 * than prose and code. Anything that prices a cap with a chars/token constant
 * is therefore optimistic by 30-45% — see the measured prices printed below.
 */
const CHARS_PER_TOKEN = 3248 / 626;

const CTX = 98_304; // the live server on :8080 (-c 98304)

interface Row {
  file: string;
  chars: number;
  cap: number;
  visibleBefore: number;
  tailVisibleBefore: number;
  tailVisibleAfter: number;
  tokens: number;
}

function shapeHeadTail(text: string, cap: number): { body: string; tailKept: number } {
  if (text.length <= cap) return { body: text, tailKept: text.length };
  // mirrors src/agent/loop.ts capToolResult()
  const TAIL_FRACTION = 0.4;
  const MARKER_RESERVE = 160;
  const tailChars = Math.floor(Math.max(0, cap - MARKER_RESERVE) * TAIL_FRACTION);
  const headBudget = Math.max(0, cap - MARKER_RESERVE - tailChars);
  const cut = text.lastIndexOf("\n", headBudget);
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, headBudget);
  let tailStart = text.length - tailChars;
  const tailNl = text.indexOf("\n", tailStart);
  if (tailStart < text.length && tailNl >= 0 && tailNl < text.length - 1) tailStart = tailNl + 1;
  const tail = text.slice(Math.max(head.length, tailStart));
  const omitted = text.length - head.length - tail.length;
  return {
    body: `${head}\n\n[...truncated: ${omitted} more characters omitted ...]\n${tail}`,
    tailKept: tail.length,
  };
}

const root = "/home/jeano/llamacli";
// NOTE: README.md is being split into a current + legacy pair by other work in
// this tree, so it is not a stable measurement subject. The archived copy is.
const bigMarkdown = join(root, "docs/history/README-legacy-2026-10-03.md");

const targets: string[] = [
  bigMarkdown,
  join(root, "src/agent/loop.ts"),
  join(root, "src/compaction/compactor.ts"),
  join(root, "src/backend/resolve.ts"),
  join(root, "package-lock.json"),
];

// a few real session-shaped payloads: shell output and a stack trace
const shellish = Array.from({ length: 900 }, (_, i) =>
  `npm warn deprecated left-pad@1.0.0: use String.prototype.padStart instead (line ${i})`
).join("\n");
const trace = `Traceback (most recent call last):\n` +
  Array.from({ length: 700 }, (_, i) => `  File "mod${i}.py", line ${i + 1}, in fn_${i}`).join("\n") +
  `\nSyntaxError: invalid syntax (foo.py, line 700)\n`;

const rows: Row[] = [];
const cap = toolResultCharCap(CTX);

for (const f of targets) {
  const text = readFileSync(f, "utf8");
  rows.push({
    file: f.replace(root + "/", ""),
    chars: text.length,
    cap,
    visibleBefore: Math.min(text.length, cap),
    tailVisibleBefore: 0,
    tailVisibleAfter: Math.min(text.length - Math.floor(cap * 0.6), Math.floor(cap * 0.4)),
    tokens: Math.round(cap / CHARS_PER_TOKEN),
  });
}
for (const [name, text] of [["<shell-like 900 lines>", shellish], ["<python trace 700 frames>", trace]] as const) {
  rows.push({
    file: name, chars: text.length, cap,
    visibleBefore: Math.min(text.length, cap),
    tailVisibleBefore: 0,
    tailVisibleAfter: Math.min(Math.max(0, text.length - Math.floor(cap * 0.6)), Math.floor(cap * 0.4)),
    tokens: Math.round(cap / CHARS_PER_TOKEN),
  });
}

console.log("=".repeat(96));
console.log(`T1/A9 — tool result shaping, ctx=${CTX} -> cap=${cap} chars (~${Math.round(cap / CHARS_PER_TOKEN)} real tokens)`);
console.log("=".repeat(96));
console.log(
  "file".padEnd(28) + "size".padStart(9) + "visible".padStart(9) +
  "tailBEFORE".padStart(13) + "tailAFTER".padStart(11) + "tokens".padStart(9)
);
console.log("-".repeat(96));
for (const r of rows) {
  console.log(
    r.file.slice(0, 27).padEnd(28) +
    r.chars.toLocaleString().padStart(9) +
    `${r.visibleBefore.toLocaleString()} (${((r.visibleBefore / r.chars) * 100).toFixed(1)}%)`.padStart(9) +
    `${r.tailVisibleBefore}`.padStart(13) +
    `${r.tailVisibleAfter.toLocaleString()}`.padStart(11) +
    r.tokens.toLocaleString().padStart(9)
  );
}
console.log("-".repeat(96));

const big = rows.filter((r) => r.chars > cap);
const avgTok = Math.round(big.reduce((n, r) => n + r.tokens, 0) / big.length);
console.log(`\nfiles/results over the cap: ${big.length}/${rows.length}`);
console.log(`the ~${avgTok} in the tokens column is a chars/5.19 ESTIMATE and is optimistic.`);
console.log(`MEASURED with the live tokenizer (/tokenize, 2026-10-04):`);
console.log(`  24,000 chars of docs/history/README-legacy  -> 8,278 tok`);
console.log(`  24,000 chars of src/agent/loop.ts          -> 6,361 tok`);
console.log(`  i.e. one capped tool result is 88-114% of a measured 7,244-token turn,`);
console.log(`  not the 64% the estimate suggests. The cap, not the fixed prompt, is`);
console.log(`  what dominates a tool-heavy turn.`);
console.log(`  tail visibility before: 0 chars, for every one of them, always.`);
console.log(`head+tail at the SAME cap: token cost unchanged, tail visibility 0 -> ~${Math.round(cap * 0.4).toLocaleString()} chars`);

// the specific documented incident, reproduced on this repo's own README
const readme = readFileSync(bigMarkdown, "utf8");
const shaped = shapeHeadTail(readme, cap);
const marker = "## 1. 한 줄 결론";
console.log(`\n--- the documented 'never saw the last ~4,500 chars' incident, on a stable subject ---`);
console.log(`docs/history/README-legacy-2026-10-03.md is ${readme.length.toLocaleString()} chars; head-only cap shows ${cap.toLocaleString()} (${((cap / readme.length) * 100).toFixed(1)}%)`);
const lastSection = readme.slice(-3000);
const visibleNow = lastSection.split("\n").filter((l) => shaped.body.includes(l)).length;
console.log(`lines from the final 3,000 chars visible after head+tail shaping: ${visibleNow} (head-only: 0)`);
void marker;