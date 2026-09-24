import type { ChatMessage, ModelBackend } from "../backend/types.js";
import { AGENT_STATE_TOOLS, FILE_TOOLS, activeToolDefs, executeTool } from "../tools/index.js";
import { CircuitBreaker } from "../hermes/selfHeal.js";
import { logFailure, getFailureLog } from "../hermes/selfHeal.js";
import { proposeImprovement, writeProposedRule, appendImprovementLog, ImprovementProposal } from "../hermes/selfImprove.js";
import {
  runCompaction,
  estimateTokens,
  buildResumePrompt,
  CompactionThresholds,
  DEFAULT_TAIL_BUDGET_FRACTION,
  splitSystemMessage,
  stripResumePrefix,
  type CompactionDetail,
} from "../compaction/compactor.js";
import { clearCheckpoint, writeCheckpoint, readCheckpoint } from "../compaction/checkpoint.js";
import type { Checkpoint } from "../compaction/checkpoint.js";
import { stripToolCallTemplateLeak } from "./textSanitize.js";
import { salvagePartialFileWrite } from "./toolCallSalvage.js";
import { existsSync } from "node:fs";
import {
  ProgressTracker,
  DEFAULT_PROGRESS_GUARD,
  progressNudgeText,
  runPostEditCheck,
  type ProgressGuardOptions,
  type VerifyConfig,
} from "./harness.js";
import { appendNote, clearNotes, readNotes, NOTES_HEADER } from "../compaction/notes.js";
import { gitCheckpoint } from "./gitCheckpoint.js";

// Sent as the `tools` field on every main-loop request (never on the
// compaction summary request, which omits tools entirely) — computed once
// since TOOL_DEFS is static, not per-call. Threaded into every
// estimateTokens() call below as `extraText` so the threshold check
// reflects what's actually being sent, not just `this.messages`. Found
// live: real usage (per llama-server's own reported n_tokens) kept
// running measurably past this project's compaction threshold before a
// compaction ever fired — measured directly, this JSON alone tokenizes to
// 626 real tokens, sent on every single request and previously never
// counted at all.
// Computed per use, not once at module load: configureBrowserTools()
// (index.tsx, startup) decides which tools are active, and this module is
// imported before that runs. It must also always match the list actually
// sent as `tools` below — an estimate computed off a different list is
// exactly how every token measurement silently drifted from reality
// before.
function toolDefsJson(): string {
  return JSON.stringify(activeToolDefs());
}

// A single tool result (e.g. read_file on a large or binary-ish file, a
// noisy shell command's stdout) had no size limit before this was added —
// its full raw content went straight into `this.messages` and from there,
// uncapped, into the next request body sent to llama.cpp. One oversized
// result could balloon a single request by itself, on top of accumulated
// history, well past what's reasonable to send in one shot.
//
// The cap itself must scale with the *actual configured* context window,
// not be a fixed absolute constant — found by a scenario test simulating
// many long developer sessions against a smaller (6k-token) context
// window: a flat 24,000-char (~6k token) cap can by itself equal the
// entire budget on a smaller model/config, so a single big tool result
// permanently fills the whole window on its own. No amount of compacting
// older messages can ever recover from that — the conversation becomes
// unrecoverable forever the moment one such result lands, which defeats
// the whole point of having a cap. Scale it to a fraction of the real
// window instead, with the previous 24k as an upper bound for the common
// case of a large (64k+) real context, and a floor so it's never
// pathologically tiny for a very small window either.
function toolResultCharCap(contextWindowTokens: number): number {
  return Math.max(2_000, Math.min(24_000, Math.floor(contextWindowTokens * 4 * 0.15)));
}

function capToolResult(content: string, contextWindowTokens: number): string {
  const cap = toolResultCharCap(contextWindowTokens);
  if (content.length <= cap) return content;
  const omitted = content.length - cap;
  return `${content.slice(0, cap)}\n\n[...truncated: ${omitted} more characters omitted to keep the request size sane]`;
}

/** capToolResult() for a read_file result: cuts at a line boundary rather
 *  than mid-line, and always says which lines are shown and where to
 *  continue. Before this, read_file could only return a whole file, and a
 *  file past the cap was cut with a bare "[...truncated]": a live session
 *  editing a 19,304-byte file never saw its last ~4,500 characters, re-read
 *  it after every compaction, and stalled for about an hour. */
function capReadFileResult(
  content: string,
  range: { start: number; end: number; total: number },
  path: string,
  contextWindowTokens: number
): string {
  const cap = toolResultCharCap(contextWindowTokens);
  let body = content;
  let shownEnd = range.end;
  if (body.length > cap) {
    const cut = body.lastIndexOf("\n", cap);
    // A single line longer than the whole cap: nothing to cut at cleanly.
    if (cut <= 0) return capToolResult(content, contextWindowTokens);
    body = body.slice(0, cut);
    shownEnd = range.start + body.split("\n").length - 1;
  }
  if (range.start === 1 && shownEnd === range.total) return body;
  const next =
    shownEnd < range.total
      ? ` — call read_file with path=${JSON.stringify(path)} and start_line=${shownEnd + 1} to continue`
      : "";
  return `${body}\n\n[showing lines ${range.start}-${shownEnd} of ${range.total}${next}]`;
}

/** Repeated-response guard: the same assistant text REPEAT_LIMIT times
 *  among the turn's last REPEAT_WINDOW assistant messages stops the turn. */
const REPEAT_WINDOW = 6;
const REPEAT_LIMIT = 3;
function normalizeForRepeat(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Caps how much of `err.message` ever reaches an `onStatus` line.
 *
 *  Two real error shapes can make `err.message` itself enormous: a
 *  non-streaming backend failure's message is `res.text()` — the entire
 *  raw HTTP response body, verbatim — and a mid-stream SSE error chunk's
 *  message can embed the backend's own "last read: ..." diagnostic, which
 *  for the exact failure this exists to catch (a `write_file` call
 *  truncated mid-JSON-string) contains the whole partially-generated file.
 *  Reported live: after `MAX_TOOL_CALL_TRUNCATION_RETRIES` was exhausted
 *  on a multi-KB test file, the fallback `[error] couldn't reach the model
 *  backend: ${err.message}` line dumped several kilobytes of raw escaped
 *  JSON (nested quotes, `\n`, the file's own source code, ending in the
 *  literal `,"type":"server_error"}}`) straight onto the screen — visually
 *  indistinguishable from a crash, even though the turn had already ended
 *  cleanly and `/quit` still worked. `logFailure()` still gets the
 *  untouched original (debugging/self-improvement needs the real text);
 *  only what's shown to the user goes through this. */
export function summarizeErrorForDisplay(message: string, maxLen = 300): string {
  if (message.length <= maxLen) return message;
  const omitted = message.length - maxLen;
  return `${message.slice(0, maxLen)}... [${omitted} more characters truncated]`;
}


/** Tool calls whose arguments carry a whole file's contents. Once the
 *  call has actually run, that content is on disk — keeping a verbatim
 *  copy of it in the conversation too is pure duplication, and a large
 *  one: measured on a real session, three generated source files sat in
 *  history as ~8,000 tokens of tool-call arguments, 49% of a
 *  16,384-token window, on top of the files themselves already existing.
 *  Compaction couldn't help either, since its kept tail preserves recent
 *  messages verbatim — which is exactly what "compaction barely shrinks
 *  anything" was. Tool RESULTS were already capped (capToolResult); tool
 *  call ARGUMENTS never were. */
const FILE_CONTENT_TOOLS = new Set(["write_file", "append_file"]);

/** Tools that change a file on disk: progress signal + post-edit check. */
const EDIT_TOOLS = new Set(["write_file", "append_file", "edit_file"]);

/** How many CONSECUTIVE failed checks on the same file before the reflect
 *  message escalates from "here's the error" to "stop and rethink". */
const REFLECT_RETRY_ESCALATE_AT = 3;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function pathArg(argumentsJson: string): string | null {
  try {
    const p = JSON.parse(argumentsJson)?.path;
    return typeof p === "string" && p ? p : null;
  } catch {
    return null;
  }
}

function elidedContentNote(chars: number): string {
  return `${chars} characters written to disk; call read_file on the path to see them`;
}
// Any short bracketed "N characters ... written to disk ..." line, not just
// the exact wording once used: live, the model reworded it ("…if you need
// it again", with a made-up count) and the exact-match guard let it through.
const ELIDED_CONTENT_RE = /^\[[^\]\n]*\bcharacters?\b[^\]\n]*\bwritten to disk\b[^\]\n]*\]$/i;

/** True when a write_file/append_file call's content is the placeholder that
 *  elideWrittenFileContent() leaves in history — the model copying its own
 *  earlier call instead of the real content. Seen live: a session rewrote
 *  wrangler.toml with exactly this placeholder seven times in a row,
 *  destroying the file's real 70 characters, until the circuit breaker
 *  stopped it. */
export function isElidedContentWrite(toolName: string, argumentsJson: string): boolean {
  if (!FILE_CONTENT_TOOLS.has(toolName)) return false;
  try {
    const content = JSON.parse(argumentsJson)?.content;
    return typeof content === "string" && ELIDED_CONTENT_RE.test(content.trim());
  } catch {
    return false;
  }
}

