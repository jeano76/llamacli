import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVersionString, buildArt, HARNESS_ART, ART_WIDTH, LETTER_WIDTH, rightAlign, shineFrame, shineFrameCount, shineMultilineFrame, shineMultilineFrameCount, bounceFrame, bounceFrameCount } from "./banner.js";

test("buildVersionString formats a file mtime as vYYYYMMDD, zero-padded", () => {
  assert.equal(buildVersionString(new Date(2026, 0, 5).getTime()), "v20260105");
  assert.equal(buildVersionString(new Date(2026, 8, 24).getTime()), "v20260924");
});

test("buildArt lays out each letter's glyph side by side, 5 rows tall, blank for an unknown character", () => {
  const art = buildArt("HA");
  assert.equal(art.length, 5, "block-letter art is 5 rows tall");
  // "H"'s glyph starts with a full-height solid vertical bar in column 0.
  assert.ok(art.every((row) => row[0] === "█"), "H's left stroke should run the full height");
  // An unrecognized character renders as blank space, not a crash.
  assert.doesNotThrow(() => buildArt("H?"));
});

test("HARNESS_ART spells out HARNESS (every row the same width, non-blank)", () => {
  assert.equal(HARNESS_ART.length, 5);
  assert.deepEqual(HARNESS_ART, buildArt("HARNESS"));
  const widths = new Set(HARNESS_ART.map((row) => row.length));
  assert.equal(widths.size, 1, "every row must be the same width for the art to look like a rectangle");
  assert.ok(HARNESS_ART.some((row) => row.includes("█")), "the art must actually draw something, not be all spaces");
});

test("buildArt gives a literal space a narrower gap than a real letter's own blank", () => {
  // "A B" is A, a word-gap space, then B (unrecognized → a full blank
  // letter cell) — the word gap must contribute less width than an actual
  // blank letter would, or a space reads as just another empty letter.
  const spaceWidth = buildArt(" ")[0].length;
  const blankLetterWidth = buildArt("?")[0].length;
  assert.ok(spaceWidth < blankLetterWidth, "a word-gap space should be narrower than a blank letter cell");
});

test("rightAlign pads plain text so it ends flush at the given width, ignoring ANSI codes in the width count", () => {
  const plain = rightAlign("v20260924", 20);
  assert.equal(plain.length, 20);
  assert.ok(plain.endsWith("v20260924"));

  // ANSI-wrapped text must be measured by its VISIBLE width, not its raw
  // string length (which would over-count and under-pad).
  const colored = rightAlign("\x1b[2mhttps://example.com\x1b[0m", 30);
  const stripped = colored.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripped.length, 30);

  assert.equal(rightAlign("way too long for this width", 5), "way too long for this width", "never truncates");
});

test("ART_WIDTH matches HARNESS_ART's actual row width, so a caption line right-aligned to it lines up", () => {
  assert.equal(ART_WIDTH, HARNESS_ART[0].length);
  assert.equal(rightAlign("x", ART_WIDTH).length, ART_WIDTH);
});

test("LETTER_WIDTH matches every glyph's real width, so ART_WIDTH - LETTER_WIDTH lands exactly on the last letter's start column", () => {
  assert.equal(ART_WIDTH % (LETTER_WIDTH + 1), LETTER_WIDTH, "N letters of LETTER_WIDTH + 1-column gaps, no trailing gap");
});

test("shineFrame reveals text as a one-directional wave, same shape as reasoning's own shimmer — never un-reveals once settled", () => {
  const text = "CLI";
  const early = shineFrame(text, 1);
  const later = shineFrame(text, shineFrameCount(text));
  assert.ok(!early.includes("\x1b[1;36m"), "almost nothing settled yet at the first tick");
  assert.equal(later, shineFrame(text, shineFrameCount(text) + 50), "clamps once fully revealed, doesn't keep changing");
  assert.notEqual(early, later);
});

test("shineFrameCount scales with text length and empty text needs no ticks", () => {
  assert.equal(shineFrameCount(""), 0);
  assert.equal(shineFrameCount("CLI", 2), 2); // 3 chars / 2 per tick, rounded up
});

test("shineMultilineFrame staggers each row's start diagonally — a later row hasn't started revealing while an earlier one has", () => {
  const lines = ["AAAA", "BBBB", "CCCC"];
  // With a slant of 2 ticks/row, tick 1 is still before row 1's (and row
  // 2's) start — only row 0 should show any color yet.
  const early = shineMultilineFrame(lines, 1, 1, 2);
  const [row0, row1, row2] = early.split("\n");
  assert.match(row0, /\x1b\[1;36m/, "row 0 has started revealing immediately");
  assert.doesNotMatch(row1, /\x1b\[1;36m/, "row 1 hasn't started yet — the diagonal delay hasn't reached it");
  assert.doesNotMatch(row2, /\x1b\[1;36m/, "row 2 starts even later than row 1");

  const settled = shineMultilineFrame(lines, shineMultilineFrameCount(lines));
  assert.equal(settled, shineMultilineFrame(lines, shineMultilineFrameCount(lines) + 20), "clamps once every character has revealed");
  const strippedSettled = settled.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(strippedSettled, lines.join("\n"));
});

test("shineMultilineFrameCount accounts for the LAST row's diagonal delay plus its own reveal time, not just the longest line", () => {
  // A short last row still needs its full diagonal delay before it can
  // even start, so the total can be longer than reading every line's own
  // shineFrameCount in isolation would suggest.
  const lines = ["a", "a", "a"];
  const slantPerRow = 2;
  const speed = 1;
  assert.equal(shineMultilineFrameCount(lines, speed, slantPerRow), 2 * slantPerRow + Math.ceil(1 / speed));
});

test("shineMultilineFrame has exactly one final color — no separate bright/peak highlight anywhere, ever", () => {
  const lines = ["AAAAAAAAAA", "BBBBBBBBBB"];
  // Across every tick of the animation, a revealed character is always
  // the SAME settled color — never the bright magenta peak from earlier
  // designs, which read as an inconsistent second color.
  for (let t = 0; t <= shineMultilineFrameCount(lines) + 5; t++) {
    assert.doesNotMatch(shineMultilineFrame(lines, t), /\x1b\[1;95m/, `tick ${t} must never use the peak color`);
  }
});

test("bounceFrame plays a decaying up-down sequence and settles on a final frame past its length", () => {
  const frames = new Set<string>();
  for (let t = 0; t <= bounceFrameCount(); t++) frames.add(bounceFrame(t));
  // More than one distinct glyph — it's actually moving, not a static dot.
  assert.ok(frames.size > 1);
  const last = bounceFrame(bounceFrameCount());
  assert.equal(bounceFrame(bounceFrameCount() + 10), last, "clamps to the resting frame once the bounce is over");
});
