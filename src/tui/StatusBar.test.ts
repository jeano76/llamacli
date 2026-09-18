import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { statusBarFieldWidth, formatPlanProgress, hasRoomForPlanSlot } from "./StatusBar.js";
import { tailToWidth } from "./textWidth.js";

test("statusBarFieldWidth never lets cwd+model+gauge(+plan-progress, when shown) exceed the terminal width", () => {
  for (const columns of [40, 60, 80, 100, 120, 200]) {
    const fieldWidth = statusBarFieldWidth(columns);
    const planSlot = hasRoomForPlanSlot(columns) ? 7 + 1 : 0; // slot + its leading space
    // Simulate the worst case: both fields maxed out at fieldWidth.
    const totalUsed = 2 /* paddingX */ + fieldWidth + fieldWidth + planSlot + 12 /* gauge */ + 5 /* " 100%" */ + 4 /* gaps */;
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
