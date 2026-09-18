import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.js";

// Reported directly: assistant text rendered with no color/formatting at
// all — a fenced code block looked identical to plain prose. These check
// that markdown actually gets translated into ANSI-carrying output, not
// just that it doesn't crash.
test("renderMarkdown emits ANSI escape codes for a fenced code block", () => {
  const out = renderMarkdown("```js\nconst x = 1;\n```", 80);
  assert.match(out, /\x1b\[/);
});

test("renderMarkdown emits ANSI escape codes for bold text", () => {
  const out = renderMarkdown("this is **bold**", 80);
  assert.match(out, /\x1b\[/);
});

test("renderMarkdown never throws on malformed/partial markdown (mid-stream text)", () => {
  // An unclosed code fence is exactly what a streaming assistant response
  // looks like for most of its own lifetime, one delta at a time.
  assert.doesNotThrow(() => renderMarkdown("```js\nconst x = 1;\nfunction unfinishe", 80));
});

test("renderMarkdown preserves the actual text content, not just adding color noise", () => {
  const out = renderMarkdown("hello **world**, this is `code`", 80);
  assert.match(out, /hello/);
  assert.match(out, /world/);
  assert.match(out, /code/);
});

// Reported directly, with a screenshot: a markdown table rendered with
// mangled, disjointed borders. renderMarkdown() itself doesn't (and
// cli-table3 has no way to) constrain a table's total width to the real
// terminal — marked-terminal's own `width` option only affects prose
// reflow, not tables (confirmed by reading marked-terminal's source: the
// table renderer never forwards `width` to cli-table3 at all). The actual
// fix for the reported garbling is App.tsx routing renderMarkdown's
// output through `wrapPreservingTables` (textWidth.ts) instead of a plain
// wrap, which clips an over-wide table row instead of wrapping it — see
// that function's own tests. This just covers that renderMarkdown itself
// still produces a real, valid table (doesn't silently drop it or crash)
// regardless of what width it's given.
test("renderMarkdown still produces real table output (border characters, all cell values) at a range of widths", () => {
  const table = "| Column A | Column B | Column C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
  for (const width of [30, 60, 120]) {
    const out = renderMarkdown(table, width);
    assert.match(out, /[┌┐└┘├┤┬┴┼─│]/, `expected table border characters at width ${width}`);
    assert.match(out, /1/);
    assert.match(out, /2/);
    assert.match(out, /3/);
  }
});

test("renderMarkdown caches instances per width but still reflects content differences at the same width", () => {
  // Guards against a caching bug where the per-width instance cache
  // somehow reuses stale renderer STATE across calls, not just config.
  const a = renderMarkdown("first", 60);
  const b = renderMarkdown("second", 60);
  assert.match(a, /first/);
  assert.match(b, /second/);
  assert.doesNotMatch(b, /first/);
});
