import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  statusBarFieldWidth,
  formatPlanProgress,
  hasRoomForPlanSlot,
  formatCompactionStatus,
  hasRoomForCompactionSlot,
  formatScrollIndicator,
  hasRoomForScrollSlot,
  renderGauge,
  SCROLL_INDICATOR_WIDTH,
} from "./StatusBar.js";
import { tailToWidth } from "./textWidth.js";

test("statusBarFieldWidth never lets cwd+model+gauge(+plan-progress+compaction-status+scroll, when shown) exceed the terminal width", () => {
  for (const columns of [40, 60, 72, 80, 100, 120, 200]) {
    const fieldWidth = statusBarFieldWidth(columns);
    const planSlot = hasRoomForPlanSlot(columns) ? 7 + 1 : 0; // slot + its leading space
    const compactionSlot = hasRoomForCompactionSlot(columns) ? 10 + 1 : 0; // slot + its leading space
    const scrollSlot = hasRoomForScrollSlot(columns) ? SCROLL_INDICATOR_WIDTH + 1 : 0; // slot + its leading space
    // Simulate the worst case: both fields maxed out at fieldWidth.
    const totalUsed =
      2 /* paddingX */ + 2 /* "│ " */ + fieldWidth + fieldWidth + planSlot + compactionSlot + scrollSlot + 12 /* gauge */ + 5 /* " 100%" */ + 4 /* gaps */;
    assert.ok(totalUsed <= columns + 4, `columns=${columns}, fieldWidth=${fieldWidth}, totalUsed=${totalUsed}`);
  }
});

// The scroll slot is budgeted unconditionally (content appears only while
// scrolled). That's the point: a bar that changes width the instant you
// press PageUp is the "this row wraps" failure the rest of the layout
// exists to prevent.
test("the scroll slot is width-budgeted even when nothing is scrolled", () => {
  const withSlot = statusBarFieldWidth(200);
  const wouldBeWithout = (() => {
    // Recompute what the old budget (no scroll slot) would have produced.
    const planSlot = hasRoomForPlanSlot(200) ? 8 : 0;
    const compactionSlot = hasRoomForCompactionSlot(200) ? 11 : 0;
    const fixed = 2 + 2 + 12 + 5 + planSlot + compactionSlot + 4;
    return Math.max(8, Math.floor((200 - fixed) / 2));
  })();
  assert.ok(withSlot < wouldBeWithout, `expected the scroll slot to consume budget: ${withSlot} vs ${wouldBeWithout}`);
});

// Caught directly by the test above before this existed: reserving the
// plan-progress slot unconditionally pushed a 40-column terminal's real
// total width past 40 (47 used), because statusBarFieldWidth's own floor
// (8) already eats into cwd/model's budget there with nothing spare left.
test("the plan-progress slot is hidden below MIN_COLUMNS_FOR_PLAN_SLOT rather than forcing cwd/model to squeeze for it", () => {
  assert.equal(hasRoomForPlanSlot(40), false);
  assert.equal(hasRoomForPlanSlot(200), true);
});

test("the compaction-status slot is hidden below MIN_COLUMNS_FOR_COMPACTION_SLOT rather than forcing cwd/model to squeeze for it", () => {
  assert.equal(hasRoomForCompactionSlot(40), false);
  assert.equal(hasRoomForCompactionSlot(60), false); // room for plan progress, but not both slots at once
  assert.equal(hasRoomForCompactionSlot(200), true);
});

// Requested directly: the "[compaction complete] ..." log line got pushed
// out of view by later scrolling activity before it was ever actually
// noticed — a persistent status-bar indicator instead, same reasoning as
// plan progress.
test("formatCompactionStatus returns \"\" when no compaction has happened yet", () => {
  assert.equal(formatCompactionStatus(null), "");
});

test("formatCompactionStatus shows a fixed 'compacting' label while running", () => {
  assert.equal(formatCompactionStatus({ state: "running", timestamp: "2026-09-18T18:01:31.059Z" }), "compacting");
});

test("formatCompactionStatus shows a checkmark and the real time-of-day on success", () => {
  assert.equal(formatCompactionStatus({ state: "complete", timestamp: "2026-09-18T18:01:31.059Z" }), "✓ 18:01:31");
});

test("formatCompactionStatus shows a cross and the real time-of-day on failure", () => {
  assert.equal(formatCompactionStatus({ state: "failed", timestamp: "2026-09-18T09:05:00.000Z" }), "✗ 09:05:00");
});

test("formatCompactionStatus falls back to a one-column ASCII mark, keeping the same total width", () => {
  // The width is the constraint, not the glyph: a two-column fallback would
  // push the gauge past the terminal width and wrap the row.
  const uni = formatCompactionStatus({ state: "complete", timestamp: "2026-09-18T18:01:31.059Z" }, true);
  const ascii = formatCompactionStatus({ state: "complete", timestamp: "2026-09-18T18:01:31.059Z" }, false);
  assert.equal(ascii, "+ 18:01:31");
  assert.equal(stringWidth(ascii), stringWidth(uni));
  assert.equal(
    stringWidth(formatCompactionStatus({ state: "failed", timestamp: "2026-09-18T09:05:00.000Z" }, false)),
    stringWidth(formatCompactionStatus({ state: "failed", timestamp: "2026-09-18T09:05:00.000Z" }, true))
  );
});

