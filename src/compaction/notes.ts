import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Working notes: findings the model records with the `note` tool so they
 *  survive context compaction. Kept in a file (not only in the
 *  conversation) and re-injected after every compaction and on resume.
 *
 *  Seen live: a session chasing one syntax error compacted ~25 times in 40
 *  minutes, and each compaction reduced what it had just worked out ("the
 *  page script is a single line", "the error is reported at the end") to a
 *  lossy summary, so it rewrote the same analysis ~60 times. */
export const NOTES_HEADER = "[Working notes — kept across compaction]";

/** Newest notes kept when the file grows past this. */
export const MAX_NOTES_CHARS = 3000;

function notesPath(projectRoot: string): string {
  return join(projectRoot, ".llamacli", "state", "notes.md");
}

export async function readNotes(projectRoot: string): Promise<string> {
  try {
    return (await readFile(notesPath(projectRoot), "utf8")).trim();
  } catch {
    return "";
  }
}

/** Appends one note as a timestamped line, dropping the oldest lines once
 *  the total passes MAX_NOTES_CHARS. */
export async function appendNote(projectRoot: string, text: string, now: Date = new Date()): Promise<void> {
  const line = `- [${now.toTimeString().slice(0, 5)}] ${text.replace(/\s+/g, " ").trim()}`;
  const lines = [...(await readNotes(projectRoot)).split("\n").filter(Boolean), line];
  while (lines.length > 1 && lines.join("\n").length > MAX_NOTES_CHARS) lines.shift();
  const path = notesPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

export async function clearNotes(projectRoot: string): Promise<void> {
  await rm(notesPath(projectRoot), { force: true });
}

/** Removes a notes block from summary text, so notes appended to the system
 *  message aren't fed back into the next summary and duplicated. */
export function stripNotesBlock(text: string): string {
  const idx = text.indexOf(NOTES_HEADER);
  return idx === -1 ? text : text.slice(0, idx).trimEnd();
}
