import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVersionString, buildArt, HARNESS_ART, shakeFrame, shakeFrameCount, bounceFrame, bounceFrameCount } from "./banner.js";

test("buildVersionString formats a file mtime as vYYYYMMDD, zero-padded", () => {
  assert.equal(buildVersionString(new Date(2026, 0, 5).getTime()), "v20260105");
  assert.equal(buildVersionString(new Date(2026, 8, 24).getTime()), "v20260924");
});

test("buildArt lays out each letter's glyph side by side, 5 rows tall, blank for an unknown character", () => {
  const art = buildArt("HA");
  assert.equal(art.length, 5, "block-letter art is 5 rows tall");
  // "H"'s glyph starts with a full-height vertical bar in column 0.
  assert.ok(art.every((row) => row[0] === "█"), "H's left stroke should run the full height");
  // An unrecognized character renders as blank space, not a crash.
  assert.doesNotThrow(() => buildArt("H?"));
});

test("HARNESS_ART actually spells HARNESS (7 glyphs wide, non-blank)", () => {
  assert.equal(HARNESS_ART.length, 5);
  // 7 letters, each 5 wide, 1-space gaps between: 7*5 + 6 = 41 columns.
  for (const row of HARNESS_ART) assert.equal(row.length, 41);
  assert.ok(HARNESS_ART.some((row) => row.includes("█")), "the art must actually draw something, not be all spaces");
});

test("shakeFrame jitters the art for a while and then settles perfectly still (no leading offset)", () => {
  const art = ["abc", "def"];
  const early = shakeFrame(art, 0);
  const settled = shakeFrame(art, shakeFrameCount());
  // The settled frame's plain text (ANSI stripped) must be exactly the
  // original art, left-aligned — the shake must fully resolve, not leave
  // a residual offset.
  const stripped = settled.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripped, art.join("\n"));
  // Further ticks past settling change nothing.
  assert.equal(shakeFrame(art, shakeFrameCount() + 20), settled);
  // It's an actual animation, not a no-op — early ticks differ from settled.
  assert.notEqual(early, settled);
});

test("bounceFrame plays a decaying up-down sequence and settles on a final frame past its length", () => {
  const frames = new Set<string>();
  for (let t = 0; t <= bounceFrameCount(); t++) frames.add(bounceFrame(t));
  // More than one distinct glyph — it's actually moving, not a static dot.
  assert.ok(frames.size > 1);
  const last = bounceFrame(bounceFrameCount());
  assert.equal(bounceFrame(bounceFrameCount() + 10), last, "clamps to the resting frame once the bounce is over");
});
