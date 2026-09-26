import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASTE_LENGTH_THRESHOLD,
  isLikelyPaste,
  looksLikePastedFilePath,
  formatPasteLabel,
  findTrailingPlaceholder,
  substitutePlaceholders,
} from "./pasteChip.js";

test("isLikelyPaste treats a short burst of a few characters as ordinary typing, not a paste", () => {
  assert.equal(isLikelyPaste("a"), false);
  assert.equal(isLikelyPaste("ab"), false);
  assert.equal(isLikelyPaste("가나"), false);
  assert.equal(isLikelyPaste("x".repeat(PASTE_LENGTH_THRESHOLD - 1)), false);
});

test("isLikelyPaste treats anything at or past the threshold as a paste", () => {
  assert.equal(isLikelyPaste("x".repeat(PASTE_LENGTH_THRESHOLD)), true);
  assert.equal(isLikelyPaste("some copied sentence"), true);
});

test("looksLikePastedFilePath accepts a single-line, reasonably-sized string", () => {
  assert.equal(looksLikePastedFilePath("/home/user/project/file.ts"), true);
  assert.equal(looksLikePastedFilePath("  /home/user/file.ts  "), true, "surrounding whitespace from the paste itself is fine");
});

test("looksLikePastedFilePath rejects multi-line content and absurdly long content", () => {
  assert.equal(looksLikePastedFilePath("line one\nline two"), false);
  assert.equal(looksLikePastedFilePath(""), false);
  assert.equal(looksLikePastedFilePath("x".repeat(4097)), false);
});

test("formatPasteLabel formats a file path label with the real path visible", () => {
  const label = formatPasteLabel("/home/user/notes.md\n", 3, true);
  assert.equal(label, "[파일 #3: /home/user/notes.md]");
});

test("formatPasteLabel formats a text label with line count and byte length", () => {
  const content = "line one\nline two\nline three";
  const label = formatPasteLabel(content, 1, false);
  assert.match(label, /^\[붙여넣기 #1: 3줄, \d+바이트\]$/);
  assert.equal(label, `[붙여넣기 #1: 3줄, ${Buffer.byteLength(content, "utf8")}바이트]`);
});

test("formatPasteLabel counts multi-byte (Korean) content correctly in bytes, not characters", () => {
  const content = "안녕하세요"; // 5 chars, but 15 bytes in UTF-8
  const label = formatPasteLabel(content, 2, false);
  assert.match(label, /15바이트/);
});

test("two pastes of the identical content get distinct labels via the counter", () => {
  const a = formatPasteLabel("same text", 1, false);
  const b = formatPasteLabel("same text", 2, false);
  assert.notEqual(a, b);
});

test("findTrailingPlaceholder finds a label the input string ends with", () => {
  const blocks = new Map([["[붙여넣기 #1: 2줄, 10바이트]", "real\ncontent"]]);
  const input = "please review this: [붙여넣기 #1: 2줄, 10바이트]";
  assert.equal(findTrailingPlaceholder(input, blocks), "[붙여넣기 #1: 2줄, 10바이트]");
});

test("findTrailingPlaceholder returns undefined when input doesn't end with any tracked label", () => {
  const blocks = new Map([["[붙여넣기 #1: 2줄, 10바이트]", "real\ncontent"]]);
  assert.equal(findTrailingPlaceholder("just typing normally", blocks), undefined);
  assert.equal(findTrailingPlaceholder("", blocks), undefined);
  assert.equal(findTrailingPlaceholder("[붙여넣기 #1: 2줄, 10바이트] and then more typed after it", blocks), undefined);
});

test("substitutePlaceholders swaps every label back for its real content", () => {
  const blocks = new Map([
    ["[파일 #1: /a/b.ts]", "/a/b.ts"],
    ["[붙여넣기 #2: 2줄, 5바이트]", "hi\nyo"],
  ]);
  const input = "check [파일 #1: /a/b.ts] against [붙여넣기 #2: 2줄, 5바이트] please";
  assert.equal(substitutePlaceholders(input, blocks), "check /a/b.ts against hi\nyo please");
});

test("substitutePlaceholders leaves plain text with no placeholders untouched", () => {
  assert.equal(substitutePlaceholders("nothing special here", new Map()), "nothing special here");
});

test("substitutePlaceholders treats the label as a literal string, not a regex, even if it contains regex metacharacters", () => {
  const blocks = new Map([["[파일 #1: /a/(b).ts]", "/a/(b).ts"]]);
  const input = "look at [파일 #1: /a/(b).ts]";
  assert.equal(substitutePlaceholders(input, blocks), "look at /a/(b).ts");
});
