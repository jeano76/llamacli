import fetch from "node-fetch";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelBackend,
} from "./types.js";

// Found auditing for the same class of bug already fixed three times
// (run_shell's missing timeout, browser.ts's missing CDP timeout, the
// streaming max_tokens gap): every fetch() call in this file had no
// timeout at all. `tokenize()` in particular is called on EVERY turn
// (compactor.ts's estimateTokens(), via maybeCompact() before every
// single request) — a hang there freezes the entire agent loop
// permanently, with no recovery short of killing the process. Lightweight
// metadata endpoints (models/tokenize/props) don't need the shared
// inference slot on a real llama.cpp server, so they should always be
// fast; a generous bound still catches a genuinely stuck connection
// instead of waiting forever. Exported so tests can shrink them.
export let LIGHTWEIGHT_FETCH_TIMEOUT_MS = 30_000;
// Chat requests DO compete for the single inference slot and can
// legitimately queue behind other work for a while — a much longer bound,
// but still a bound, since "still queued" and "the connection itself is
// dead" must eventually be distinguishable from the caller's side.
export let CHAT_FETCH_TIMEOUT_MS = 120_000;
export function setFetchTimeoutsForTests(lightweightMs: number, chatMs: number): void {
  LIGHTWEIGHT_FETCH_TIMEOUT_MS = lightweightMs;
  CHAT_FETCH_TIMEOUT_MS = chatMs;
}

/**
 * Any OpenAI-compatible /v1 endpoint: a locally spawned llama.cpp `llama-server`,
 * a remote llama-server, vLLM, LM Studio, or a real OpenAI-compatible account.
 * This is the single client used everywhere else in the codebase — swapping
 * backends is a config change (baseUrl/apiKey), never a code change.
 */
/** Distinguishes a deliberate cancel() from a real timeout on the same
 *  AbortController — both produce an identical AbortError otherwise,
 *  and the caller (loop.ts) needs to tell them apart to report a clean
 *  "[cancelled]" status instead of a scary-looking timeout/network error. */
const CANCELLED_REASON = "llamacli:cancelled-by-user";

export class OpenAICompatibleClient implements ModelBackend {
  // Tracks whichever chat() request is currently in flight, so cancel() has
  // something to abort. Only ever one at a time in practice (the agent
  // loop is single-turn-at-a-time), so a single field is enough — no need
  // for a set/map of concurrent requests.
  private currentChatController: AbortController | null = null;

