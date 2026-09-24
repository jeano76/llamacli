import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVersionString, bannerFrame, bannerFrameCount } from "./banner.js";

test("buildVersionString formats a file mtime as vYYYYMMDD, zero-padded", () => {
  assert.equal(buildVersionString(new Date(2026, 0, 5).getTime()), "v20260105");
  assert.equal(buildVersionString(new Date(2026, 8, 24).getTime()), "v20260924");
});

test("bannerFrame reveals text as a one-directional wave — earlier characters stay settled, never revert to dim", () => {
  const text = "Harness CLI";
  const early = bannerFrame(text, 1);
  const later = bannerFrame(text, 10);
  // At tick 1 almost nothing is settled yet (dim/peak only).
  assert.ok(!early.includes("\x1b[1;36m"));
  // Once the wave has fully crossed, later ticks stop changing anything —
  // revealed clamps at text.length, so the frame is stable (not literally
  // all-settled: the trailing bandWidth stays the "peak" leading-edge
  // color by design, same as App.tsx's shimmerBands).
  assert.equal(later, bannerFrame(text, 100));
  assert.ok(later.startsWith("\x1b[1;36mH"));
});

test("bannerFrame is idempotent for the same (text, tick) and empty text renders as empty", () => {
  assert.equal(bannerFrame("abc", 3), bannerFrame("abc", 3));
  assert.equal(bannerFrame("", 3), "");
});

test("bannerFrameCount gives enough ticks for the wave to fully cross the text (some trailing chars stay the peak color by design, same as App.tsx's shimmerBands)", () => {
  const text = "Harness CLI";
  assert.equal(bannerFrameCount(text, 2), 6); // 11 chars / 2 per tick, rounded up
  const finalFrame = bannerFrame(text, bannerFrameCount(text, 2));
  assert.equal(finalFrame, bannerFrame(text, bannerFrameCount(text, 2) + 5), "further ticks change nothing once revealed is clamped");
});
