import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsAnsiTui } from "./ansiSupport.js";

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

test("supportsAnsiTui: NO_COLOR forces it off (any value, per the NO_COLOR convention)", () => {
  assert.equal(supportsAnsiTui({ NO_COLOR: "" }, TTY), false);
});

test("supportsAnsiTui: LLAMACLI_FORCE_ANSI=1 forces it on even without a TTY or a known-good win32 terminal", () => {
  assert.equal(supportsAnsiTui({ LLAMACLI_FORCE_ANSI: "1" }, { stdoutIsTTY: false, stdinIsTTY: false, platform: "win32" }), true);
});
