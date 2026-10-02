import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransientLine, type TransientRow } from "./transientLine.js";

/**
 * Exercises the SAME reducer `App.tsx` uses, not a copy. An earlier version of
 * this file re-implemented the logic in the test, which meant every case passed
 * regardless of what the app did — the exact failure mode these tests exist to
 * rule out.
 */

interface Row extends TransientRow {
  kind: string;
}

/** A stand-in for App.tsx's log state: same cap, same commit shape. */
function makeLog(maxRows = 5000) {
  let rows: Row[] = [];
  let idc = 0;
  const get = () => rows;
  const set = (next: Row[]) => {
    rows = next;
  };
  const t = createTransientLine<Row>(get, set, (text) => ({ id: -1, text, kind: "status" }), () => idc++, maxRows);
  return {
    t,
    get rows() {
      return rows;
    },
    count: () => rows.length,
    /** What `pushLine` does — append, which is the behaviour being replaced. */
    pushStatus: (text: string) => {
      rows = [...rows, { id: idc++, text, kind: "status" }].slice(-maxRows);
    },
  };
}

const bar = (p: number) => `[${"#".repeat(Math.round(p / 10)).padEnd(10, "░")}] ${p}%`;

test("a thousand progress updates occupy exactly ONE row", () => {
  // The regression itself: 0→100% in 0.1% steps is ~1000 updates, fewer than a
  // large transfer emits.
  const log = makeLog();
  for (let p = 0; p <= 100; p += 0.1) log.t.update(bar(p));
  assert.equal(log.count(), 1, "a redrawn bar must not append rows");
});

test("appending instead would have scrolled the log", () => {
  // The contrast that gives the test above meaning: this is what the user saw.
  const log = makeLog();
  for (let p = 0; p <= 100; p += 0.1) log.pushStatus(bar(p));
  assert.ok(log.count() > 1000, `expected the log to grow, got ${log.count()}`);
});

test("the row shows the LATEST value, not the first", () => {
  // A row that kept its first update would sit at 0% for the whole transfer —
  // indistinguishable from a frozen download, and worse than scrolling.
  const log = makeLog();
  for (let p = 0; p <= 100; p += 5) log.t.update(bar(p));
  assert.equal(log.rows[0].text, bar(100), "must end on the final progress");
});

test("messages logged during a transfer are not overwritten", () => {
  // update() touches only its OWN row. Rewriting "the last row" unconditionally
  // would erase a "[reset] building llama.cpp" line on the next tick.
  const log = makeLog();
  log.t.update(bar(10));
  log.pushStatus("[reset] llama.cpp 빌드 완료");
  log.t.update(bar(20));
  log.t.update(bar(30));
  assert.equal(log.count(), 2, "the message and the bar are separate rows");
  assert.equal(log.rows[0].text, bar(30), "the bar is still redrawn in place");
  assert.equal(log.rows[1].text, "[reset] llama.cpp 빌드 완료", "and the message survived");
});

test("end() freezes the last value and frees the slot", () => {
  // The final state must remain in the scrollback, or the transfer ends with no
  // record that it happened.
  const log = makeLog();
  log.t.update(bar(100));
  log.t.end();
  log.t.update(bar(0));
  assert.equal(log.count(), 2, "a new transient line is a new row");
  assert.equal(log.rows[0].text, bar(100), "the completed transfer is still there");
});

test("a row trimmed off mid-transfer is re-added rather than lost", () => {
  // MAX_LOG_ENTRIES is 5000 and a chatty session can exceed it. An abandoned id
  // would freeze the bar for the rest of the download, which reads as a stall.
  const log = makeLog(3);
  log.t.update(bar(1));
  log.pushStatus("a");
  log.pushStatus("b");
  log.pushStatus("c"); // the bar's row is now trimmed away
  log.t.update(bar(2));
  assert.ok(log.rows.some((r) => r.text === bar(2)), "progress must resume after a trim");
  log.t.update(bar(3));
  assert.ok(log.rows.some((r) => r.text === bar(3)), "and keep updating");
});

test("the transient row keeps the caller's own fields", () => {
  // App.tsx renders by `kind`; a reducer that rebuilt rows from scratch would
  // drop it and the bar would render as the wrong kind of line.
  const log = makeLog();
  log.t.update("x");
  assert.equal(log.rows[0].kind, "status");
});

test("ids never collide with the log's own", () => {
  // A collision would make the bar rewrite an unrelated row — a user's message,
  // say — which is data loss, not a cosmetic glitch.
  const log = makeLog();
  log.pushStatus("first");
  log.t.update("bar");
  const ids = log.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(",")}`);
});
