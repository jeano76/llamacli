/**
 * PROMPT.md §3 second bullet — self-improvement: accumulate failure patterns,
 * propose a rule update, and NEVER apply it without explicit user approval
 * (writing straight into .llamacli/rules/ unattended would be exactly the
 * kind of unattended, confident overwrite the user's CLINE delegation rules
 * warn against for headless agents — see ~/.claude/CLAUDE.md "모호한 지시는
 * 절대 위임 금지"). The proposal is always a *new* file, never an edit to an
 * existing rule, so approving it can never silently destroy prior rules.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ModelBackend } from "../backend/types.js";
import type { FailureLogEntry } from "./selfHeal.js";

export interface ImprovementProposal {
  /** Short human-readable summary shown to the user before they approve anything. */
  summary: string;
  /** The rule file content itself (markdown), ready to write if approved. */
  ruleMarkdown: string;
  failureCount: number;
  /** The grouping key this proposal was drafted from — stable across repeat
   *  occurrences of the same pattern (unlike `summary`, whose count changes
   *  each time), so callers can dedupe "already logged this one" cheaply. */
  signature: string;
}

const MIN_FAILURES_TO_PROPOSE = 2;

/** Groups failures by tool + a normalized error signature so a single
 *  recurring problem (not N unrelated one-off errors) drives the proposal. */
function groupFailures(entries: readonly FailureLogEntry[]): Map<string, FailureLogEntry[]> {
  const groups = new Map<string, FailureLogEntry[]>();
  for (const entry of entries) {
    // Strip obvious variable parts (paths, numbers) so near-identical errors
    // land in the same bucket instead of each counting as "only happened once".
    const signature = `${entry.toolName}:${entry.errorMessage.replace(/[0-9]+|\/[^\s:]+/g, "#")}`;
    const bucket = groups.get(signature) ?? [];
    bucket.push(entry);
    groups.set(signature, bucket);
  }
  return groups;
}

/**
 * Analyzes the accumulated failure log and, if a pattern recurs often enough
 * to be worth a rule, asks the model to draft one. Returns null when there's
 * nothing worth proposing (too few/too scattered failures) — the caller
 * should treat that as "no proposal", not an error.
 */
export async function proposeImprovement(
  failureLog: readonly FailureLogEntry[],
  backend: ModelBackend,
  model: string
): Promise<ImprovementProposal | null> {
  if (failureLog.length === 0) return null;

  const groups = groupFailures(failureLog);
  const worst = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!worst || worst[1].length < MIN_FAILURES_TO_PROPOSE) return null;

  const [signature, occurrences] = worst;
  const examples = occurrences
    .slice(0, 5)
    .map((e) => `- [${e.timestamp}] ${e.toolName}: ${e.errorMessage}`)
    .join("\n");

  const request: ChatMessage[] = [
    {
      role: "system",
      content:
        "You draft a short project rule (markdown, 5-10 lines) that would have prevented a " +
        "recurring tool-call failure. Output ONLY the rule markdown — no preamble, no code " +
        "fences, no explanation. Start with a '# ' heading naming the failure pattern, then " +
        "state the concrete rule to follow to avoid it.",
    },
    {
      role: "user",
      content:
        `The following tool call failed ${occurrences.length} times with the same underlying ` +
        `pattern in this session:\n\n${examples}\n\nDraft the rule.`,
    },
  ];

  const res = await backend.chat({ model, messages: request, stream: false });
  const ruleMarkdown = res.choices[0]?.message.content?.trim() ?? "";
  if (!ruleMarkdown) return null;

  return {
    summary: `"${occurrences[0].toolName}" failed with the same pattern ${occurrences.length} times. Proposing a new rule.`,
    ruleMarkdown,
    failureCount: occurrences.length,
    signature,
  };
}

/** Writes an approved proposal as a NEW rule file — never overwrites an
 *  existing one, so approving a bad proposal can't destroy prior rules. */
export async function writeProposedRule(projectRoot: string, proposal: ImprovementProposal): Promise<string> {
  const dir = join(projectRoot, ".llamacli", "rules");
  await mkdir(dir, { recursive: true });
  const filename = `hermes-proposed-${Date.now()}.md`;
  const path = join(dir, filename);
  await writeFile(path, proposal.ruleMarkdown + "\n", "utf8");
  return path;
}

/**
 * Real-time analysis journal: a running, append-only Markdown log of every
 * recurring pattern Hermes noticed during the session, written as soon as
 * it's detected — not just when the user runs /improve or quits. This is
 * purely a *record*, never auto-loaded as a rule and never fed back into
 * the system prompt, so appending to it doesn't change agent behavior on
 * its own (that still always requires the explicit /improve-apply
 * approval step — see the module docstring). Safe to call repeatedly;
 * callers should dedupe on `ImprovementProposal.signature` themselves
 * (e.g. AgentLoop only logs a given signature once per session) so a
 * still-recurring pattern doesn't spam the file on every new occurrence.
 */
export async function appendImprovementLog(projectRoot: string, proposal: ImprovementProposal): Promise<string> {
  const dir = join(projectRoot, ".llamacli", "state");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "improvement-log.md");
  const entry =
    `## ${new Date().toISOString()}\n\n` +
    `${proposal.summary}\n\n` +
    `${proposal.ruleMarkdown}\n\n---\n\n`;
  await appendFile(path, entry, "utf8");
  return path;
}
