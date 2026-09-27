import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsAnsiTui } from "./ansiSupport.js";
import { detectTerminal } from "./terminal.js";

const TTY = { stdoutIsTTY: true, stdinIsTTY: true, platform: "linux" as NodeJS.Platform };

test("supportsAnsiTui: a plain TTY on a non-Windows platform is supported by default", () => {
  assert.equal(supportsAnsiTui({}, TTY), true);
});

test("supportsAnsiTui: not a real terminal at all (piped/redirected output) is never supported", () => {
  assert.equal(supportsAnsiTui({}, { ...TTY, stdoutIsTTY: false }), false);
  assert.equal(supportsAnsiTui({}, { ...TTY, stdinIsTTY: false }), false);
});

test("supportsAnsiTui: TERM=dumb is never supported", () => {
  assert.equal(supportsAnsiTui({ TERM: "dumb" }, TTY), false);
});

test("supportsAnsiTui: on win32, a bare console with none of the known-good terminal env vars is NOT supported", () => {
  // Reported directly: this is exactly the "Windows cmd" case — flickering
  // and stray escape-sequence characters in the prompt.
  assert.equal(supportsAnsiTui({}, { ...TTY, platform: "win32" }), false);
});

test("supportsAnsiTui: on win32, Windows Terminal (WT_SESSION) is supported", () => {
  assert.equal(supportsAnsiTui({ WT_SESSION: "abc" }, { ...TTY, platform: "win32" }), true);
});

test("supportsAnsiTui: on win32, a recognized TERM_PROGRAM (e.g. VS Code) is supported", () => {
  assert.equal(supportsAnsiTui({ TERM_PROGRAM: "vscode" }, { ...TTY, platform: "win32" }), true);
});

test("supportsAnsiTui: LLAMACLI_NO_ANSI=1 forces it off even on an otherwise-supported terminal", () => {
  assert.equal(supportsAnsiTui({ LLAMACLI_NO_ANSI: "1" }, TTY), false);
});

test("supportsAnsiTui: NO_COLOR suppresses color but NOT cursor/alt-screen control", () => {
  // Corrected semantics. NO_COLOR (https://no-color.org) is a request about
  // COLOR, and it used to switch off every control sequence this app emits —
  // so setting it silently disabled the alt screen and the absolute cursor
  // positioning that the input line depends on, for a color preference. That
  // was over-broad, and it is itself part of the per-terminal breakage this
  // shim now delegates away. `supportsAnsiTui` answers "may we emit control
  // sequences"; color is `capabilities.colorDepth`, tested in terminal.test.ts.
  assert.equal(supportsAnsiTui({ NO_COLOR: "" }, TTY), true);
  assert.equal(detectTerminal({ NO_COLOR: "" }, TTY).colorDepth, 0);
});

test("supportsAnsiTui: NO_COLOR=0 is still honored (any value counts, per the convention)", () => {
  // The convention is presence-based, not truthiness-based — `NO_COLOR=0` and
  // `NO_COLOR=` both mean "no color".
  assert.equal(detectTerminal({ TERM: "xterm-256color", NO_COLOR: "0" }, TTY).colorDepth, 0);
});

test("supportsAnsiTui: LLAMACLI_FORCE_ANSI=1 forces it on even without a TTY or a known-good win32 terminal", () => {
  assert.equal(supportsAnsiTui({ LLAMACLI_FORCE_ANSI: "1" }, { stdoutIsTTY: false, stdinIsTTY: false, platform: "win32" }), true);
});
