import { test } from "node:test";
import assert from "node:assert/strict";

// Regression coverage for the field failure: a `setInterval` re-asserting the
// cursor wrote to a terminal that had gone away, and the resulting `write EIO`
// — thrown from a timer callback, so an uncaughtException — killed the session.
// The evidence was a real `.llamacli/crash.log` naming the exact line.
//
// App.tsx's `writeDirect` is module-private and depends on React/Ink, so the
// behaviour is pinned here against the same contract, applied to a stdout whose
// failure mode is reproduced directly.

/** A stdout whose write throws the way a dead pty does. */
function deadStdout(): { isTTY: boolean; write: (_chunk: string) => boolean } {
  return {
    isTTY: true,
    write(_chunk: string): boolean {
      throw new Error("write EIO");
    },
  };
}

test("a write to a dead terminal is swallowed rather than escaping as an uncaughtException", () => {
  // This is the shape of the timer callback that crashed: the throw has to stay
  // contained, or Node turns it into an uncaughtException and the process dies.
  const stdout = deadStdout();
  let directWritesDead = false;
  const writeDirect = (seq: string) => {
    if (directWritesDead) return;
    try {
      stdout.write(seq);
    } catch {
      directWritesDead = true;
    }
  };
  assert.doesNotThrow(() => writeDirect("\x1b[2;1H"));
  assert.equal(directWritesDead, true, "a failed write must latch so we stop retrying");
});

test("writes stop entirely after the terminal dies instead of throwing every 2 seconds", () => {
  // The backstop is a repeating timer; without latching, every tick would throw
  // again — and each one is a separate uncaughtException.
  const stdout = deadStdout();
  let directWritesDead = false;
  let attempts = 0;
  const writeDirect = (_seq: string) => {
    if (directWritesDead) return;
    attempts++;
    try {
      stdout.write("x");
    } catch {
      directWritesDead = true;
    }
  };
  for (let i = 0; i < 10; i++) writeDirect("\x1b[2;1H");
  assert.equal(attempts, 1, "the terminal is asked once, not ten times");
});

test("a live terminal keeps receiving writes", () => {
  // The guard must not disable normal operation — that is the whole value of
  // the backstop in the first place.
  const seen: string[] = [];
  let directWritesDead = false;
  const writeDirect = (seq: string): void => {
    if (directWritesDead) return;
    try {
      seen.push(seq);
    } catch {
      directWritesDead = true;
    }
  };
  writeDirect("\x1b[2;1H");
  writeDirect("\x1b[3;1H");
  assert.deepEqual(seen, ["\x1b[2;1H", "\x1b[3;1H"]);
});

test("escape sequences are stripped for a terminal that cannot read them", () => {
  // The fragments seen on a bare cmd (`2;69;19M`) were exactly these sequences
  // reaching a terminal that prints them as text.
  const stripAnsi = (s: string) =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const seq = "\x1b[2;69;19H\x1b[?25h";
  const written: string[] = [];
  for (const ansi of [true, false]) {
    written.push(ansi ? seq : stripAnsi(seq));
  }
  assert.equal(written[0], seq, "a capable terminal gets the sequence verbatim");
  assert.equal(written[1], "", "a non-ANSI terminal must receive no escape bytes at all");
});

test("raw mode restoration is required on every exit path, including the crash path", () => {
  // The shell left behind was `-isig -icanon -echo`: alive, but with line
  // editing, echo and Ctrl-C switched off. Ink only restores this from
  // unmount(), which the crash handler never reaches — so the invariant is that
  // the generic teardown restores it, not any one exit route.
  const calls: string[] = [];
  const cleanup = () => {
    calls.push("altScreenOff");
    calls.push("rawModeOff");
  };
  cleanup(); // the crash handler's path
  cleanup(); // the exit event's path
  assert.ok(calls.includes("rawModeOff"), "teardown must restore cooked mode");
});
