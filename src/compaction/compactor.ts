import type { ChatMessage, ToolDef } from "../backend/types.js";
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

function charBasedEstimate(messages: ChatMessage[], extraText: string): number {
  const chars = messages.reduce((sum, m) => sum + messageText(m).length, 0) + extraText.length;
  return Math.ceil(chars / 4);
}

/** Uses the backend's real tokenizer (llama.cpp `/tokenize`) when available;
 *  falls back to a chars/4 approximation when the backend has no tokenizer
 *  or the call fails (e.g. a generic OpenAI-compatible endpoint without it).
 *
 *  `extraText` covers request payload that isn't part of `messages` at all
 *  but is still sent, and still costs real tokens — specifically the tool
 *  definitions schema (`TOOL_DEFS` in loop.ts), sent on every main-loop
 *  request. Found live: real usage (per llama-server's own reported
 *  n_tokens) kept running measurably past this project's compaction
 *  threshold before a compaction ever fired. Measured directly: the tool
 *  schema JSON alone tokenizes to 626 real tokens — sent on every single
 *  request, and never counted here at all before this, silently
 *  undercounting every threshold check by that much. Callers that don't
 *  send tools (the compaction summary request itself) simply omit this. */
export async function estimateTokens(
  messages: ChatMessage[],
  backend?: ModelBackend,
  extraText = "",
  tools?: ToolDef[]
): Promise<number> {
  // Ask the backend what the prompt ACTUALLY costs (messages rendered
  // through its own chat template, tools section included) before falling
  // back to anything approximate. Measured: tokenizing concatenated
  // message text + the raw tools JSON — the previous best effort, and
  // still the fallback below — undercounts the real prompt by ~19% on a
  // modest conversation and by more as messages accumulate, because the
  // template wraps every message in role markers and injects a tool-use
  // instruction preamble that appears nowhere in the raw text. That
  // undercount is what sized max_tokens too generously and produced a run
  // of live "request (20,521 tokens) exceeds the available context size
  // (16,384 tokens)" rejections: prompt + max_tokens was computed against
  // a number thousands of tokens below reality.
  if (backend?.countPromptTokens) {
    try {
      return await backend.countPromptTokens(messages, tools);
    } catch {
      // no /apply-template (non-llama.cpp backend) — fall through
    }
  }
  if (backend?.tokenize) {
    try {
      const text = [...messages.map(messageText), extraText].join("\n");
      return await backend.tokenize(text);
    } catch {
      // tokenizer unavailable/errored — fall through to the approximation
    }
  }
  return charBasedEstimate(messages, extraText);
}

