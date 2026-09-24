import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVersionString, bannerWordFrame, bannerWordCount, bounceFrame, bounceFrameCount } from "./banner.js";

test("buildVersionString formats a file mtime as vYYYYMMDD, zero-padded", () => {
  assert.equal(buildVersionString(new Date(2026, 0, 5).getTime()), "v20260105");
  assert.equal(buildVersionString(new Date(2026, 8, 24).getTime()), "v20260924");
});

test("bannerWordFrame reveals one word per tick, earlier words staying visible (settled) once revealed", () => {
  const text = "Harness CLI v20260924";
  assert.equal(bannerWordFrame(text, 0), "");
  const one = bannerWordFrame(text, 1);
  assert.match(one, /Harness/);
  assert.doesNotMatch(one, /CLI/);
  const two = bannerWordFrame(text, 2);
  assert.match(two, /Harness/);
  assert.match(two, /CLI/);
  assert.doesNotMatch(two, /v20260924/);
  const all = bannerWordFrame(text, bannerWordCount(text));
  assert.match(all, /Harness/);
  assert.match(all, /CLI/);
  assert.match(all, /v20260924/);
});

test("bannerWordFrame clamps past the last word and handles empty text", () => {
  const text = "Harness CLI";
  assert.equal(bannerWordFrame(text, 50), bannerWordFrame(text, bannerWordCount(text)));
  assert.equal(bannerWordFrame("", 3), "");
});

test("bannerWordCount counts words by splitting on spaces", () => {
  assert.equal(bannerWordCount("Harness CLI v20260924"), 3);
  assert.equal(bannerWordCount(""), 0);
  assert.equal(bannerWordCount("one"), 1);
});

test("bounceFrame plays a decaying up-down sequence and settles on a final frame past its length", () => {
  const frames = new Set<string>();
  for (let t = 0; t <= bounceFrameCount(); t++) frames.add(bounceFrame(t));
  // More than one distinct glyph — it's actually moving, not a static dot.
  assert.ok(frames.size > 1);
  const last = bounceFrame(bounceFrameCount());
  assert.equal(bounceFrame(bounceFrameCount() + 10), last, "clamps to the resting frame once the bounce is over");
});
