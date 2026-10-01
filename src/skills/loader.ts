import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillIndexEntry {
  name: string;
  trigger: string; // one-line description used to decide relevance
  path: string;
}

export interface RuleFile {
  path: string;
  content: string;
}

/**
 * PROMPT.md §5: reuse whatever rule/skill convention an existing AI coding
 * CLI already left in this project, instead of forcing everyone onto
 * llamacli's own format. Every source that exists gets loaded (a project
 * may have several); llamacli's own `.llamacli/rules/` is generated as a
 * fallback only when NONE of these are present.
 */
const RULE_SOURCES = [
  ".llamacli/rules", // llamacli's own
  ".clinerules", // Cline
  "CLAUDE.md", // Claude Code project memory
  "GEMINI.md", // Gemini CLI project memory
  ".cursorrules", // Cursor
  ".windsurfrules", // Windsurf
  "AGENTS.md", // emerging cross-CLI convention (Codex CLI and others)
  ".github/copilot-instructions.md", // GitHub Copilot
];

const OWN_SKILLS_DIR = ".llamacli/skills";
/** Claude Code's skill convention: one subdirectory per skill, each with a
 *  SKILL.md carrying `name`/`description` YAML frontmatter. */
const CLAUDE_CODE_SKILLS_DIR = ".claude/skills";
/** Skills llamacli ships with itself (PROMPT.md §4/§5): a coding agent
 *  should have these fundamentals built in regardless of what a given
 *  project provides. Resolved relative to this module so it works the same
 *  whether running from src/ (tsx) or dist/ (built). */
const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "builtin");

function extractFrontmatterField(content: string, field: string): string {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const scope = frontmatter?.[1] ?? content;
  const match = scope.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

async function loadRuleSource(projectRoot: string, source: string): Promise<RuleFile[]> {
  const full = join(projectRoot, source);
  try {
    const entries = await readdir(full, { withFileTypes: true });
    const rules: RuleFile[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const path = join(full, entry.name);
        rules.push({ path, content: await readFile(path, "utf8") });
      }
    }
    return rules;
  } catch {
    // not a directory — try it as a single file
    try {
      return [{ path: full, content: await readFile(full, "utf8") }];
    } catch {
      return []; // this source doesn't exist in this project — fine
    }
  }
}

const DEFAULT_OWN_RULE = `# Core rules (always applied)

- Read the relevant code before changing it. Never edit based on guesswork.
- Don't add refactors or abstractions beyond what was asked for.
- Confirm with the user before destructive commands (file deletion, force-push, etc).
- Verify changes afterward with tests/typecheck whenever possible.
`;

/** Rules are always-on: load full content and inject into the system prompt
 *  at session start. Reuses whatever convention already exists in the
 *  project (§5); only falls back to generating llamacli's own default rule
 *  file when literally none of the known conventions are present. */
export async function loadRules(projectRoot: string): Promise<RuleFile[]> {
  const rules: RuleFile[] = [];
  for (const source of RULE_SOURCES) {
    rules.push(...(await loadRuleSource(projectRoot, source)));
  }
  if (rules.length > 0) return rules;

  // Nothing from any known CLI convention — generate our own default so the
  // agent always has a baseline project rule to work from.
  const path = join(projectRoot, ".llamacli", "rules", "00-core.md");
  await mkdir(join(projectRoot, ".llamacli", "rules"), { recursive: true });
  await writeFile(path, DEFAULT_OWN_RULE, "utf8");
  return [{ path, content: DEFAULT_OWN_RULE }];
}

async function loadOwnSkillIndex(projectRoot: string): Promise<SkillIndexEntry[]> {
  const dir = join(projectRoot, OWN_SKILLS_DIR);
  const index: SkillIndexEntry[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const content = await readFile(path, "utf8");
      index.push({
        name: entry.name.replace(/\.md$/, ""),
        trigger: extractFrontmatterField(content, "trigger"),
        path,
      });
    }
  } catch {
    // no .llamacli/skills directory
  }
  return index;
}

/** Claude Code convention: `.claude/skills/<name>/SKILL.md` with
 *  `name`/`description` frontmatter — description doubles as the trigger. */
async function loadClaudeCodeSkillIndex(projectRoot: string): Promise<SkillIndexEntry[]> {
  const dir = join(projectRoot, CLAUDE_CODE_SKILLS_DIR);
  const index: SkillIndexEntry[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      try {
        const content = await readFile(path, "utf8");
        index.push({
          name: extractFrontmatterField(content, "name") || entry.name,
          trigger: extractFrontmatterField(content, "description"),
          path,
        });
      } catch {
        // this subdirectory has no SKILL.md — skip it
      }
    }
  } catch {
    // no .claude/skills directory
  }
  return index;
}

/** llamacli's built-in skill set: architecture design, planning,
 *  implementation, code review, white-box/black-box testing, static
 *  analysis, security. Always loaded, independent of what the project has —
 *  these are the "senior engineer fundamentals" PROMPT.md §4 asks for. */
async function loadBuiltinSkillIndex(): Promise<SkillIndexEntry[]> {
  const index: SkillIndexEntry[] = [];
  try {
    const entries = await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(BUILTIN_SKILLS_DIR, entry.name);
      const content = await readFile(path, "utf8");
      index.push({
        name: entry.name.replace(/\.md$/, ""),
        trigger: extractFrontmatterField(content, "trigger"),
        path,
      });
    }
  } catch {
    // shouldn't happen (shipped with the package), but don't crash the CLI over it
  }
  return index;
}

