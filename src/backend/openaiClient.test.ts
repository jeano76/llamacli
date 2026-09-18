import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { OpenAICompatibleClient } from "./openaiClient.js";

async function withFakeServer(
  handler: (path: string) => { status: number; body: unknown },
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The config-drift bug this guards against: llamacli trusted a static
// contextSize from config.yaml, which can silently go stale relative to
// what the server is actually running (seen live: config said 8192, the
// real server was -c 65536 — compaction fired 8x too eagerly and
// interrupted every turn in an endless compact/resume loop). getContextSize()
// exists so the real value can be pulled from the backend instead.
test("getContextSize reads n_ctx from default_generation_settings, matching real llama.cpp /props shape", () =>
  withFakeServer(
    () => ({ status: 200, body: { default_generation_settings: { n_ctx: 65536 }, total_slots: 1 } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      assert.equal(await client.getContextSize(), 65536);
    }
  ));

test("getContextSize throws when /props has no n_ctx anywhere, so callers fall back instead of silently using 0/undefined", () =>
  withFakeServer(
    () => ({ status: 200, body: { total_slots: 1 } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.getContextSize());
    }
  ));

test("getContextSize throws on a non-OK response instead of returning a bogus value", () =>
  withFakeServer(
    () => ({ status: 404, body: { error: "not found" } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.getContextSize());
    }
  ));

/** Serves a raw SSE body — the initial HTTP response is always 200 OK
 *  (real backends only fail *within* the stream sometimes), matching how
 *  llama-server can start streaming normally and only later emit an
 *  error-shaped chunk mid-response. */
async function withFakeSSEServer(sseBody: string, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Reported live: crashed with "Cannot read properties of undefined
// (reading '0')" while streaming. Root cause: the initial HTTP response
// was 200 OK, but llama-server can still emit an error-shaped SSE chunk
// mid-stream (e.g. discovering it's now over the context window only
// after generation already started) — a chunk with an `error` field and
// no `choices` field at all. Blindly indexing `.choices[0]` on that
// crashed instead of surfacing a real, readable error.
test("a mid-stream SSE error chunk throws a readable error instead of crashing on missing choices", () =>
  withFakeSSEServer(
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n' +
      'data: {"error":{"code":400,"message":"request (65999 tokens) exceeds the available context size (65536 tokens)","type":"exceed_context_size_error"}}\n\n',
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(
        () => client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }, () => {}),
        /exceeds the available context size/
      );
    }
  ));

test("a normal SSE stream with no error chunks still completes successfully (no regression)", () =>
  withFakeSSEServer(
    'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n",
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const deltas: string[] = [];
      const res = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        (chunk) => {
          if (chunk.choices[0]?.delta.content) deltas.push(chunk.choices[0].delta.content as string);
        }
      );
      assert.equal(deltas.join(""), "hello");
      assert.equal(res.choices[0].message.content, "hello");
    }
  ));

/** A server that keeps streaming SSE chunks indefinitely (well past any
 *  reasonable cap) until the client disconnects — simulating exactly what
 *  the real llama.cpp backend was caught doing: never stopping on its
 *  own for a streaming request, regardless of max_tokens. `onChunkSent`
 *  fires after each one so the test can see how many the server actually
 *  got to send before the client aborted. */
async function withUnboundedSSEServer(
  totalChunksIfNeverStopped: number,
  onChunkSent: (n: number) => void,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalChunksIfNeverStopped || res.destroyed) {
        clearInterval(interval);
        if (!res.destroyed) res.end();
        return;
      }
      sent++;
      onChunkSent(sent);
      res.write(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n`);
    }, 5);
    req.on("close", () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Caught live: a real request with max_tokens: 16384 kept streaming anyway,
// all the way past 45,000 tokens, only stopping once it physically ran out
// of the 65,536-token context window — nearly 17 minutes pinning the
// single inference slot on one response. A direct curl reproduction
// confirmed max_tokens genuinely isn't honored for STREAMING requests on
// that llama.cpp build (a stream: false request with the same field
// correctly stopped). The client must not simply trust the server to stop.
test("chat() enforces max_tokens itself by aborting the stream, even if the server never stops on its own", () =>
  withUnboundedSSEServer(
    500, // "never stops on its own" within any reasonable test timeout
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const deltas: string[] = [];
      const start = Date.now();
      const res = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 5 },
        (chunk) => {
          if (chunk.choices[0]?.delta.content) deltas.push(chunk.choices[0].delta.content as string);
        }
      );
      const elapsed = Date.now() - start;

      assert.equal(deltas.length, 5, `expected exactly 5 streamed deltas (the cap), got ${deltas.length}`);
      assert.equal(res.choices[0].finish_reason, "length");
      assert.equal(res.choices[0].message.content, "xxxxx");
      // 500 chunks at 5ms apart would take ~2.5s if the client waited for
      // the server to finish on its own — this proves it actually cut the
      // connection early rather than happening to still be fast.
      assert.ok(elapsed < 1000, `expected an early abort (well under 1s), took ${elapsed}ms`);
    }
  ));

test("chat() does not cap the stream at all when max_tokens isn't set (no regression)", () =>
  withUnboundedSSEServer(
    10,
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const deltas: string[] = [];
      const res = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        (chunk) => {
          if (chunk.choices[0]?.delta.content) deltas.push(chunk.choices[0].delta.content as string);
        }
      );
      assert.equal(deltas.length, 10, "expected the full (bounded, in this test) stream to be consumed");
      assert.equal(res.choices[0].message.content, "x".repeat(10));
    }
  ));
