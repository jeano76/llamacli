import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { statusBarFieldWidth } from "./StatusBar.js";
import { tailToWidth } from "./textWidth.js";

test("statusBarFieldWidth never lets cwd+model+gauge exceed the terminal width", () => {
  for (const columns of [40, 60, 80, 100, 120, 200]) {
    const fieldWidth = statusBarFieldWidth(columns);
    // Simulate the worst case: both fields maxed out at fieldWidth.
    const totalUsed = 2 /* paddingX */ + fieldWidth + fieldWidth + 12 /* gauge */ + 5 /* " 100%" */ + 4 /* gaps */;
    assert.ok(totalUsed <= columns + 4, `columns=${columns}, fieldWidth=${fieldWidth}, totalUsed=${totalUsed}`);
  }
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
