import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ToolDef } from "../backend/types.js";
import { formatDiff } from "./diff.js";

const execAsync = promisify(exec);

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's contents from the local filesystem.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (overwrite) a file's contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact substring in a file with new text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command in the project working directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Declare or update your step-by-step plan for the current task. Call this " +
        "whenever the plan changes (a step starts, finishes, or new steps are added) " +
        "so progress can survive context compaction and be resumed automatically.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                status: { type: "string", enum: ["todo", "in_progress", "done"] },
              },
              required: ["description", "status"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
];

/** Tools handled directly by the agent loop (they mutate its in-memory state)
 *  rather than by `executeTool`, which only touches the filesystem/shell. */
export const AGENT_STATE_TOOLS = new Set(["update_plan"]);

/** Tool calls whose `path` argument identifies a file the checkpoint should track. */
export const FILE_TOOLS: Record<string, "modified" | "read"> = {
  read_file: "read",
  write_file: "modified",
  edit_file: "modified",
};

export interface ToolResult {
  /** Plain-text result fed back to the model as the tool message content. */
  content: string;
  /** ANSI-colored unified diff for file-mutating tools, UI-only (never sent
   *  to the model — it would waste tokens and the model doesn't need color). */
  diff?: string;
}

export async function executeTool(name: string, argsJson: string): Promise<ToolResult> {
  const args = JSON.parse(argsJson || "{}");
  switch (name) {
    case "read_file":
      return { content: await readFile(args.path, "utf8") };
    case "write_file": {
      const before = await readFile(args.path, "utf8").catch(() => "");
      await writeFile(args.path, args.content, "utf8");
      return { content: `wrote ${args.path}`, diff: formatDiff(args.path, before, args.content) };
    }
    case "edit_file": {
      const original = await readFile(args.path, "utf8");
      if (!original.includes(args.old_text)) {
        throw new Error(`old_text not found in ${args.path}`);
      }
      const updated = original.replace(args.old_text, args.new_text);
      await writeFile(args.path, updated, "utf8");
      return { content: `edited ${args.path}`, diff: formatDiff(args.path, original, updated) };
    }
    case "run_shell": {
      const { stdout, stderr } = await execAsync(args.command, { cwd: process.cwd() });
      return { content: stdout || stderr };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
