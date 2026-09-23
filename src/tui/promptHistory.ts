import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Every text the user actually submitted (sent immediately, or queued
 *  while busy — both count as "submitted a prompt" from the user's
 *  perspective, see App.tsx), most recent last. Capped and persisted so
 *  Up/Down arrow history survives across restarts, not just within one
 *  running session. */
export const MAX_PROMPT_HISTORY = 50;

function historyPath(projectRoot: string): string {
  return join(projectRoot, ".llamacli", "state", "prompt-history.json");
}

export async function loadPromptHistory(projectRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(historyPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(-MAX_PROMPT_HISTORY);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    return []; // corrupt/unreadable history file — start fresh rather than crash the CLI over it
  }
}

export async function savePromptHistory(projectRoot: string, history: string[]): Promise<void> {
  const path = historyPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(history.slice(-MAX_PROMPT_HISTORY), null, 2), "utf8");
}
