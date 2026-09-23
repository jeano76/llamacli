import { exec } from "node:child_process";
import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ToolDef } from "../backend/types.js";
import { formatDiff } from "./diff.js";
import * as browser from "./browser.js";
import type { BrowserConfig } from "./browser.js";
import type { SkillIndexEntry } from "../skills/loader.js";
import { loadSkillBody } from "../skills/loader.js";

const execAsync = promisify(exec);

/** Set once at startup from .llamacli/config.yaml (PROMPT.md new requirement:
 *  remote-control an already-running browser over its CDP debug port). */
let browserConfig: BrowserConfig = { debugPort: 9222, host: "127.0.0.1" };
let browserScreenshotDir = join(process.cwd(), ".llamacli", "state", "screenshots");

/** Whether the 4 browser tools are offered to the model at all. Off by
 *  default: measured against the real backend, the tool schema costs
 *  1,238 prompt tokens on EVERY request (7.6% of a 16,384-token window),
 *  and the browser tools are ~400-500 of that — paid on every single
 *  request whether or not a browser is ever touched, in a session that
 *  usually never touches one. Enable per project via config.yaml's
 *  `browser.enabled: true`. */
let browserToolsEnabled = false;

export function configureBrowserTools(config: BrowserConfig, projectRoot: string, enabled = false): void {
  browserConfig = config;
  browserToolsEnabled = enabled;
  browserScreenshotDir = join(projectRoot, ".llamacli", "state", "screenshots");
}

const BROWSER_DISABLED_MESSAGE =
  "browser tools are disabled for this project — set `browser.enabled: true` in .llamacli/config.yaml to use them";

const BROWSER_TOOL_NAMES = new Set(["browser_list_tabs", "browser_navigate", "browser_eval", "browser_screenshot"]);

/** The tools actually sent to the model, after applying config. Always
 *  call this rather than using TOOL_DEFS directly for a request — and use
 *  the SAME list for the token estimate, or the estimate silently stops
 *  matching what's really sent (the exact failure mode that made every
 *  measurement ~19% low before /apply-template). */
export function activeToolDefs(): ToolDef[] {
  return browserToolsEnabled ? TOOL_DEFS : TOOL_DEFS.filter((t) => !BROWSER_TOOL_NAMES.has(t.function.name));
}

/** Set once at startup from loadSkillIndex() (index.tsx). The index
 *  (name+trigger only) is what the model sees up front via the system
 *  prompt; `load_skill` is how it pulls a specific skill's full body only
 *  when actually needed, rather than every skill's content being sent on
 *  every request regardless of relevance.
 *
 *  Before this, loadSkillBody() had no caller anywhere in the codebase —
 *  the 8 builtin skills (planning, code-review, security, ...) were
 *  indexed and even copied into dist/ by the build, but the model itself
 *  had no way to ever read one: the skill system was fully wired up on the
 *  loader side and never connected to the tool-call side at all. */
let skillIndex: SkillIndexEntry[] = [];

export function configureSkills(index: SkillIndexEntry[]): void {
  skillIndex = index;
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
      name: "append_file",
      description:
        "Append content to the end of a file, creating it (and any missing parent " +
        "directories) if it doesn't exist yet. Use this to write a large file in " +
        "multiple smaller calls instead of one write_file call whose content might " +
        "not fit in a single reply: call write_file once for the FIRST chunk (creates " +
        "the file), then append_file repeatedly, in order, for each remaining chunk.",
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
      name: "load_skill",
      description:
        "Load the full body of a skill by name (from the list of available skills given " +
        "in the system prompt). Use this when the current task matches a skill's trigger " +
        "description, before starting that kind of work.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
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
  append_file: "modified",
  edit_file: "modified",
};

export interface ToolResult {
  /** Plain-text result fed back to the model as the tool message content. */
  content: string;
  /** ANSI-colored unified diff for file-mutating tools, UI-only (never sent
   *  to the model — it would waste tokens and the model doesn't need color). */
  diff?: string;
}

/** How long a single `run_shell` call is allowed to block before it's
 *  killed. Exported so tests can shrink it instead of waiting out the real
 *  default. There was previously no timeout at all — found via a scenario
 *  test simulating many long developer sessions: a command that blocks
 *  (network stall, something waiting on stdin, a genuinely long-running
 *  build/test command) hung the entire agent loop forever with no way to
 *  recover, which lines up with multiple "seems stuck?" reports earlier —
 *  those were plausibly this, not the other bugs already found and fixed. */
export let RUN_SHELL_TIMEOUT_MS = 60_000;
export function setRunShellTimeoutForTests(ms: number): void {
  RUN_SHELL_TIMEOUT_MS = ms;
}

/** Above this, read_file refuses to load a whole file into memory before
 *  capToolResult() (loop.ts) gets a chance to truncate it — a large binary,
 *  log, or data file (routine to accidentally point at: a bundled asset, a
 *  model weights file, a dump) could otherwise exhaust memory before any
 *  cap applies at all. Read only up to the cap directly instead. */
const READ_FILE_MAX_BYTES = 5 * 1024 * 1024;

