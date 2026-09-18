import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { tailToWidth } from "./App.js";

test("tailToWidth returns the text unchanged when it already fits", () => {
  assert.equal(tailToWidth("hello", 20), "hello");
});

test("tailToWidth returns the text unchanged when it exactly fits", () => {
  assert.equal(tailToWidth("12345", 5), "12345");
});

test("tailToWidth truncates from the front, keeping the tail, when too long", () => {
  const result = tailToWidth("abcdefghij", 5);
  assert.ok(result.startsWith("…"));
  assert.ok(result.endsWith("ghij")); // last 4 chars + 1 col for the ellipsis = 5
  assert.ok(stringWidth(result) <= 5);
});

test("tailToWidth accounts for real display width, not string length, for wide (Hangul) characters", () => {
  // Each Hangul syllable is 2 terminal columns wide, unlike ASCII's 1.
  const text = "안녕하세요"; // 5 chars, 10 display columns
  assert.equal(stringWidth(text), 10);

  const result = tailToWidth(text, 10);
  assert.equal(result, text); // fits exactly, no truncation needed

  const truncated = tailToWidth(text, 7);
  assert.ok(stringWidth(truncated) <= 7, `expected width <= 7, got ${stringWidth(truncated)} for "${truncated}"`);
  assert.ok(truncated.startsWith("…"));
});

test("tailToWidth never returns something wider than maxWidth, across a range of inputs/widths", () => {
  const candidates = ["", "a", "hello world", "안녕하세요 반갑습니다", "x".repeat(200), "가".repeat(50)];
  for (const text of candidates) {
    for (const maxWidth of [1, 5, 10, 20, 50]) {
      const result = tailToWidth(text, maxWidth);
      assert.ok(
        stringWidth(result) <= maxWidth,
        `tailToWidth(${JSON.stringify(text)}, ${maxWidth}) = ${JSON.stringify(result)} has width ${stringWidth(result)}`
      );
    }
  }
});
