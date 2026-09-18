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

/** The text that actually counts toward a message's size in the real
 *  request. An assistant message requesting tool calls has `content: null`
 *  — the real payload sent to the backend lives entirely in
 *  `tool_calls[].function.{name,arguments}` instead, which every estimator
 *  here previously ignored completely (treated as ""). In a tool-heavy
 *  session (this agent calls run_shell/read_file/etc. constantly) that's
 *  not a rounding error — it undercounts a large fraction of the real
 *  conversation, so `shouldCompact` kept saying "plenty of room" right up
 *  until the backend hard-rejected the request with `exceeds the available
 *  context size` (seen live: 65,636 real tokens against a 65,536 window,
 *  repeating on retry since nothing had actually shrunk). Include tool call
 *  name+arguments so the estimate reflects what's actually being sent. */
function messageText(m: ChatMessage): string {
  const content = typeof m.content === "string" ? m.content : "";
  const toolCalls = (m.tool_calls ?? [])
    .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
    .join("\n");
  return toolCalls ? `${content}\n${toolCalls}` : content;
}

function charBasedEstimate(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + messageText(m).length, 0);
  return Math.ceil(chars / 4);
}

/** Uses the backend's real tokenizer (llama.cpp `/tokenize`) when available;
 *  falls back to a chars/4 approximation when the backend has no tokenizer
 *  or the call fails (e.g. a generic OpenAI-compatible endpoint without it). */
export async function estimateTokens(messages: ChatMessage[], backend?: ModelBackend): Promise<number> {
  if (backend?.tokenize) {
    try {
      const text = messages.map(messageText).join("\n");
      return await backend.tokenize(text);
    } catch {
      // tokenizer unavailable/errored — fall through to the approximation
    }
  }
  return charBasedEstimate(messages);
}

export async function shouldCompact(
  messages: ChatMessage[],
  thresholds: CompactionThresholds,
  backend?: ModelBackend
): Promise<boolean> {
  const used = await estimateTokens(messages, backend);
  return used >= thresholds.contextWindowTokens * thresholds.autoTriggerRatio;
}

/**
 * The summary request is a plain (non-tool) completion call, but
 * `toSummarize` is an arbitrary slice of the real conversation and can end
 * — or contain — an assistant message with `tool_calls` that isn't followed
 * by its matching `tool` role responses (those may have landed in the kept
 * tail instead). Sending that as-is gets rejected by at least one real
 * backend with "Cannot continue an assistant message that contains tool
 * calls" (400). Rather than trying to align the slice to turn boundaries
 * (fragile — the boundary depends on exact message-count patterns), strip
 * every tool_calls/tool-role message down to plain describable text so the
 * summary request never contains anything tool-related to validate.
 */
function sanitizeForSummary(messages: ChatMessage[]): ChatMessage[] {
  const converted = messages.map((m): ChatMessage => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls
        .map((tc) => `[called tool ${tc.function.name} with ${tc.function.arguments}]`)
        .join(" ");
      return { role: "assistant", content: [m.content, calls].filter(Boolean).join(" ") };
    }
    if (m.role === "tool") {
      return { role: "assistant", content: `[tool result] ${m.content ?? ""}` };
    }
    return m;
  });

  // Converting tool_calls/tool messages to role:"assistant" can leave
  // consecutive assistant messages where there weren't any before (e.g. a
  // plain assistant reply immediately followed by what used to be a
  // tool_calls message). At least one real backend also rejects "2 or more
  // assistant messages at the end of the list" — merge any run of
  // same-role messages into one so the request's role sequence is never
  // stricter-than-expected regardless of where in the slice this happens.
  const merged: ChatMessage[] = [];
  for (const m of converted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === "string" && typeof m.content === "string") {
      prev.content = [prev.content, m.content].filter(Boolean).join("\n");
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
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
    ...sanitizeForSummary(toSummarize),
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
