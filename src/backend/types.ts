// OpenAI Chat Completions-compatible wire types (subset used by llamacli).

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** llama.cpp-server / chat-template passthrough. Used to turn the
   *  model's chain-of-thought off (`{ enable_thinking: false }`) — see
   *  config.ts's `enableThinking` for the measurements behind why that's
   *  the default: with thinking on, an entire max_tokens budget was
   *  consumed by invisible `reasoning_content` before the tool call even
   *  started. A backend that doesn't recognize the field ignores it. */
  chat_template_kwargs?: Record<string, unknown>;
  /** llama.cpp-server sampling passthrough, ignored by backends that don't
   *  recognize it. Sent explicitly because a bare launch of llama-server
   *  defaults this to 1.0 (off) — confirmed live via GET /slots — which
   *  lets a degenerate loop repeat the same phrase verbatim until
   *  max_tokens cuts it off instead of self-correcting. */
  repeat_penalty?: number;
}

export interface ChatCompletionChunk {
  choices: Array<{
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }>;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ModelBackend {
  /** Streams assistant deltas; resolves with the final assembled message. */
  chat(
    req: ChatCompletionRequest,
    onDelta?: (chunk: ChatCompletionChunk) => void
  ): Promise<ChatCompletionResponse>;

  listModels(): Promise<string[]>;

  /** llama.cpp-server-specific `/tokenize` endpoint — not part of the
   *  OpenAI Chat Completions spec, so it's optional. Callers must fall back
   *  to an approximation (see compaction/compactor.ts estimateTokens) when
   *  this is absent or throws, since a generic OpenAI-compatible endpoint
   *  (e.g. real OpenAI, or another server that doesn't implement it) won't
   *  have it. Returns the exact token count for the given text. */
  tokenize?(text: string): Promise<number>;

  /** The EXACT number of prompt tokens the backend will actually charge
   *  for this request — messages rendered through the server's real chat
   *  template (llama.cpp's `/apply-template`), tools section included,
   *  then tokenized. Prefer this over tokenize() on concatenated message
   *  text, which silently misses everything the template adds.
   *
   *  Measured directly against the real backend: concatenating message
   *  text + the tools JSON and tokenizing that undercounted the true
   *  prompt by 18.8% (1,482 vs 1,825) on a modest conversation — the
   *  template wraps every message in role markers AND injects a whole
   *  "# Tools ... If you choose to call a function ONLY reply in the
   *  following format" preamble that the raw JSON never contains. The
   *  undercount scales with message count, so it is worst exactly when
   *  it matters most: near the context limit. Live consequence, seen
   *  repeatedly: requests of 16,921 / 18,346 / 20,521 tokens sent against
   *  a 16,384-token window and hard-rejected, because prompt +
   *  max_tokens was sized off an estimate that was thousands of tokens
   *  low. Optional — callers fall back to the approximation. */
  countPromptTokens?(messages: ChatMessage[], tools?: ToolDef[]): Promise<number>;

  /** llama.cpp-server-specific `/props` endpoint. Returns the server's
   *  actual running context size (`n_ctx`), so compaction thresholds can be
   *  based on what the backend is really configured with instead of a
   *  static config value that can silently drift out of sync with it (seen
   *  live: config said 8192, the running server was actually -c 65536 —
   *  compaction fired 8x too eagerly, interrupting every single turn in a
   *  loop). Optional and may throw for non-llama.cpp backends. */
  getContextSize?(): Promise<number>;

  /** Aborts whichever chat() call is currently in flight on this backend,
   *  if any (a no-op otherwise). Lets the caller stop a turn the user
   *  cancelled (e.g. via the TUI's Esc-to-cancel) instead of waiting for
   *  the model to finish generating on its own — the single inference slot
   *  (`-np 1`) would otherwise stay pinned by a turn nobody wants anymore
   *  for as long as it takes to finish. Optional so a backend that can't
   *  support mid-request cancellation simply doesn't implement it. */
  cancel?(): void;
}