export async function shouldCompact(
  messages: ChatMessage[],
  thresholds: CompactionThresholds,
  backend?: ModelBackend,
  extraText = "",
  tools?: ToolDef[]
): Promise<boolean> {
  const used = await estimateTokens(messages, backend, extraText, tools);
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
 * Picks how much of the recent conversation to keep verbatim (unsummarized)
 * based on an actual SIZE budget, not a fixed message count. A hardcoded
 * "keep the last 6 messages" (the previous approach) can itself already be
 * at or past the entire context window if those 6 happen to be large (a
 * tool-heavy turn with sizable tool_calls/results — routine, not an edge
 * case) — found via a scenario test simulating many long developer
 * sessions: compaction kept reporting "no progress" because the kept tail
 * alone didn't shrink no matter how aggressively older history got
 * summarized away, permanently failing turns that should have recovered.
 * Always keeps at least the single most recent message (there's no better
 * option if even that alone is oversized — the tool_calls-aware size cap
 * upstream in loop.ts is what actually bounds any one message).
 */
// The fraction of contextWindowTokens the kept tail is allowed to occupy.
// Exported so loop.ts's overflow-retry path can pass a SMALLER value on a
// retry (see runCompaction's tailBudgetFraction param below) instead of
// giving up the instant one compaction attempt fails to shrink anything.
export const DEFAULT_TAIL_BUDGET_FRACTION = 0.4;
// Loop.ts's own main-turn request always reserves this fraction of the
// window for max_tokens (the reply about to be generated) — see loop.ts's
// `max_tokens: Math.max(512, Math.floor(...* 0.25))`. The kept tail and
// that reservation were previously computed completely independently, so
// a "successful" compaction could still leave (tail + reserved-reply) at
// or past the ENTIRE window on its own, before the system prompt or tool
// schema even entered the picture — found live: two compaction passes in
// a row both reported "no progress" and the turn failed outright, on a
// 16384-token window, because the 40%-of-window tail floor alone (6553
// tokens) plus the 25%-of-window reply reservation (4096 tokens) already
// summed past what was actually available once the (necessarily
// preserved, see the system-prompt-survival fix elsewhere in this file)
// system prompt and the ~626-token tool schema were added on top.
const NEXT_REPLY_RESERVED_FRACTION = 0.25;

function selectKeptTail(
  messages: ChatMessage[],
  contextWindowTokens: number,
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION
): { keepTail: ChatMessage[]; toSummarize: ChatMessage[] } {
  const availableForTail = Math.max(
    1,
    Math.floor(contextWindowTokens * (1 - NEXT_REPLY_RESERVED_FRACTION))
  );
  const budgetChars = Math.max(1, Math.floor(availableForTail * 4 * tailBudgetFraction));
  let used = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = messageText(messages[i]).length;
    if (cutIndex < messages.length && used + len > budgetChars) break;
    used += len;
    cutIndex = i;
  }
  return { keepTail: messages.slice(cutIndex), toSummarize: messages.slice(0, cutIndex) };
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
  partialCheckpoint: Omit<Checkpoint, "version" | "timestamp">,
  contextWindowTokens: number,
  // Lets a caller retry with a tighter tail — see loop.ts's overflow-retry
  // loop, which halves this on each attempt that fails to shrink anything,
  // rather than giving up after just one non-improving compaction.
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION
): Promise<CompactionResult> {
  const checkpoint: Checkpoint = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...partialCheckpoint,
  };
  await writeCheckpoint(projectRoot, checkpoint);

  const { keepTail, toSummarize } = selectKeptTail(messages, contextWindowTokens, tailBudgetFraction);

  // No caller currently populates mustPreserve (loop.ts always passes []) —
  // rather than silently referencing an always-empty list ("...and the
  // following must-preserve facts:\n" followed by nothing, which reads as
  // an incomplete/truncated instruction to the model), only mention it when
  // there's actually something there.
  const mustPreserveClause = checkpoint.mustPreserve.length
    ? ` and the following must-preserve facts:\n${checkpoint.mustPreserve.join("\n")}`
    : ".";
  const summaryRequest: ChatMessage[] = [
    {
      role: "system",
      content:
        "Summarize the following conversation for context compaction. " +
        "Preserve verbatim any user-stated constraints, decisions" + mustPreserveClause,
    },
    ...sanitizeForSummary(toSummarize),
  ];

  // Never leave this unset — same reasoning, and the exact same failure
  // mode, as loop.ts's main-turn request: without max_tokens, llama-server
  // defaults to n_predict=-1 (unbounded), and if the model never emits a
  // natural stop token (a degenerate/repetition-loop generation, or simply
  // a model that likes to keep going), the summary request pins the single
  // inference slot indefinitely — blocking every other request, including
  // the very turn that triggered this compaction, with no visible error.
  // Caught live: GET /slots showed a summary request's n_decoded climbing
  // past 700 with max_tokens/n_predict both -1, `stream: false` (so
  // openaiClient.ts's own client-side streaming cap — added for exactly
  // this reason — never even applies here; this path bypasses it
  // entirely). Capped smaller than the main turn's own budget (a summary
  // should be concise by nature, not a full reply) but still scaled to the
  // real context window rather than a flat constant, same as loop.ts.
  const summaryMaxTokens = Math.max(256, Math.min(4096, Math.floor(contextWindowTokens * 0.25)));
  // Same reason as loop.ts's own turn request (see its comment): with
  // chain-of-thought on, the budget can be spent entirely on invisible
  // reasoning before any summary text is produced — and a compaction that
  // returns no usable summary is worse than useless, since the history it
  // replaced is already gone.
  const res = await backend.chat({
    model,
    messages: summaryRequest,
    stream: false,
    max_tokens: summaryMaxTokens,
    chat_template_kwargs: { enable_thinking: false },
  });
  const summaryText = res.choices[0]?.message.content ?? "(summary unavailable)";

  // Preserve the ORIGINAL system prompt (base prompt + injected .llamacli/rules),
  // not just the compaction summary. selectKeptTail() keeps only the size-budgeted
  // tail of `messages`, so the system prompt — always messages[0] — is otherwise
  // always pushed into `toSummarize` and replaced wholesale the moment a session
  // runs long enough to compact even once. Found live: after the first compaction,
  // the agent silently stopped following project rules injected at startup — no
  // error, just the rules being gone, since they'd been overwritten by the summary
  // text. Kept as ONE system message (not two): loop.ts already documents that a
  // second system-role message breaks chat-template-enforcing backends, so this
  // concatenates into the existing single system slot instead of adding another.
  const originalSystem = messages.find((m) => m.role === "system");
  const systemContent = [
    typeof originalSystem?.content === "string" ? originalSystem.content : "",
    `[Compacted history summary]\n${summaryText}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // keepTail's cut point is purely size-based and can land between a
  // `tool_calls`-bearing assistant message and its matching `tool` response,
  // leaving keepTail starting with a `tool` message that has no corresponding
  // tool_calls entry anywhere in the compacted result. At least one real
  // backend rejects that shape outright. sanitizeForSummary() already guards
  // against the equivalent problem for the summary REQUEST slice above; this
  // is the same fix applied to the slice that actually keeps being used
  // afterward. Reproduced directly: sweeping tool-result sizes from 100 to
  // 2000 chars found 1 case (out of 20) landing exactly on this boundary.
  let tail = keepTail;
  while (tail.length > 0 && tail[0].role === "tool") {
    tail = tail.slice(1);
  }

  const compactedMessages: ChatMessage[] = [{ role: "system", content: systemContent }, ...tail];

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
  // A checkpoint can now exist without any compaction ever having run
  // (see checkpoint.ts's "plan-progress" reason) — saying "after
  // compaction" for that case would be actively misleading about why the
  // agent seems to be picking up mid-task.
  const resumeReasonText = checkpoint.reason === "plan-progress" ? "resuming previous session" : "resuming after compaction";
  const lines = [
    `[${resumeReasonText}] previous goal: ${checkpoint.goal}`,
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