/** Drops a completed file-write's `content` argument from history, leaving
 *  the path and a `content_note` so the conversation still reads as "I
 *  wrote this file". Safe because the file itself is the source of truth
 *  from here on — the model can read_file it if it needs the content back.
 *
 *  The note is deliberately NOT put back under `content`: a placeholder
 *  there is a ready-made argument, and live sessions copied their own
 *  earlier calls and wrote it into files three times (once reworded, past
 *  an exact-match guard). With no `content` at all, a copied call fails
 *  with a clear error instead of writing anything. */
function elideWrittenFileContent(argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson);
    if (typeof args?.content !== "string" || args.content.length === 0) return argumentsJson;
    const { content, ...rest } = args;
    return JSON.stringify({ ...rest, content_note: elidedContentNote(content.length) });
  } catch {
    return argumentsJson; // unparseable (shouldn't happen post-execution) — leave as is
  }
}

export interface AgentLoopOptions {
  projectRoot: string;
  model: string;
  backend: ModelBackend;
  systemPrompt: string;
  thresholds: CompactionThresholds;
  /** Off by default — see config.ts's `enableThinking` for the measured
   *  reason (an entire max_tokens budget spent on invisible
   *  `reasoning_content` before the tool call even began). */
  enableThinking?: boolean;
  /** Per-extension checks run after each file edit (see harness.ts);
   *  false turns them off. From config.yaml's verify.afterEdit. */
  verify?: VerifyConfig;
  /** No-progress guard thresholds (see harness.ts ProgressTracker). */
  progressGuard?: ProgressGuardOptions;
  /** Aider-style auto-commit of each successful edit (see gitCheckpoint.ts).
   *  Off by default — see that file's doc comment for why. From
   *  config.yaml's checkpoint.git. */
  gitCheckpoint?: boolean;
  /** llama.cpp repeat_penalty sent with every chat request. Defaults to 1.1
   *  (see ChatCompletionRequest.repeat_penalty) — from config.yaml's
   *  llama.repeatPenalty. */
  repeatPenalty?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Called for each incremental token/chunk of assistant text as it streams in. */
  onAssistantDelta?: (text: string) => void;
  /** Streamed chain-of-thought (`reasoning_content`), separate from
   *  onAssistantDelta's `content` — only fires when enableThinking is true.
   *  Display-only: this text is never appended to the assistant message
   *  that gets pushed into `this.messages`/history (see the streamChat doc
   *  comment in openaiClient.ts for why) — the model already conditions on
   *  it within the SAME generation by construction; re-feeding it as input
   *  on a LATER turn would only cost tokens for no benefit. */
  onReasoningDelta?: (text: string) => void;
  /** Fires whenever the queued-message list changes (see queueMessage), so
   *  the UI's own display of it (the /queue command) stays in sync with
   *  the authoritative copy this class now owns. */
  onQueueChange?: (queue: string[]) => void;
  /** Called once an assistant message (streamed or not) is fully received —
   *  the UI uses this to stop appending to the current line. */
  onAssistantDone?: () => void;
  onToolCall?: (name: string, args: string) => void;
  /** ANSI-colored diff for a file-mutating tool call, UI-only. */
  onDiff?: (path: string, diff: string) => void;
  /** Fires with a run_shell command's raw output — see its call site's doc
   *  comment for why it's scoped to that tool only. */
  onToolResult?: (command: string, output: string) => void;
  onStatus?: (status: string) => void;
  /** Fires whenever context usage is (re-)measured, so the UI's context
   *  battery gauge can reflect real usage (PROMPT.md §2.5) instead of being
   *  disconnected from the agent loop. */
  onContextUsage?: (usedTokens: number, totalTokens: number) => void;
  /** Fires whenever the model declares/updates its plan via `update_plan`,
   *  and once more with (0, 0) when a plan completes (every step "done")
   *  or a fresh turn starts with none — requested directly, so progress
   *  ("step 3 of 7") is visible somewhere persistent (the status bar)
   *  instead of only scrolling by once in the log. */
  onPlanProgress?: (done: number, total: number) => void;
  /** Fires when compaction starts/completes/fails — requested directly:
   *  the "[compaction complete] ..." line lived only in the scrolling log,
   *  and got pushed out of view by later activity (a long tool-call batch,
   *  a big prompt-processing wait) before it was ever actually noticed.
   *  Meant for a persistent indicator (the status bar) that survives
   *  exactly that kind of scroll, the same reasoning behind
   *  `onPlanProgress`. */
  onCompactionStatus?: (status: "running" | "complete" | "failed", timestamp: string) => void;
  /** Fires once per successful compaction with what was actually dropped
   *  vs kept/summarized — lets the UI show compaction's before/after
   *  instead of it being a black box. */
  onCompactionDetail?: (detail: CompactionDetail) => void;
  /** When a compaction interrupts a tool call mid-turn (checkpoint written,
   *  batch abandoned — see the maybeCompact() call site below), immediately
   *  fold the checkpoint's resume prompt back in and keep the same turn
   *  going, instead of stopping and waiting for the user to type another
   *  message. Defaults to true (config.ts's compaction.autoResume). Startup
   *  resume (resumeIfCheckpointExists, for a checkpoint left by a crashed
   *  previous process) already does this unconditionally — this extends the
   *  same behavior to a compaction that fires live, mid-session. */
  autoResume?: boolean;
}

/**
 * The core agentic loop: send messages, execute tool calls, feed results
 * back, repeat until the assistant stops requesting tools. Compaction
 * (PROMPT.md §2) and the self-healing circuit breaker (§3) are wired in here
 * so every call site gets both automatically.
 */
export class AgentLoop {
  private messages: ChatMessage[];
  private breaker = new CircuitBreaker();
  /** Serializes every operation that reads/mutates `messages` (turns and
   *  compaction) so `/compact` can never race a turn's tool-call loop —
   *  see README "구현 상태" (race condition fix). */
  private taskChain: Promise<void> = Promise.resolve();

  /** Model-declared plan via the `update_plan` tool (PROMPT.md §2.2 steps). */
  private plan: Checkpoint["steps"] = [];
  /** Messages typed while a turn is running. Owned here (not just mirrored
   *  from the UI) so the turn loop can apply them at the next opportunity
   *  — between tool-call rounds — rather than only after the ENTIRE turn
   *  (every queued tool call included) finishes. Requested directly: a
   *  message queued mid-turn used to wait behind whatever the turn was
   *  already doing, however long that took. */
  private queuedMessages: string[] = [];
  /** Consecutive post-edit-check failures, per file path — drives the
   *  escalating reflect-and-retry message (Aider's edit → validate →
   *  reflect → retry loop). Reset the moment a check on that path passes,
   *  or the path stops being edited (implicitly, since it only grows). */
  private consecutiveCheckFailures = new Map<string, number>();
  private progress!: ProgressTracker;
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  /** The session's task as the user stated it. Tracked explicitly because
   *  deriving it from `this.messages` stops working after the first
   *  compaction: the first user message left in the kept tail is then the
   *  injected "[resuming ...]" message, and recording THAT as the goal made
   *  every later resume message nest the previous one inside itself. */
  private goal: string | null = null;
  /** Warn only once per session that the fixed prompt overhead leaves no
   *  room for compaction to work with — see compact(). */
  private warnedWindowTooSmall = false;
  /** Files touched via read_file/write_file/edit_file, most-recent status wins. */
  private filesTouched = new Map<string, Checkpoint["files"][number]["status"]>();
  /** Fallback step history when the model never calls update_plan: every
   *  successfully executed tool call, in order. Bounded (see
   *  pushExecutedToolLog) — unbounded growth here doesn't cost request
   *  tokens directly (it's never sent to the backend), but it IS written
   *  verbatim into the on-disk checkpoint (currentSteps(), via compact())
   *  on every compaction, so a very long tool-heavy session would otherwise
   *  make that checkpoint file grow without limit too. */
  private executedToolLog: string[] = [];
  private static readonly MAX_EXECUTED_TOOL_LOG = 200;
  /** Last self-improvement proposal shown to the user but not yet applied
   *  (§3: never write a proposed rule without explicit approval). */
  private pendingImprovement: ImprovementProposal | null = null;
  /** Pattern signatures already written to the real-time improvement log
   *  this session, so a still-recurring failure doesn't re-append (and
   *  re-call the model for) the same finding on every new occurrence. */
  private loggedImprovementSignatures = new Set<string>();
  /** Set whenever a failure is logged during the current turn; checked
   *  after the turn fully completes (see `send()`) rather than triggering
   *  the improvement-check model call immediately inside the turn. This
   *  server only has one inference slot (`-np 1`, confirmed from real
   *  llama-server logs — llamacli's own background call was racing the
   *  turn's own next request for that single slot and could delay it),
   *  so a background analysis call must never fire while a turn is still
   *  actively in flight. */
  private hasNewFailuresThisTurn = false;
  /** Set by cancelCurrentTurn() (TUI: Esc → Y confirms), consumed by
   *  runUntilIdle() at the two points a turn can actually notice it — the
   *  chat() catch block and the top of the tool-call loop. Kept as a flag
   *  rather than throwing directly from cancelCurrentTurn() itself: that
   *  method can be called at any time from the UI thread, completely
   *  independent of where runUntilIdle currently is in its own await
   *  chain, so there's no single `throw` site that would actually reach
   *  the right place. */
  private cancelRequested = false;

