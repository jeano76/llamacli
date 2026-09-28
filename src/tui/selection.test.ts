import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edgeDirection, normalizeSelection, rowRange, selectionText, isSelectionEmpty,
  buildOsc52, copySelection, stripAnsiForCopy, CLIPBOARD_FALLBACK_PATH,
  EDGE_SCROLL_STEP, EDGE_SCROLL_INTERVAL_MS, EDGE_ROWS,
  type Selection,
} from "./selection.js";

const rows = (lines: string[]) => lines.map((text) => ({ text }));
const sel = (ar: number, ac: number, hr: number, hc: number): Selection => ({
  anchor: { row: ar, col: ac },
  head: { row: hr, col: hc },
});

// ── Edge detection ──────────────────────────────────────────────────────────
// The log occupies terminal rows 5..20 in a 30-row terminal (banner gap above,
// input box below), which is the realistic shape — an earlier version of this
// logic compared against the window height and would have treated row 29 (the
// input box) as the bottom of the log.

test("a drag on the top rows of the log scrolls toward older output", () => {
  assert.equal(edgeDirection(5, 5, 20), "up");
  assert.equal(edgeDirection(6, 5, 20), "up");
});

test("a drag on the bottom rows of the log scrolls toward the live tail", () => {
  assert.equal(edgeDirection(20, 5, 20), "down");
  assert.equal(edgeDirection(19, 5, 20), "down");
});

test("a drag in the middle of the log does not scroll", () => {
  // The gap between the two edge bands is where a user selects an ordinary
  // line, and scrolling there instead would make that impossible.
  for (let row = 5 + EDGE_ROWS; row <= 20 - EDGE_ROWS; row++) {
    assert.equal(edgeDirection(row, 5, 20), null, `row ${row} must not auto-scroll`);
  }
});

test("a drag outside the log — e.g. over the input box — does not scroll", () => {
  assert.equal(edgeDirection(4, 5, 20), null, "one row above the log");
  assert.equal(edgeDirection(21, 5, 20), null, "below the log (the input box)");
  assert.equal(edgeDirection(29, 5, 20), null, "the very bottom of the terminal");
});

test("auto-scroll is disabled while the slash menu overlays the log", () => {
  assert.equal(edgeDirection(5, 5, 20, { menuOpen: true }), null);
});

test("the edge band is more than one row, so a drag resting on the last line can still stop", () => {
  // With a one-row band, holding the pointer on the final row of the log (where
  // it naturally rests) would keep scrolling forever, and a user trying to
  // select that last line could never stop.
  assert.equal(edgeDirection(20, 5, 20, { edgeRows: 1 }), "down");
  assert.equal(edgeDirection(19, 5, 20, { edgeRows: 1 }), null, "one row of slack is not enough");
});

test("edge auto-scroll is tuned to a readable speed, not a teleport", () => {
  assert.ok(EDGE_SCROLL_INTERVAL_MS > 0 && EDGE_SCROLL_STEP > 0);
  const rowsPerSecond = (EDGE_SCROLL_STEP * 1000) / EDGE_SCROLL_INTERVAL_MS;
  assert.ok(rowsPerSecond >= 5 && rowsPerSecond <= 40,
    `${rowsPerSecond.toFixed(0)} rows/s should be slow enough to stop on a line`);
});

// ── Normalization ───────────────────────────────────────────────────────────

test("dragging up-left selects the same text as dragging down-right", () => {
  // The most common way a hand-rolled selection is visibly wrong.
  const a = normalizeSelection(sel(10, 20, 2, 3));
  assert.deepEqual(a.start, { row: 2, col: 3 });
  assert.deepEqual(a.end, { row: 10, col: 20 });
});

test("a click that does not move is an empty selection", () => {
  assert.ok(isSelectionEmpty(sel(5, 5, 5, 5)));
  assert.ok(!isSelectionEmpty(sel(5, 5, 5, 6)));
  assert.ok(!isSelectionEmpty(sel(5, 5, 6, 0)));
});

// ── Per-row ranges ──────────────────────────────────────────────────────────

test("rowRange covers the middle rows of a multi-row selection in full", () => {
  const s = sel(0, 2, 3, 1);
  assert.deepEqual(rowRange(s, 0, 10), { start: 2, end: 10 });
  assert.deepEqual(rowRange(s, 1, 10), { start: 0, end: 10 });
  assert.deepEqual(rowRange(s, 2, 10), { start: 0, end: 10 });
  assert.deepEqual(rowRange(s, 3, 10), { start: 0, end: 1 });
});

test("rowRange returns null for rows outside the selection", () => {
  const s = sel(2, 0, 4, 5);
  assert.equal(rowRange(s, 1, 10), null);
  assert.equal(rowRange(s, 5, 10), null);
});

test("rowRange clamps a column past the end of a short row instead of over-reading", () => {
  // Dragging to column 90 of a 6-character row must select the whole row, not
  // slice out of range.
  assert.deepEqual(rowRange(sel(0, 0, 0, 90), 0, 6), { start: 0, end: 6 });
});

test("a selection ending at column 0 does not paint the whole final row", () => {
  // The drag stopped *before* that row's first character.
  assert.equal(rowRange(sel(0, 0, 2, 0), 2, 10), null);
  assert.deepEqual(rowRange(sel(0, 0, 2, 3), 2, 10), { start: 0, end: 3 });
});

// ── Copy text ───────────────────────────────────────────────────────────────

