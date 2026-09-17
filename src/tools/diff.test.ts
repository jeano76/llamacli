import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDiff } from "./diff.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

test("formatDiff returns empty string when content is unchanged", () => {
  assert.equal(formatDiff("f.ts", "same\ncontent\n", "same\ncontent\n"), "");
});

test("formatDiff marks every line as added for a brand-new file", () => {
  const out = formatDiff("f.ts", "", "line1\nline2\n");
  assert.match(out, /\x1b\[32m\+ line1\x1b\[0m/);
  assert.match(out, /\x1b\[32m\+ line2\x1b\[0m/);
});

test("formatDiff shows unchanged context lines and only colors the actual change", () => {
  const out = formatDiff(
    "f.ts",
    "function add(a, b) {\n  return a + b;\n}\n",
    "function add(a, b) {\n  // sum\n  return a + b;\n}\n"
  );
  const plain = stripAnsi(out);
  assert.match(plain, /^\+ {3}\/\/ sum$/m);
  assert.match(plain, /^ {2}function add\(a, b\) \{$/m);
  assert.match(plain, /^ {2} {2}return a \+ b;$/m);
  // the unchanged lines must be gray context, not colored as additions/removals
  assert.doesNotMatch(out, /\x1b\[32m {2}function add/);
});

test("formatDiff marks a removed line with '-' and a changed line as del+add", () => {
  const out = formatDiff("f.ts", "a\nb\nc\n", "a\nc\n");
  const plain = stripAnsi(out);
  assert.match(plain, /^- b$/m);
  assert.match(out, /\x1b\[31m- b\x1b\[0m/);
});

test("formatDiff header includes the file path", () => {
  const out = formatDiff("/some/path/f.ts", "a\n", "b\n");
  assert.match(stripAnsi(out), /^--- \/some\/path\/f\.ts$/m);
});