  constructor(private opts: AgentLoopOptions) {
    this.messages = [{ role: "system", content: opts.systemPrompt }];
    this.progress = new ProgressTracker(opts.progressGuard ?? DEFAULT_PROGRESS_GUARD, this.now());
  }

  /** Reads back a checkpoint left by a compaction that abandoned work
   *  mid-batch (see the mid-tool-call-loop comment below) and folds its
   *  resume prompt into the conversation, so whoever calls this next picks
   *  the interrupted work back up. Consumes (clears) the checkpoint before
   *  returning — if a fresh compaction happens later in the same turn,
   *  that new checkpoint must survive, so clearing afterward would be
   *  wrong. Returns whether there was anything to resume. */
  private async injectResumeContextIfPending(): Promise<boolean> {
    // A plan-progress checkpoint this process wrote itself (the plan is
    // still live in this.plan) is crash insurance for the NEXT process, not
    // something to resume here. Reported live as the same prompt repeating:
    // a plan with a manual step stayed unfinished at the end of every
    // turn, and each new message re-injected "[resuming previous session]
    // ..." before it. Leave the checkpoint on disk.
    const pending = await readCheckpoint(this.opts.projectRoot);
    if (pending?.reason === "plan-progress" && this.plan.length > 0) return false;
    const systemText = typeof this.messages[0]?.content === "string" ? this.messages[0].content : "";
    const resumeText = await buildResumePrompt(this.opts.projectRoot, {
      includeSummary: splitSystemMessage(systemText).summary === null,
    });
    if (!resumeText) return false;
    this.opts.onStatus?.(resumeText);
    // Must be role "user", not "system": this.messages already starts with
    // one system message (the system prompt, set in the constructor), and
    // pushing a second one broke chat-template-enforcing backends (llama.cpp
    // Jinja templates that raise "System message must be at the beginning"
    // for a second system entry, and separately "No user query found" when
    // that left the conversation with zero user-role messages at all —
    // hit in production 2026-09-21, a resumed session couldn't get a reply
    // out of the model at all). A resume is conceptually the user saying
    // Avoid accumulating duplicate resume messages consecutively
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string" && lastMsg.content.startsWith("[resuming")) {
      lastMsg.content = resumeText;
    } else {
      this.messages.push({ role: "user", content: resumeText });
    }
    // Restore the plan/progress too, not just the text summary — otherwise
    // the status bar's progress indicator (PLAN_PROGRESS_WIDTH) shows
    // nothing until the model happens to call update_plan again, even
    // though a resumed checkpoint may already record real remaining steps.
    const checkpoint = await readCheckpoint(this.opts.projectRoot);
    if (checkpoint && !this.goal) this.goal = stripResumePrefix(checkpoint.goal);
    if (checkpoint && checkpoint.steps.length > 0) {
      this.plan = checkpoint.steps;
      this.opts.onPlanProgress?.(checkpoint.steps.filter((s) => s.status === "done").length, checkpoint.steps.length);
    }
    await clearCheckpoint(this.opts.projectRoot);
    return true;
  }

  /** PROMPT.md §2.4: on startup, if a checkpoint was left behind (compaction
   *  fired in a previous session that then exited/crashed before finishing),
   *  resume automatically — no user input required. */
  async resumeIfCheckpointExists(): Promise<void> {
    await this.enqueue(async () => {
      // See send()'s reset() call below for why this matters.
      this.breaker.reset();
      this.progress.reset(this.now());
      const resumed = await this.injectResumeContextIfPending();
      if (resumed) await this.runUntilIdle();
      this.checkForRealtimeImprovementAfterTurn();
    });
  }

  /** Queues a message typed while a turn is running (see queuedMessages'
   *  doc comment) — applied at the next turnLoop iteration, not held until
   *  the whole turn ends. `send()` remains how a message submitted while
   *  IDLE starts a turn; this is only for the busy case. */
  queueMessage(text: string): void {
    this.queuedMessages.push(text);
    this.opts.onQueueChange?.(this.queuedMessages.slice());
  }

  async send(userText: string): Promise<void> {
    await this.enqueue(async () => {
      // The circuit breaker is created once per AgentLoop (i.e. once per
      // process) and never reset anywhere before this — its 30-minute
      // "hard timeout" was measured from PROCESS STARTUP, not from the
      // start of whatever task is actually running. Caught live: a real
      // session open longer than 30 minutes (completely normal for an
      // interactive coding session) hit "[stopped] self-healing circuit
      // breaker tripped: hard timeout exceeded" on its very next tool
      // call — and since nothing ever reset it, EVERY subsequent tool
      // call for the rest of that process's life would trip the same way,
      // permanently breaking the session until restarted. The timeout is
      // meant to catch one runaway task/turn stuck looping for 30+
      // minutes straight, not to cap how long a session can stay open —
      // reset it at the start of each new turn so the clock (and the
      // repetitive-call detection window) restarts fresh every time.
      this.breaker.reset();
      this.progress.reset(this.now());
      // A compaction can also fire *mid-session* (not just be left over
      // from a previous process) and abandon work — e.g. mid-tool-call-loop
      // below. Previously that resume context only ever got folded in on a
      // fresh process restart, so typing a new message in the same running
      // session silently dropped it instead of picking the interrupted work
      // back up, even though a checkpoint was sitting on disk the whole
      // time. Check every time, not just at startup.
      await this.injectResumeContextIfPending();
      this.goal ??= userText.trim().slice(0, 200) || null;
      this.messages.push({ role: "user", content: userText });
      await this.runUntilIdle();
      this.checkForRealtimeImprovementAfterTurn();
    });
  }

  /** Fires the (fire-and-forget) real-time improvement check only after the
   *  turn has fully finished — never while one is still in flight. See the
   *  `hasNewFailuresThisTurn` docstring for why. */
  private checkForRealtimeImprovementAfterTurn(): void {
    if (!this.hasNewFailuresThisTurn) return;
    this.hasNewFailuresThisTurn = false;
    this.triggerRealtimeImprovementCheck();
  }

