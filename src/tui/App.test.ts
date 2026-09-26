import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { filterMenuItems, appendHistory, MAX_PROMPT_HISTORY, shouldHideCursor, quittingStatusText, parseMouseWheel, WHEEL_SCROLL_ROWS, runHintText, shimmerBands, parseMouseClicks, foldedReasoningSummary, foldToggleHintExpanded, foldedCompactionSummary, compactionDetailBody, parseDiffStats, foldedDiffSummary, foldedToolResultSummary, bufferMouseChunk, looksLikePartialMouseSequenceStart } from "./App.js";
import { formatDiff } from "../tools/diff.js";
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

test("the running-state key hint uses the long form when it fits, and a short one otherwise, and always distinguishes Esc (force quit) from /quit (normal quit)", () => {
  assert.match(runHintText(100), /Shift\+드래그: 선택 · Shift\+우클릭: 복사\/붙여넣기/);
  assert.equal(runHintText(50), "  Esc: 강제종료 · /quit: 정상종료");
  assert.equal(runHintText(30), "  Esc: 강제종료 · /quit: 정상종료");
  for (const cols of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 40, 60, 80, 120]) {
    const text = runHintText(cols);
    assert.match(text, /Esc: 강제종료/);
    assert.match(text, /\/quit: 정상종료/);
    // The shortest form is itself fairly wide now that it must name both
    // Esc and /quit distinctly (see runHintText's doc comment) — only the
    // widest form's own line matters for not overflowing a normal terminal;
    // an unrealistically narrow one (<34 cols) is a display cutoff, not a
    // display-code bug, the same carve-out the old shortest form had.
    if (cols >= 34) assert.ok(stringWidth(text) <= cols - 1);
  }
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


test("bufferMouseChunk reassembles a SGR mouse report split across two stdin chunks, instead of leaking the fragment as typed text", () => {
  // Reported directly: under fast scrolling/clicking, a chunk boundary can
  // land mid-escape-sequence and the trailing half appeared as literal
  // ANSI garbage in the prompt box.
  const full = "\x1b[<35;10;20M";
  const splitAt = 7;
  const first = bufferMouseChunk("", full.slice(0, splitAt));
  assert.equal(first.action, "wait", "the first half alone isn't a complete report yet");
  const second = bufferMouseChunk(full.slice(0, splitAt), full.slice(splitAt));
  assert.equal(second.action, "process");
  assert.equal((second as { action: "process"; text: string }).text, full, "the two halves must reassemble to the original report");
});

test("bufferMouseChunk processes a complete report immediately with nothing buffered, and discards an over-long non-report rather than buffering forever", () => {
  const complete = bufferMouseChunk("", "\x1b[<0;5;5M");
  assert.equal(complete.action, "process");

  const garbage = bufferMouseChunk("", "\x1b[<" + "9".repeat(100));
  assert.equal(garbage.action, "discard");
});

test("looksLikePartialMouseSequenceStart recognizes a bare ESC or ESC+[ fragment, and nothing else", () => {
  // Reported directly: garbled fragments (e.g. ";1;5m", stray "[붙여넣기 ...]"
  // placeholders) showed up in the input box while just MOVING the mouse —
  // motion reports fire continuously, so a read() boundary landing INSIDE
  // the 2-3 byte "\x1b[<" lead-in (before the entry check's own full-match
  // regex would ever fire) is far more likely than with occasional clicks.
  assert.equal(looksLikePartialMouseSequenceStart("\x1b"), true);
  assert.equal(looksLikePartialMouseSequenceStart("\x1b["), true);
  // A complete lead-in, or a normal keystroke, is not "partial" — the
  // existing full-match regex (or normal typing) already handles those.
  assert.equal(looksLikePartialMouseSequenceStart("\x1b[<"), false);
  assert.equal(looksLikePartialMouseSequenceStart("a"), false);
  assert.equal(looksLikePartialMouseSequenceStart(""), false);
});

test("scenario: a mouse report split right after ESC, or right after ESC+[ (before '<' ever arrives), still reassembles correctly end to end", () => {
  // This is the exact gap the fix closes: bufferMouseChunk's own full-match
  // regex requires "\x1b[<" together to recognize a report is IN PROGRESS,
  // so a split landing strictly before that 3-byte lead-in completes was
  // invisible to it — the real useInput callback's entry check needed
  // looksLikePartialMouseSequenceStart to even call bufferMouseChunk at all
  // for the first fragment. Simulates that combined entry logic here.
  const full = "\x1b[<35;10;20M";
  for (const splitAt of [1, 2]) {
    let buffered = "";
    for (const chunk of [full.slice(0, splitAt), full.slice(splitAt)]) {
      const shouldBuffer = buffered !== "" || /\x1b\[</.test(chunk) || looksLikePartialMouseSequenceStart(chunk);
      assert.ok(shouldBuffer, `splitAt=${splitAt}: chunk ${JSON.stringify(chunk)} should have entered buffering`);
      const outcome = bufferMouseChunk(buffered, chunk);
      if (outcome.action === "process") {
        assert.equal(outcome.text, full, `splitAt=${splitAt}: must reassemble to the original report`);
        buffered = "";
      } else {
        assert.equal(outcome.action, "wait", `splitAt=${splitAt}: an incomplete fragment must wait, never discard this early`);
        buffered = buffered + chunk;
      }
    }
    assert.equal(buffered, "", `splitAt=${splitAt}: must have fully resolved by the end, nothing left dangling`);
  }
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

test("foldedCompactionSummary names counts, and compactionDetailBody shows both dropped and kept content", () => {
  const label = foldedCompactionSummary(6, 1200, 3);
  assert.match(label, /6개/);
  assert.match(label, /1200/);
  assert.match(label, /3개/);
  assert.match(label, /펼치기/);

  const body = compactionDetailBody({ droppedPreview: ["[user] old request", "[tool] some output"], summary: "the gist of it" });
  assert.match(body, /잊혀진/);
  assert.match(body, /old request/);
  assert.match(body, /강조된/);
  assert.match(body, /the gist of it/);
});

test("foldedToolResultSummary names the command and the output's line count, and invites a click to expand", () => {
  const label = foldedToolResultSummary("npm test", "line1\nline2\nline3");
  assert.match(label, /npm test/);
  assert.match(label, /3줄/);
  assert.match(label, /펼치기/);
});

test("parseDiffStats reads the path and +/- counts out of a real formatDiff() string", () => {
  const diff = formatDiff("src/foo.ts", "line1\nline2\nline3", "line1\nchanged\nline3\nline4");
  const stats = parseDiffStats(diff);
  assert.equal(stats.path, "src/foo.ts");
  assert.ok(stats.added >= 1, "expected at least the changed/added line to be counted");
  assert.ok(stats.removed >= 1, "expected the replaced line to be counted as removed");
});

test("parseDiffStats falls back gracefully on text that doesn't look like formatDiff's output", () => {
  const stats = parseDiffStats("not a diff at all");
  assert.equal(stats.path, "(unknown file)");
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("foldedDiffSummary names the file and the +/- counts, and invites a click to expand", () => {
  const diff = formatDiff("a.js", "old", "new");
  const label = foldedDiffSummary(diff);
  assert.match(label, /a\.js/);
  assert.match(label, /\+\d+/);
  assert.match(label, /-\d+/);
  assert.match(label, /펼치기/);
});
