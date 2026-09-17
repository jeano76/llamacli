import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDef } from "../backend/types.js";
import { formatDiff } from "./diff.js";
import * as browser from "./browser.js";
import type { BrowserConfig } from "./browser.js";

const execAsync = promisify(exec);

/** Set once at startup from .llamacli/config.yaml (PROMPT.md new requirement:
 *  remote-control an already-running browser over its CDP debug port). */
let browserConfig: BrowserConfig = { debugPort: 9222, host: "127.0.0.1" };
let browserScreenshotDir = join(process.cwd(), ".llamacli", "state", "screenshots");

export function configureBrowserTools(config: BrowserConfig, projectRoot: string): void {
  browserConfig = config;
  browserScreenshotDir = join(projectRoot, ".llamacli", "state", "screenshots");
}

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
  {
    type: "function",
    function: {
      name: "browser_list_tabs",
      description:
        "List open page tabs on the browser attached via its remote debugging port " +
        "(--remote-debugging-port). Does not launch a browser — only attaches to one already running.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the (first, or given) browser tab to a URL and wait for it to load.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          target_id: { type: "string", description: "Tab id from browser_list_tabs; defaults to the first tab." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_eval",
      description: "Evaluate a JavaScript expression in the page and return its value (JSON-stringified if not a string).",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string" },
          target_id: { type: "string", description: "Tab id from browser_list_tabs; defaults to the first tab." },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the page and save it to disk; returns the saved path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional output path; defaults to .llamacli/state/screenshots/<timestamp>.png" },
          target_id: { type: "string", description: "Tab id from browser_list_tabs; defaults to the first tab." },
        },
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
    case "browser_list_tabs":
      return { content: await browser.listTabs(browserConfig) };
    case "browser_navigate":
      return { content: await browser.navigate(browserConfig, args.url, args.target_id) };
    case "browser_eval":
      return { content: await browser.evaluate(browserConfig, args.expression, args.target_id) };
    case "browser_screenshot": {
      const path = args.path ?? join(browserScreenshotDir, `${Date.now()}.png`);
      return { content: await browser.screenshot(browserConfig, path, args.target_id) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
