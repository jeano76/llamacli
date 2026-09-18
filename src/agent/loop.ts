import type { ChatMessage, ModelBackend } from "../backend/types.js";
import { AGENT_STATE_TOOLS, FILE_TOOLS, TOOL_DEFS, executeTool } from "../tools/index.js";
import { CircuitBreaker } from "../hermes/selfHeal.js";
import { logFailure, getFailureLog } from "../hermes/selfHeal.js";
import { proposeImprovement, writeProposedRule, appendImprovementLog, ImprovementProposal } from "../hermes/selfImprove.js";
import { runCompaction, estimateTokens, buildResumePrompt, CompactionThresholds } from "../compaction/compactor.js";
import { clearCheckpoint } from "../compaction/checkpoint.js";
import type { Checkpoint } from "../compaction/checkpoint.js";
import { stripToolCallTemplateLeak } from "./textSanitize.js";

export interface AgentLoopOptions {
  projectRoot: string;
  model: string;
  backend: ModelBackend;
  systemPrompt: string;
  thresholds: CompactionThresholds;
  /** Called for each incremental token/chunk of assistant text as it streams in. */
  onAssistantDelta?: (text: string) => void;
  /** Called once an assistant message (streamed or not) is fully received —
   *  the UI uses this to stop appending to the current line. */
  onAssistantDone?: () => void;
  onToolCall?: (name: string, args: string) => void;
  /** ANSI-colored diff for a file-mutating tool call, UI-only. */
  onDiff?: (path: string, diff: string) => void;
  onStatus?: (status: string) => void;
  /** Fires whenever context usage is (re-)measured, so the UI's context
   *  battery gauge can reflect real usage (PROMPT.md §2.5) instead of being
   *  disconnected from the agent loop. */
  onContextUsage?: (usedTokens: number, totalTokens: number) => void;
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
  /** Files touched via read_file/write_file/edit_file, most-recent status wins. */
  private filesTouched = new Map<string, Checkpoint["files"][number]["status"]>();
  /** Fallback step history when the model never calls update_plan: every
   *  successfully executed tool call, in order. */
  private executedToolLog: string[] = [];
  /** Last self-improvement proposal shown to the user but not yet applied
   *  (§3: never write a proposed rule without explicit approval). */
  private pendingImprovement: ImprovementProposal | null = null;
  /** Pattern signatures already written to the real-time improvement log
   *  this session, so a still-recurring failure doesn't re-append (and
   *  re-call the model for) the same finding on every new occurrence. */
  private loggedImprovementSignatures = new Set<string>();

  constructor(private opts: AgentLoopOptions) {
    this.messages = [{ role: "system", content: opts.systemPrompt }];
  }

  /** Reads back a checkpoint left by a compaction that abandoned work
   *  mid-batch (see the mid-tool-call-loop comment below) and folds its
   *  resume prompt into the conversation, so whoever calls this next picks
   *  the interrupted work back up. Consumes (clears) the checkpoint before
   *  returning — if a fresh compaction happens later in the same turn,
   *  that new checkpoint must survive, so clearing afterward would be
   *  wrong. Returns whether there was anything to resume. */
  private async injectResumeContextIfPending(): Promise<boolean> {
    const resumeText = await buildResumePrompt(this.opts.projectRoot);
    if (!resumeText) return false;
    this.opts.onStatus?.(resumeText);
    this.messages.push({ role: "system", content: resumeText });
    await clearCheckpoint(this.opts.projectRoot);
    return true;
  }

  /** PROMPT.md §2.4: on startup, if a checkpoint was left behind (compaction
   *  fired in a previous session that then exited/crashed before finishing),
   *  resume automatically — no user input required. */
  async resumeIfCheckpointExists(): Promise<void> {
    await this.enqueue(async () => {
      const resumed = await this.injectResumeContextIfPending();
      if (resumed) await this.runUntilIdle();
    });
  }

