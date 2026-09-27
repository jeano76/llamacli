import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTerminal,
  buildSequences,
  paint,
  glyph,
  stripAnsi,
  withMouse,
  type TerminalCapabilities,
} from "./terminal.js";

const TTY = { stdoutIsTTY: true, stdinIsTTY: true, platform: "linux" as NodeJS.Platform };

// ── ansi gating ─────────────────────────────────────────────────────────────

test("a plain TTY on Linux is ANSI-capable", () => {
  const caps = detectTerminal({ TERM: "xterm-256color" }, TTY);
  assert.equal(caps.ansi, true);
});

test("piped/redirected output is never ANSI-capable, in either direction", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, { ...TTY, stdoutIsTTY: false }).ansi, false);
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, { ...TTY, stdinIsTTY: false }).ansi, false);
});

test("TERM=dumb is never ANSI-capable", () => {
  assert.equal(detectTerminal({ TERM: "dumb" }, TTY).ansi, false);
});

test("win32 with no recognized terminal marker is not ANSI-capable", () => {
  assert.equal(detectTerminal({}, { ...TTY, platform: "win32" }).ansi, false);
});

test("win32 + WT_SESSION (Windows Terminal) is ANSI-capable", () => {
  const caps = detectTerminal({ WT_SESSION: "abc" }, { ...TTY, platform: "win32" });
  assert.equal(caps.ansi, true);
  assert.equal(caps.terminal, "Windows Terminal");
});

test("win32 + ConEmuANSI=ON is ANSI-capable, but ConEmuANSI=OFF is NOT", () => {
  // The reported breakage was literal escape bytes in a Windows console.
  // ConEmu sets ConEmuANSI=OFF when its own ANSI mode is disabled, and
  // treating mere presence as a positive signal would enable ANSI in exactly
  // the case it must be off.
  assert.equal(detectTerminal({ ConEmuANSI: "ON" }, { ...TTY, platform: "win32" }).ansi, true);
  assert.equal(detectTerminal({ ConEmuANSI: "OFF" }, { ...TTY, platform: "win32" }).ansi, false);
});

test("LLAMACLI_NO_ANSI=1 and NO_COLOR win over every other signal", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color", LLAMACLI_NO_ANSI: "1" }, TTY).ansi, false);
  assert.equal(detectTerminal({ TERM: "xterm-256color", NO_COLOR: "" }, TTY).colorDepth, 0);
});

test("LLAMACLI_FORCE_ANSI=1 forces ANSI on even without a TTY", () => {
  const caps = detectTerminal(
    { LLAMACLI_FORCE_ANSI: "1" },
    { stdoutIsTTY: false, stdinIsTTY: false, platform: "win32" }
  );
  assert.equal(caps.ansi, true);
});

test("the detection reason explains the verdict, for /diagnostics", () => {
  assert.match(detectTerminal({ TERM: "dumb" }, TTY).reason, /TERM=dumb/);
  assert.match(detectTerminal({ TERM: "xterm" }, { ...TTY, stdoutIsTTY: false }).reason, /not a TTY/);
  assert.match(detectTerminal({ TERM: "xterm-256color" }, TTY).reason, /ok/);
});

// ── color depth ─────────────────────────────────────────────────────────────

test("color depth follows COLORTERM / TERM / known emulators", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, TTY).colorDepth, 8);
  assert.equal(detectTerminal({ TERM: "xterm-256color", COLORTERM: "truecolor" }, TTY).colorDepth, 24);
  assert.equal(detectTerminal({ TERM: "xterm-256color", COLORTERM: "24bit" }, TTY).colorDepth, 24);
  assert.equal(detectTerminal({ TERM: "xterm" }, TTY).colorDepth, 4);
  assert.equal(detectTerminal({ TERM: "xterm-direct" }, TTY).colorDepth, 24);
  assert.equal(detectTerminal({ TERM: "alacritty" }, TTY).colorDepth, 8);
});

test("a multiplexer whose TERM carries 256color is trusted for depth", () => {
  assert.equal(detectTerminal({ TERM: "screen-256color" }, TTY).colorDepth, 8);
  assert.equal(detectTerminal({ TERM: "screen" }, TTY).colorDepth, 4);
  assert.equal(detectTerminal({ TERM: "screen" }, TTY).inMultiplexer, true);
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, TTY).inMultiplexer, false);
});

test("no-color depth when ANSI is off entirely", () => {
  assert.equal(detectTerminal({ TERM: "dumb" }, TTY).colorDepth, 0);
});

test("LLAMACLI_COLOR_DEPTH overrides, accepting both naming conventions", () => {
  const d = (v: string) => detectTerminal({ TERM: "xterm", LLAMACLI_COLOR_DEPTH: v }, TTY).colorDepth;
  assert.equal(d("0"), 0);
  assert.equal(d("4"), 4);
  assert.equal(d("16"), 4);
  assert.equal(d("8"), 8);
  assert.equal(d("256"), 8);
  assert.equal(d("24"), 24);
  // Garbage must not produce NaN and poison later comparisons.
  assert.equal(d("banana"), 4);
});

