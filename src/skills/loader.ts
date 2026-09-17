import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

const DEFAULT_OWN_SKILL = `---
trigger: user asks to write or update tests for changed code
---

# Write tests for changes

When a code change touches logic (not just docs/comments), check whether
existing tests cover it. If not, add a focused test for the new behavior
rather than expanding scope elsewhere. Run the test suite afterward and
report the result — don't claim success without having run it.
`;

/** Skills are lazily loaded: only the name+trigger index is read up front
 *  (§5). Reuses `.llamacli/skills/*.md` and Claude Code's `.claude/skills/`
 *  when present; generates one starter skill of our own only when neither
 *  convention has anything in this project. */
export async function loadSkillIndex(projectRoot: string): Promise<SkillIndexEntry[]> {
  const index = [...(await loadOwnSkillIndex(projectRoot)), ...(await loadClaudeCodeSkillIndex(projectRoot))];
  if (index.length > 0) return index;

  const dir = join(projectRoot, OWN_SKILLS_DIR);
  const path = join(dir, "write-tests.md");
  await mkdir(dir, { recursive: true });
  await writeFile(path, DEFAULT_OWN_SKILL, "utf8");
  return [{ name: "write-tests", trigger: "user asks to write or update tests for changed code", path }];
}

export async function loadSkillBody(entry: SkillIndexEntry): Promise<string> {
  return readFile(entry.path, "utf8");
}

export function injectRulesIntoSystemPrompt(basePrompt: string, rules: RuleFile[]): string {
  if (rules.length === 0) return basePrompt;
  const ruleText = rules.map((r) => `--- ${r.path} ---\n${r.content}`).join("\n\n");
  return `${basePrompt}\n\n# Project Rules (always apply)\n${ruleText}`;
}