export async function executeTool(name: string, argsJson: string, projectRoot: string = process.cwd()): Promise<ToolResult> {
  const args = JSON.parse(argsJson || "{}");
  switch (name) {
    case "read_file": {
      const info = await stat(args.path);
      if (info.size > READ_FILE_MAX_BYTES) {
        const fh = await open(args.path, "r");
        try {
          const buf = Buffer.alloc(READ_FILE_MAX_BYTES);
          const { bytesRead } = await fh.read(buf, 0, READ_FILE_MAX_BYTES, 0);
          return {
            content:
              buf.subarray(0, bytesRead).toString("utf8") +
              `\n\n[...truncated: file is ${info.size} bytes, only the first ${READ_FILE_MAX_BYTES} were read]`,
          };
        } finally {
          await fh.close();
        }
      }
      return { content: await readFile(args.path, "utf8") };
    }
    case "load_skill": {
      const entry = skillIndex.find((s) => s.name === args.name);
      if (!entry) {
        const available = skillIndex.map((s) => s.name).join(", ") || "(none loaded)";
        throw new Error(`unknown skill: ${args.name}. Available: ${available}`);
      }
      return { content: await loadSkillBody(entry) };
    }
    case "write_file": {
      const before = await readFile(args.path, "utf8").catch(() => "");
      // Found auditing for the same class of gap as run_shell/CDP's
      // missing timeouts: writing a brand-new file in a directory that
      // doesn't exist yet — routine for "create a new module/handler" —
      // threw ENOENT instead of just working, since writeFile() never
      // creates parent directories on its own.
      await mkdir(dirname(args.path), { recursive: true });
      await writeFile(args.path, args.content, "utf8");
      return { content: `wrote ${args.path}`, diff: formatDiff(args.path, before, args.content) };
    }
    case "append_file": {
      const before = await readFile(args.path, "utf8").catch(() => "");
      // Same directory-creation fix as write_file — a first append_file
      // call (e.g. after a truncated write_file never got to run) must
      // still be able to create the file fresh, not require it to
      // already exist.
      await mkdir(dirname(args.path), { recursive: true });
      await appendFile(args.path, args.content, "utf8");
      return { content: `appended ${args.content.length} chars to ${args.path}`, diff: formatDiff(args.path, before, before + args.content) };
    }
    case "edit_file": {
      const original = await readFile(args.path, "utf8");
      // `.replace()` only ever touches the FIRST match, silently, even
      // when old_text also appears elsewhere in the file — a genuinely
      // common case (similar-looking functions, repeated boilerplate).
      // The previous `.includes()` check only confirmed "at least one
      // match exists," not that it's the RIGHT (unique) one, so an
      // ambiguous old_text could silently edit an unrelated earlier
      // occurrence instead of the one actually intended, with no warning
      // at all. Require a unique match instead — same principle as the
      // other tools here refusing to guess and fail silently.
      const occurrences = original.split(args.old_text).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_text not found in ${args.path}`);
      }
      if (occurrences > 1) {
        throw new Error(
          `old_text matches ${occurrences} places in ${args.path} — ambiguous. ` +
            `Include more surrounding context so it uniquely identifies the one location to edit.`
        );
      }
      const updated = original.replace(args.old_text, args.new_text);
      await writeFile(args.path, updated, "utf8");
      return { content: `edited ${args.path}`, diff: formatDiff(args.path, original, updated) };
    }
    case "run_shell": {
      // cwd was previously always process.cwd() — the whole CLI process's
      // own working directory, not necessarily the project actually being
      // worked on (it only happened to match in normal single-project use
      // because llamacli is launched from inside the project). Use the
      // real project root explicitly instead of relying on that
      // coincidence. `timeout` means a command that blocks forever (stuck
      // on network, waiting on stdin, a runaway build) gets killed and
      // reported as a tool error instead of hanging the entire agent loop
      // with no way to recover — see RUN_SHELL_TIMEOUT_MS above.
      //
      // maxBuffer previously wasn't set (Node's default is 1MB), so any
      // command with heavier output (a real build, a verbose test run) was
      // killed with ENOBUFS and its output discarded entirely — the same
      // class of gap the timeout above was added for.
      //
      // `stdout || stderr` previously dropped stderr whenever stdout was
      // non-empty, even though plenty of real tools (tsc, pytest, cargo)
      // write diagnostics to stderr alongside normal stdout output — losing
      // exactly the information the model needs to judge whether a command
      // that "succeeded" (exit 0) actually did what was asked.
      //
      // A non-zero exit makes execAsync throw and discard err.stdout/
      // err.stderr entirely (only err.message survived before this) — so a
      // failing command's actual output, the one piece of information that
      // would tell the model WHY it failed, never reached it. Left to guess,
      // the model tends to retry the same failing command — exactly the
      // repetitive-call pattern the circuit breaker (selfHeal.ts) exists to
      // catch, treating a *knowable* cause as an unrecoverable loop instead.
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: projectRoot,
          timeout: RUN_SHELL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { content: [stdout, stderr].filter(Boolean).join("\n") || "(exit 0, no output)" };
      } catch (err: any) {
        const body = [err.stdout, err.stderr].filter(Boolean).join("\n");
        throw new Error(body ? `exit ${err.code ?? "?"}: ${body}` : err.message);
      }
    }
    case "browser_list_tabs":
      // Defensive: a disabled browser tool isn't in activeToolDefs(), so
      // the model is never offered it — but a stale tool call replayed
      // from a checkpoint/resume could still reach here, and failing with
      // a readable reason beats a confusing CDP connection error.
      if (!browserToolsEnabled) throw new Error(BROWSER_DISABLED_MESSAGE);
      return { content: await browser.listTabs(browserConfig) };
    case "browser_navigate":
      if (!browserToolsEnabled) throw new Error(BROWSER_DISABLED_MESSAGE);
      return { content: await browser.navigate(browserConfig, args.url, args.target_id) };
    case "browser_eval":
      if (!browserToolsEnabled) throw new Error(BROWSER_DISABLED_MESSAGE);
      return { content: await browser.evaluate(browserConfig, args.expression, args.target_id) };
    case "browser_screenshot": {
      if (!browserToolsEnabled) throw new Error(BROWSER_DISABLED_MESSAGE);
      const path = args.path ?? join(browserScreenshotDir, `${Date.now()}.png`);
      return { content: await browser.screenshot(browserConfig, path, args.target_id) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
