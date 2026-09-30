import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelBackend,
  ToolDef,
} from "./types.js";

/**
 * A ModelBackend that is not resolved yet.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Getting a usable backend can take minutes: a first run installs llama.cpp,
 * downloads a 20 GB model, then loads it. Doing that work BEFORE `render()`
 * meant the alt screen was already up with nothing in it, so the terminal just
 * sat blank — reported directly as "llamacli 를 입력하면 setup 진행이 되면서
 * 화면이 사라져". The screen has to come up first and the setup has to happen
 * inside it, which means AgentLoop has to be handed a backend before the real
 * one exists.
 *
 * So it is handed this instead. Every call awaits the same resolution promise;
 * a turn typed during setup therefore simply waits for setup to finish and then
 * runs, instead of failing against a dead port.
 *
 * The optional methods (`tokenize`, `countPromptTokens`, `getContextSize`,
 * `cancel`) are present on the proxy unconditionally, because callers feature-
 * detect with `backend.tokenize?.(...)`. A proxy that hid them would silently
 * make every llama.cpp-specific capability look unavailable — so it forwards,
 * and throws if the real backend turns out not to implement one. That is the
 * same failure a caller already handles for a non-llama.cpp server.
 */
export class DeferredBackend implements ModelBackend {
  private settled: ModelBackend | null = null;
  private failure: Error | null = null;

  constructor(private readonly pending: Promise<ModelBackend>) {
    // Handled here rather than only at the `resolve()` call sites so an early
    // failure is recorded once, instead of surfacing as an unhandled rejection
    // while nothing is awaiting the promise yet.
    pending.then(
      (backend) => {
        this.settled = backend;
      },
      (err) => {
        this.failure = err instanceof Error ? err : new Error(String(err));
      }
    );
  }

  /** The real backend if setup has already finished, else null. Lets a caller
   *  skip waiting when it has nothing to do until the first turn. */
  peek(): ModelBackend | null {
    return this.settled;
  }

  private async resolve(): Promise<ModelBackend> {
    if (this.settled) return this.settled;
    if (this.failure) throw this.describe(this.failure);
    try {
      return await this.pending;
    } catch (err) {
      throw this.describe(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** One message for the failure, naming the thing the user can actually do
   *  about it. A bare "fetch failed" here would be reported as a turn error
   *  with no indication that the cause was setup, several minutes earlier. */
  private describe(err: Error): Error {
    return new Error(
      `모델 백엔드를 준비하지 못했습니다: ${err.message} ` +
        `— .llamacli/config.yaml 을 확인하거나, llama-server 를 직접 실행한 뒤 다시 시도하세요.`
    );
  }

  async chat(
    req: ChatCompletionRequest,
    onDelta?: (chunk: ChatCompletionChunk) => void
  ): Promise<ChatCompletionResponse> {
    return (await this.resolve()).chat(req, onDelta);
  }

  async listModels(): Promise<string[]> {
    return (await this.resolve()).listModels();
  }

  async tokenize(text: string): Promise<number> {
    const backend = await this.resolve();
    if (!backend.tokenize) throw new Error("tokenize: 이 백엔드는 지원하지 않습니다");
    return backend.tokenize(text);
  }

  async countPromptTokens(messages: ChatCompletionRequest["messages"], tools?: ToolDef[]): Promise<number> {
    const backend = await this.resolve();
    if (!backend.countPromptTokens) throw new Error("countPromptTokens: 이 백엔드는 지원하지 않습니다");
    return backend.countPromptTokens(messages, tools);
  }

  async getContextSize(): Promise<number> {
    const backend = await this.resolve();
    if (!backend.getContextSize) throw new Error("getContextSize: 이 백엔드는 지원하지 않습니다");
    return backend.getContextSize();
  }

  /** Cancels the in-flight turn. A no-op while setup is still running: there
   *  is no request to abort yet, and the turn that eventually starts will be
   *  the user's next one. */
  cancel(): void {
    this.settled?.cancel?.();
  }
}