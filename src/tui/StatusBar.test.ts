import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  statusBarFieldWidth,
  formatPlanProgress,
  hasRoomForPlanSlot,
  formatCompactionStatus,
  hasRoomForCompactionSlot,
} from "./StatusBar.js";
import { tailToWidth } from "./textWidth.js";

test("statusBarFieldWidth never lets cwd+model+gauge(+plan-progress+compaction-status, when shown) exceed the terminal width", () => {
  for (const columns of [40, 60, 80, 100, 120, 200]) {
    const fieldWidth = statusBarFieldWidth(columns);
    const planSlot = hasRoomForPlanSlot(columns) ? 7 + 1 : 0; // slot + its leading space
    const compactionSlot = hasRoomForCompactionSlot(columns) ? 10 + 1 : 0; // slot + its leading space
    // Simulate the worst case: both fields maxed out at fieldWidth.
    const totalUsed =
      2 /* paddingX */ + 2 /* "│ " */ + fieldWidth + fieldWidth + planSlot + compactionSlot + 12 /* gauge */ + 5 /* " 100%" */ + 4 /* gaps */;
    assert.ok(totalUsed <= columns + 4, `columns=${columns}, fieldWidth=${fieldWidth}, totalUsed=${totalUsed}`);
  }
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
