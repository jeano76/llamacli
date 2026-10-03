import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { filterMenuItems, appendHistory, MAX_PROMPT_HISTORY, shouldHideCursor, quittingStatusText, parseMouseWheel, WHEEL_SCROLL_ROWS, runHintText, shimmerBands, parseMouseClicks, foldedReasoningSummary, foldToggleHintExpanded, foldedCompactionSummary, compactionDetailBody, parseDiffStats, foldedDiffSummary, foldedToolResultSummary, bufferMouseChunk, wordLeft, wordRight, cursorRowCol, scrolledBannerText, createDeltaBuffer, UI_TICK_MS } from "./App.js";
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
  const result = filterMenuItems("/pla");
  assert.deepEqual(
    result.map((i) => i.key),
    ["plan-clear"]
  );
});

test("filterMenuItems is case-insensitive", () => {
  const result = filterMenuItems("/QUIT");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "quit");
});

test("filterMenuItems matches a substring anywhere in the command name, not just a prefix", () => {
  // "lear" only occurs inside "plan-clear", never at its start.
  const result = filterMenuItems("/lear");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "plan-clear");
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

test("filterMenuItems still matches once an argument is typed after the command name — the exact bug reported live", () => {
  // Reported directly: "/fastcheck on" used to filter against the query
  // "fastcheck on" in full (argument included), which no command's key
  // contains, dropping to "No matching commands" and silently breaking Enter.
  //
  // The example command changed when /fastcheck was removed, but the BEHAVIOUR
  // is unrelated to which command it is and is still live for every command
  // that takes an argument — /copy among them. Renaming the fixture rather
  // than deleting the test keeps the regression covered.
  assert.deepEqual(
    filterMenuItems("/copy 20").map((i) => i.key),
    ["copy"]
  );
  assert.deepEqual(
    filterMenuItems("/copy status").map((i) => i.key),
    ["copy"]
  );
  // Free text after the command, containing words that would otherwise
  // accidentally match some OTHER command.
  assert.deepEqual(
    filterMenuItems("/copy is this a quit-worthy risk?").map((i) => i.key),
    ["copy"]
  );
  // A prefix with no space is still filtered against the whole query, and
  // `includes` means a prefix legitimately matches several commands.
  assert.deepEqual(
    filterMenuItems("/co").map((i) => i.key),
    ["compact", "copy"]
  );
  // An argument does not narrow the match back to a full-key comparison: this
  // is the regression. Without the split, "copy 20" would match nothing.
  assert.notDeepEqual(
    filterMenuItems("/copy 20").map((i) => i.key),
    [],
    "an argument must not reduce the matches to none"
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

test("the running-state key hint teaches the app's own drag-to-select, and never overflows the input box", () => {
  // With the mouse default back ON (see terminal.ts for why it was flipped
  // back), a plain drag is now the app's own selection — the user has to be
  // told that dragging copies, because the alt screen has no native
  // scrollback to discover that from.
  assert.match(runHintText(100), /드래그: 선택·복사/);
  assert.doesNotMatch(runHintText(100), /자동 스크롤/);
  // Narrow terminals fall back to progressively shorter forms rather than
  // clipping mid-word; the last form is deliberately the most compact one.
  assert.equal(runHintText(40), "  Esc: 강제종료 · 드래그: 선택·복사");
  assert.equal(runHintText(20), "  Esc: 강제종료 · /quit: 정상종료");
  for (const cols of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 40, 60, 80, 100, 120]) {
    const text = runHintText(cols);
    assert.match(text, /Esc: 강제종료/);
    // This line renders in place of the input box's own text, and the input
    // Box is width-constrained and clips — so the guarantee is that the widest
    // form is never itself clipped on a terminal wide enough to be real. An
    // absurdly narrow terminal (<34 cols) is a display cutoff, not a bug.
    if (cols >= 34) assert.ok(stringWidth(text) <= cols - 1, `overflowed at ${cols} cols`);
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

// looksLikePartialMouseSequenceStart and its tests were REVERTED — reported
// directly: after it shipped, backspace stopped responding at all after
// recalling a history entry (Up/Down). See the (now-removed) function's
// former doc comment location in App.tsx for the root cause: an arrow key
// can arrive as raw, not-yet-decoded bytes under the same chunk-boundary
// hazard the mouse fix was targeting, and once mistaken for "maybe a mouse
// report" and buffered, every subsequent keystroke got silently absorbed
// into the same stuck buffer.

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

test("wordLeft skips trailing whitespace then the word behind it, like a shell's Ctrl+Left", () => {
  const text = "quick brown fox";
  assert.equal(wordLeft(text, text.length), "quick brown ".length);
  assert.equal(wordLeft(text, "quick brown ".length), "quick ".length);
  assert.equal(wordLeft(text, "quick ".length), 0);
  assert.equal(wordLeft(text, 0), 0);
});

test("wordRight skips the current word then any whitespace after it, mirroring wordLeft", () => {
  const text = "quick brown fox";
  assert.equal(wordRight(text, 0), "quick".length);
  assert.equal(wordRight(text, "quick".length), "quick brown".length);
  assert.equal(wordRight(text, "quick brown".length), "quick brown fox".length);
  assert.equal(wordRight(text, text.length), text.length);
});

test("cursorRowCol places the cursor on the same row/col wrapToWidth would render it on", () => {
  // "abcde" at width 2 wraps to ["ab", "cd", "e"] (see wrapToWidth). Offset 2
  // sits exactly on the wrap boundary — treated as the END of row 0 (right
  // after "ab"), not the start of row 1, matching where a cursor naturally
  // sits right before a line actually overflows.
  assert.deepEqual(cursorRowCol("abcde", 2, 0), { row: 0, col: 0 });
  assert.deepEqual(cursorRowCol("abcde", 2, 2), { row: 0, col: 2 });
  assert.deepEqual(cursorRowCol("abcde", 2, 3), { row: 1, col: 1 });
  assert.deepEqual(cursorRowCol("abcde", 2, 5), { row: 2, col: 1 });
});

test("cursorRowCol accounts for an explicit newline as a consumed separator, not a rendered character", () => {
  // "ab\ncd" wraps (width >= 2) to ["ab", "cd"] — the "\n" itself occupies
  // no column, so the offset right after it (3) is col 0 of row 1.
  assert.deepEqual(cursorRowCol("ab\ncd", 10, 3), { row: 1, col: 0 });
  assert.deepEqual(cursorRowCol("ab\ncd", 10, 2), { row: 0, col: 2 });
});

// ── "you are scrolled back" banner ──────────────────────────────────────────
// Replaces a version that built its text and then cut it with
// `.slice(0, columns)`. slice() counts UTF-16 code units, not terminal
// columns, so a narrow terminal could end up with a dangling separator and a
// misleading fragment — and the text was English in a Korean UI while using
// `─ ↑ ↓`, the exact glyphs that don't render on a non-UTF-8 terminal.

test("scrolledBannerText always fits the terminal width", () => {
  for (const columns of [10, 20, 30, 40, 60, 80, 120, 200]) {
    for (const offset of [1, 12, 999, 123456]) {
      const text = scrolledBannerText(offset, 5000, columns, true);
      assert.ok(
        stringWidth(text) <= columns,
        `columns=${columns} offset=${offset} width=${stringWidth(text)} "${text}"`
      );
    }
  }
});

test("scrolledBannerText falls back to ASCII on a non-UTF-8 terminal", () => {
  // The DECORATIVE glyphs must not leak: a `?` in their place is both ugly
  // and a width the layout never budgeted for. The Korean prose is the app's
  // own language and deliberately stays — see scrolledBannerText's comment.
  const text = scrolledBannerText(12, 480, 200, false);
  assert.ok(!/[─↑↓…·█░⠁❯│✓✗]/.test(text), `decorative non-ASCII leaked: "${text}"`);
  assert.ok(text.includes("12"), `expected the position, got "${text}"`);
  // …and the same banner in Unicode mode is the decorated version of the
  // same information, so the two can't drift in content.
  const uni = scrolledBannerText(12, 480, 200, true);
  for (const token of ["12", "480", "Shift+T"]) {
    assert.ok(uni.includes(token), `unicode banner lost "${token}": "${uni}"`);
  }
});

test("scrolledBannerText states the position and how to get back to live", () => {
  const wide = scrolledBannerText(7, 90, 200, true);
  assert.ok(wide.includes("7"), "should say how far up we are");
  assert.ok(wide.includes("90"), "should say how much there is in total");
  assert.ok(wide.includes("Shift+T"), "should say how to return to the live tail");
});

test("scrolledBannerText says something useful even when very little fits", () => {
  const narrow = scrolledBannerText(3, 9, 12, true);
  assert.ok(stringWidth(narrow) <= 12);
  assert.ok(narrow.includes("3"), `expected the offset to survive, got "${narrow}"`);
});

test("runHintText intentionally returns the shortest form even when it does not fit", () => {
  // Deliberate, and NOT the same contract as the log-area hints: this line
  // renders in place of the input box's own text, and the input Box is
  // width-constrained and clips, so a truncated "Esc: 강제종료 · /qu" still
  // communicates something while "" would communicate nothing. The log-area
  // hints (scrolledBannerText, startupHintText) are held to a hard width
  // guarantee instead, because they live in the log's fixed-height area where
  // overflowing really does displace rows.
  for (const columns of [1, 5, 10, 19]) {
    const text = runHintText(columns);
    assert.equal(text, "  Esc: 강제종료 · /quit: 정상종료");
    assert.ok(stringWidth(text) > columns, "expected this form to be wider than the terminal (that is the point)");
  }
  // Above the shortest form's width it does fit, and that's the case where
  // the width guarantee actually holds.
  for (const columns of [34, 40, 80, 200]) {
    assert.ok(stringWidth(runHintText(columns)) <= columns - 1, `columns=${columns}`);
  }
});

// Streaming deltas are batched into ~10Hz log updates (UI_TICK_MS) instead
// of re-rendering on every token — reported directly as flicker from the
// prompt input down to the bottom (tmux). The buffer itself is pure so the
// batching contract is testable without mounting Ink; the timer wiring
// (unified tick + finalize flush) is deliberately thin on top of it.
test("createDeltaBuffer concatenates pushes and drains them in one take", () => {
  const buf = createDeltaBuffer();
  buf.push("Hello, ");
  buf.push("world");
  assert.equal(buf.take(), "Hello, world");
  assert.equal(buf.take(), "", "a second take with no new pushes drains nothing (the tick skips its setLog)");
});

test("createDeltaBuffer starts empty", () => {
  assert.equal(createDeltaBuffer().take(), "");
});

test("UI_TICK_MS batches streaming renders well below the per-token rate", () => {
  // At ~30 tok/s, per-token renders would reconcile the whole screen ~30x/s
  // (plus shimmer + spinner on their own timers). One 100ms tick covers
  // flush + shimmer + spinner in a single render instead.
  assert.ok(UI_TICK_MS >= 50 && UI_TICK_MS <= 250, `UI_TICK_MS=${UI_TICK_MS} should batch visibly without feeling laggy`);
});
