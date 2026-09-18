import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.js";

// Reported directly: assistant text rendered with no color/formatting at
// all — a fenced code block looked identical to plain prose. These check
// that markdown actually gets translated into ANSI-carrying output, not
// just that it doesn't crash.
test("renderMarkdown emits ANSI escape codes for a fenced code block", () => {
  const out = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(out, /\x1b\[/);
});

test("renderMarkdown emits ANSI escape codes for bold text", () => {
  const out = renderMarkdown("this is **bold**");
  assert.match(out, /\x1b\[/);
});

test("renderMarkdown never throws on malformed/partial markdown (mid-stream text)", () => {
  // An unclosed code fence is exactly what a streaming assistant response
  // looks like for most of its own lifetime, one delta at a time.
  assert.doesNotThrow(() => renderMarkdown("```js\nconst x = 1;\nfunction unfinishe"));
});

test("renderMarkdown preserves the actual text content, not just adding color noise", () => {
  const out = renderMarkdown("hello **world**, this is `code`");
  assert.match(out, /hello/);
  assert.match(out, /world/);
  assert.match(out, /code/);
});