  /** Chains `task` onto the shared queue so it never overlaps a turn or a
   *  compaction already touching `this.messages`, and re-throws its error
   *  to the caller without breaking the chain for subsequent tasks. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.taskChain.then(task);
    // Swallow so a failed task doesn't permanently poison the chain for
    // whatever is queued after it.
    this.taskChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async runUntilIdle(): Promise<void> {
    // Defense in depth against the estimate in maybeCompact() ever still
    // being wrong (e.g. a future backend field it doesn't account for):
    // the backend's own hard rejection is ground truth and should trigger
    // an immediate forced compaction and retry, rather than ending the
    // turn and leaving the *next* message to walk into the exact same
    // oversized history again. Seen live: two consecutive user turns both
    // failed with "exceeds the available context size" at ~65,636 and
    // ~65,648 tokens — nothing had shrunk in between because the estimate
    // (now fixed separately) said there was still room.
    //
    // Retries are bounded by *compaction actually shrinking the history*,
    // not a flat one-shot count — a single long tool-calling turn (many
    // chained tool calls before the model finally stops and answers) can
    // legitimately hit this more than once before the turn ends, and each
    // time compaction genuinely works and frees up room again. A flat
    // one-retry cap treated that completely normal, working recovery as
    // exhausted and permanently failed the turn on the second occurrence
    // even though nothing was actually stuck — caught by a scenario test
    // simulating many long multi-tool-call developer sessions. Only give
    // up when a compaction attempt fails to actually reduce the estimated
    // size (a real stuck state, e.g. one message alone is too large to
    // ever fit), with a hard cap as a last-resort safety net against any
    // other unforeseen loop.
    const MAX_OVERFLOW_RETRIES = 8;
    let overflowRetries = 0;
    // Starts at the normal default and HALVES each time a compaction
    // attempt fails to shrink anything (see the `after >= before` branch
    // below), down to a floor — rather than giving up the instant the
    // first attempt doesn't help. Found live: the kept tail's own default
    // budget (40% of the window) plus the next reply's reservation (25%)
    // plus the (necessarily preserved) system prompt and tool schema can
    // together already exceed a modest context window on their own, so
    // "one compaction pass didn't shrink it" doesn't mean the conversation
    // is truly unrecoverable — it means the tail itself needs to give up
    // more room too. Reset per-turn (a fresh send() call starts over at
    // the default), so a difficult turn doesn't leave every later turn in
    // the session artificially starved of kept context.
    let tailBudgetFraction = DEFAULT_TAIL_BUDGET_FRACTION;
    const MIN_TAIL_BUDGET_FRACTION = 0.05;
    // See the "tool call truncated" catch branch below. Bounded the same
    // way overflowRetries is — a model that keeps generating oversized
    // content despite being told to split it up must eventually surface
    // as a real failure, not retry forever.
    const MAX_TOOL_CALL_TRUNCATION_RETRIES = 5;
    let toolCallTruncationRetries = 0;
    // Reported live: the text nudge alone was not enough — a real retry
    // regenerated the EXACT same content and got cut off at the EXACT
    // same character column as the first attempt, twice, because nothing
    // about the actual request changed (same computeMaxTokens() result
    // both times, since `usedBeforeChat` barely moves between retries in
    // the same turn) — the model simply ignored the character-budget
    // instruction and tried to write the whole thing again. A prompt
    // instruction is not enforceable; max_tokens itself is — it's a real
    // server-side generation cap, honored regardless of whether the model
    // "chooses" to respect it. This factor HALVES max_tokens (down to a
    // floor) specifically when the error repeats verbatim, so a model
    // that keeps ignoring the chunking instruction still gets physically
    // forced to generate less each time — guaranteeing the failure point
    // moves earlier and the wasted generation shrinks every retry, even
    // in the worst case where the instruction itself is never followed.
    // Reset per-turn, same as tailBudgetFraction above.
    let toolCallMaxTokensShrinkFactor = 1;
    const MIN_TOOL_CALL_MAX_TOKENS_SHRINK_FACTOR = 0.125;
    let lastToolCallTruncationMessage: string | null = null;
    // Requested directly: don't just discard a truncated write and ask the
    // model to redo the whole thing from memory — recover the prefix that
    // DID generate successfully (openaiClient.ts attaches it to the error
    // as `partialToolCalls`) and write it to the real file for real, then
    // only ask the model to generate the REMAINDER. Tracks, per path
    // salvaged so far THIS turn, how many characters are already on disk —
    // the first salvage for a given path uses write_file (create/
    // overwrite), every salvage after that for the SAME path uses
    // append_file instead, so a multi-round recovery on one large file
    // builds it up correctly rather than each round overwriting the last.
    const salvagedCharsWrittenByPath = new Map<string, number>();
    // Recent assistant texts in this turn, for repeatedResponse() below.
    const recentAssistantTexts: string[] = [];
    turnLoop: while (true) {
      // Apply anything queued since the last request went out — before
      // the model's next turn, not after the whole (possibly multi-tool-
      // call) turn finishes. Drains everything waiting, in order: a user
      // steering a task usually means every queued message together, not
      // one per tool-call round.
      if (this.queuedMessages.length > 0) {
        for (const text of this.queuedMessages) {
          this.opts.onStatus?.(`[applying queued message] ${text}`);
          this.messages.push({ role: "user", content: text });
        }
        this.queuedMessages = [];
        this.opts.onQueueChange?.([]);
      }
      const verdict = this.progress.check(this.now());
      if (verdict === "nudge") {
        const guard = this.opts.progressGuard ?? DEFAULT_PROGRESS_GUARD;
        this.opts.onStatus?.("[progress check] no progress for a while — asking the model to state the cause and act.");
        this.messages.push({ role: "user", content: progressNudgeText(guard.minutes, guard.compactions) });
      } else if (verdict === "stop") {
        this.opts.onStatus?.(
          "[stopped] still no progress after a progress check — no edit to an existing file and no plan step completed. " +
            "Tell it what to do next (its working notes are in .llamacli/state/notes.md)."
        );
        logFailure({
          timestamp: new Date().toISOString(),
          summary: "no progress after nudge",
          toolName: "chat",
          errorMessage: "progress guard stopped the turn",
        });
        this.hasNewFailuresThisTurn = true;
        return;
      }
      const { used: usedBeforeChat } = await this.maybeCompact();

      let res;
      try {
        res = await this.opts.backend.chat(
          {
            model: this.opts.model,
            messages: this.messages,
            tools: activeToolDefs(),
            stream: true,
            // Never leave this unset: without it llama-server defaults to
            // n_predict=-1 (unbounded), and a degenerate generation (no
            // stop token reached, e.g. a repetition loop) runs forever,
            // pinning the single inference slot and blocking every other
            // request indefinitely instead of failing visibly. Caught live
            // via GET /slots showing n_decoded climbing past 22k with
            // max_tokens/n_predict both -1. See computeMaxTokens()'s doc
            // comment for why this is sized to the room actually left
            // rather than a flat fraction of the window. Multiplied by
            // toolCallMaxTokensShrinkFactor (see its own comment above) —
            // 1 normally, but forced smaller after a tool call truncation
            // repeats verbatim, so a non-compliant model still physically
            // cannot regenerate the identical oversized content again.
            max_tokens: Math.max(512, Math.floor(this.computeMaxTokens(usedBeforeChat) * toolCallMaxTokensShrinkFactor)),
            // See ChatCompletionRequest.repeat_penalty's doc comment.
            repeat_penalty: this.opts.repeatPenalty ?? 1.1,
            // THE root cause behind a long run of "the model never
            // finished writing the file" failures — measured directly
            // against the real backend, same 420-token budget, same
            // prompt: thinking ON gave 420 reasoning_content deltas and
            // ZERO tool_calls deltas (the budget was gone before the tool
            // call even started, so nothing was written and there were no
            // tool-call deltas for the salvage path to recover either);
            // thinking OFF gave 0 reasoning deltas and 362 tool_calls
            // deltas from the identical budget. Everything else in this
            // file's truncation handling is a safety net under this.
            ...(this.opts.enableThinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
          },
          (chunk) => {
            // Defensive: `chunk.choices` isn't guaranteed non-empty/present
            // by every ModelBackend implementation (openaiClient.ts already
            // filters out non-choices chunks before calling this, but
            // don't assume every backend does) — a bare `chunk.choices[0]`
            // throws instead of just skipping the chunk when it's missing.
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) this.opts.onAssistantDelta?.(delta.content);
            const reasoning = (delta as any)?.reasoning_content;
            if (typeof reasoning === "string" && reasoning) this.opts.onReasoningDelta?.(reasoning);
          }
        );
      } catch (err: any) {
        // cancelCurrentTurn() already wrote a resumable checkpoint and
        // called backend.cancel() before this throw ever happens — this is
        // just recognizing that the resulting AbortError is the expected
        // shape of a deliberate cancel, not a real failure to report or
        // retry. Checked first, ahead of the overflow-retry branch below,
        // since a cancel can in principle race a context-overflow message
        // (both surface as an error out of the same backend.chat() call).
        if (this.cancelRequested) {
          this.cancelRequested = false;
          this.opts.onStatus?.(
            "[cancelled] work saved — it will resume automatically the next time llamacli starts in this project."
          );
          return;
        }
        if (
          overflowRetries < MAX_OVERFLOW_RETRIES &&
          /exceeds the available context size|exceed_context_size_error/i.test(err.message)
        ) {
          overflowRetries++;
          this.opts.onStatus?.(
            `[context overflow] request exceeded the context window — forcing compaction and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES}).`
          );
          const before = await estimateTokens(this.messages, this.opts.backend, toolDefsJson(), activeToolDefs());
          await this.compact("auto-threshold", null, tailBudgetFraction);
          const after = await estimateTokens(this.messages, this.opts.backend, toolDefsJson(), activeToolDefs());
          // A compaction that didn't actually shrink anything at the
          // CURRENT tail budget doesn't necessarily mean the conversation
          // is truly unrecoverable — it can just mean the kept tail itself
          // (see compactor.ts's DEFAULT_TAIL_BUDGET_FRACTION) needs to give
          // up more room too. Tighten it and try again before giving up,
          // down to a floor; only once even the tightest budget fails to
          // help is this a real "one message alone is too large" stuck
          // state, not a fixable one. Reported live: a real session hit
          // "no longer fits even after compaction" after just ONE
          // non-improving pass at the default 40% budget, on a 16384-token
          // window where 40% (tail) + 25% (the next reply's own
          // reservation) + the system prompt + tool schema together left
          // no real room — a smaller tail alone was enough to fit.
          if (after >= before) {
            if (tailBudgetFraction > MIN_TAIL_BUDGET_FRACTION) {
              tailBudgetFraction = Math.max(MIN_TAIL_BUDGET_FRACTION, tailBudgetFraction / 2);
              this.opts.onStatus?.(
                `[context overflow] compaction alone didn't shrink it — retrying with a smaller kept-context budget (${Math.round(tailBudgetFraction * 100)}%).`
              );
              continue;
            }
            this.opts.onStatus?.(
              "[error] the conversation no longer fits the context window even after compaction — some content is too large to keep."
            );
            logFailure({
              timestamp: new Date().toISOString(),
              summary: "backend chat request failed",
              toolName: "chat",
              errorMessage: err.message,
            });
            this.hasNewFailuresThisTurn = true;
            return;
          }
          continue;
        }
        // A tool call's arguments got cut off mid-generation by max_tokens
        // (NOT a context-window overflow — llama-server's own `truncated`
        // flag is 0 for this; the reply itself just hit its cap before a
        // large generated string could close) and the server rejects the
        // resulting unterminated JSON with a 500. Reported live twice: a
        // write_file call generating a long document/source file ran out
        // of its allotted reply budget mid-string. Recoverable — unlike a
        // real context overflow, nothing about the conversation itself is
        // too large; the single UPCOMING reply just needs to be shorter.
        if (
          toolCallTruncationRetries < MAX_TOOL_CALL_TRUNCATION_RETRIES &&
          /Failed to parse tool call arguments as JSON/i.test(err.message)
        ) {
          toolCallTruncationRetries++;
          // Try to recover the prefix that DID generate successfully
          // before falling back to the shrink-and-retry strategy below —
          // requested directly: don't just discard a truncated write and
          // make the model regenerate the whole thing from memory (the
          // very thing that produced the identical-content, identical-
          // cutoff repeat this file was written to guard against in the
          // first place). Only applies to a write_file/append_file call
          // (the only tools whose truncated argument is itself the thing
          // worth saving) and only when salvagePartialFileWrite() can
          // actually make sense of the raw accumulated arguments — a
          // genuinely unsalvageable shape (no recognizable path/content
          // fields at all) falls through to the shrink-and-nudge path
          // exactly as before.
          const partialCall = (err as any).partialToolCalls?.find(
            (c: any) => c?.name === "write_file" || c?.name === "append_file"
          );
          const salvaged = partialCall ? salvagePartialFileWrite(partialCall.arguments ?? "") : null;
          if (salvaged) {
            const alreadyWritten = salvagedCharsWrittenByPath.get(salvaged.path) ?? 0;
            const isContinuation = alreadyWritten > 0;
            try {
              await executeTool(
                isContinuation ? "append_file" : "write_file",
                JSON.stringify({ path: salvaged.path, content: salvaged.partialContent }),
                this.opts.projectRoot
              );
              salvagedCharsWrittenByPath.set(salvaged.path, alreadyWritten + salvaged.partialContent.length);
              this.opts.onStatus?.(
                `[tool call truncated] recovered and saved ${salvaged.partialContent.length} already-generated characters to ${salvaged.path} (${alreadyWritten + salvaged.partialContent.length} total so far) — asking the model to continue from there (${toolCallTruncationRetries}/${MAX_TOOL_CALL_TRUNCATION_RETRIES}).`
              );
              this.messages.push({
                role: "user",
                content:
                  `Your last tool call writing ${salvaged.path} was cut off before finishing, but the ${salvaged.partialContent.length} characters it did generate were NOT lost — ` +
                  `they've already been saved to the file (${alreadyWritten + salvaged.partialContent.length} characters on disk so far). ` +
                  `Do not repeat any of that content and do not use write_file again for this path. Continue by calling append_file with path="${salvaged.path}" ` +
                  `and content equal to ONLY what comes next, picking up exactly where the saved content leaves off, until the file is complete.`,
              });
              continue;
            } catch (writeErr: any) {
              // The salvage extraction succeeded but actually persisting
              // it failed (disk error, bad path, ...) — fall through to
              // the shrink-and-nudge path below rather than losing the
              // turn over a salvage-specific failure; that path has no
              // dependency on the filesystem write having worked.
              this.opts.onStatus?.(`[tool call truncated] salvage write failed (${writeErr.message}) — falling back.`);
            }
          }
          // Detected by comparing the error text verbatim: the server
          // embeds the actual generated (truncated) string in its
          // "last read: ..." field, so an IDENTICAL message means the
          // model regenerated identical content and got cut at the exact
          // same point — proof the chunking instruction below was
          // ignored, not just that another large file happened to be
          // involved. Reported live: this happened twice in a row on the
          // very same file. When it repeats, halve the shrink factor
          // (floor MIN_TOOL_CALL_MAX_TOKENS_SHRINK_FACTOR) so the NEXT
          // request's max_tokens — a real server-enforced cap the model
          // cannot ignore, unlike a prompt instruction — is smaller than
          // what just failed, guaranteeing the cutoff point moves earlier
          // and less generation is wasted even in the worst case. Resets
          // to 1 the moment a retry produces genuinely different content
          // (no reason to keep punishing a request that's actually
          // responding to the guidance).
          const isRepeatOfLastFailure = err.message === lastToolCallTruncationMessage;
          lastToolCallTruncationMessage = err.message;
          toolCallMaxTokensShrinkFactor = isRepeatOfLastFailure
            ? Math.max(MIN_TOOL_CALL_MAX_TOKENS_SHRINK_FACTOR, toolCallMaxTokensShrinkFactor / 2)
            : 1;
          // A vague "write shorter content" nudge is unenforceable on its
          // own — the model can silently ignore it and produce another
          // oversized blob (as above). Give it a concrete, checkable
          // number too: the exact character budget the NEXT retry's
          // (possibly now-shrunk) max_tokens actually allows, derived the
          // same way computeMaxTokens() sizes the request itself
          // (chars-per-token estimate * a safety factor, since a real
          // generated string usually costs MORE JSON-encoded characters
          // than raw text — escaped quotes/newlines/backslashes in code or
          // markdown routinely nearly double it) — plus the append_file
          // tool (tools/index.ts), which turns "one file, one shot" into a
          // fixed-size chunking protocol: write_file for the first chunk,
          // append_file repeatedly for the rest.
          const CHARS_PER_TOKEN_ESTIMATE = 4;
          const JSON_ESCAPE_SAFETY_FACTOR = 0.5;
          const nextMaxTokens = Math.max(
            512,
            Math.floor(this.computeMaxTokens(usedBeforeChat) * toolCallMaxTokensShrinkFactor)
          );
          const chunkCharBudget = Math.floor(nextMaxTokens * CHARS_PER_TOKEN_ESTIMATE * JSON_ESCAPE_SAFETY_FACTOR);
          this.opts.onStatus?.(
            isRepeatOfLastFailure
              ? `[tool call truncated] the model repeated the exact same oversized content and hit the exact same cutoff — forcing a smaller reply budget (~${chunkCharBudget} chars) and retrying (${toolCallTruncationRetries}/${MAX_TOOL_CALL_TRUNCATION_RETRIES}).`
              : `[tool call truncated] the model's last tool call was cut off before it could finish (too long for the available reply budget) — asking it to continue in ~${chunkCharBudget}-character chunks and retrying (${toolCallTruncationRetries}/${MAX_TOOL_CALL_TRUNCATION_RETRIES}).`
          );
          // Not a tool result (there's no valid tool_call_id — the
          // assistant message that would have carried one never made it
          // into `this.messages`, since the request itself threw before
          // any of it was appended) — a plain user-role nudge instead,
          // same as how a human would redirect the very next turn.
          this.messages.push({
            role: "user",
            content: isRepeatOfLastFailure
              ? `STOP. You just tried to write the exact same content again and it was cut off at the exact same point — you did NOT shorten it. ` +
                `This is a hard limit, not a suggestion: your next reply can physically generate at most ${chunkCharBudget} characters of tool-call content before being cut off. ` +
                `Call write_file with ONLY the first part of the file (well under ${chunkCharBudget} characters) and STOP THERE — do not try to include the rest. ` +
                `You will be prompted to continue with append_file afterward.`
              : `Your last tool call's arguments were cut off before finishing (too long for the reply budget) and could not be parsed — nothing was written. ` +
                `Do not retry the same call. Instead, write this content in fixed-size chunks of no more than ${chunkCharBudget} characters each: ` +
                `call write_file once with the FIRST chunk (this creates/overwrites the file), then call append_file once per remaining chunk, in order, ` +
                `until the full content has been written. Each individual call's content argument must stay under the ${chunkCharBudget}-character limit.`,
          });
          continue;
        }
        // A network/backend failure here must never crash the whole CLI —
        // this is exactly the crash reproduced when running from a project
        // with no .llamacli/config.yaml (falls back to an unreachable
        // default backend URL): report it and end the turn gracefully so
        // the user can fix config/connectivity and try again.
        this.opts.onStatus?.(`[error] couldn't reach the model backend: ${summarizeErrorForDisplay(err.message)}`);
        logFailure({
          timestamp: new Date().toISOString(),
          summary: "backend chat request failed",
          toolName: "chat",
          errorMessage: err.message,
        });
        this.hasNewFailuresThisTurn = true;
        return;
      }
      const message = res.choices[0].message;
      // Some models occasionally leak raw tool-calling template tags into
      // plain content when llama-server's grammar-constrained tool-call
      // mode doesn't trigger cleanly (confirmed against the real backend —
      // see textSanitize.ts). Clean it out of what's stored in history too,
      // not just what's displayed, so a leaked tag doesn't linger in
      // context and reinforce the same pattern on a later turn.
      if (typeof message.content === "string") {
        message.content = stripToolCallTemplateLeak(message.content);
      }
      this.messages.push(message);
      this.opts.onAssistantDone?.();

      // The circuit breaker only watches tool calls; a model can also get
      // stuck saying the same thing over and over (each time with some
      // tool call), which it never sees. Stop the turn instead.
      if (typeof message.content === "string" && message.content.trim()) {
        recentAssistantTexts.push(normalizeForRepeat(message.content));
        if (recentAssistantTexts.length > REPEAT_WINDOW) recentAssistantTexts.shift();
        const latest = recentAssistantTexts[recentAssistantTexts.length - 1];
        const repeats = recentAssistantTexts.filter((t) => t === latest).length;
        if (repeats >= REPEAT_LIMIT) {
          this.opts.onStatus?.(
            `[stopped] the model gave the same response ${repeats} times in this turn — stopping so it doesn't keep looping. ` +
              "Tell it what to do differently to continue."
          );
          logFailure({
            timestamp: new Date().toISOString(),
            summary: "repeated identical assistant response",
            toolName: "chat",
            errorMessage: `same response ${repeats} times in the last ${recentAssistantTexts.length}`,
          });
          this.hasNewFailuresThisTurn = true;
          return;
        }
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        // The turn ended cleanly (not interrupted by compaction — that
        // exits through a different path below). If every declared step
        // is done (or nothing was ever declared), there's nothing left to
        // resume — clear the plan-progress checkpoint and hide the
        // progress indicator, rather than leaving a stale "5/5" (or a
        // fully-resolved plan) sitting around for a completely unrelated
        // next task to inherit. A plan with real remaining steps is left
        // on disk on purpose, so a crash right after this point can still
        // resume it.
        if (this.plan.length === 0 || this.plan.every((s) => s.status === "done")) {
          if (this.plan.length > 0) {
            this.plan = [];
            await clearCheckpoint(this.opts.projectRoot);
            await clearNotes(this.opts.projectRoot).catch(() => {});
          }
          this.opts.onPlanProgress?.(0, 0);
        }
        // A turn that ends on plain text (no tool call) leaves nothing on
        // screen marking it as finished — reported live as the TUI looking
        // "stuck" after a long response, when the turn had actually ended
        // cleanly and was just waiting for the next message the whole time.
        this.opts.onStatus?.("[done — waiting for your next message]");
        return; // assistant is done, control returns to the prompt
      }

      for (const call of message.tool_calls) {
        // Cancellation can land here instead of inside the chat() catch
        // above when the user hits Esc while a tool (run_shell, a file
        // write, ...) is actually running rather than while the model is
        // generating — backend.cancel() is a no-op in that case (nothing
        // in flight on the backend to abort), so nothing throws from
        // chat(). Checking here too means a cancel between tool calls in a
        // batch is still honored promptly instead of only being noticed
        // once the model streams its next reply.
        if (this.cancelRequested) {
          this.cancelRequested = false;
          this.opts.onStatus?.(
            "[cancelled] work saved — it will resume automatically the next time llamacli starts in this project."
          );
          return;
        }
        const stopReason = this.breaker.shouldStop();
        if (stopReason) {
          this.opts.onStatus?.(`[stopped] self-healing circuit breaker tripped: ${stopReason}`);
          return;
        }
        this.breaker.record({ toolName: call.function.name, argsSignature: call.function.arguments });

        // Check compaction between individual tool calls too, not just
        // between turns — otherwise pendingToolCall (PROMPT.md §2.2) can
        // never be captured, since a whole batch of tool calls always ran
        // to completion before the next compaction check. If it fires here,
        // this call (and any after it in the same batch) is abandoned in
        // favor of the checkpoint's resume prompt reissuing it next turn —
        // the assistant message that requested it gets summarized away by
        // compact(), so there's no valid tool_call_id left to answer anyway.
        if (
          (
            await this.maybeCompact({
              name: call.function.name,
              argumentsJson: call.function.arguments,
              reason: "compaction threshold hit before this call could run",
            })
          ).compacted
        ) {
          // Without an explicit message here, the turn just stops with no
          // visible signal beyond whatever compact() already logged (which,
          // on failure, doesn't say the turn is over) — indistinguishable
          // from the CLI having hung. Say so plainly.
          if (this.opts.autoResume ?? true) {
            // Fold the just-written checkpoint's resume prompt straight
            // back into the conversation and re-enter the top of the turn
            // loop — the next iteration's maybeCompact() no-ops (already
            // compacted) and backend.chat() runs with the resumed context,
            // so the abandoned tool call effectively gets reissued without
            // waiting for a manual message. The self-healing circuit
            // breaker (checked at the top of each tool call, never reset
            // within a single send()/resumeIfCheckpointExists() call) still
            // bounds this against a compaction/resume cycle that never
            // makes real progress.
            this.opts.onStatus?.(
              "[compaction] interrupted mid-task — resuming automatically."
            );
            await this.injectResumeContextIfPending();
            continue turnLoop;
          }
          this.opts.onStatus?.(
            "[turn ended] Compaction interrupted this task. It'll pick back up automatically with your next message."
          );
          return;
        }

        this.opts.onToolCall?.(call.function.name, call.function.arguments);

        if (AGENT_STATE_TOOLS.has(call.function.name)) {
          const result = await this.applyStateTool(call.function.name, call.function.arguments);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
          continue;
        }

        let content: string;
        if (isElidedContentWrite(call.function.name, call.function.arguments)) {
          content =
            "ERROR: refused — the content argument is the placeholder that replaces an earlier write's content in this " +
            "conversation, not real file content. Writing it would destroy the file. Call read_file on the path to see " +
            "its current content, then write the actual content you intend.";
          logFailure({
            timestamp: new Date().toISOString(),
            summary: `tool ${call.function.name} refused: placeholder content`,
            toolName: call.function.name,
            errorMessage: "content was the elided-write placeholder",
          });
          this.hasNewFailuresThisTurn = true;
          this.messages.push({ role: "tool", tool_call_id: call.id, content });
          continue;
        }
        const editPath = EDIT_TOOLS.has(call.function.name) ? pathArg(call.function.arguments) : null;
        const editedExisting = editPath !== null && existsSync(editPath);
        try {
          const result = await executeTool(call.function.name, call.function.arguments, this.opts.projectRoot);
          content = result.lineRange
            ? capReadFileResult(
                result.content,
                result.lineRange,
                JSON.parse(call.function.arguments).path,
                this.opts.thresholds.contextWindowTokens
              )
            : capToolResult(result.content, this.opts.thresholds.contextWindowTokens);
          if (result.diff) {
            this.opts.onDiff?.(this.summarizeArgs(call.function.arguments), result.diff);
          }
          // Requested directly: a run_shell result (npm test, npm run
          // build, ...) was never actually shown in the TUI at all —
          // only the "⚡ run_shell(npm test)" call label, not what it
          // printed. Scoped to run_shell (not every tool): a read_file
          // result would just duplicate a file already visible on disk,
          // but a shell command's output is often the ONLY place that
          // information exists.
          if (call.function.name === "run_shell") {
            this.opts.onToolResult?.(this.summarizeArgs(call.function.arguments), content);
          }
          this.recordFileTouch(call.function.name, call.function.arguments);
          this.pushExecutedToolLog(`${call.function.name}(${this.summarizeArgs(call.function.arguments)})`);
          if (editPath !== null) {
            const check = await runPostEditCheck(editPath, this.opts.projectRoot, this.opts.verify, call.function.name === "append_file");
            const checkFailed = check?.includes("FAILED") ?? false;
            // Progress requires the edit to have LANDED clean: a check
            // failure must not count, or a model stuck failing the same
            // validation forever resets the no-progress clock on every
            // attempt and the guard never fires. Reported live: exactly
            // this let a session "edit" a file with a stray // comment
            // for 40 minutes without ever being flagged as stuck.
            if (editedExisting && !checkFailed) this.progress.markProgress(this.now());
            if (check) content = `${content}\n\n${check}`;

            // Aider's edit → validate → reflect → retry loop: turn a
            // check failure into an explicit, escalating instruction
            // rather than a passive result the model may or may not act
            // on. Resets to 0 the moment a check on this path passes.
            const prevFails = this.consecutiveCheckFailures.get(editPath) ?? 0;
            if (checkFailed) {
              const fails = prevFails + 1;
              this.consecutiveCheckFailures.set(editPath, fails);
              if (fails >= REFLECT_RETRY_ESCALATE_AT) {
                content =
                  `${content}\n\n[reflect] This is the ${ordinal(fails)} consecutive failed check on this exact file — ` +
                  "repeating the same edit will not help. Stop, re-read the actual error above line by line, and change " +
                  "your approach before touching this file again.";
              }
            } else if (prevFails > 0) {
              this.consecutiveCheckFailures.delete(editPath);
            }

            if (!checkFailed && this.opts.gitCheckpoint) {
              const label = `llamacli: ${call.function.name} ${this.summarizeArgs(call.function.arguments)}`.slice(0, 72);
              const cp = await gitCheckpoint(editPath, label, this.opts.projectRoot);
              if (cp.committed) content = `${content}\n\n[checkpoint] committed as ${cp.hash} — revertable with git revert/reset.`;
            }
          }
          // Drop the now-redundant copy of the file content from the
          // assistant message still sitting in `this.messages` (pushed
          // just above, before this batch ran) — see
          // elideWrittenFileContent. Only after a SUCCESSFUL write: if it
          // failed, the content is all that's left of the attempt.
          if (FILE_CONTENT_TOOLS.has(call.function.name)) {
            call.function.arguments = elideWrittenFileContent(call.function.arguments);
          }
        } catch (err: any) {
          // Capped exactly like a successful result: run_shell reports a
          // non-zero exit by throwing with the command's full output in the
          // message. A failing `npm test` (41,920 chars, ~16K tokens) went
          // into the history uncapped, pushed usage past the compaction
          // trigger on its own, got compacted away before the model read it,
          // and the model reran it — a compaction every ~16s, live.
          content = capToolResult(`ERROR: ${err.message}`, this.opts.thresholds.contextWindowTokens);
          logFailure({
            timestamp: new Date().toISOString(),
            summary: `tool ${call.function.name} failed`,
            toolName: call.function.name,
            errorMessage: err.message,
          });
          this.hasNewFailuresThisTurn = true;
        }
        this.messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
  }

  /** Handles a tool call that mutates loop state rather than the filesystem/shell. */
  private async applyStateTool(name: string, argsJson: string): Promise<string> {
    if (name === "note") {
      try {
        const { text } = JSON.parse(argsJson) as { text: string };
        if (typeof text !== "string" || !text.trim()) return "ERROR: note needs a non-empty `text`";
        await appendNote(this.opts.projectRoot, text);
        return "noted (kept across compaction)";
      } catch (err: any) {
        return `ERROR: invalid note arguments: ${err.message}`;
      }
    }
    if (name === "update_plan") {
      try {
        const { steps } = JSON.parse(argsJson) as { steps: Checkpoint["steps"] };
        const doneBefore = this.plan.filter((s) => s.status === "done").length;
        if (steps.filter((s) => s.status === "done").length > doneBefore) this.progress.markProgress(this.now());
        this.plan = steps;
        // Persist immediately, independent of compaction — requested
        // directly: a plan should survive a hard kill (Ctrl-C at the OS
        // level, crash) at ANY point, not only if a compaction happened to
        // have already run first. Before this, a checkpoint only ever
        // existed after compaction, so a session killed mid-task lost the
        // whole plan with nothing to resume from. Best-effort: a failure
        // here must never break the actual tool-call response the model
        // is waiting on.
        try {
          await writeCheckpoint(this.opts.projectRoot, {
            version: 1,
            timestamp: new Date().toISOString(),
            reason: "plan-progress",
            goal: this.currentGoalSummary(),
            steps,
            files: this.currentFiles(),
            pendingToolCall: null,
            mustPreserve: [],
          });
        } catch {
          // best-effort — the in-memory plan (this.plan) still works for
          // the rest of THIS process's lifetime either way.
        }
        this.opts.onPlanProgress?.(steps.filter((s) => s.status === "done").length, steps.length);
        return `plan updated (${steps.length} steps)`;
      } catch (err: any) {
        return `ERROR: invalid update_plan arguments: ${err.message}`;
      }
    }
    return `ERROR: unhandled state tool ${name}`;
  }