  async send(userText: string): Promise<void> {
    await this.enqueue(async () => {
      // A compaction can also fire *mid-session* (not just be left over
      // from a previous process) and abandon work — e.g. mid-tool-call-loop
      // below. Previously that resume context only ever got folded in on a
      // fresh process restart, so typing a new message in the same running
      // session silently dropped it instead of picking the interrupted work
      // back up, even though a checkpoint was sitting on disk the whole
      // time. Check every time, not just at startup.
      await this.injectResumeContextIfPending();
      this.messages.push({ role: "user", content: userText });
      await this.runUntilIdle();
    });
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
    while (true) {
      await this.maybeCompact();

      let res;
      try {
        res = await this.opts.backend.chat(
          { model: this.opts.model, messages: this.messages, tools: TOOL_DEFS, stream: true },
          (chunk) => {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) this.opts.onAssistantDelta?.(delta.content);
          }
        );
      } catch (err: any) {
        // A network/backend failure here must never crash the whole CLI —
        // this is exactly the crash reproduced when running from a project
        // with no .llamacli/config.yaml (falls back to an unreachable
        // default backend URL): report it and end the turn gracefully so
        // the user can fix config/connectivity and try again.
        this.opts.onStatus?.(`[error] couldn't reach the model backend: ${err.message}`);
        logFailure({
          timestamp: new Date().toISOString(),
          summary: "backend chat request failed",
          toolName: "chat",
          errorMessage: err.message,
        });
        this.triggerRealtimeImprovementCheck();
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

      if (!message.tool_calls || message.tool_calls.length === 0) {
        return; // assistant is done, control returns to the prompt
      }

      for (const call of message.tool_calls) {
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
          await this.maybeCompact({
            name: call.function.name,
            argumentsJson: call.function.arguments,
            reason: "compaction threshold hit before this call could run",
          })
        ) {
          // Without an explicit message here, the turn just stops with no
          // visible signal beyond whatever compact() already logged (which,
          // on failure, doesn't say the turn is over) — indistinguishable
          // from the CLI having hung. Say so plainly: this is a real stop,
          // not the agent still thinking.
          this.opts.onStatus?.(
            "[turn ended] Compaction interrupted this task. It'll pick back up automatically with your next message."
          );
          return;
        }

        this.opts.onToolCall?.(call.function.name, call.function.arguments);

        if (AGENT_STATE_TOOLS.has(call.function.name)) {
          const result = this.applyStateTool(call.function.name, call.function.arguments);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
          continue;
        }

        let content: string;
        try {
          const result = await executeTool(call.function.name, call.function.arguments);
          content = result.content;
          if (result.diff) {
            this.opts.onDiff?.(this.summarizeArgs(call.function.arguments), result.diff);
          }
          this.recordFileTouch(call.function.name, call.function.arguments);
          this.executedToolLog.push(`${call.function.name}(${this.summarizeArgs(call.function.arguments)})`);
        } catch (err: any) {
          content = `ERROR: ${err.message}`;
          logFailure({
            timestamp: new Date().toISOString(),
            summary: `tool ${call.function.name} failed`,
            toolName: call.function.name,
            errorMessage: err.message,
          });
          this.triggerRealtimeImprovementCheck();
        }
        this.messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
  }

  /** Handles a tool call that mutates loop state rather than the filesystem/shell. */
  private applyStateTool(name: string, argsJson: string): string {
    if (name === "update_plan") {
      try {
        const { steps } = JSON.parse(argsJson) as { steps: Checkpoint["steps"] };
        this.plan = steps;
        return `plan updated (${steps.length} steps)`;
      } catch (err: any) {
        return `ERROR: invalid update_plan arguments: ${err.message}`;
      }
    }
    return `ERROR: unhandled state tool ${name}`;
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
    if (this.plan.length > 0) return this.plan;
    return this.executedToolLog.map((description) => ({ description, status: "done" as const }));
  }

  private currentFiles(): Checkpoint["files"] {
    return [...this.filesTouched.entries()].map(([path, status]) => ({ path, status }));
  }

  /** Entry point for the /compact slash command — runs compaction immediately
   *  regardless of current context usage. */
  async forceCompact(): Promise<void> {
    await this.enqueue(() => this.compact("manual", null));
  }

  /** Measures current context usage, reports it to the UI (§2.5), and
   *  compacts if over threshold. Returns whether it compacted, so callers
   *  mid-tool-call-batch know to abandon the rest of the batch. */
  private async maybeCompact(pendingToolCall: Checkpoint["pendingToolCall"] = null): Promise<boolean> {
    const used = await estimateTokens(this.messages, this.opts.backend);
    this.opts.onContextUsage?.(used, this.opts.thresholds.contextWindowTokens);
    if (used >= this.opts.thresholds.contextWindowTokens * this.opts.thresholds.autoTriggerRatio) {
      await this.compact("auto-threshold", pendingToolCall);
      return true;
    }
    return false;
  }

  private async compact(
    reason: Checkpoint["reason"],
    pendingToolCall: Checkpoint["pendingToolCall"]
  ): Promise<void> {
    const partial: Omit<Checkpoint, "version" | "timestamp"> = {
      reason,
      goal: this.currentGoalSummary(),
      steps: this.currentSteps(),
      files: this.currentFiles(),
      pendingToolCall,
      mustPreserve: [],
    };
    try {
      const { messages, checkpoint } = await runCompaction(
        this.opts.projectRoot,
        this.messages,
        this.opts.backend,
        this.opts.model,
        partial
      );
      this.messages = messages;
      this.opts.onStatus?.(`[compaction complete] ${checkpoint.timestamp}`);
    } catch (err: any) {
      // The checkpoint file itself is already written by this point
      // (runCompaction writes it before making the summary request), so
      // nothing is lost — just don't crash, and don't pretend the
      // conversation was compacted when it wasn't.
      this.opts.onStatus?.(
        `[compaction failed] ${err.message} — checkpoint was saved, but the conversation wasn't summarized; continuing with the current context.`
      );
      logFailure({
        timestamp: new Date().toISOString(),
        summary: "compaction summary request failed",
        toolName: "compact",
        errorMessage: err.message,
      });
      this.triggerRealtimeImprovementCheck();
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

  private currentGoalSummary(): string {
    const firstUser = this.messages.find((m) => m.role === "user");
    return typeof firstUser?.content === "string" ? firstUser.content.slice(0, 200) : "(unknown)";
  }
}