// ── context gauge glyph fallback ────────────────────────────────────────────

test("renderGauge produces the same width with and without block glyphs", () => {
  // `█`/`░` are U+2588/U+2591. On a terminal without block coverage they
  // become `?` at an unpredictable width, which desynchronizes this fixed
  // one-row bar — so the ASCII form must be exactly as wide.
  for (const ratio of [0, 0.13, 0.5, 0.87, 1, 1.4]) {
    assert.equal(stringWidth(renderGauge(ratio, true)), stringWidth(renderGauge(ratio, false)));
    assert.equal(stringWidth(renderGauge(ratio, false)), 12);
  }
});

test("renderGauge clamps out-of-range ratios instead of overflowing", () => {
  assert.equal(renderGauge(-1, false), renderGauge(0, false));
  assert.equal(renderGauge(5, false), renderGauge(1, false));
});

// ── scroll indicator ────────────────────────────────────────────────────────

test("the scroll slot is hidden on terminals too narrow to show it", () => {
  assert.equal(hasRoomForScrollSlot(40), false);
  assert.equal(hasRoomForScrollSlot(71), false);
  assert.equal(hasRoomForScrollSlot(72), true);
});

test("formatScrollIndicator is blank when pinned to the bottom", () => {
  // Blank-when-idle is deliberate: the slot is already width-budgeted, so
  // nothing reflows when the user starts or stops scrolling.
  assert.equal(formatScrollIndicator({ offset: 0, max: 40 }, "▲", true), "");
  assert.equal(formatScrollIndicator(null, "▲", true), "");
});

test("formatScrollIndicator shows rows-back / rows-available, padded to the reserved width", () => {
  const text = formatScrollIndicator({ offset: 12, max: 48 }, "▲", true);
  assert.equal(text.trim(), "▲ 12/48");
  assert.equal(stringWidth(text), SCROLL_INDICATOR_WIDTH);
});

test("formatScrollIndicator uses an ASCII caret when Unicode is unavailable", () => {
  const text = formatScrollIndicator({ offset: 3, max: 9 }, "^", false);
  assert.equal(text.trim(), "^ 3/9");
  assert.equal(stringWidth(text), SCROLL_INDICATOR_WIDTH);
});

test("formatScrollIndicator goes blank rather than overflow its reserved slot", () => {
  // A 5-digit offset would otherwise wrap the whole status bar.
  const text = formatScrollIndicator({ offset: 123456, max: 987654 }, "^", false);
  assert.equal(text, "");
  assert.ok(stringWidth(formatScrollIndicator({ offset: 99, max: 100 }, "^", false)) <= SCROLL_INDICATOR_WIDTH);
});

// Requested directly: show plan/todo progress persistently in the status
// bar, not just scrolling by once in the log. The bar's row must never
// wrap regardless of how many steps a plan has — these cover the
// fixed-width formatting that guarantees that.
test("formatPlanProgress returns \"\" when there's no active plan", () => {
  assert.equal(formatPlanProgress(null), "");
});

test("formatPlanProgress formats a normal in-progress plan as \"done/total\"", () => {
  assert.equal(formatPlanProgress({ done: 3, total: 7 }), "3/7");
});

test("formatPlanProgress falls back to blank instead of overflowing the reserved slot for a pathologically large plan", () => {
  // "1000/2000" is 9 characters, wider than the 7-char slot the layout
  // reserves for it — must not silently overflow and break the row.
  assert.equal(formatPlanProgress({ done: 1000, total: 2000 }), "");
});

test("statusBarFieldWidth has a sane floor even on a very narrow terminal", () => {
  assert.ok(statusBarFieldWidth(20) >= 8);
});

test("a long cwd/model combination truncates to fit within the budgeted field width", () => {
  const columns = 120;
  const fieldWidth = statusBarFieldWidth(columns);
  const longCwd = "/home/jeano/some/very/deeply/nested/project/directory/that/keeps/going/and/going";
  const longModel = "/media/jeano/nvme-usb/models/Ornith-1.5-35B-Q4_K_M.gguf";

  const truncatedCwd = tailToWidth(longCwd, fieldWidth);
  const truncatedModel = tailToWidth(longModel, fieldWidth);

  assert.ok(stringWidth(truncatedCwd) <= fieldWidth);
  assert.ok(stringWidth(truncatedModel) <= fieldWidth);
  // the most useful part (the tail) survives truncation
  assert.ok(truncatedModel.endsWith("Ornith-1.5-35B-Q4_K_M.gguf") || truncatedModel === longModel);
});
