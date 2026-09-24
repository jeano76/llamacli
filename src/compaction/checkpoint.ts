import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Machine-parseable state written right before compaction runs (PROMPT.md §2.2).
 *  Distinct from the human-readable conversation summary — never merge the two. */
export interface Checkpoint {
  version: 1;
  timestamp: string;
  // "plan-progress": written on every update_plan call, independent of
  // compaction — requested directly, so a plan/todo list survives a hard
  // kill (Ctrl-C at the OS level, crash, power loss) at any point, not
  // only when a compaction happened to have already run. Before this,
  // this file only ever existed after a compaction, so a session killed
  // mid-task with no compaction yet lost its whole plan with nothing to
  // resume from.
  reason: "auto-threshold" | "manual" | "plan-progress";
  /** One-line restatement of what the user originally asked for. */
  goal: string;
  steps: Array<{
    description: string;
    status: "done" | "in_progress" | "todo";
  }>;
  files: Array<{
    path: string;
    status: "modified" | "read";
  }>;
  /** The tool call that was about to run (or had just run) when compaction fired. */
  pendingToolCall: {
    name: string;
    argumentsJson: string;
    reason: string;
  } | null;
  /** Facts/decisions that must survive summarization losslessly. */
  mustPreserve: string[];
  /** The compaction summary, added once it has been generated, so a resume
   *  in a NEW process knows what the previous one did (its conversation is
   *  gone). Absent on checkpoints written before summarizing. */
  summary?: string;
  /** The last tool calls, when no plan was declared (steps is then empty). */
  recentActions?: string[];
}

function checkpointPath(projectRoot: string): string {
  return join(projectRoot, ".llamacli", "state", "checkpoint.json");
}

export async function writeCheckpoint(
  projectRoot: string,
  checkpoint: Checkpoint
): Promise<void> {
  const path = checkpointPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), "utf8");
}

export async function readCheckpoint(projectRoot: string): Promise<Checkpoint | null> {
  try {
    const raw = await readFile(checkpointPath(projectRoot), "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Clears the checkpoint once its work has been successfully resumed and verified.
 *  Deletes the file outright (not an empty write) so a subsequent readCheckpoint()
 *  correctly returns null via its ENOENT path instead of failing to parse "". */
export async function clearCheckpoint(projectRoot: string): Promise<void> {
  await rm(checkpointPath(projectRoot), { force: true });
}
