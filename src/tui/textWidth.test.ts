import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { tailToWidth, wrapToWidth } from "./textWidth.js";

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

test("wrapToWidth returns a single line unchanged when it already fits", () => {
  assert.deepEqual(wrapToWidth("hello", 20), ["hello"]);
});

test("wrapToWidth splits a long line into multiple lines, each within the width budget", () => {
  const lines = wrapToWidth("abcdefghij", 4);
  assert.deepEqual(lines, ["abcd", "efgh", "ij"]);
});

test("wrapToWidth preserves existing newlines as their own wrap boundaries", () => {
  const lines = wrapToWidth("short\nlonger line that wraps", 10);
  assert.equal(lines[0], "short");
  assert.ok(lines.length > 2); // "short" line + the wrapped continuation lines
});

test("wrapToWidth never emits a line wider than maxWidth, and never drops content, for a range of inputs", () => {
  const candidates = [
    "",
    "a",
    "a tool call with a long command: date +\"%Y년 %m월 %d일 %A\"",
    "안녕하세요 반갑습니다 — 이건 아주 긴 한글 문장으로 줄바꿈을 테스트합니다",
    "x".repeat(300),
    "가".repeat(80),
  ];
  for (const text of candidates) {
    for (const maxWidth of [5, 10, 20, 50, 120]) {
      // maxWidth=1 is excluded: a single double-width (CJK) character can't
      // be split further, so it's the one unavoidable case where a "line"
      // exceeds the budget — not a realistic terminal width anyway.
      const lines = wrapToWidth(text, maxWidth);
      for (const line of lines) {
        assert.ok(
          stringWidth(line) <= maxWidth,
          `wrapToWidth(${JSON.stringify(text)}, ${maxWidth}) produced a line wider than budget: ${JSON.stringify(line)}`
        );
      }
      // no content lost: concatenating the wrapped pieces (undoing the
      // inserted breaks) reproduces the original paragraph text exactly
      assert.equal(lines.join(""), text.replace(/\n/g, ""));
    }
  }
});

test("wrapToWidth round-trips content losslessly (joining wrapped lines reconstructs the original, modulo the inserted wrap breaks)", () => {
  const text = "가나다라마바사아자차카타파하".repeat(3);
  const lines = wrapToWidth(text, 6);
  assert.equal(lines.join(""), text);
});