// ── unicode ─────────────────────────────────────────────────────────────────

test("an explicit UTF-8 locale allows non-ASCII glyphs", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color", LANG: "ko_KR.UTF-8" }, TTY).unicode, true);
  assert.equal(detectTerminal({ TERM: "xterm-256color", LC_ALL: "C.UTF-8" }, TTY).unicode, true);
});

test("an explicit non-UTF-8 locale forces ASCII-only glyphs", () => {
  // This is the case that used to desynchronize the whole layout: Braille
  // block/gauge glyphs render as `?` or at a different width, so Ink's
  // width math and the terminal's disagree.
  assert.equal(detectTerminal({ TERM: "xterm-256color", LANG: "C" }, TTY).unicode, false);
  assert.equal(detectTerminal({ TERM: "xterm-256color", LC_ALL: "POSIX" }, TTY).unicode, false);
  assert.equal(detectTerminal({ TERM: "xterm-256color", LANG: "ko_KR.euc-kr" }, TTY).unicode, false);
});

test("with no locale set, Unicode is assumed off Windows but on elsewhere", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, TTY).unicode, true);
  assert.equal(detectTerminal({ WT_SESSION: "a" }, { ...TTY, platform: "win32" }).unicode, true);
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, { ...TTY, platform: "win32" }).unicode, false);
});

test("LLAMACLI_ASCII=1 forces ASCII glyphs, and disables unicode even on win32+WT", () => {
  const caps = detectTerminal({ WT_SESSION: "a", LLAMACLI_ASCII: "1" }, { ...TTY, platform: "win32" });
  assert.equal(caps.unicode, false);
});

// ── mouse ───────────────────────────────────────────────────────────────────

test("mouse is OFF by default even on a fully capable terminal", () => {
  // Always-on mouse reporting is what forced Shift-drag for text selection on
  // every terminal, for a feature the app can now also drive from the keyboard.
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, TTY).mouse, false);
});

test("LLAMACLI_MOUSE=1 turns it on where SGR is available", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color", LLAMACLI_MOUSE: "1" }, TTY).mouse, true);
  assert.equal(detectTerminal({ TERM: "xterm-256color", LLAMACLI_MOUSE: "0" }, TTY).mouse, false);
});

test("mouse can never be enabled where the SGR encoding is unavailable", () => {
  // Legacy X10 mouse reports cannot be parsed by this app at all, so enabling
  // mouse there means the wheel is silently dead forever.
  for (const term of ["rxvt-unicode-256color", "linux", "vt100", "dumb"]) {
    const caps = detectTerminal({ TERM: term, LLAMACLI_MOUSE: "1" }, TTY);
    assert.equal(caps.mouseSgr, false, `${term} should not report SGR mouse support`);
    assert.equal(caps.mouse, false, `${term} must not enable mouse`);
  }
});

test("a multiplexer without a 256color inner TERM is not trusted for SGR mouse", () => {
  assert.equal(detectTerminal({ TERM: "screen" }, TTY).mouseSgr, false);
  assert.equal(detectTerminal({ TERM: "screen-256color" }, TTY).mouseSgr, true);
  assert.equal(detectTerminal({ TERM: "tmux-256color" }, TTY).mouseSgr, true);
});

test("withMouse flips mouse while preserving every other detection", () => {
  const caps = detectTerminal({ TERM: "xterm-256color", LANG: "ko_KR.UTF-8" }, TTY);
  const on = withMouse(caps, true);
  assert.equal(on.mouse, true);
  assert.equal(on.colorDepth, caps.colorDepth);
  assert.equal(on.unicode, true);
  // …and can be turned off again at runtime (/mouse), no re-exec needed.
  assert.equal(withMouse(on, false).mouse, false);
});

test("withMouse cannot force mouse on for a terminal that cannot do SGR", () => {
  const caps = detectTerminal({ TERM: "rxvt" }, TTY);
  assert.equal(withMouse(caps, true).mouse, false);
});

test("detectTerminal without opts reads the real process environment", () => {
  // Sanity check that the default-args path (used by getCapabilities) is
  // wired to the same code as the explicit path, not a stub.
  const caps = detectTerminal();
  assert.equal(caps.ansi, !!(process.stdout.isTTY && process.stdin.isTTY));
  assert.equal(typeof caps.colorDepth, "number");
  assert.equal(caps.reason.length > 0, true);
});

// ── modern features ─────────────────────────────────────────────────────────

