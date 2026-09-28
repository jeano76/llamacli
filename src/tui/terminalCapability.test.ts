import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTerminal, buildSequences } from "./terminal.js";
import { menuVisibleRows } from "./SlashMenu.js";
import { SLASH_MENU_ITEMS } from "./SlashMenu.js";

// Ground-truth capability tables. Every entry pairs an environment with what
// that terminal genuinely does, so a wrong detection is detectable rather than
// merely different from expectation.
//
// Source: a sweep of 12 terminal configurations. The two bugs below were both
// invisible on a modern xterm — the dev box, and the only terminal most people
// test on.

const caps = (env: Record<string, string>, platform: NodeJS.Platform = "linux") =>
  detectTerminal(env, { stdoutIsTTY: true, stdinIsTTY: true, platform });
const TTY = { stdoutIsTTY: true, stdinIsTTY: true };

// ── monochrome terminals must not be sent colour ────────────────────────────

test("a monochrome TERM is reported as having no colour", () => {
  // vt100 predates SGR colour entirely. The detection fell through to the
  // 16-colour default, so the app emitted `95m` and `48;2;0;0;0m` into a
  // terminal that renders them as stray characters — the exact "guess up and
  // print garbage" failure the fallback comment warns about, just in the
  // opposite direction from the one it anticipated.
  for (const term of ["vt100", "vt220", "vt320", "vt420", "sun", "wy50"]) {
    const c = caps({ TERM: term });
    assert.equal(c.colorDepth, 0, `TERM=${term} has no colour support, reported depth ${c.colorDepth}`);
    const seq = buildSequences(c);
    assert.equal(seq.backgroundOn, "", `TERM=${term} must not be sent a background sequence`);
    assert.equal(seq.backgroundOff, "", `TERM=${term} must not be sent a background reset`);
  }
});

test("a terminal that does support colour is still detected as such", () => {
  // The fix must not have over-corrected into "unknown TERM means no colour".
  assert.equal(caps({ TERM: "xterm-256color" }).colorDepth, 8);
  assert.equal(caps({ TERM: "xterm", COLORTERM: "truecolor" }).colorDepth, 24);
  assert.equal(caps({ TERM: "alacritty" }).colorDepth, 8);
  assert.equal(caps({ TERM: "linux" }).colorDepth, 4);
  // An unrecognised TERM still falls back to the safe 16-colour default.
  assert.equal(caps({ TERM: "some-terminal-nobody-has-heard-of" }).colorDepth, 4);
  // And NO_COLOR still wins over everything.
  assert.equal(caps({ TERM: "xterm-256color", NO_COLOR: "1" }).colorDepth, 0);
});

// ── the alternate screen is not the same capability as ANSI ─────────────────

test("a terminal without an alternate screen buffer is not told to use one", () => {
  // `altScreen` was derived from `ansi`, which is true for both of these, so
  // the app emitted `?1049h` into terminals that either predate the feature or
  // have it disabled.
  for (const term of ["vt100", "vt220", "dumb", "emacs"]) {
    assert.equal(caps({ TERM: term }).altScreen, false, `TERM=${term} has no alternate screen, reported true`);
  }
  // tmux and GNU screen disable alternate-screen BY DEFAULT — that is the
  // whole point of the option, since switching buffers destroys scrollback.
  // The inner TERM is still `*-256color`, so nothing else would catch it.
  for (const term of ["screen", "screen-256color", "tmux", "tmux-256color"]) {
    assert.equal(caps({ TERM: term }).altScreen, false, `TERM=${term} has alternate-screen off by default, reported true`);
  }
});

test("a terminal that does have an alternate screen still gets it", () => {
  for (const term of ["xterm-256color", "xterm", "alacritty", "kitty", "wezterm", "foot"]) {
    assert.equal(caps({ TERM: term }).altScreen, true, `TERM=${term} does support the alternate screen`);
  }
  // The user who knows their multiplexer is configured can say so.
  assert.equal(caps({ TERM: "tmux-256color", LLAMACLI_ALT_SCREEN: "1" }).altScreen, true, "explicit opt-in was ignored");
  assert.equal(caps({ TERM: "xterm-256color", LLAMACLI_ALT_SCREEN: "0" }).altScreen, false, "explicit opt-out was ignored");
});

test("no alt screen means no alt-screen sequences are emitted", () => {
  // The consequence of the flag, not the flag itself: what actually reaches
  // the terminal is what matters.
  for (const term of ["vt100", "tmux-256color", "screen"]) {
    const seq = buildSequences(caps({ TERM: term }));
    assert.equal(seq.altScreenOn, "", `TERM=${term}: emitted ${JSON.stringify(seq.altScreenOn)}`);
    assert.equal(seq.altScreenOff, "", `TERM=${term}: emitted ${JSON.stringify(seq.altScreenOff)}`);
  }
  // And a terminal that does support it still gets the real sequence.
  assert.equal(buildSequences(caps({ TERM: "xterm-256color" })).altScreenOn.includes("?1049h"), true);
});

// ── a background must never outlive the process ────────────────────────────

