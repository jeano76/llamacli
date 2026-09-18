import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { tailToWidth, wrapToWidth, wrapAnsiSafe, wrapPreservingTables } from "./textWidth.js";

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

// wrapAnsiSafe exists because wrapToWidth's plain char-by-char wrapping
// tears an ANSI escape sequence like `\x1b[32m` into individual characters
// (each counted as visible width), corrupting both the code and the width
// budget — this was the reason diff text was previously left entirely
// unwrapped rather than passed through wrapToWidth.
test("wrapAnsiSafe never splits an escape sequence across two lines", () => {
  const colored = "\x1b[32mHello world this is a longer colored line\x1b[0m";
  const lines = wrapAnsiSafe(colored, 10);
  for (const line of lines) {
    // An escape sequence starts with ESC and ends at the first letter
    // ('m' for SGR codes); a torn sequence would leave a stray lone ESC
    // with no matching 'm' terminator in that same line.
    const opens = (line.match(/\x1b\[/g) ?? []).length;
    const closes = (line.match(/m/g) ?? []).length;
    assert.ok(closes >= opens, `line has an unterminated escape sequence: ${JSON.stringify(line)}`);
  }
});

test("wrapAnsiSafe keeps every wrapped line's visible width within budget, ignoring ANSI codes", () => {
  const colored = "\x1b[1m\x1b[32mHello world this is a longer bold colored line that must wrap\x1b[0m";
  const lines = wrapAnsiSafe(colored, 12);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 12, `line exceeds width budget: ${JSON.stringify(line)} (${stringWidth(line)})`);
  }
});

test("wrapAnsiSafe preserves the visible text content across the wrap", () => {
  const colored = "\x1b[32mHello world this is a longer colored line\x1b[0m";
  const lines = wrapAnsiSafe(colored, 10);
  // Strip ANSI codes from the rejoined output and compare visible text only.
  const visible = lines.join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(visible, "Hello world this is a longer colored line");
});

test("wrapAnsiSafe behaves like wrapToWidth for plain text with no ANSI codes", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  assert.deepEqual(wrapAnsiSafe(text, 10), wrapToWidth(text, 10));
});

// Reported directly, with a screenshot: a markdown table rendered with
// mangled, disjointed borders in a real terminal. Root cause: a table row
// is one long ANSI-colored line, and wrapping it — even ANSI-safely,
// without tearing escape codes — still destroys its visual structure
// (half a cell's border on one line, the rest orphaned on the next with
// nothing lining up). wrapPreservingTables clips an over-wide table row
// instead of wrapping it onto a second line.
test("wrapPreservingTables clips an over-wide table row instead of wrapping it onto a second line", () => {
  const tableRow = "│ some fairly long cell content │ another cell │ a third one │";
  const result = wrapPreservingTables(tableRow, 20);
  assert.equal(result.length, 1, `expected exactly one (clipped) line for a table row, got ${result.length}`);
  assert.ok(stringWidth(result[0]) <= 20);
});

test("wrapPreservingTables still wraps normal (non-table) prose across multiple lines", () => {
  const prose = "the quick brown fox jumps over the lazy dog and keeps going for a while longer";
  const result = wrapPreservingTables(prose, 20);
  assert.ok(result.length > 1, "expected prose to actually wrap onto multiple lines");
  for (const line of result) assert.ok(stringWidth(line) <= 20);
});

test("wrapPreservingTables preserves ANSI color codes on a clipped table row (doesn't tear them)", () => {
  const tableRow = "\x1b[32m│ colored cell content that is fairly long │\x1b[39m";
  const result = wrapPreservingTables(tableRow, 15);
  assert.equal(result.length, 1);
  // A torn escape sequence would leave a lone ESC with no 'm' terminator.
  const opens = (result[0].match(/\x1b\[/g) ?? []).length;
  const closes = (result[0].match(/m/g) ?? []).length;
  assert.ok(closes >= opens, `line has an unterminated escape sequence: ${JSON.stringify(result[0])}`);
});

test("wrapPreservingTables leaves a table row that already fits completely unchanged", () => {
  const tableRow = "│ a │ b │";
  assert.deepEqual(wrapPreservingTables(tableRow, 80), [tableRow]);
});
