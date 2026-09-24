import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNote, readNotes, clearNotes, stripNotesBlock, NOTES_HEADER, MAX_NOTES_CHARS } from "./notes.js";

test("notes append as timestamped lines, keep only the newest past the cap, and clear", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-notes-"));
  try {
    assert.equal(await readNotes(dir), "");
    await appendNote(dir, "page script is built\nwithout newlines", new Date(2026, 8, 24, 18, 5));
    assert.equal(await readNotes(dir), "- [18:05] page script is built without newlines");
    for (let i = 0; i < 200; i++) await appendNote(dir, `finding ${i} ${"x".repeat(40)}`);
    const notes = await readNotes(dir);
    assert.ok(notes.length <= MAX_NOTES_CHARS);
    assert.match(notes, /finding 199/);
    assert.doesNotMatch(notes, /page script/);
    await clearNotes(dir);
    assert.equal(await readNotes(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stripNotesBlock removes an appended notes block from summary text", () => {
  assert.equal(stripNotesBlock(`summary text\n\n${NOTES_HEADER}\n- [18:05] note`), "summary text");
  assert.equal(stripNotesBlock("summary only"), "summary only");
});