  private pushExecutedToolLog(description: string): void {
    this.executedToolLog.push(description);
    if (this.executedToolLog.length > AgentLoop.MAX_EXECUTED_TOOL_LOG) {
      // Drop from the front — oldest entries are the least useful for a
      // fallback "what was done" summary anyway.
      this.executedToolLog.splice(0, this.executedToolLog.length - AgentLoop.MAX_EXECUTED_TOOL_LOG);
    }
  }

  private recordFileTouch(toolName: string, argsJson: string): void {
    const status = FILE_TOOLS[toolName];
    if (!status) return;
    try {
      const { path } = JSON.parse(argsJson) as { path?: string };
      if (!path) return;
      // A file already marked "modified" stays "modified" even if later re-read.
      if (status === "read" && this.filesTouched.get(path) === "modified") return;
      this.filesTouched.set(path, status);
    } catch {
      // malformed args — nothing to record
    }
  }

  private summarizeArgs(argsJson: string): string {
    try {
      const args = JSON.parse(argsJson);
      return (args.path ?? args.command ?? "").toString().slice(0, 80);
    } catch {
      return "";
    }
  }

  /** Falls back to "every executed tool call so far = a done step" when the
   *  model never called update_plan, so steps are never silently empty. */
  private currentSteps(): Checkpoint["steps"] {
    return this.plan;
  }

