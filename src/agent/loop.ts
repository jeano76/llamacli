import type { ChatMessage, ModelBackend } from "../backend/types.js";
import { AGENT_STATE_TOOLS, FILE_TOOLS, TOOL_DEFS, executeTool } from "../tools/index.js";
import { CircuitBreaker } from "../hermes/selfHeal.js";
import { logFailure, getFailureLog } from "../hermes/selfHeal.js";
import { proposeImprovement, writeProposedRule, ImprovementProposal } from "../hermes/selfImprove.js";
import { runCompaction, shouldCompact, buildResumePrompt, CompactionThresholds } from "../compaction/compactor.js";
import type { Checkpoint } from "../compaction/checkpoint.js";

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

  constructor(private opts: AgentLoopOptions) {
    this.messages = [{ role: "system", content: opts.systemPrompt }];
  }

  async resumeIfCheckpointExists(): Promise<void> {
    const resumeText = await buildResumePrompt(this.opts.projectRoot);
    if (resumeText) {
      this.opts.onStatus?.(resumeText);
      this.messages.push({ role: "system", content: resumeText });
    }
  }

  async send(userText: string): Promise<void> {
    await this.enqueue(async () => {
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
      if (shouldCompact(this.messages, this.opts.thresholds)) {
        await this.compact();
      }

      const res = await this.opts.backend.chat(
        { model: this.opts.model, messages: this.messages, tools: TOOL_DEFS, stream: true },
        (chunk) => {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) this.opts.onAssistantDelta?.(delta.content);
        }
      );
      const message = res.choices[0].message;
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
    await this.enqueue(() => this.compact("manual"));
  }

  private async compact(reason: Checkpoint["reason"] = "auto-threshold"): Promise<void> {
    const partial: Omit<Checkpoint, "version" | "timestamp"> = {
      reason,
      goal: this.currentGoalSummary(),
      steps: this.currentSteps(),
      files: this.currentFiles(),
      pendingToolCall: null,
      mustPreserve: [],
    };
    const { messages, checkpoint } = await runCompaction(
      this.opts.projectRoot,
      this.messages,
      this.opts.backend,
      this.opts.model,
      partial
    );
    this.messages = messages;
    this.opts.onStatus?.(`[compaction complete] ${checkpoint.timestamp}`);
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
