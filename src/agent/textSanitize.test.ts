import { test } from "node:test";
import assert from "node:assert/strict";
import { stripToolCallTemplateLeak } from "./textSanitize.js";

test("stripToolCallTemplateLeak leaves normal text untouched", () => {
  const text = "Here's the answer: the date is September 18th, 2026.";
  assert.equal(stripToolCallTemplateLeak(text), text);
});

test("stripToolCallTemplateLeak strips the exact Hermes-style leak observed in production", () => {
  const text = '```sh\necho "=== hostname ===" ; cat /etc/hostname\n</parameter>\n</function>\n</tool_call>';
  const result = stripToolCallTemplateLeak(text);
  assert.doesNotMatch(result, /<\/?tool_call>/);
  assert.doesNotMatch(result, /<\/?function>/);
  assert.doesNotMatch(result, /<\/?parameter>/);
  assert.match(result, /echo "=== hostname ==="/); // the real content survives
});

test("stripToolCallTemplateLeak strips the Anthropic-style leak variant also observed", () => {
  const text = 'cat /etc/hosts\n</parameter>\n</invoke>';
  const result = stripToolCallTemplateLeak(text);
  assert.doesNotMatch(result, /<\/?parameter>/);
  assert.doesNotMatch(result, /<\/?invoke>/);
  assert.match(result, /cat \/etc\/hosts/);
});

test("stripToolCallTemplateLeak strips opening tags with attributes too", () => {
  const text = '<invoke name="run_shell">command output</invoke>';
  const result = stripToolCallTemplateLeak(text);
  assert.equal(result, "command output");
});

test("stripToolCallTemplateLeak only matches the known tool-calling tag vocabulary, not arbitrary tags", () => {
  const text = "Here's some HTML: <div>hello</div> and <span>world</span>";
  assert.equal(stripToolCallTemplateLeak(text), text);
});

test("stripToolCallTemplateLeak is idempotent (safe to call repeatedly on cumulative streaming text)", () => {
  const text = "answer\n</parameter>\n</tool_call>";
  const once = stripToolCallTemplateLeak(text);
  const twice = stripToolCallTemplateLeak(once);
  assert.equal(once, twice);
});

test("stripToolCallTemplateLeak handles a tag that only becomes complete after more streamed text arrives", () => {
  // Simulates what App.tsx does: re-run over the cumulative text as chunks arrive.
  const chunks = ["answer\n</para", "meter>\n</tool", "_call>"];
  let cumulative = "";
  for (const chunk of chunks) {
    cumulative = stripToolCallTemplateLeak(cumulative + chunk);
  }
  assert.equal(cumulative.trim(), "answer");
  assert.doesNotMatch(cumulative, /<\/?(tool_call|parameter)>/);
});