  /** Without a plan, the latest tool calls are what shows where the work
   *  was. They used to be stored as "done" steps, which made a resume
   *  report that everything was already finished. */
  private recentActions(): string[] | undefined {
    return this.plan.length > 0 ? undefined : this.executedToolLog.slice(-15);
  }

  private currentFiles(): Checkpoint["files"] {
    return [...this.filesTouched.entries()].map(([path, status]) => ({ path, status }));
  }

  /** TUI entry point for Esc → Y (cancel the in-progress turn and save
   *  progress to resume later). Deliberately does NOT go through
   *  enqueue(): the currently-running turn IS the thing occupying
   *  `taskChain` right now, so queuing behind it would mean waiting for
   *  the very turn being cancelled to finish on its own first — exactly
   *  what this exists to avoid. Safe to call while nothing is running too
   *  (a no-op past the checkpoint write, which is harmless either way) —
   *  the UI only wires this to Esc while `busy` is true, but there's
   *  nothing here that depends on that being reliably true.
   *
   *  Writes the checkpoint FIRST, before requesting the abort — same
   *  ordering compact() already uses, so a crash between the two steps
   *  still leaves a resumable checkpoint on disk rather than losing
   *  everything if the abort somehow tore something down first. */
  async cancelCurrentTurn(): Promise<void> {
    this.cancelRequested = true;
    try {
      await writeCheckpoint(this.opts.projectRoot, {
        version: 1,
        timestamp: new Date().toISOString(),
        reason: "manual",
        goal: this.currentGoalSummary(),
        steps: this.currentSteps(),
        recentActions: this.recentActions(),
        files: this.currentFiles(),
        pendingToolCall: null,
        mustPreserve: [],
      });
    } catch {
      // Best-effort, same as every other checkpoint write in this file —
      // the cancel itself must still go through even if the disk write
      // fails, rather than leaving the turn stuck running.
    }
    this.opts.backend.cancel?.();
  }

