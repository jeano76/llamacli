import fetch from "node-fetch";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelBackend,
} from "./types.js";

/**
 * Any OpenAI-compatible /v1 endpoint: a locally spawned llama.cpp `llama-server`,
 * a remote llama-server, vLLM, LM Studio, or a real OpenAI-compatible account.
 * This is the single client used everywhere else in the codebase — swapping
 * backends is a config change (baseUrl/apiKey), never a code change.
 */
export class OpenAICompatibleClient implements ModelBackend {
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined = undefined
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`listModels failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    return json.data.map((m) => m.id);
  }

  /** llama.cpp-server-specific endpoint (not all OpenAI-compatible servers
   *  have it) — callers must be ready for this to throw and fall back. */
  async tokenize(text: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/tokenize`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`tokenize failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { tokens: unknown[] };
    return json.tokens.length;
  }

  /** llama.cpp-server-specific endpoint — callers must be ready for this to
   *  throw and fall back to the configured value. */
  async getContextSize(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/props`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getContextSize failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
    const n_ctx = json.default_generation_settings?.n_ctx ?? json.n_ctx;
    if (!n_ctx) throw new Error("getContextSize: /props response had no n_ctx field");
    return n_ctx;
  }

  async chat(
    req: ChatCompletionRequest,
    onDelta?: (chunk: ChatCompletionChunk) => void
  ): Promise<ChatCompletionResponse> {
    if (!req.stream || !onDelta) {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...req, stream: false }),
      });
      if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as ChatCompletionResponse;
    }

    return this.streamChat(req, onDelta);
  }

  /** Consumes an SSE stream and reassembles it into a single final response,
   *  while forwarding each delta to the caller for incremental rendering. */
  private async streamChat(
    req: ChatCompletionRequest,
    onDelta: (chunk: ChatCompletionChunk) => void
  ): Promise<ChatCompletionResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...req, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`chat stream failed: ${res.status} ${await res.text()}`);
    }

    let content = "";
    const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason = "stop";
    let buffer = "";

    for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        const parsed = JSON.parse(data) as ChatCompletionChunk;
        // The initial HTTP response can be 200 OK (so the `res.ok` check
        // above passes) with the actual failure only showing up later, as
        // an SSE data chunk shaped like `{"error": {...}}` with no
        // `choices` field at all — e.g. llama-server discovering mid-
        // generation that it's now over the context window, after having
        // already started streaming tokens. Reported live: this crashed
        // with "Cannot read properties of undefined (reading '0')" from
        // blindly indexing `.choices[0]` on a chunk that had no `choices`.
        // Surface it as a real, readable error instead of letting an
        // unrelated line of code choke on the malformed shape.
        if ((parsed as any).error) {
          const errBody = (parsed as any).error;
          throw new Error(`chat stream error: ${errBody.message ?? JSON.stringify(errBody)}`);
        }
        if (!Array.isArray(parsed.choices)) continue;
        onDelta(parsed);

        const choice = parsed.choices[0];
        if (!choice) continue;
        if (choice.delta.content) content += choice.delta.content;
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls as any[]) {
            const idx = tc.index ?? 0;
            const slot = toolCalls[idx] ?? { id: "", name: "", arguments: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            toolCalls[idx] = slot;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    const tool_calls = Object.values(toolCalls).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: content || null,
            ...(tool_calls.length ? { tool_calls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
    };
  }
}
