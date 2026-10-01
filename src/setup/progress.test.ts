import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProgressLine } from "./bootstrap.js";

// A first run prints download progress for tens of minutes, and this reporter is
// the only thing the user sees during it. Both bugs below were found by driving
// this function directly and inspecting the bytes it produced — reasoning about
// what it "obviously" wrote missed the missing ESC byte for a long time.

/** Runs `fn` with stdout.isTTY forced, restoring the real value afterward. */
function withIsTTY(value: boolean, fn: () => void): void {
  const real = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: real, configurable: true });
  }
}

const at = (percent: number) => ({ receivedBytes: percent * 2e8, totalBytes: 2e10, percent }) as any;

test("the in-place rewrite uses a real ESC[2K, never the literal text [2K", () => {
  // The bug: the sequence was written as `\r[2K`, so the erase-line control code
  // reached the terminal as four visible characters at the start of every update.
  process.env.LLAMACLI_FORCE_ANSI = "1";
  try {
    const lines: string[] = [];
    withIsTTY(true, () => {
      const rep = renderProgressLine((l) => lines.push(l));
      rep(at(25));
      rep(at(30));
    });
    assert.ok(
      !lines.some((l) => /\r\[2K/.test(l)),
      `literal "[2K" leaked to the terminal: ${JSON.stringify(lines)}`
    );
    assert.ok(lines.some((l) => l.includes("\r\x1b[2K")), "expected a proper carriage-return + erase-line");
  } finally {
    delete process.env.LLAMACLI_FORCE_ANSI;
  }
});

test("progress is written through the log sink, never straight to stdout", () => {
  // Writing to process.stdout directly bypasses whatever sink the caller gave
  // us — which is how this used to corrupt the TUI it shared a terminal with.
  process.env.LLAMACLI_FORCE_ANSI = "1";
  const lines: string[] = [];
  withIsTTY(true, () => renderProgressLine((l) => lines.push(l))(at(50)));
  assert.equal(lines.length, 1, "the caller's log must receive the update");
  assert.match(lines[0], /50%/);
  delete process.env.LLAMACLI_FORCE_ANSI;
});

test("the first update does not carriage-return over unread scrollback", () => {
  // A leading \r on the first line would blank whatever the user has not read
  // yet; only subsequent rewrites need it.
  process.env.LLAMACLI_FORCE_ANSI = "1";
  try {
    const lines: string[] = [];
    withIsTTY(true, () => {
      const rep = renderProgressLine((l) => lines.push(l));
      rep(at(10));
      rep(at(20));
    });
    assert.ok(!lines[0].startsWith("\r"), `first line started with \\r: ${JSON.stringify(lines[0])}`);
    assert.ok(lines[1].startsWith("\r"), "later lines must rewrite in place");
  } finally {
    delete process.env.LLAMACLI_FORCE_ANSI;
  }
});

test("a terminal that cannot interpret escapes gets plain lines, no control bytes", () => {
  // A non-TTY (a redirected log, a Windows cmd without VT mode) must never be
  // sent escape sequences, and must instead get a readable periodic record.
  const lines: string[] = [];
  withIsTTY(false, () => {
    const rep = renderProgressLine((l) => lines.push(l));
    for (const p of [0, 5, 10, 11, 42, 43]) rep(at(p));
  });
  assert.ok(!lines.some((l) => /\x1b|\r/.test(l)), `control bytes leaked: ${JSON.stringify(lines)}`);
  assert.ok(lines.length > 0, "a redirected log still needs progress output");
});

test("progress is throttled by decile so a long download cannot flood the log", () => {
  // Every update below 10% used to pass `floor(percent) % 10 === 0`, so a real
  // 20 GB fetch emitted a line ~4x/second for its first minutes.
  const lines: string[] = [];
  withIsTTY(false, () => {
    const rep = renderProgressLine((l) => lines.push(l));
    for (let p = 0; p < 10; p += 0.25) rep(at(p));
  });
  assert.ok(lines.length <= 3, `expected throttling below 10%, got ${lines.length} lines`);
});