test("selectionText reproduces the selected lines in reading order, not drag order", () => {
  const text = selectionText(sel(3, 2, 1, 4), rows([
    "line zero", "line one", "line two", "line three", "line four",
  ]));
  // Normalized to (1,4)→(3,2): "line one" from col 4, "line two" whole, and
  // "line three" only up to col 2.
  assert.equal(text, " one\nline two\nli");
});

test("selectionText strips trailing whitespace so the copy pastes cleanly", () => {
  // The log box is a fixed width, so its rows arrive space-padded; copying them
  // verbatim gives a ragged block with trailing spaces on every line.
  const text = selectionText(sel(0, 0, 1, 8), rows(["alpha      ", "beta       "]));
  assert.equal(text, "alpha\nbeta");
});

test("selectionText of nothing is empty, not undefined", () => {
  assert.equal(selectionText(null, rows(["x"])), "");
  assert.equal(selectionText(sel(0, 0, 0, 0), rows(["x"])), "");
});

// ── Clipboard ───────────────────────────────────────────────────────────────

test("buildOsc52 produces a well-formed OSC 52 sequence", () => {
  const seq = buildOsc52("hi")!;
  assert.ok(seq.startsWith("\x1b]52;c;"), "OSC 52, clipboard selection");
  assert.ok(seq.endsWith("\x07"), "terminated by BEL");
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "hi");
});

test("buildOsc52 refuses empty text and over-long payloads rather than sending them", () => {
  assert.equal(buildOsc52(""), null);
  assert.equal(buildOsc52("x".repeat(200_000)), null, "over the cap => null so the file fallback runs");
});

test("copySelection always writes the file, because a refused OSC 52 is silent", () => {
  // Most Wayland terminals drop OSC 52 without saying so. If the file were only
  // written when the sequence was too big to send, a user could select, release,
  // paste, get their old clipboard, and have no idea anything failed.
  const written: Record<string, string> = {};
  return copySelection("selected text", {
    path: "/tmp/fake-clip.txt",
    write: () => {},
    writeFile: async (p, t) => { written[p] = t; },
  }).then((result) => {
    assert.equal(result.via, "osc52");
    assert.equal(written["/tmp/fake-clip.txt"], "selected text");
    assert.equal(result.path, "/tmp/fake-clip.txt");
  });
});

test("copySelection falls back to the file alone when the text exceeds the OSC 52 cap", () => {
  const written: Record<string, string> = {};
  let seqWritten = "";
  return copySelection("y".repeat(5000), {
    path: "/tmp/fake2.txt",
    maxOsc52: 100, // deliberately tiny
    write: (s) => { seqWritten += s; },
    writeFile: async (p, t) => { written[p] = t; },
  }).then((result) => {
    assert.equal(result.via, "file", "nothing was sent over the wire");
    assert.equal(seqWritten, "", "no OSC 52 sequence at all");
    assert.equal(written["/tmp/fake2.txt"].length, 5000, "the FULL text is in the file, untruncated");
    assert.equal(result.truncated, false, "the file fallback is not a truncation");
  });
});

test("an over-cap selection is written to the file IN FULL, never silently truncated", () => {
  // The copy is Korean-heavy, so truncation is not a rare corner: any long
  // selection of this app's own output hits it. Truncating what lands on the
  // clipboard hands the user an incomplete block with no indication it was cut;
  // the file is the lossless copy, so the full text goes there and the wire gets
  // nothing. Asserted on characters so a byte-slicing bug (splitting a Hangul
  // syllable in half) can't pass as "close enough".
  const korean = "가나다라마바사아자차카타파하".repeat(400);
  const written: Record<string, string> = {};
  let seqWritten = "";
  return copySelection(korean, {
    path: "/tmp/fake3.txt",
    maxOsc52: 1000,
    write: (s) => { seqWritten += s; },
    writeFile: async (p, t) => { written[p] = t; },
  }).then((result) => {
    assert.equal(result.via, "file");
    assert.equal(seqWritten, "", "nothing goes to the clipboard when it cannot fit");
    assert.equal(result.truncated, false, "the file fallback is lossless, not a truncation");
    assert.equal(written["/tmp/fake3.txt"], korean, "the file has every character, in order");
    // And it is valid UTF-8 — the real assertion behind "never mid-character".
    assert.equal(Buffer.from(written["/tmp/fake3.txt"], "utf8").toString("utf8"), korean);
  });
});

test("the default clipboard fallback path is in /tmp, not the project directory", () => {
  // A copy is a scratch artifact of a UI action. Writing it into the project
  // would put a file the user never asked for into their git status.
  assert.ok(CLIPBOARD_FALLBACK_PATH.startsWith("/tmp/"), CLIPBOARD_FALLBACK_PATH);
});

// ── ANSI stripping ──────────────────────────────────────────────────────────

test("stripAnsiForCopy removes colour codes, the way the banner and status lines carry them", () => {
  // Caught by copying from the real app: the pasted text contained literal
  // "[1;36m" fragments.
  const raw = "\x1b[1;36m█   █  ███\x1b[0m \x1b[1;33m████\x1b[0m";
  assert.equal(stripAnsiForCopy(raw), "█   █  ███ ████");
});

test("stripAnsiForCopy also removes OSC hyperlinks, not just SGR", () => {
  const raw = "\x1b]8;;https://example.com\x07link text\x1b]8;;\x07";
  assert.equal(stripAnsiForCopy(raw), "link text");
});