test("synchronized output and hyperlinks are only claimed from known terminals", () => {
  assert.equal(detectTerminal({ TERM: "xterm-256color" }, TTY).synchronizedOutput, false);
  const modern = detectTerminal({ TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" }, TTY);
  assert.equal(modern.synchronizedOutput, true);
  assert.equal(modern.hyperlink, true);
  assert.equal(detectTerminal({ TERM: "xterm-256color", LLAMACLI_NO_SMOOTH: "1" }, TTY).synchronizedOutput, false);
});

// ── sequence builders ───────────────────────────────────────────────────────

test("every sequence builder degrades to an empty string when unsupported", () => {
  const none = detectTerminal({ TERM: "dumb" }, TTY);
  const s = buildSequences(none);
  assert.equal(s.altScreenOn, "");
  assert.equal(s.altScreenOff, "");
  assert.equal(s.mouseOn, "");
  assert.equal(s.mouseOff, "");
  assert.equal(s.hideCursor, "");
  assert.equal(s.showCursor, "");
  assert.equal(s.syncBegin, "");
  assert.equal(s.syncEnd, "");
  assert.equal(s.reset, "");
  assert.equal(s.moveTo(3, 5), "");
  assert.equal(s.eraseLineAt(3), "");
});

test("mouseOn/mouseOff are only emitted together", () => {
  const on = buildSequences(detectTerminal({ TERM: "xterm-256color", LLAMACLI_MOUSE: "1" }, TTY));
  assert.ok(on.mouseOn.includes("\x1b[?1000h"));
  assert.ok(on.mouseOn.includes("\x1b[?1006h"));
  const off = buildSequences(detectTerminal({ TERM: "xterm-256color" }, TTY));
  assert.equal(off.mouseOn, "");
  // mouseOff must still be emitted when the terminal *can* do SGR, so a
  // terminal whose mode we turned on and then disabled still gets cleaned up.
  assert.ok(off.mouseOff.includes("\x1b[?1000l"));
});

test("alt screen entry hides the cursor and exit restores it", () => {
  const s = buildSequences(detectTerminal({ TERM: "xterm-256color" }, TTY));
  assert.ok(s.altScreenOn.includes("\x1b[?1049h"));
  assert.ok(s.altScreenOn.endsWith("\x1b[?25l"));
  assert.ok(s.altScreenOff.startsWith("\x1b[?25h"));
  assert.ok(s.altScreenOff.endsWith("\x1b[?1049l"));
});

test("moveTo/eraseLineAt use 1-based coordinates matching CUP/EL", () => {
  const s = buildSequences(detectTerminal({ TERM: "xterm-256color" }, TTY));
  assert.equal(s.moveTo(4, 7), "\x1b[4;7H");
  assert.equal(s.eraseLineAt(4), "\x1b[4;1H\x1b[2K");
});

// ── paint / glyph / stripAnsi ───────────────────────────────────────────────

test("paint drops color entirely at depth 0 but keeps text", () => {
  const caps: TerminalCapabilities = detectTerminal({ TERM: "dumb" }, TTY);
  assert.equal(paint("hi", "1;36m", caps), "hi");
  assert.equal(paint("hi", "1;36m", { ...caps, colorDepth: 0 }), "hi");
});

test("paint strips 256/truecolor sequences at 16-color depth rather than leaking them", () => {
  const caps = detectTerminal({ TERM: "xterm" }, TTY); // depth 4
  assert.equal(caps.colorDepth, 4);
  assert.equal(paint("hi", "38;5;208m", caps), "hi");
  assert.equal(paint("hi", "38;2;10;20;30m", caps), "hi");
  // Plain SGR attributes are still fine at depth 4.
  assert.equal(paint("hi", "1;36m", caps), "\x1b[1;36mhi\x1b[0m");
  assert.equal(paint("hi", "2;90m", caps), "\x1b[2;90mhi\x1b[0m");
  // Bare parameters (no trailing "m") must produce the same thing, not
  // "1;36mm" — both spellings are already used in this codebase.
  assert.equal(paint("hi", "1;36", caps), "\x1b[1;36mhi\x1b[0m");
});

test("paint passes bright/extended SGR through at 256 and truecolor", () => {
  const deep = detectTerminal({ TERM: "xterm-256color" }, TTY);
  assert.equal(paint("x", "1;95m", deep), "\x1b[1;95mx\x1b[0m");
  assert.equal(paint("x", "38;5;208m", deep), "\x1b[38;5;208mx\x1b[0m");
});

test("glyph picks the ASCII fallback when Unicode is unavailable", () => {
  const uni = detectTerminal({ TERM: "xterm-256color", LANG: "ko_KR.UTF-8" }, TTY);
  const ascii = detectTerminal({ TERM: "xterm-256color", LANG: "C" }, TTY);
  assert.equal(glyph("█", "#", uni), "█");
  assert.equal(glyph("█", "#", ascii), "#");
  assert.equal(glyph("⠁", "o", ascii), "o");
});

test("stripAnsi removes both CSI and OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[1;36mhello\x1b[0m"), "hello");
  assert.equal(stripAnsi("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripAnsi("plain"), "plain");
});