test("a background is never set without a way to clear it", () => {
  // The failure this prevents: a black shell for the rest of the session
  // after the app exits. `backgroundOff` is not optional whenever
  // `backgroundOn` fires.
  const envs: Record<string, string>[] = [
    { TERM: "xterm-256color" },
    { TERM: "xterm-256color", COLORTERM: "truecolor" },
    { TERM: "linux" },
  ];
  for (const env of envs) {
    const c = caps(env);
    const seq = buildSequences(c);
    if (seq.backgroundOn !== "") {
      assert.notEqual(seq.backgroundOff, "", `background taken (${JSON.stringify(seq.backgroundOn)}) with no way to clear it`);
    }
  }
});

test("NO_COLOR and monochrome terminals take no background at all", () => {
  const envs: Record<string, string>[] = [
    { TERM: "xterm-256color", NO_COLOR: "1" },
    { TERM: "vt100" },
    { TERM: "dumb" },
  ];
  for (const env of envs) {
    const seq = buildSequences(caps(env));
    assert.equal(seq.backgroundOn, "", `${JSON.stringify(env)}: took a background it cannot honour`);
    assert.equal(seq.backgroundOff, "", `${JSON.stringify(env)}: cleared a background it never set`);
  }
});

test("the truecolor background is the set-then-default pair", () => {
  // 48;2;r;g;b alone is a one-shot set that an Ink repaint overwrites; the
  // trailing 49 promotes it to the DEFAULT so it survives. Omitting the
  // trailing `m` produced a truncated `\x1b[49` that terminals silently fail
  // to parse — caught on a real pty, not by reading the code.
  const seq = buildSequences(caps({ TERM: "xterm-256color", COLORTERM: "truecolor" }));
  assert.equal(seq.backgroundOn, "\x1b[48;2;0;0;0m\x1b[49m");
  // A 16/256-colour terminal must not be sent the 48;2 form at all.
  const low = buildSequences(caps({ TERM: "xterm-256color" }));
  assert.ok(!low.backgroundOn.includes("48;2;"), `256-colour terminal was sent ${JSON.stringify(low.backgroundOn)}`);
  assert.equal(low.backgroundOn, "\x1b[40m\x1b[49m");
});

// ── the popup must never be taller than the thing it overlays ──────────────

test("the slash menu never renders taller than its container", () => {
  // `Math.max(MIN_ROWS, ...)` made the floor unconditional, so on a 20x10
  // terminal the log area is 5 rows, the floor produced 4 items, and the box
  // needed 6 — drawn larger than the overlay, clipping its own bottom border.
  // Found by the terminal simulation sweep at 20x10.
  //
  // The contract is against `availableRows`, the number App actually passes
  // (App.tsx:1984 — `Math.max(4, rows - 3 - inputLines)`), NOT against the
  // log height. On a terminal so short that the log is 3 rows, App still
  // offers 4, and a 2-row box is legitimate there; asserting against the log
  // height instead would have failed a correct implementation.
  for (const [cols, rows] of [[20, 10], [24, 8], [40, 16], [60, 20], [80, 24], [120, 40], [200, 50]] as const) {
    const inputLines = cols < 60 ? 2 : 1;
    const available = Math.max(4, rows - 3 - inputLines);
    for (const matchCount of [1, 2, 3, 7, SLASH_MENU_ITEMS.length]) {
      const itemRows = menuVisibleRows(available, matchCount);
      assert.ok(itemRows + 2 <= available, `${cols}x${rows}: a ${matchCount}-item menu drew a ${itemRows + 2}-row box over ${available} available rows`);
      assert.ok(itemRows >= 1, `${cols}x${rows}: menu showed ${itemRows} rows`);
      assert.ok(itemRows <= matchCount, `${cols}x${rows}: reserved ${itemRows} rows for ${matchCount} matches`);
    }
  }
  // And specifically the case that was broken: 20x10 gives 5 available rows,
  // so the box must be at most 5 — the old floor produced 6.
  assert.ok(menuVisibleRows(5, SLASH_MENU_ITEMS.length) + 2 <= 5, "a 20x10 terminal still overflows its overlay");
});

test("a roomy terminal still leaves a readable transcript", () => {
  // The clamp must not have taken a useful box away on a normal terminal.
  for (const [cols, rows] of [[40, 16], [60, 20], [80, 24], [120, 40], [200, 50]] as const) {
    const inputLines = cols < 60 ? 2 : 1;
    const logHeight = Math.max(3, rows - 3 - inputLines);
    const itemRows = menuVisibleRows(Math.max(4, logHeight), SLASH_MENU_ITEMS.length);
    assert.ok(logHeight - (itemRows + 2) >= 3, `${cols}x${rows}: menu left only ${logHeight - itemRows - 2} log rows`);
  }
  // A single match is one row everywhere — the anti-ghosting property the
  // fixed-height design used to give up.
  for (const available of [4, 5, 8, 11, 20, 36]) {
    assert.equal(menuVisibleRows(available, 1), 1, `a 1-match filter reserved ${menuVisibleRows(available, 1)} rows at ${available}`);
  }
});
