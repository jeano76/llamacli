import type { ChatMessage } from "../backend/types.js";
import type { ModelBackend } from "../backend/types.js";
import { Checkpoint, readCheckpoint, writeCheckpoint } from "./checkpoint.js";

export interface CompactionThresholds {
  /** Fraction of the model's context window (0-1) that triggers auto-compaction. */
  autoTriggerRatio: number;
  contextWindowTokens: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  checkpoint: Checkpoint;
}

/** Very rough token estimate until a real tokenizer is wired in (llama.cpp /tokenize). */
export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
  return Math.ceil(chars / 4);
}

export function shouldCompact(messages: ChatMessage[], thresholds: CompactionThresholds): boolean {
  const used = estimateTokens(messages);
  return used >= thresholds.contextWindowTokens * thresholds.autoTriggerRatio;
}

/**
 * PROMPT.md §2: write the checkpoint FIRST (before summarizing anything), then
 * ask the model to summarize the older turns, keeping mustPreserve items intact.
 */
export async function runCompaction(
  projectRoot: string,
  messages: ChatMessage[],
  backend: ModelBackend,
  model: string,
  partialCheckpoint: Omit<Checkpoint, "version" | "timestamp">
): Promise<CompactionResult> {
  const checkpoint: Checkpoint = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...partialCheckpoint,
  };
  await writeCheckpoint(projectRoot, checkpoint);

  const keepTail = messages.slice(-6); // keep the most recent turns verbatim
  const toSummarize = messages.slice(0, -6);

  const summaryRequest: ChatMessage[] = [
    {
      role: "system",
      content:
        "Summarize the following conversation for context compaction. " +
        "Preserve verbatim any user-stated constraints, decisions, and the following " +
        "must-preserve facts:\n" + checkpoint.mustPreserve.join("\n"),
    },
    ...toSummarize,
  ];

  const res = await backend.chat({ model, messages: summaryRequest, stream: false });
  const summaryText = res.choices[0]?.message.content ?? "(summary unavailable)";

  const compactedMessages: ChatMessage[] = [
    { role: "system", content: `[Compacted history summary]\n${summaryText}` },
    ...keepTail,
  ];

  return { messages: compactedMessages, checkpoint };
}

/**
 * PROMPT.md §2.4: after compaction, read the checkpoint back and produce a
 * short resume announcement + the injected system reminder that drives the
 * agent to continue the interrupted work rather than wait for new input.
 */
export async function buildResumePrompt(projectRoot: string): Promise<string | null> {
  const checkpoint = await readCheckpoint(projectRoot);
  if (!checkpoint) return null;

  const remaining = checkpoint.steps.filter((s) => s.status !== "done");
  const lines = [
    `[resuming after compaction] previous goal: ${checkpoint.goal}`,
    remaining.length
      ? `remaining steps:\n${remaining.map((s) => `- (${s.status}) ${s.description}`).join("\n")}`
      : "All steps were already done — re-verifying before wrapping up.",
    checkpoint.pendingToolCall
      ? `interrupted tool call: ${checkpoint.pendingToolCall.name} (${checkpoint.pendingToolCall.reason})`
      : "",
    checkpoint.files.length
      ? `files touched:\n${checkpoint.files.map((f) => `- (${f.status}) ${f.path}`).join("\n")}`
      : "",
  ].filter(Boolean);

  return lines.join("\n\n");
}
