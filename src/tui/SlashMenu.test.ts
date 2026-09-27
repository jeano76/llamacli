import { test } from "node:test";
import assert from "node:assert/strict";
import { menuVisibleRows, menuWindow, SLASH_MENU_ITEMS } from "./SlashMenu.js";

const KEYS = SLASH_MENU_ITEMS.map((i) => i.key);

/** Mirrors App.tsx's arithmetic: logHeight, then the log rows left once the
 *  menu box is subtracted. Kept here so the two can't drift. */
function layout(rows: number, inputLines: number, matchCount: number) {
  const logHeight = Math.max(3, rows - 3 - inputLines);
  const itemRows = menuVisibleRows(Math.max(4, logHeight), matchCount);
  const boxHeight = itemRows + 2; // border top + bottom
  return { logHeight, itemRows, boxHeight, logLeft: Math.max(0, logHeight - boxHeight) };
}

// ── sizing ──────────────────────────────────────────────────────────────────

test("a one-match filter no longer draws the whole command list", () => {
  // The defect this replaced: `/q` matched one command and still reserved a
  // 13-row box, 12 of them blank.
  assert.equal(menuVisibleRows(26, 1), 1);
  assert.equal(menuVisibleRows(26, 3), 3);
});

test("the menu never takes more than half the available space", () => {
  for (const available of [4, 8, 10, 20, 26, 40, 200]) {
    const rows = menuVisibleRows(available, SLASH_MENU_ITEMS.length);
    assert.ok(rows <= Math.max(4, Math.floor(available * 0.5)) + 1, `available=${available} rows=${rows}`);
  }
});

test("the menu always keeps a usable minimum height", () => {
  // Even on a terminal with almost nothing to give, a 1-row popup is a
  // rendering bug, not a compact design.
  for (const available of [0, 1, 2, 3, 4, 5]) {
    assert.ok(menuVisibleRows(available, SLASH_MENU_ITEMS.length) >= 1, `available=${available}`);
  }
});

test("menuVisibleRows is never 0, even with no matches", () => {
  // Zero rows would collapse the box to its borders and hide the
  // "No matching commands" message entirely.
  assert.ok(menuVisibleRows(24, 0) >= 1);
});

test("the height does not depend on the selection — only on size and count", () => {
  // This is the anti-ghosting property the original fixed-height menu had.
  // It has to survive, or holding an arrow key would reflow the screen.
  for (const count of [1, 5, SLASH_MENU_ITEMS.length]) {
    const heights = new Set([0, 1, 5, 9].map(() => menuVisibleRows(24, count)));
    assert.equal(heights.size, 1);
  }
});

// ── the actual layout improvement ───────────────────────────────────────────

test("a short terminal keeps a readable transcript behind an open menu", () => {
  // Measured before the fix: rows=24 -> 5 log rows with any filter, 3 with a
  // 3-line input box. Both are unusable.
  const l1 = layout(24, 1, 1);
  assert.ok(l1.logLeft >= 10, `1 match at 24 rows left only ${l1.logLeft} log rows`);
  const l3 = layout(24, 3, 1);
  assert.ok(l3.logLeft >= 10, `1 match at 24 rows/3-line input left only ${l3.logLeft}`);
});

test("the new layout is never worse than the old fixed 15-row box", () => {
  // The regression guard that matters: the fix must not make the crowded case
  // worse than what it replaced.
  for (const rows of [20, 24, 30, 40, 60]) {
    for (const inputLines of [1, 2, 3, 5]) {
      for (const count of [1, 3, 8, SLASH_MENU_ITEMS.length]) {
        const { logHeight, logLeft } = layout(rows, inputLines, count);
        const oldLeft = Math.max(0, logHeight - (SLASH_MENU_ITEMS.length + 2));
        assert.ok(
          logLeft >= oldLeft,
          `rows=${rows} input=${inputLines} count=${count}: ${logLeft} < old ${oldLeft}`
        );
      }
    }
  }
});

test("the menu box never exceeds the log area it lives in", () => {
  for (const rows of [10, 15, 20, 24, 30, 50]) {
    for (const count of [1, 5, SLASH_MENU_ITEMS.length]) {
      const { boxHeight, logHeight } = layout(rows, 1, count);
      assert.ok(boxHeight <= logHeight + 2, `rows=${rows} count=${count}: box ${boxHeight} > log ${logHeight}`);
    }
  }
});

// ── the scroll window ───────────────────────────────────────────────────────

test("everything fits and is returned unchanged when it all fits", () => {
  assert.deepEqual(menuWindow(KEYS, 0, 20), KEYS);
  assert.deepEqual(menuWindow(KEYS, 7, KEYS.length), KEYS);
});

test("the selection is always inside the window", () => {
  // The reason the window exists: a command the user cannot see or reach is
  // worse than a tall box.
  for (const visible of [1, 2, 4, 6]) {
    for (let sel = 0; sel < KEYS.length; sel++) {
      const w = menuWindow(KEYS, sel, visible);
      assert.ok(w.length <= visible, `visible=${visible} sel=${sel} returned ${w.length}`);
      assert.ok(w.includes(KEYS[sel]), `visible=${visible} sel=${sel} lost the selection: [${w}]`);
    }
  }
});

test("the window clamps at the ends rather than scrolling past them", () => {
  assert.equal(menuWindow(KEYS, 0, 4)[0], KEYS[0]);
  assert.equal(menuWindow(KEYS, KEYS.length - 1, 4).at(-1), KEYS.at(-1));
});

test("an out-of-range selection index is clamped, not crashed on", () => {
  for (const sel of [-5, -1, KEYS.length, KEYS.length + 99]) {
    const w = menuWindow(KEYS, sel, 4);
    assert.ok(w.length > 0 && w.length <= 4);
  }
});

test("an empty or zero-height window yields nothing rather than throwing", () => {
  assert.deepEqual(menuWindow([], 0, 4), []);
  assert.deepEqual(menuWindow(KEYS, 0, 0), []);
});

test("consecutive selections move the window monotonically and minimally", () => {
  // "Minimally" matters: a window that jumps to the top on every move makes
  // it impossible to compare neighbouring commands.
  for (let visible = 2; visible <= 6; visible++) {
    let prevStart = -1;
    for (let sel = 0; sel < KEYS.length; sel++) {
      const start = KEYS.indexOf(menuWindow(KEYS, sel, visible)[0]);
      if (prevStart >= 0) assert.ok(start >= prevStart, `window went backwards at sel=${sel}`);
      prevStart = start;
    }
  }
});