  constructor(
    private baseUrl: string,
    private apiKey: string | undefined = undefined
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Aborts the in-flight chat() request, if any — see ModelBackend.cancel
   *  doc comment. A no-op if nothing is currently in flight (e.g. the user
   *  pressed Esc between turns). */
  cancel(): void {
    this.currentChatController?.abort(CANCELLED_REASON);
  }

  /** Wraps fetch() with a real timeout — plain fetch() waits forever by
   *  default, which is exactly the gap described above. `controller`
   *  defaults to a fresh one for non-chat (lightweight metadata) calls;
   *  chat() passes its own so cancel() above can reach it. */
  private async fetchWithTimeout(
    url: string,
    options: Record<string, unknown>,
    timeoutMs: number,
    label: string,
    controller: AbortController = new AbortController()
  ) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal as any });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        if (controller.signal.reason === CANCELLED_REASON) throw new Error("cancelled by user");
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/models`, { headers: this.headers() }, LIGHTWEIGHT_FETCH_TIMEOUT_MS, "listModels");
    if (!res.ok) throw new Error(`listModels failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    return json.data.map((m) => m.id);
  }

  /** llama.cpp-server-specific endpoint (not all OpenAI-compatible servers
   *  have it) — callers must be ready for this to throw and fall back. */
  async tokenize(text: string): Promise<number> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/tokenize`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ content: text }) },
      LIGHTWEIGHT_FETCH_TIMEOUT_MS,
      "tokenize"
    );
    if (!res.ok) throw new Error(`tokenize failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { tokens: unknown[] };
    return json.tokens.length;
  }

  /** llama.cpp-server-specific endpoint — callers must be ready for this to
   *  throw and fall back to the configured value. */
  async getContextSize(): Promise<number> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/props`, { headers: this.headers() }, LIGHTWEIGHT_FETCH_TIMEOUT_MS, "getContextSize");
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
      const controller = new AbortController();
      this.currentChatController = controller;
      try {
        const res = await this.fetchWithTimeout(
          `${this.baseUrl}/v1/chat/completions`,
          { method: "POST", headers: this.headers(), body: JSON.stringify({ ...req, stream: false }) },
          CHAT_FETCH_TIMEOUT_MS,
          "chat",
          controller
        );
        if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as ChatCompletionResponse;
      } finally {
        this.currentChatController = null;
      }
    }

    return this.streamChat(req, onDelta);
  }

  /** Consumes an SSE stream and reassembles it into a single final response,
   *  while forwarding each delta to the caller for incremental rendering.
   *
   *  Enforces `req.max_tokens` itself, client-side, rather than trusting
   *  the server to stop generating once it's sent. Caught live: a real
   *  request with `max_tokens: 16384` kept streaming anyway, all the way
   *  past 45,000 tokens, only stopping once it physically ran out of
   *  context window (`truncated = 1`) — nearly 17 minutes pinning the
   *  single inference slot on one response. A direct curl reproduction
   *  confirmed `max_tokens` genuinely isn't honored for **streaming**
   *  requests on this llama.cpp build specifically (a `stream: false`
   *  request with the same field correctly stopped with
   *  `finish_reason: "length"` — this is a streaming-only gap, not a
   *  general backend bug). The max_tokens cap itself (loop.ts) was already
   *  correct; the request just can't rely on the server actually
   *  respecting it. */
  private async streamChat(
    req: ChatCompletionRequest,
    onDelta: (chunk: ChatCompletionChunk) => void
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    // Set immediately (before the connection even completes) so cancel()
    // can interrupt a turn that's still only connecting, not just one
    // that's already streaming tokens.
    this.currentChatController = controller;
    // Guards only the CONNECTION phase (no response at all yet) — once
    // streaming genuinely starts, a real generation can legitimately run
    // long, and that's what the max_tokens-triggered abort further below
    // (reusing this same controller) is already responsible for bounding.
    // Requests do compete for the single inference slot and can queue for
    // a while under load, hence the longer CHAT_FETCH_TIMEOUT_MS bound
    // rather than the lightweight one.
    const connectTimer = setTimeout(() => controller.abort(), CHAT_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...req, stream: true }),
        signal: controller.signal as any, // node-fetch's AbortSignal type predates the global one
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        if (controller.signal.reason === CANCELLED_REASON) throw new Error("cancelled by user");
        throw new Error(`chat stream connection timed out after ${CHAT_FETCH_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok || !res.body) {
      throw new Error(`chat stream failed: ${res.status} ${await res.text()}`);
    }

    let content = "";
    const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason = "stop";
    let buffer = "";
    // Counts streamed delta *events*, not exact tokens — llama.cpp emits
    // one SSE chunk per generated token in the normal (non-batched) case,
    // so this is an accurate enough proxy for a safety cap: better to cut
    // a response very slightly early/late than not cut it off at all,
    // which is what relying solely on the server did.
    let deltaCount = 0;
    let clientCapped = false;
    // Separate from the connection-phase timer above: once streaming
    // genuinely starts, this guards against the body just going silent —
    // no more chunks, no error, no [DONE], never reaching max_tokens
    // either — which would otherwise leave the `for await` loop waiting
    // forever. Re-armed on every chunk received, so a normal (even slow)
    // generation that's still actively producing output is never cut off.
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, CHAT_FETCH_TIMEOUT_MS);
    };
    armIdleTimer();

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
        armIdleTimer();
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          // A single unparseable `data:` line (a keepalive/comment some
          // proxies inject, a chunk split across a read boundary in an
          // unexpected way) previously threw straight out of this loop —
          // discarding every token already streamed successfully before it
          // and failing the whole turn over one cosmetic line. Skip just
          // that line; there's nothing this line could contain that's worth
          // losing an otherwise-successful response over.
          let parsed: ChatCompletionChunk;
          try {
            parsed = JSON.parse(data) as ChatCompletionChunk;
          } catch {
            continue;
          }
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
            const err: any = new Error(`chat stream error: ${errBody.message ?? JSON.stringify(errBody)}`);
            // Reported live: a tool call cut off mid-JSON by max_tokens
            // (e.g. a write_file call generating a long file) triggers
            // exactly this error — the server discovers the accumulated
            // arguments don't parse as valid JSON only once generation has
            // already finished. Everything streamed before that point is
            // otherwise thrown away with it, even though it's real,
            // already-generated content the caller could recover and save
            // instead of asking the model to regenerate the whole thing
            // from scratch (unreliable — a model can just produce the
            // identical oversized content again and hit the identical
            // wall). Attaching what was accumulated so far lets the
            // caller (loop.ts) salvage it.
            err.partialToolCalls = Object.values(toolCalls);
            throw err;
          }
          if (!Array.isArray(parsed.choices)) continue;
          onDelta(parsed);

          const choice = parsed.choices[0];
          if (!choice) continue;
          if (choice.delta.content) {
            content += choice.delta.content;
            deltaCount++;
          }
          // Chain-of-thought, streamed by llama-server as its own field
          // (NOT `content`) when the chat template preserves reasoning.
          // Measured directly against the real backend: a request whose
          // whole 420-token budget went to reasoning produced 420 of
          // these deltas and zero `content`/`tool_calls` deltas — and
          // because nothing here looked at this field, llamacli rendered
          // absolutely nothing for the entire time, which is what the
          // repeated "it looks stuck / 멈춘 것 같다" reports actually
          // were. It also has to count toward deltaCount: these tokens
          // are just as real against max_tokens as any other, and the
          // client-side cap (see streamChat's doc comment) silently
          // stopped bounding anything at all while the model was thinking.
          const reasoning = (choice.delta as any).reasoning_content;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            deltaCount++;
          }
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls as any[]) {
              const idx = tc.index ?? 0;
              const slot = toolCalls[idx] ?? { id: "", name: "", arguments: "" };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.arguments += tc.function.arguments;
              toolCalls[idx] = slot;
            }
            deltaCount++;
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        if (req.max_tokens && deltaCount >= req.max_tokens) {
          clientCapped = true;
          finishReason = "length";
          controller.abort();
          break;
        }
      }
    } catch (err: any) {
      // AbortError from our own controller.abort() is expected in three
      // cases: the max_tokens cap was hit mid-chunk (clientCapped), the
      // stream went idle too long (idleTimedOut), or the user cancelled
      // the turn (cancel(), checked via the abort reason) — none of these
      // three is a real failure in the network sense. Anything else still
      // propagates.
      if (err?.name === "AbortError" && controller.signal.reason === CANCELLED_REASON) {
        throw new Error("cancelled by user");
      }
      if (err?.name === "AbortError" && idleTimedOut) {
        throw new Error(`chat stream went idle (no new data) for over ${CHAT_FETCH_TIMEOUT_MS}ms`);
      }
      if (!(clientCapped && err?.name === "AbortError")) throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      this.currentChatController = null;
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
