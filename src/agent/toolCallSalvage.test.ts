import { test } from "node:test";
import assert from "node:assert/strict";
import { salvagePartialFileWrite } from "./toolCallSalvage.js";

test("salvages path and content from a complete, well-formed arguments string", () => {
  const args = JSON.stringify({ path: "src/foo.ts", content: "hello world" });
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: "src/foo.ts", partialContent: "hello world" });
});

// The realistic case this exists for: the raw accumulated string cuts off
// mid-content with no closing quote or brace at all — exactly what
// streams in before llama-server's own JSON parse error fires.
test("salvages the prefix of content from a string truncated mid-plain-text (no closing quote)", () => {
  const args = '{"path":"src/foo.ts","content":"line one\\nline two\\nline thr';
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: "src/foo.ts", partialContent: "line one\nline two\nline thr" });
});

test("drops a dangling trailing backslash instead of corrupting the unescape", () => {
  // Cut immediately after a backslash that was about to start an escape
  // sequence — e.g. generation stopped exactly before emitting the "n" of
  // "\n". That lone backslash can never be completed, so it's dropped.
  const args = '{"path":"a.txt","content":"hello\\';
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: "a.txt", partialContent: "hello" });
});

test("drops an incomplete unicode escape instead of corrupting the unescape", () => {
  const args = '{"path":"a.txt","content":"emoji test \\u26';
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: "a.txt", partialContent: "emoji test " });
});

test("handles an even number of trailing backslashes correctly (they form complete escaped-backslash pairs, nothing dangling)", () => {
  // \\\\  == two complete escaped backslashes == "\\" in the real string.
  const args = '{"path":"a.txt","content":"path is C:\\\\\\\\';
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: "a.txt", partialContent: "path is C:\\\\" });
});

test("preserves non-ASCII (Korean) content correctly through the unescape round-trip", () => {
  const original = "# netproxy - Cloudflare 기반 내부 SSH 프록시 시스템\n\n연결 상태";
  const fullArgs = JSON.stringify({ path: "docs/plan.md", content: original });
  // Simulate truncation partway through by cutting the raw JSON string
  // before its closing quote/brace.
  const cutPoint = fullArgs.indexOf("SSH 프록시") + "SSH 프록시".length;
  const truncated = fullArgs.slice(0, cutPoint);
  const result = salvagePartialFileWrite(truncated);
  assert.ok(result);
  assert.equal(result!.path, "docs/plan.md");
  assert.ok(original.startsWith(result!.partialContent), `expected a real prefix of the original, got: ${JSON.stringify(result!.partialContent)}`);
  assert.ok(result!.partialContent.length > 10, "expected meaningful salvaged content, not just a couple of characters");
});

test("returns null when there is no path field at all", () => {
  const args = '{"content":"some content here';
  assert.equal(salvagePartialFileWrite(args), null);
});

test("returns null when there is no content field at all", () => {
  const args = '{"path":"a.txt"';
  assert.equal(salvagePartialFileWrite(args), null);
});

test("returns null when the content field is present but empty (nothing worth salvaging)", () => {
  const args = '{"path":"a.txt","content":"';
  assert.equal(salvagePartialFileWrite(args), null);
});

test("returns null for arguments that aren't a file-write shape at all (e.g. run_shell's `command` field)", () => {
  const args = JSON.stringify({ command: "echo hello" });
  assert.equal(salvagePartialFileWrite(args), null);
});

test("returns null for a completely empty string", () => {
  assert.equal(salvagePartialFileWrite(""), null);
});

test("salvages correctly even when path itself contains escaped characters", () => {
  const args = '{"path":"src/a \\"weird\\" dir/file.ts","content":"partial conte';
  const result = salvagePartialFileWrite(args);
  assert.deepEqual(result, { path: 'src/a "weird" dir/file.ts', partialContent: "partial conte" });
});
