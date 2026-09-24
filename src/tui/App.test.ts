import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { filterMenuItems, appendHistory, MAX_PROMPT_HISTORY, shouldHideCursor, quittingStatusText, parseMouseWheel, WHEEL_SCROLL_ROWS, runHintText, shimmerBands, parseMouseClicks, foldedReasoningSummary, foldToggleHintExpanded } from "./App.js";
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

test("the running-state key hint uses the long form when it fits, and a short one otherwise", () => {
  assert.match(runHintText(100), /Shift\+드래그: 선택 · Shift\+우클릭: 복사\/붙여넣기/);
  assert.equal(runHintText(50), "  Esc: 종료 · Shift+우클릭: 복사/붙여넣기");
  assert.equal(runHintText(30), "  Esc: 종료");
  for (const cols of [20, 40, 60, 80, 120]) assert.ok(stringWidth(runHintText(cols)) <= cols - 1 || cols < 14);
});

test("shimmerBands reveals text as a one-directional wave that never un-reveals already-passed text", () => {
  const text = "abcdefghijklmnopqrst"; // 20 chars
  const bw = 5, speed = 1;

  // tick 0: nothing revealed yet — all dim.
  assert.deepEqual(shimmerBands(text, 0, bw, speed), [{ text, role: "dim" }]);

  // Partway: settled (already passed) + peak (leading edge) + dim (not yet reached).
  const mid = shimmerBands(text, 8, bw, speed); // revealed=8, peakStart=3
  assert.deepEqual(mid, [
    { text: "abc", role: "settled" },
    { text: "defgh", role: "peak" },
    { text: "ijklmnopqrst", role: "dim" },
  ]);
  assert.equal(mid.map((b) => b.text).join(""), text, "bands must reconstruct the original text exactly");

  // Monotonic: a LATER tick must never move settled text back to dim —
  // this is the whole point of the redesign (the earlier cyclic version did).
  const later = shimmerBands(text, 12, bw, speed); // revealed=12, peakStart=7
  const midSettledPrefix = text.slice(0, 3);
  const laterSettledPrefix = later[0].text;
  assert.ok(laterSettledPrefix.startsWith(midSettledPrefix), "everything settled at an earlier tick must still be settled (or further) later");

  // Fully revealed: no dim band left, and it stays that way past the end.
  const done = shimmerBands(text, 100, bw, speed);
  assert.ok(!done.some((b) => b.role === "dim"));
  assert.equal(shimmerBands(text, 1000, bw, speed).map((b) => b.text).join(""), text);
});

test("shimmerBands is empty for empty text", () => {
  assert.deepEqual(shimmerBands("", 5), []);
});


test("parseMouseClicks reports a plain button press with its (row, col), and ignores wheel/drag/release", () => {
  assert.deepEqual(parseMouseClicks("[<0;15;22M"), [{ row: 22, col: 15 }]);
  assert.deepEqual(parseMouseClicks("[<0;15;22m"), [], "a release must not also toggle");
  assert.deepEqual(parseMouseClicks("[<64;10;5M"), [], "a wheel report is not a click");
  assert.deepEqual(parseMouseClicks("[<32;10;5M"), [], "a drag/motion report is not a click");
  assert.deepEqual(parseMouseClicks("[<0;1;1M[<0;40;12M"), [
    { row: 1, col: 1 },
    { row: 12, col: 40 },
  ]);
  assert.deepEqual(parseMouseClicks("hello"), []);
});

test("foldedReasoningSummary and the expanded hint both name what a click does", () => {
  assert.match(foldedReasoningSummary("x".repeat(42)), /42자/);
  assert.match(foldedReasoningSummary("hi"), /펼치기/);
  assert.match(foldToggleHintExpanded, /접기/);
});