  /** Entry point for the /compact slash command — runs compaction immediately
   *  regardless of current context usage. */
  async forceCompact(): Promise<void> {
    await this.enqueue(() => this.compact("manual", null));
  }

  /** Called right before actually quitting (index.tsx's /quit handler) —
   *  requested directly: "when quitting, write current progress to disk
   *  immediately so the next launch can pick up where this one left off,
   *  the same as how compaction already saves state before/after
   *  summarizing." The plan-progress checkpoint (written on every
   *  update_plan call) already covers the case where a plan was declared,
   *  but a session that never called update_plan — plenty of real work
   *  (tool calls, file reads, exploration) still possible without one —
   *  had nothing at all saved before this, losing the whole conversation
   *  the moment the process exited. Runs an actual compaction (the exact
   *  same mechanism `/compact` uses) so the next launch resumes with a
   *  real model-generated summary of what was happening, not just
   *  whatever structured plan steps happen to exist. A no-op when there's
   *  nothing beyond the initial system prompt to save. */
  async saveStateOnQuit(): Promise<void> {
    await this.enqueue(async () => {
      if (this.messages.length <= 1) return; // nothing but the system prompt — nothing to save
      await this.compact("manual", null);
    });
  }

  /** Measures current context usage, reports it to the UI (§2.5), and
   *  compacts if over threshold. Returns whether it compacted, so callers
   *  mid-tool-call-batch know to abandon the rest of the batch. */
  /** Returns the pre-compaction token estimate alongside whether it
   *  compacted, so the top-of-turnLoop call site (runUntilIdle) can reuse
   *  it to size max_tokens dynamically without a second tokenize() call —
   *  see computeMaxTokens()'s doc comment for why that estimate matters. */
  private async maybeCompact(
    pendingToolCall: Checkpoint["pendingToolCall"] = null
  ): Promise<{ compacted: boolean; used: number }> {
    const used = await estimateTokens(this.messages, this.opts.backend, toolDefsJson(), activeToolDefs());
    this.opts.onContextUsage?.(used, this.opts.thresholds.contextWindowTokens);
    if (used >= this.opts.thresholds.contextWindowTokens * this.opts.thresholds.autoTriggerRatio) {
      await this.compact("auto-threshold", pendingToolCall);
      return { compacted: true, used };
    }
    return { compacted: false, used };
  }

  /** How many tokens the upcoming request is allowed to generate.
   *
   *  Previously a flat `contextWindowTokens * 0.25`, regardless of how
   *  much of the window the conversation actually used — found live: a
   *  request with only 6,400 tokens of real history (9,984 tokens of
   *  genuinely free room in a 16,384-token window) still got capped at a
   *  flat 4,096, truncating a `write_file` tool call's arguments — a
   *  long generated document — mid-JSON-string. The server's
   *  grammar-constrained tool-call parser then rejected the resulting
   *  unterminated string as invalid JSON (500 "missing closing quote"),
   *  which looked to the user like the whole turn had silently stopped.
   *
   *  Sized to the room actually left (window minus what's already used,
   *  minus a safety margin) instead, so a small conversation gets real
   *  headroom for a legitimately long single response/tool call. Still
   *  bounded at a ceiling — this must never become effectively unbounded
   *  again (the exact failure `max_tokens` exists to prevent: n_predict=-1
   *  pinning the single inference slot indefinitely on a
   *  degenerate/repetition-loop generation) — just a much more generous
   *  one than the old flat 25%.
   *
   *  The margin was originally 256 — found live to be nowhere near enough:
   *  a real request's PROMPT ALONE (13,880 tokens, per the server's own
   *  count) ran ~1,200 tokens over what `usedTokens` (this client's
   *  estimate, fed by estimateTokens()) had said the conversation was.
   *  The generation that followed (2,504 tokens — genuinely under its
   *  3,497 max_tokens cap, so the cap itself wasn't the problem) then
   *  pushed prompt+reply to exactly 16,384 — the server's own context
   *  limit — and got hard-truncated (`truncated=1`) independent of
   *  max_tokens entirely. `estimateTokens()` does use the backend's real
   *  tokenizer when available, but a live gap of that size means
   *  something server-side (chat-template wrapping, per-message role
   *  formatting, the exact tool-call grammar overhead) still isn't fully
   *  captured by tokenizing the raw message text alone.
   *
   *  A first fix raised this to 1,024 — a regression test reproducing the
   *  exact observed gap (real_prompt + max_tokens = window + gap - margin)
   *  caught that this was STILL under the 1,200-token gap itself, only
   *  narrowing the overflow to 176 tokens rather than eliminating it: the
   *  margin must exceed the observed gap, not just be in its general
   *  neighborhood. 2,048 clears the known gap with a real cushion (~70%
   *  more) for the next one to vary by, rather than being tuned to just
   *  barely survive this specific incident. */
  private computeMaxTokens(usedTokens: number): number {
    const window = this.opts.thresholds.contextWindowTokens;
    const SAFETY_MARGIN_TOKENS = 2048;
    const CEILING_FRACTION = 0.75;
    const available = window - usedTokens - SAFETY_MARGIN_TOKENS;
    const ceiling = Math.floor(window * CEILING_FRACTION);
    return Math.max(512, Math.min(available, ceiling));
  }

