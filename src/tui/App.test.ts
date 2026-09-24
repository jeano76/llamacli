import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMenuItems, appendHistory, MAX_PROMPT_HISTORY, shouldHideCursor, quittingStatusText, parseMouseWheel, WHEEL_SCROLL_ROWS } from "./App.js";
import { SLASH_MENU_ITEMS } from "./SlashMenu.js";

// Reported directly: the slash menu could only be driven with arrow keys —
// typing the rest of a command's name after "/" did nothing at all. These
// cover the pure filtering logic; the actual key-handling wiring
// (App.tsx's useInput) isn't unit-testable without a full Ink render, but
// this is where a regression in the matching rule itself would show up.
test("filterMenuItems returns every command when the query is empty (just \"/\")", () => {
  assert.deepEqual(filterMenuItems("/"), SLASH_MENU_ITEMS);
});

test("filterMenuItems matches a full command name", () => {
  const result = filterMenuItems("/quit");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "quit");
});

test("filterMenuItems matches a partial prefix", () => {
  const result = filterMenuItems("/imp");
  assert.deepEqual(
    result.map((i) => i.key),
    ["improve", "improve-apply"]
  );
});

test("filterMenuItems is case-insensitive", () => {
  const result = filterMenuItems("/QUIT");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "quit");
});

test("filterMenuItems matches a substring anywhere in the command name, not just a prefix", () => {
  const result = filterMenuItems("/apply");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "improve-apply");
});

test("filterMenuItems returns an empty list when nothing matches, instead of falling back to all commands", () => {
  assert.deepEqual(filterMenuItems("/xyz123"), []);
});

test("filterMenuItems matches the plan-clear command", () => {
  assert.deepEqual(
    filterMenuItems("/plan").map((i) => i.key),
    ["plan-clear"]
  );
});

// Prompt history (Up/Down arrow) backing logic — the actual key handling
// itself isn't unit-testable without a full Ink render (same limitation as
// filterMenuItems above), so this covers the pure append/cap/dedupe rule
// that decides what ends up in history.
test("appendHistory adds a new entry to the end", () => {
  assert.deepEqual(appendHistory(["a", "b"], "c"), ["a", "b", "c"]);
});

test("appendHistory drops an exact duplicate of the immediately preceding entry, instead of spamming a repeat", () => {
  assert.deepEqual(appendHistory(["a", "b"], "b"), ["a", "b"]);
});

test("appendHistory still adds a duplicate that ISN'T immediately preceding (only the immediate repeat is special-cased)", () => {
  assert.deepEqual(appendHistory(["a", "b", "c"], "a"), ["a", "b", "c", "a"]);
});

test(`appendHistory caps at MAX_PROMPT_HISTORY (${MAX_PROMPT_HISTORY}), dropping the oldest entries first`, () => {
  const full = Array.from({ length: MAX_PROMPT_HISTORY }, (_, i) => `p${i}`);
  const result = appendHistory(full, "newest");
  assert.equal(result.length, MAX_PROMPT_HISTORY);
  assert.equal(result[0], "p1"); // p0 was dropped
  assert.equal(result[result.length - 1], "newest");
});

test("appendHistory does not grow past the cap even starting from an already-oversized list (e.g. loaded from an older/corrupted file)", () => {
  const oversized = Array.from({ length: MAX_PROMPT_HISTORY + 10 }, (_, i) => `p${i}`);
  const result = appendHistory(oversized, "newest");
  assert.equal(result.length, MAX_PROMPT_HISTORY);
  assert.equal(result[result.length - 1], "newest");
});

test("the cursor is hidden while the agent works with an empty input, and while saving before exit", () => {
  assert.equal(shouldHideCursor({ quitting: false, busy: true, input: "" }), true);
  assert.equal(shouldHideCursor({ quitting: true, busy: false, input: "" }), true);
  assert.equal(shouldHideCursor({ quitting: true, busy: false, input: "typed" }), true);
});

test("the cursor stays visible wherever the user can type", () => {
  assert.equal(shouldHideCursor({ quitting: false, busy: false, input: "" }), false);
  // Typing a message to queue while the agent works still needs a cursor.
  assert.equal(shouldHideCursor({ quitting: false, busy: true, input: "next" }), false);
});

test("the save-before-exit text shows whole elapsed seconds and how to skip the save", () => {
  assert.match(quittingStatusText(12_900), /저장 중… 12초/);
  assert.match(quittingStatusText(0), /Esc: 저장하지 않고 바로 종료/);
});

// Mouse wheel scrollback: Ink hands over SGR mouse reports with the leading
// ESC stripped, sometimes several in one string.
test("parseMouseWheel turns wheel-up/down reports into a scroll amount", () => {
  assert.equal(parseMouseWheel("[<64;10;5M"), WHEEL_SCROLL_ROWS);
  assert.equal(parseMouseWheel("[<65;10;5M"), -WHEEL_SCROLL_ROWS);
  // several reports batched into one chunk (a fast wheel spin)
  assert.equal(parseMouseWheel("[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M"), 3 * WHEEL_SCROLL_ROWS);
  // wheel with a modifier held (Shift adds 4, Ctrl adds 16) still scrolls
  assert.equal(parseMouseWheel("[<80;10;5M"), WHEEL_SCROLL_ROWS);
});

test("parseMouseWheel consumes clicks without scrolling, and ignores ordinary input", () => {
  assert.equal(parseMouseWheel("[<0;10;5M"), 0);
  assert.equal(parseMouseWheel("[<0;10;5m"), 0);
  assert.equal(parseMouseWheel("hello"), null);
  assert.equal(parseMouseWheel("[<not a report"), null);
});
