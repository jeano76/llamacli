import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  KEY_BINDINGS,
  formatKeyRow,
  startupHintText,
  KEY_COLUMN_WIDTH,
  type KeyBinding,
} from "./keybindings.js";
import { SLASH_MENU_ITEMS } from "./SlashMenu.js";

const allBindings = KEY_BINDINGS.flatMap((g) => g.bindings);

// ── the data itself ─────────────────────────────────────────────────────────

test("every key binding has a key spec and a non-empty description", () => {
  for (const group of KEY_BINDINGS) {
    assert.ok(group.title.length > 0, "group needs a title");
    assert.ok(group.bindings.length > 0, `${group.title} has no bindings`);
    for (const b of group.bindings) {
      assert.ok(b.keys.trim().length > 0, `${group.title}: empty keys`);
      assert.ok(b.description.trim().length > 0, `${b.keys}: empty description`);
    }
  }
});

test("the groups are non-empty and there is more than one", () => {
  assert.ok(KEY_BINDINGS.length >= 3);
  assert.ok(allBindings.length >= 20, `expected a real reference, got ${allBindings.length}`);
});

test("no key binding is listed twice within a group", () => {
  for (const group of KEY_BINDINGS) {
    const keys = group.bindings.map((b) => b.keys);
    assert.equal(new Set(keys).size, keys.length, `duplicate in "${group.title}"`);
  }
});

// ── rendering ───────────────────────────────────────────────────────────────

test("formatKeyRow pads the key column so descriptions line up", () => {
  const row = formatKeyRow({ keys: "Esc", description: "종료" });
  assert.equal(row, `Esc${" ".repeat(KEY_COLUMN_WIDTH - 3)}  종료`);
  // The description must start at the same column regardless of key length.
  const a = formatKeyRow({ keys: "Esc", description: "X" });
  const b = formatKeyRow({ keys: "PageUp / PageDown", description: "X" });
  assert.equal(stringWidth(a.slice(0, a.indexOf("X"))), stringWidth(b.slice(0, b.indexOf("X"))));
});

test("formatKeyRow handles a key spec wider than the column without corrupting the text", () => {
  const long: KeyBinding = { keys: "X".repeat(KEY_COLUMN_WIDTH + 10), description: "D" };
  const row = formatKeyRow(long);
  // No negative pad, and the description is still present and reachable.
  assert.ok(row.includes("D"));
  assert.ok(!row.includes("undefined"));
  assert.ok(stringWidth(row) >= KEY_COLUMN_WIDTH + 12);
});

test("formatKeyRow measures CJK key specs by display width, not code units", () => {
  // A 2-column key spec must consume 2 columns of padding budget, not 1.
  const row = formatKeyRow({ keys: "한글", description: "D" });
  assert.equal(stringWidth(row.slice(0, row.indexOf("D"))), KEY_COLUMN_WIDTH + 2);
});

// ── startup hint ────────────────────────────────────────────────────────────

test("the startup hint never exceeds the terminal width", () => {
  for (const columns of [20, 40, 60, 80, 120, 200]) {
    const hint = startupHintText(columns);
    assert.ok(stringWidth(hint) <= columns, `columns=${columns}, width=${stringWidth(hint)}`);
  }
});

test("the startup hint always points at /help", () => {
  // The one thing that must survive every width: how to find out what else
  // exists. Without it the keybinding table is undiscoverable again.
  for (const columns of [20, 40, 80, 200]) {
    assert.ok(startupHintText(columns).includes("/help"), `columns=${columns}`);
  }
});

test("the startup hint gets more informative as the terminal gets wider", () => {
  assert.ok(stringWidth(startupHintText(200)) > stringWidth(startupHintText(40)));
});

test("the startup hint degrades rather than overflowing on an absurdly narrow terminal", () => {
  // Must always fit, even below the width of its own shortest form — the
  // old `?? lastForm` fallback returned a 9-column string for an 8-column
  // terminal, which is the layout-shifting bug the form selection avoids.
  for (const columns of [1, 4, 6, 8, 9, 10]) {
    const hint = startupHintText(columns);
    assert.ok(stringWidth(hint) <= columns, `columns=${columns}, hint="${hint}"`);
  }
  // And where "/help" genuinely fits, it must be there.
  assert.ok(startupHintText(6).includes("/help"));
  // Below even that, silence beats overflowing.
  assert.equal(startupHintText(3), "");
});

// ── consistency with the actual command list ────────────────────────────────

test("every command mentioned in the keybinding table exists in the slash menu", () => {
  // A binding that advertises "/compact" while the command is actually
  // "/compactx" is worse than no binding. Cheap guard against the two lists
  // drifting apart as commands are added. Hyphens are part of a menu key
  // ("/improve-apply", "/plan-clear"), so the pattern has to allow them.
  const menuKeys = new Set(SLASH_MENU_ITEMS.map((i) => i.key));
  const referenced = new Set<string>();
  for (const b of allBindings) {
    for (const m of b.keys.matchAll(/\/([a-z][a-z-]*)/g)) referenced.add(m[1]);
  }
  assert.ok(referenced.size > 0, "no commands referenced at all — the pattern is wrong, not the data");
  for (const ref of referenced) {
    assert.ok(menuKeys.has(ref), `keybindings mention /${ref}, which is not in SLASH_MENU_ITEMS`);
  }
});

test("the slash menu keys that are pure aliases still dispatch somewhere", () => {
  // /help and /keys are intentionally the same content; assert they're both
  // present so removing one is a deliberate act rather than an accident.
  const keys = new Set(SLASH_MENU_ITEMS.map((i) => i.key));
  assert.ok(keys.has("help"));
  assert.ok(keys.has("keys"));
  assert.ok(keys.has("term"));
  assert.ok(keys.has("mouse"));
});

test("every slash menu label is exactly what gets dispatched, so typing it works", () => {
  // Found by the "commands referenced in the table" test above, and the bug
  // class is worth its own guard: SLASH_MENU_ITEMS has separate `key` (what
  // index.tsx switches on) and `label` (what the menu shows). When they
  // disagree, the user types the advertised text, the filter matches nothing,
  // and the menu that advertised it answers "No matching commands". The
  // filter is a prefix match on the input against `label`, so any space or
  // shorthand in a label makes it un-typeable.
  for (const item of SLASH_MENU_ITEMS) {
    assert.equal(
      item.label,
      `/${item.key}`,
      `"${item.label}" advertises a different command than the "${item.key}" it dispatches`
    );
  }
});

test("slash menu labels are wide enough that descriptions all start at one column", () => {
  const labelWidth = Math.max(...SLASH_MENU_ITEMS.map((i) => stringWidth(i.label)));
  for (const item of SLASH_MENU_ITEMS) {
    // The component pads to a fixed 15; anything wider would break alignment
    // and overflow the menu's reserved width.
    assert.ok(stringWidth(item.label) <= 15, `${item.label} is wider than the 15-column pad`);
  }
  assert.ok(labelWidth <= 15);
});