  /** Sizes the summary and the kept tail so that the COMPACTED conversation
   *  (base system prompt + tool schema + summary + tail) lands clearly under
   *  the auto-trigger threshold. Both used to be flat fractions of the
   *  window, independent of the fixed per-request overhead — measured live
   *  on a 4096-token window: base prompt + tool schema alone = 1,283 tokens,
   *  summary cap 1,024, tail budget 1,228, so a "successful" compaction left
   *  ~3,500 tokens against a 2,867 trigger and the very next step compacted
   *  again — every step, forever, each pass re-summarizing the last. */
  private async postCompactionBudget(
    maxTailBudgetFraction: number
  ): Promise<{ tailBudgetFraction: number; summaryMaxTokens: number | undefined }> {
    const window = this.opts.thresholds.contextWindowTokens;
    const systemText = typeof this.messages[0]?.content === "string" ? this.messages[0].content : "";
    // The one-character user turn is there because some chat templates
    // (Ornith-1.5's) reject a conversation with no user message; without
    // it this exact count failed on every compaction and fell back to a
    // rougher estimate that misses the template's own overhead.
    const overhead = await estimateTokens(
      [
        { role: "system", content: splitSystemMessage(systemText).base },
        { role: "user", content: "." },
      ],
      this.opts.backend,
      toolDefsJson(),
      activeToolDefs()
    );
    // Land at half the trigger level, so the conversation can grow for a
    // while before the next compaction. Was 75%: measured live on a 24,576
    // window, that left ~4-6K tokens of room, and tool-heavy steps add
    // 2-5K each, so compaction (30-40s of summary generation) came every
    // 2-5 minutes. Half the trigger roughly doubles the room, at the cost
    // of keeping less recent conversation verbatim.
    const target = Math.floor(window * this.opts.thresholds.autoTriggerRatio * 0.5);
    const room = target - overhead;
    if (room < 512 && !this.warnedWindowTooSmall) {
      this.warnedWindowTooSmall = true;
      this.opts.onStatus?.(
        `[warning] the system prompt + tool schema alone use ${overhead} of ${window} context tokens — ` +
          `too little room is left for compaction to keep useful history. Restart llama-server with a larger -c (e.g. 16384 or more).`
      );
    }
    const usableRoom = Math.max(256, room);
    // Same default cap as runCompaction's; only tightened when room is short.
    const defaultSummaryMaxTokens = Math.max(256, Math.min(4096, Math.floor(window * 0.25)));
    const summaryMaxTokens = Math.min(defaultSummaryMaxTokens, Math.floor(usableRoom / 2));
    // selectKeptTail() measures its budget as a fraction of 75% of the window.
    const tailTokens = usableRoom - summaryMaxTokens;
    const tailBudgetFraction = Math.min(maxTailBudgetFraction, Math.max(0.02, tailTokens / (window * 0.75)));
    return { tailBudgetFraction, summaryMaxTokens };
  }

  private async compact(
    reason: Checkpoint["reason"],
    pendingToolCall: Checkpoint["pendingToolCall"],
    // See runUntilIdle's overflow-retry loop: passed smaller than
    // DEFAULT_TAIL_BUDGET_FRACTION on a retry, when a previous compaction
    // at the default fraction failed to shrink anything at all — the kept
    // tail itself, not just old history, was the thing too large to fit.
    tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION
  ): Promise<void> {
    this.opts.onCompactionStatus?.("running", new Date().toISOString());
    const partial: Omit<Checkpoint, "version" | "timestamp"> = {
      reason,
      goal: this.currentGoalSummary(),
      steps: this.currentSteps(),
        recentActions: this.recentActions(),
      files: this.currentFiles(),
      pendingToolCall,
      mustPreserve: [],
    };
    try {
      const budget = await this.postCompactionBudget(tailBudgetFraction);
      const { messages, checkpoint, detail } = await runCompaction(
        this.opts.projectRoot,
        this.messages,
        this.opts.backend,
        this.opts.model,
        partial,
        this.opts.thresholds.contextWindowTokens,
        budget.tailBudgetFraction,
        budget.summaryMaxTokens
      );
      this.messages = messages;
      this.progress.onCompaction();
      // Working notes go back in with the summary, so what the model had
      // established survives the compaction verbatim.
      const notes = await readNotes(this.opts.projectRoot);
      if (notes && typeof this.messages[0]?.content === "string") {
        this.messages[0] = { ...this.messages[0], content: `${this.messages[0].content}\n\n${NOTES_HEADER}\n${notes}` };
      }
      this.opts.onStatus?.(`[compaction complete] ${checkpoint.timestamp}`);
      this.opts.onCompactionStatus?.("complete", checkpoint.timestamp);
      this.opts.onCompactionDetail?.(detail);
    } catch (err: any) {
      // The checkpoint file itself is already written by this point
      // (runCompaction writes it before making the summary request), so
      // nothing is lost — just don't crash, and don't pretend the
      // conversation was compacted when it wasn't.
      this.opts.onStatus?.(
        `[compaction failed] ${summarizeErrorForDisplay(err.message)} — checkpoint was saved, but the conversation wasn't summarized; continuing with the current context.`
      );
      this.opts.onCompactionStatus?.("failed", new Date().toISOString());
      logFailure({
        timestamp: new Date().toISOString(),
        summary: "compaction summary request failed",
        toolName: "compact",
        errorMessage: err.message,
      });
      this.hasNewFailuresThisTurn = true;
    }
  }

  /**
   * PROMPT.md §3 real-time extension: rather than waiting for the user to
   * run /improve or for the session to end, re-check the failure log right
   * after every new failure and — if a pattern is now recurring — append it
   * to `.llamacli/state/improvement-log.md` immediately. This is
   * fire-and-forget on purpose: analysis calls the model, which must never
   * block the tool-call loop it's reacting to, and a failure here is
   * itself just logged, never surfaced as a hard error (it's best-effort
   * background journaling, not part of the main task). Writing to the log
   * file is purely a *record* — never auto-loaded as a rule, so this can
   * never change agent behavior on its own; only /improve-apply can.
   */
  private triggerRealtimeImprovementCheck(): void {
    proposeImprovement(getFailureLog(), this.opts.backend, this.opts.model)
      .then(async (proposal) => {
        if (!proposal || this.loggedImprovementSignatures.has(proposal.signature)) return;
        this.loggedImprovementSignatures.add(proposal.signature);
        const path = await appendImprovementLog(this.opts.projectRoot, proposal);
        this.opts.onStatus?.(
          `[auto-improve] Noticed a recurring pattern — logged to ${path}. Run /improve to review, /improve-apply to turn it into a rule.`
        );
      })
      .catch(() => {
        // best-effort background analysis — never let it surface as a hard failure
      });
  }

  /** Analyzes the accumulated failure log and, if a pattern recurs often
   *  enough, asks the model to draft a rule that would prevent it. Does NOT
   *  write anything — call applyPendingImprovement() after the user approves. */
  async proposeSelfImprovement(): Promise<ImprovementProposal | null> {
    const proposal = await proposeImprovement(getFailureLog(), this.opts.backend, this.opts.model);
    this.pendingImprovement = proposal;
    return proposal;
  }

  /** Writes the last proposed rule as a NEW file under .llamacli/rules/ — only
   *  called after the user has explicitly seen and approved the proposal. */
  async applyPendingImprovement(): Promise<string | null> {
    if (!this.pendingImprovement) return null;
    const path = await writeProposedRule(this.opts.projectRoot, this.pendingImprovement);
    this.pendingImprovement = null;
    return path;
  }

  hasFailureLog(): boolean {
    return getFailureLog().length > 0;
  }

  /** Manually clears the plan-progress indicator and its on-disk checkpoint —
   *  the escape hatch for when the model finishes real work but never calls
   *  update_plan to mark the final step done, leaving a stale "N/M" stuck in
   *  the status bar with no way to clear it (reported directly: the model
   *  hallucinated a nonexistent "close the run from the browser UI" fix when
   *  asked about this instead of admitting there was no such hook). Mirrors
   *  the auto-cleanup block above but is invoked externally, by the user,
   *  rather than by the model finishing all its declared steps. */
  async clearPlan(): Promise<void> {
    await clearNotes(this.opts.projectRoot).catch(() => {});
    this.plan = [];
    await clearCheckpoint(this.opts.projectRoot);
    this.opts.onPlanProgress?.(0, 0);
  }

  private currentGoalSummary(): string {
    if (this.goal) return this.goal;
    const firstUser = this.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[resuming")
    );
    return typeof firstUser?.content === "string" ? firstUser.content.slice(0, 200) : "(unknown)";
  }
}
