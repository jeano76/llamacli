import { readFile, readdir } from "node:fs/promises";
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

const RULES_DIRS = [".llamacli/rules", ".clinerules"];
const SKILLS_DIR = ".llamacli/skills";

/** Rules are always-on: load full content and inject into the system prompt at session start. */
export async function loadRules(projectRoot: string): Promise<RuleFile[]> {
  const rules: RuleFile[] = [];
  for (const dir of RULES_DIRS) {
    const full = join(projectRoot, dir);
    try {
      const stat = await readdir(full, { withFileTypes: true });
      for (const entry of stat) {
        if (entry.isFile()) {
          const path = join(full, entry.name);
          rules.push({ path, content: await readFile(path, "utf8") });
        }
      }
    } catch {
      // try as a single file instead of a directory
      try {
        rules.push({ path: full, content: await readFile(full, "utf8") });
      } catch {
        // neither exists — fine, no rules here
      }
    }
  }
  return rules;
}

/** Skills are lazily loaded: only the name+trigger index is read up front (§5). */
export async function loadSkillIndex(projectRoot: string): Promise<SkillIndexEntry[]> {
  const dir = join(projectRoot, SKILLS_DIR);
  const index: SkillIndexEntry[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const content = await readFile(path, "utf8");
      const triggerMatch = content.match(/^trigger:\s*(.+)$/m);
      index.push({
        name: entry.name.replace(/\.md$/, ""),
        trigger: triggerMatch?.[1] ?? "",
        path,
      });
    }
  } catch {
    // no skills directory yet
  }
  return index;
}

export async function loadSkillBody(entry: SkillIndexEntry): Promise<string> {
  return readFile(entry.path, "utf8");
}

export function injectRulesIntoSystemPrompt(basePrompt: string, rules: RuleFile[]): string {
  if (rules.length === 0) return basePrompt;
  const ruleText = rules.map((r) => `--- ${r.path} ---\n${r.content}`).join("\n\n");
  return `${basePrompt}\n\n# Project Rules (always apply)\n${ruleText}`;
}
