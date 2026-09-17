import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, loadSkillIndex, injectRulesIntoSystemPrompt } from "./loader.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadRules generates llamacli's own default rule when no convention exists", () =>
  withTempDir(async (dir) => {
    const rules = await loadRules(dir);
    assert.equal(rules.length, 1);
    assert.match(rules[0].path, /\.llamacli[/\\]rules[/\\]00-core\.md$/);
    // it should also have been written to disk, not just returned in memory
    assert.equal(await readFile(rules[0].path, "utf8"), rules[0].content);
  }));

test("loadRules reuses an existing CLAUDE.md instead of generating its own default", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, "CLAUDE.md"), "# project memory\nAlways run tests.\n", "utf8");
    const rules = await loadRules(dir);
    assert.equal(rules.length, 1);
    assert.match(rules[0].path, /CLAUDE\.md$/);
    assert.match(rules[0].content, /Always run tests/);
  }));

test("loadRules merges multiple existing conventions rather than picking just one", () =>
  withTempDir(async (dir) => {
    await writeFile(join(dir, "CLAUDE.md"), "claude rules", "utf8");
    await writeFile(join(dir, "GEMINI.md"), "gemini rules", "utf8");
    await writeFile(join(dir, ".cursorrules"), "cursor rules", "utf8");
    const rules = await loadRules(dir);
    assert.equal(rules.length, 3);
    const contents = rules.map((r) => r.content);
    assert.ok(contents.includes("claude rules"));
    assert.ok(contents.includes("gemini rules"));
    assert.ok(contents.includes("cursor rules"));
  }));

test("loadRules reads .llamacli/rules/ as a directory of multiple files", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli", "rules"), { recursive: true });
    await writeFile(join(dir, ".llamacli", "rules", "a.md"), "rule a", "utf8");
    await writeFile(join(dir, ".llamacli", "rules", "b.md"), "rule b", "utf8");
    const rules = await loadRules(dir);
    assert.equal(rules.length, 2);
  }));

test("injectRulesIntoSystemPrompt leaves the base prompt untouched when there are no rules", () => {
  assert.equal(injectRulesIntoSystemPrompt("base", []), "base");
});

test("injectRulesIntoSystemPrompt appends every rule's path and content", () => {
  const out = injectRulesIntoSystemPrompt("base", [{ path: "/a.md", content: "do X" }]);
  assert.match(out, /^base/);
  assert.match(out, /\/a\.md/);
  assert.match(out, /do X/);
});

test("loadSkillIndex always includes llamacli's built-in skill set", () =>
  withTempDir(async (dir) => {
    const index = await loadSkillIndex(dir);
    const names = index.map((s) => s.name);
    for (const expected of [
      "architecture-design",
      "planning",
      "implementation",
      "code-review",
      "whitebox-testing",
      "blackbox-testing",
      "static-analysis",
      "security",
    ]) {
      assert.ok(names.includes(expected), `expected built-in skill "${expected}" to be loaded`);
    }
    // every built-in skill must carry a non-empty trigger so matching can work
    for (const entry of index) {
      assert.ok(entry.trigger.length > 0, `skill "${entry.name}" has an empty trigger`);
    }
  }));

test("loadSkillIndex merges the project's own .llamacli/skills on top of built-ins", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".llamacli", "skills"), { recursive: true });
    await writeFile(
      join(dir, ".llamacli", "skills", "custom.md"),
      "---\ntrigger: user asks for the custom thing\n---\nbody",
      "utf8"
    );
    const index = await loadSkillIndex(dir);
    const custom = index.find((s) => s.name === "custom");
    assert.ok(custom);
    assert.equal(custom!.trigger, "user asks for the custom thing");
    // built-ins should still be present alongside it
    assert.ok(index.some((s) => s.name === "security"));
  }));

test("loadSkillIndex reads Claude Code's .claude/skills/<name>/SKILL.md convention", () =>
  withTempDir(async (dir) => {
    await mkdir(join(dir, ".claude", "skills", "pdf-fill"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "pdf-fill", "SKILL.md"),
      "---\nname: pdf-fill\ndescription: fill out PDF forms\n---\nbody",
      "utf8"
    );
    const index = await loadSkillIndex(dir);
    const found = index.find((s) => s.name === "pdf-fill");
    assert.ok(found);
    assert.equal(found!.trigger, "fill out PDF forms");
  }));
