import type { ChatMessage, ToolDef } from "../backend/types.js";
import type { ModelBackend } from "../backend/types.js";
import { Checkpoint, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { readNotes } from "./notes.js";

export interface CompactionThresholds {
  /** Fraction of the model's context window (0-1) that triggers auto-compaction. */
  autoTriggerRatio: number;
  contextWindowTokens: number;
}

/** What a compaction actually did to the conversation — requested directly
 *  so the TUI can show before/after instead of compaction being a black
 *  box ("어떤 내용들이 잊혀지고 어떤 내용들이 강조가 되게 되었는지"). */
export interface CompactionDetail {
  droppedCount: number;
  droppedTokens: number;
  /** One line per dropped message, "[role] first ~70 chars", capped —
   *  see DETAIL_PREVIEW_CAP. */
  droppedPreview: string[];
  keptCount: number;
  keptTokens: number;
  /** What replaced the dropped messages — the same text written to the
   *  checkpoint and the system prompt. */
  summary: string;
}

export interface CompactionResult {
  messages: ChatMessage[];
  checkpoint: Checkpoint;
  detail: CompactionDetail;
}

const DETAIL_PREVIEW_CAP = 8;

function previewLine(m: ChatMessage): string {
  const text = messageText(m).trim().replace(/\s+/g, " ");
  const snippet = text.length > 70 ? `${text.slice(0, 70)}…` : text || "(empty)";
  return `[${m.role}] ${snippet}`;
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

/**
 * Estimates the token weight of text, accounting for CJK (Hangul, Hanzi, Kana)
 * characters which consume ~1.5 to 2.5 tokens per character rather than 0.25 (chars/4).
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Hangul syllables & jamo: AC00-D7AF, 1100-11FF, 3130-318F
    // CJK Unified Ideographs: 4E00-9FFF
    // Hiragana/Katakana: 3040-30FF
    if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    }
  }
  const nonCjk = text.length - cjk;
  // CJK: ~1.5 tokens/char. Non-CJK (ASCII/Latin/punctuation): ~0.25 tokens/char (4 chars/token).
  return Math.ceil(cjk * 1.5 + nonCjk * 0.25);
}

function charBasedEstimate(messages: ChatMessage[], extraText: string): number {
  let cjk = 0;
  let totalLength = extraText.length;
  for (const m of messages) {
    const text = messageText(m);
    totalLength += text.length;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0x1100 && code <= 0x11ff) ||
        (code >= 0x3130 && code <= 0x318f) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff)
      ) {
        cjk++;
      }
    }
  }
  for (let i = 0; i < extraText.length; i++) {
    const code = extraText.charCodeAt(i);
    if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    }
  }
  const nonCjk = totalLength - cjk;
  return Math.ceil(cjk * 1.5 + nonCjk * 0.25);
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

export function selectKeptTail(
  messages: ChatMessage[],
  contextWindowTokens: number,
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION
): { keepTail: ChatMessage[]; toSummarize: ChatMessage[] } {
  // Only partition conversation messages (non-system), so messages[0] (system instructions)
  // is never included in toSummarize or duplicated into summaries.
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  if (nonSystemMessages.length === 0) {
    return { keepTail: [], toSummarize: [] };
  }

  const availableForTail = Math.max(
    1,
    Math.floor(contextWindowTokens * (1 - NEXT_REPLY_RESERVED_FRACTION))
  );
  const budgetTokens = Math.max(1, Math.floor(availableForTail * tailBudgetFraction));

  let usedTokens = 0;
  let cutIndex = nonSystemMessages.length;

  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const tokens = estimateTextTokens(messageText(nonSystemMessages[i]));
    if (cutIndex < nonSystemMessages.length && usedTokens + tokens > budgetTokens) break;
    usedTokens += tokens;
    cutIndex = i;
  }

  // Align cutIndex to a natural turn boundary: prefer starting keepTail at a user message
  // so the conversation doesn't start with a dangling assistant response or orphaned tool call.
  let alignedCutIndex = cutIndex;
  if (alignedCutIndex > 0 && alignedCutIndex < nonSystemMessages.length) {
    // If cut lands on an assistant or tool message, see if advancing to the next user message still keeps a tail
    if (nonSystemMessages[alignedCutIndex].role !== "user") {
      const nextUser = nonSystemMessages.findIndex((m, idx) => idx > alignedCutIndex && m.role === "user");
      if (nextUser !== -1) {
        alignedCutIndex = nextUser;
      }
    }
  }

  // Ensure at least the last message is kept
  if (alignedCutIndex >= nonSystemMessages.length && nonSystemMessages.length > 0) {
    alignedCutIndex = nonSystemMessages.length - 1;
  }

  return {
    keepTail: nonSystemMessages.slice(alignedCutIndex),
    toSummarize: nonSystemMessages.slice(0, alignedCutIndex),
  };
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
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION,
  // Lets the caller shrink the summary below its default cap so that
  // base prompt + summary + kept tail lands under the auto-trigger
  // threshold — see loop.ts compact().
  summaryMaxTokensCap?: number
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
  // selectKeptTail() never puts the system message into toSummarize (so the
  // base prompt isn't summarized into the summary and re-appended to itself
  // on every pass). originalSystemText already carries any previous summary
  // forward (composeSystemMessage stacks base + [Summary] on every pass), so
  // it doesn't need to be re-injected separately here as long as the system
  // message below is kept verbatim — see the cache-prefix note below.
  const originalSystem = messages.find((m) => m.role === "system");
  const originalSystemText = typeof originalSystem?.content === "string" ? originalSystem.content : "";
  const summaryInput = sanitizeForSummary(toSummarize);

  const defaultSummaryMaxTokens = Math.max(256, Math.min(4096, Math.floor(contextWindowTokens * 0.25)));
  const windowBasedCap = summaryMaxTokensCap
    ? Math.max(128, Math.min(defaultSummaryMaxTokens, summaryMaxTokensCap))
    : defaultSummaryMaxTokens;
  // Reported directly: "컴팩션을 전체를 하는게 아니라 실제 있는 데이터 만큼만
  // 하면 안될까" — windowBasedCap above is sized purely from the context
  // window, with zero regard for how much history is ACTUALLY being
  // summarized. A compaction firing early (a small autoTriggerRatio, or
  // just a quiet session with little to say) still got handed the full
  // window-sized budget, free to generate up to thousands of tokens
  // regardless of whether there were only a handful of short messages to
  // condense — wasting real generation time (and, worse, real turns at
  // the single inference slot other requests queue behind) on a summary
  // far longer than the source material could ever justify. A summary is
  // expected to meaningfully compress its input, so cap it at a fraction
  // of the ACTUAL input size too — whichever cap is tighter wins. Only
  // ever tightens windowBasedCap (a large `toSummarize` still falls back
  // to it via the outer Math.min), so the existing large-history behavior
  // is unchanged.
  const summaryInputTokens = summaryInput.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0);
  const SUMMARY_COMPRESSION_RATIO = 0.35;
  const summaryMaxTokens = Math.max(128, Math.min(windowBasedCap, Math.ceil(summaryInputTokens * SUMMARY_COMPRESSION_RATIO)));

  // The summary request is itself a request against the same window. On the
  // overflow-retry path the history being summarized can be close to the
  // whole window already, and prompt + summaryMaxTokens then overflows too,
  // so the compaction fails and nothing ever shrinks. Drop the oldest
  // messages (after the previous summary, which condenses them anyway)
  // until the input fits.
  const inputBudget = Math.max(256, contextWindowTokens - summaryMaxTokens - 512);
  while (
    summaryInput.length > 1 &&
    summaryInput.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0) > inputBudget
  ) {
    summaryInput.splice(0, 1);
  }

  // Reported directly: "컴팩션 하고나면 왜 다음 프롬프트시 시간이 소요가 되지?"
  // — the summary request used to open with a BRAND NEW system message
  // ("Summarize the following conversation...") instead of the real
  // originalSystemText the just-completed turn actually used. That made
  // this request's very first token diverge from everything llama-server
  // had cached, so it paid a full prefill of the entire toSummarize history
  // with zero cache reuse. Keeping originalSystemText verbatim as the
  // system message here means this request's prefix ([system] + toSummarize)
  // is byte-for-byte a PREFIX of the real turn that was just processed (that
  // turn's messages were [system, ...toSummarize, ...keepTail, ...]), so
  // llama-server's prompt cache can serve everything up through the end of
  // toSummarize from cache instead of recomputing it. The "please
  // summarize" instruction moves to a trailing user message instead of
  // living in the system role, since changing the system message is exactly
  // what would break that prefix match.
  const summaryRequest: ChatMessage[] = [
    { role: "system", content: originalSystemText },
    ...summaryInput,
  ];
  // The request must END with a user turn asking for the summary. When the
  // last message is an assistant one (usual here: sanitizeForSummary turns
  // tool calls and results into assistant text), llama-server treats it as
  // an assistant prefill and the model CONTINUES that message instead of
  // summarizing. Measured against the real backend: ending on the assistant
  // message returned an echo of the tool-call text; ending on a user
  // request returned an actual summary. Live, one compaction's summary
  // request generated a single token, so everything it replaced was lost.
  const SUMMARY_INSTRUCTION =
    "Summarize the conversation above for context compaction. Preserve verbatim any user-stated constraints, decisions" +
    mustPreserveClause +
    "\n\nNow write the summary of the conversation above. Output only the summary.";
  summaryRequest.push({ role: "user", content: SUMMARY_INSTRUCTION });

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
  const systemContent = composeSystemMessage(originalSystemText, summaryText);
  // Store the summary with the checkpoint too: a resume in a new process
  // (after /quit, a crash, a restart) has none of this conversation, and
  // without it the resumed model had only a goal line and a file list —
  // live, it answered "No response requested." and stopped.
  const finalCheckpoint: Checkpoint = res.choices[0]?.message.content ? { ...checkpoint, summary: summaryText } : checkpoint;
  if (finalCheckpoint !== checkpoint) await writeCheckpoint(projectRoot, finalCheckpoint);

  // keepTail's cut point is purely size-based and can land between a
  // `tool_calls`-bearing assistant message and its matching `tool` response,
  // leaving keepTail starting with a `tool` message that has no corresponding
  // tool_calls entry anywhere in the compacted result. At least one real
  // backend rejects that shape outright. sanitizeForSummary() already guards
  // against the equivalent problem for the summary REQUEST slice above; this
  // is the same fix applied to the slice that actually keeps being used
  // afterward. Reproduced directly: sweeping tool-result sizes from 100 to
  // 2000 chars found 1 case (out of 20) landing exactly on this boundary.
  //
  // Prefer pulling the matching assistant message (and any sibling tool
  // results of the same batch) back into the tail over dropping the tool
  // results: when the newest message is a tool result, it is exactly what
  // the model needs next. Dropping it made a live session loop — a failing
  // `npm test` whose output alone pushed usage past the trigger was
  // compacted away before the model ever saw it, so the model reran the
  // same command, every ~16s, indefinitely. Only fall back to dropping when
  // no owning assistant message exists in the summarized slice.
  let tail = keepTail;
  if (tail.length > 0 && tail[0].role === "tool") {
    let i = toSummarize.length - 1;
    while (i >= 0 && toSummarize[i].role === "tool") i--;
    const owner = i >= 0 ? toSummarize[i] : undefined;
    if (owner?.role === "assistant" && owner.tool_calls?.length) {
      tail = [...toSummarize.slice(i), ...tail];
    }
  }
  while (tail.length > 0 && tail[0].role === "tool") {
    tail = tail.slice(1);
  }

  // Some chat templates reject a conversation with no user message at all
  // ("No user query found in messages." — Ornith-1.5's does; Qwen3.6's
  // doesn't). A size-based tail can easily be nothing but a tool-call
  // chain, the user's request having gone into the summary, so give it a
  // user turn to hang off. Verified against the real server: the same
  // compacted shape is rejected without this and accepted with it.
  if (!tail.some((m) => m.role === "user")) {
    tail = [{ role: "user", content: CONTINUE_AFTER_COMPACTION }, ...tail];
  }

  const compactedMessages: ChatMessage[] = [{ role: "system", content: systemContent }, ...tail];

  const detail: CompactionDetail = {
    droppedCount: toSummarize.length,
    droppedTokens: toSummarize.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0),
    droppedPreview: toSummarize.slice(0, DETAIL_PREVIEW_CAP).map(previewLine),
    keptCount: tail.length,
    keptTokens: tail.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0),
    summary: summaryText,
  };
  if (toSummarize.length > DETAIL_PREVIEW_CAP) {
    detail.droppedPreview.push(`…and ${toSummarize.length - DETAIL_PREVIEW_CAP} more`);
  }

  return { messages: compactedMessages, checkpoint: finalCheckpoint, detail };
}

const SUMMARY_HEADER = "[Compacted history summary]";
/** Placeholder user turn for a compacted conversation whose kept tail has
 *  no user message (see runCompaction). */
export const CONTINUE_AFTER_COMPACTION =
  "[Earlier conversation was compacted — see the summary in the system message. Continue the current task.]";

/**
 * Splits a system message into the original base prompt and the compaction
 * summary appended to it (if any). The summary block is always appended LAST
 * (see composeSystemMessage), so everything from the header to the end is
 * the summary. The previous version cut the block at the first blank line
 * after the header instead — but model-written summaries are routinely
 * multi-paragraph markdown, so paragraphs 2..N of every old summary were
 * treated as "content after the block" and kept, piling up a little more
 * duplicated text on every compaction.
 */
export function splitSystemMessage(content: string): { base: string; summary: string | null } {
  const idx = content.indexOf(SUMMARY_HEADER);
  if (idx === -1) return { base: content, summary: null };
  return {
    base: content.slice(0, idx).trimEnd(),
    summary: content.slice(idx + SUMMARY_HEADER.length).trim(),
  };
}

/**
 * Assemble the final system-role message after a compaction pass: the
 * original base prompt plus exactly one summary block, replacing any
 * summary block already there rather than appending a second one.
 */
export function composeSystemMessage(originalContent: string, newSummary: string): string {
  const { base } = splitSystemMessage(originalContent);
  return [base, `${SUMMARY_HEADER}\n${newSummary}`].filter(Boolean).join("\n\n");
}

/** Removes any number of leading "[resuming ...] previous goal: " prefixes.
 *  The goal recorded in a checkpoint used to be taken from the first user
 *  message in the conversation — which, after one compaction, IS the
 *  injected resume message — so each checkpoint's goal wrapped the previous
 *  resume text ("[resuming after compaction] previous goal: [resuming after
 *  compaction] previous goal: ..."), growing on every compaction. */
export function stripResumePrefix(goal: string): string {
  return goal.replace(/^(\s*\[resuming[^\]]*\]\s*previous goal:\s*)+/, "").split("\n\nremaining steps:")[0].trim() || "(unknown)";
}

/**
 * PROMPT.md §2.4: after compaction, read the checkpoint back and produce a
 * short resume announcement + the injected system reminder that drives the
 * agent to continue the interrupted work rather than wait for new input.
 */
/** Cap on how much of a stored summary goes into a resume message. */
const RESUME_SUMMARY_MAX_CHARS = 4000;

export async function buildResumePrompt(
  projectRoot: string,
  // False when the live conversation already carries the summary (a
  // mid-session resume right after compaction), so it isn't sent twice.
  opts: { includeSummary?: boolean } = {}
): Promise<string | null> {
  const checkpoint = await readCheckpoint(projectRoot);
  if (!checkpoint) return null;
  const includeSummary = opts.includeSummary ?? true;
  const notes = includeSummary ? await readNotes(projectRoot) : "";

  const remaining = checkpoint.steps.filter((s) => s.status !== "done");
  // A checkpoint can now exist without any compaction ever having run
  // (see checkpoint.ts's "plan-progress" reason) — saying "after
  // compaction" for that case would be actively misleading about why the
  // agent seems to be picking up mid-task.
  const resumeReasonText = checkpoint.reason === "plan-progress" ? "resuming previous session" : "resuming after compaction";
  const lines = [
    `[${resumeReasonText}] previous goal: ${stripResumePrefix(checkpoint.goal)}`,
    remaining.length
      ? `remaining steps:\n${remaining.map((s) => `- (${s.status}) ${s.description}`).join("\n")}`
      : checkpoint.steps.length
        ? "All plan steps were already done — re-verifying before wrapping up."
        : // No plan was declared. Saying "all steps done" here (the tool
          // log used to be stored as done steps) told the model there was
          // nothing left to do.
          "No plan was recorded for this work.",
    includeSummary && checkpoint.summary
      ? `summary of the previous session:\n${
          checkpoint.summary.length > RESUME_SUMMARY_MAX_CHARS
            ? checkpoint.summary.slice(0, RESUME_SUMMARY_MAX_CHARS) + " …"
            : checkpoint.summary
        }`
      : "",
    includeSummary && notes ? `working notes (findings recorded before; trust these over re-deriving them):\n${notes}` : "",
    checkpoint.recentActions?.length ? `recent actions:\n${checkpoint.recentActions.map((a) => `- ${a}`).join("\n")}` : "",
    checkpoint.pendingToolCall
      ? `interrupted tool call: ${checkpoint.pendingToolCall.name} (${checkpoint.pendingToolCall.reason})`
      : "",
    checkpoint.files.length
      ? `files touched:\n${checkpoint.files.map((f) => `- (${f.status}) ${f.path}`).join("\n")}`
      : "",
    "Continue the task from where it stopped. If it is already complete, verify that and report the result.",
  ].filter(Boolean);

  return lines.join("\n\n");
}
