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
}