/** Skills are lazily loaded: only the name+trigger index is read up front
 *  (§5). Always includes llamacli's built-in skill set, plus whatever the
 *  project itself provides via `.llamacli/skills/*.md` or Claude Code's
 *  `.claude/skills/`. */
export async function loadSkillIndex(projectRoot: string): Promise<SkillIndexEntry[]> {
  return [
    ...(await loadBuiltinSkillIndex()),
    ...(await loadOwnSkillIndex(projectRoot)),
    ...(await loadClaudeCodeSkillIndex(projectRoot)),
  ];
}

export async function loadSkillBody(entry: SkillIndexEntry): Promise<string> {
  return readFile(entry.path, "utf8");
}

/**
 * Hard ceiling on how many characters of project rules may go into the system
 * prompt.
 *
 * Rules are injected into the SYSTEM message, and compaction never shrinks it:
 * `composeSystemMessage` (compaction/compactor.ts) keeps `splitSystemMessage`'s
 * `base` verbatim and only ever replaces the summary block that follows it. So
 * whatever lands here is a permanent floor for every request in the session —
 * unbounded growth is not recoverable the way conversation history is.
 *
 * That was a live bug: `writeProposedRule` (hermes/selfImprove.ts) wrote a NEW
 * `hermes-proposed-<timestamp>.md` for every applied proposal, `loadRules`
 * reads every file in `.llamacli/rules/`, and the old injection concatenated
 * all of them. Each /improve-apply therefore permanently raised the baseline,
 * and when context filled up the compactor could only drop summary/tail — the
 * rules stayed. This budget makes the growth structurally impossible instead of
 * merely unlikely. Kept generous (roughly 8-10K tokens) so a real CLAUDE.md
 * still fits whole; only a runaway pile-up gets truncated.
 */
export const MAX_RULE_PROMPT_CHARS = 32_000;

/**
 * Injects rules into the system prompt under a total character budget.
 *
 * Files are added in the order `loadRules` produced them (its RULE_SOURCES
 * order, then readdir order within a directory) until the budget is spent;
 * the rest are dropped with an explicit, visible marker. Rules are truncated
 * per-file at the boundary rather than the whole list being dropped, so one
 * huge file can't silently push every later rule out of the prompt.
 */
export function injectRulesIntoSystemPrompt(
  basePrompt: string,
  rules: RuleFile[],
  maxChars: number = MAX_RULE_PROMPT_CHARS
): string {
  if (rules.length === 0) return basePrompt;

  const header = "# Project Rules (always apply)";
  const TRUNCATION_NOTE = "[truncated: rule exceeds the prompt budget]";
  // Reserved up front so the trailing "N files omitted" marker can never push
  // the block past maxChars. It is kept short by naming at most a few paths —
  // without that, a directory with 50 rule files would need ~700 chars of
  // marker, which is exactly the kind of unbounded term the budget exists to
  // rule out.
  const MARKER_RESERVE = 320;
  const MAX_OMITTED_NAMES = 5;

  // What the header itself costs, so the budget covers the whole injected
  // block rather than silently overshooting by the header + separators.
  let used = header.length + 2;
  const parts: string[] = [];
  const omitted: string[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const block = `--- ${rule.path} ---\n${rule.content}`;
    const cost = block.length + 2;
    if (used + cost + MARKER_RESERVE <= maxChars) {
      parts.push(block);
      used += cost;
      continue;
    }

    // Doesn't fit whole. Take as much of this one file as still leaves room
    // for both markers, cut at a line boundary so the prompt never ends
    // mid-sentence.
    const prefix = `--- ${rule.path} ---\n`;
    const suffix = `\n${TRUNCATION_NOTE}`;
    const bodyRoom = maxChars - used - MARKER_RESERVE - prefix.length - suffix.length;
    if (bodyRoom > 200) {
      const cut = rule.content.slice(0, bodyRoom);
      const lastNewline = cut.lastIndexOf("\n");
      const body = (lastNewline > 0 ? cut.slice(0, lastNewline) : cut).trimEnd();
      if (body) {
        const partial = prefix + body + suffix;
        parts.push(partial);
        used += partial.length + 2;
      }
    }
    // This one is only partly in, so it counts as omitted too — and so does
    // every rule after it, which never got considered.
    for (let j = i; j < rules.length; j++) omitted.push(rules[j].path);
    break;
  }

  let ruleText = parts.join("\n\n");
  if (omitted.length > 0) {
    const shown = omitted.slice(0, MAX_OMITTED_NAMES);
    const more = omitted.length - shown.length;
    ruleText +=
      `\n\n[${omitted.length} further rule file(s) omitted to stay within the context budget: ` +
      `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}]`;
  }
  return `${basePrompt}\n\n${header}\n${ruleText}`;
}

/** Lists the available skills' names + triggers (never their full bodies —
 *  those stay lazily loaded via the `load_skill` tool, per §5) so the model
 *  actually knows they exist. Before this, loadSkillIndex()'s result was
 *  used only to print a list for the human in `/skills` — the model itself
 *  had no way to learn a skill existed, since neither the index nor a way
 *  to fetch a skill's body ever reached the system prompt or the tool
 *  list. The 8 builtin skills (planning, code-review, security, ...) were
 *  fully wired up on the loader/build side and effectively dead code from
 *  the model's perspective. */
export function injectSkillIndexIntoSystemPrompt(basePrompt: string, skills: SkillIndexEntry[]): string {
  if (skills.length === 0) return basePrompt;
  const list = skills.map((s) => `- ${s.name}: ${s.trigger}`).join("\n");
  return `${basePrompt}\n\n# Available Skills\nCall the load_skill tool with one of these names when its trigger matches the current task:\n${list}`;
}
