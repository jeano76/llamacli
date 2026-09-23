import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { OpenAICompatibleClient, setFetchTimeoutsForTests } from "./openaiClient.js";

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

// JSON.parse(data) previously wasn't guarded at all — one unparseable
// `data:` line (a keepalive/comment some proxies inject, or any malformed
// line) threw straight out of the loop and discarded every token already
// streamed successfully before it, failing the whole turn over one
// cosmetic line instead of just skipping it.
test("an unparseable SSE data line is skipped, not thrown — tokens streamed before and after it still arrive", () =>
  withFakeSSEServer(
    'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n' +
      "data: this is not json\n\n" +
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

// Backs agent/loop.ts's tool-call-truncation SALVAGE recovery (requested
// directly: don't discard a truncated write_file's already-generated
// content, save it and only ask the model for the remainder). That
// recovery needs the raw accumulated tool_calls arguments string from
// BEFORE the error chunk arrived — this is the client-side half of that:
// confirming it's actually attached to the thrown error, not silently
// dropped the way it was before this existed.
// Hand-escaping nested-quote JSON inside SSE literal strings is exactly
// the class of bug this file's own "unparseable SSE data line" test
// guards the CLIENT against — build each chunk with JSON.stringify
// instead of typing escapes by hand, so a malformed test fixture can't
// masquerade as a passing test (an earlier draft of this test did exactly
// that: a bracket-mismatch typo made the fixture's own JSON invalid, the
// client's own "skip unparseable lines" resilience silently ate it, and
// the assertion below then failed for the wrong reason entirely).
function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test("a mid-stream tool-call-truncation error attaches the partial tool_calls accumulated before it, not just the error text", () =>
  withFakeSSEServer(
    sseChunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"a.txt",' } }] }, finish_reason: null },
      ],
    }) +
      sseChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"partial conte' } }] }, finish_reason: null }],
      }) +
      sseChunk({ error: { code: 500, message: "Failed to parse tool call arguments as JSON: missing closing quote", type: "server_error" } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      let caught: any;
      try {
        await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }, () => {});
        assert.fail("expected chat() to reject");
      } catch (err) {
        caught = err;
      }
      assert.match(caught.message, /Failed to parse tool call arguments as JSON/);
      assert.ok(Array.isArray(caught.partialToolCalls), "expected partialToolCalls to be attached to the thrown error");
      assert.equal(caught.partialToolCalls.length, 1);
      assert.equal(caught.partialToolCalls[0].name, "write_file");
      assert.equal(caught.partialToolCalls[0].arguments, '{"path":"a.txt","content":"partial conte');
    }
  ));

test("a mid-stream error with no tool_calls deltas at all attaches an empty partialToolCalls, not undefined or a crash", () =>
  withFakeSSEServer(
    'data: {"choices":[{"delta":{"content":"some text"},"finish_reason":null}]}\n\n' +
      'data: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: cut","type":"server_error"}}\n\n',
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      let caught: any;
      try {
        await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }, () => {});
        assert.fail("expected chat() to reject");
      } catch (err) {
        caught = err;
      }
      assert.deepEqual(caught.partialToolCalls, []);
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

/** A server that accepts the connection but never sends any response at
 *  all — simulating a genuinely dead/stuck backend, not just a slow one. */
async function withDeadServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(() => {
    // never call res.write()/res.end() — the connection just hangs
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

// Found auditing for the same class of bug already fixed three times
// (run_shell, browser.ts's CDP commands, the streaming max_tokens gap):
// every fetch() call here had no timeout at all. tokenize() in particular
// is called on every single turn (compactor.ts's estimateTokens(), via
// maybeCompact() before every request) — a hang there freezes the entire
// agent loop permanently.
test("tokenize() times out instead of hanging forever against a dead server", () =>
  withDeadServer(async (baseUrl) => {
    setFetchTimeoutsForTests(200, 200);
    try {
      const client = new OpenAICompatibleClient(baseUrl);
      const start = Date.now();
      await assert.rejects(() => client.tokenize("hello"), /timed out/);
      assert.ok(Date.now() - start < 3000, "expected the timeout to fire near 200ms");
    } finally {
      setFetchTimeoutsForTests(30_000, 120_000);
    }
  }));

test("getContextSize() times out instead of hanging forever against a dead server", () =>
  withDeadServer(async (baseUrl) => {
    setFetchTimeoutsForTests(200, 200);
    try {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.getContextSize(), /timed out/);
    } finally {
      setFetchTimeoutsForTests(30_000, 120_000);
    }
  }));

test("listModels() times out instead of hanging forever against a dead server", () =>
  withDeadServer(async (baseUrl) => {
    setFetchTimeoutsForTests(200, 200);
    try {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.listModels(), /timed out/);
    } finally {
      setFetchTimeoutsForTests(30_000, 120_000);
    }
  }));

test("a non-streaming chat() call times out instead of hanging forever against a dead server", () =>
  withDeadServer(async (baseUrl) => {
    setFetchTimeoutsForTests(200, 200);
    try {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(
        () => client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }),
        /timed out/
      );
    } finally {
      setFetchTimeoutsForTests(30_000, 120_000);
    }
  }));

test("a streaming chat() call times out on connection instead of hanging forever against a dead server", () =>
  withDeadServer(async (baseUrl) => {
    setFetchTimeoutsForTests(200, 200);
    try {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(
        () => client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }, () => {}),
        /timed out/
      );
    } finally {
      setFetchTimeoutsForTests(30_000, 120_000);
    }
  }));

/** Sends exactly one SSE chunk, then leaves the connection open forever —
 *  no more data, no error, no [DONE] — simulating a stream that genuinely
 *  goes silent mid-response rather than one that (even slowly) eventually
 *  finishes on its own. */
async function withStalledSSEServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n`);
    // deliberately never write again or call res.end()
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

// Distinct from the connection-timeout case above: the connection opens
// and streams SOME data, then just goes silent forever — no error, no
// [DONE], never reaching max_tokens either. Without a re-armed idle
// watchdog, the `for await` loop in streamChat() would wait on that
// forever.
test("a streaming chat() call times out when the body goes idle mid-stream, not just on connect", () =>
  withStalledSSEServer(
    async (baseUrl) => {
      setFetchTimeoutsForTests(30_000, 200); // generous connect bound, tight idle bound
      try {
        const client = new OpenAICompatibleClient(baseUrl);
        const start = Date.now();
        await assert.rejects(
          () => client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }, () => {}),
          /idle/
        );
        assert.ok(Date.now() - start < 3000, "expected the idle timeout to fire near 200ms after the last chunk");
      } finally {
        setFetchTimeoutsForTests(30_000, 120_000);
      }
    }
  ));

// cancel() backs the TUI's Esc-to-cancel feature: the user interrupting a
// turn must actually stop the in-flight request against the backend, not
// just stop rendering it locally — otherwise the single inference slot
// (-np 1) stays pinned by a turn nobody wants anymore for as long as it
// takes to finish on its own.
test("cancel() aborts an in-flight streaming chat() call, distinguishably from a timeout", () =>
  withUnboundedSSEServer(
    500, // would otherwise keep streaming for ~2.5s
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const deltas: string[] = [];
      const chatPromise = client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        (chunk) => {
          if (chunk.choices[0]?.delta.content) deltas.push(chunk.choices[0].delta.content as string);
        }
      );
      // Give it a moment to actually start streaming before cancelling —
      // cancelling instantly (before any chunk arrives) is covered by the
      // "cancel before anything streams" case below.
      await new Promise((r) => setTimeout(r, 20));
      const start = Date.now();
      client.cancel();
      await assert.rejects(() => chatPromise, /cancelled/);
      assert.ok(Date.now() - start < 500, "expected cancel() to abort promptly, not wait for the server");
      assert.ok(deltas.length > 0, "expected at least one delta to have streamed before cancellation");
      assert.ok(deltas.length < 500, "expected cancellation to have actually cut the stream short");
    }
  ));

test("cancel() is a harmless no-op when no request is currently in flight", () => {
  const client = new OpenAICompatibleClient("http://127.0.0.1:1"); // nothing listening — never actually called
  assert.doesNotThrow(() => client.cancel());
});

// Seen live: the client-side max_tokens cap cut a write_file call
// mid-arguments. Because the client hung up first, the server never sent
// its own parse-error chunk, and the truncated call came back as a normal
// reply. Once it was in the history, llama-server failed to apply the chat
// template to every later request (it JSON-parses tool_calls arguments in
// input messages), so every retry failed instantly.
test("a tool call cut off by the client-side max_tokens cap throws the truncation error with partialToolCalls, instead of returning a broken call", async () => {
  const chunks = [
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"a.txt",' } }] }, finish_reason: null }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"line1\\n' } }] }, finish_reason: null }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "line2\\n" } }] }, finish_reason: null }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'line3"}' } }] }, finish_reason: "tool_calls" }] }),
  ];
  // One chunk per write, spaced out, like a real generation — so the
  // client's cap (checked after each read) cuts the stream mid-arguments.
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let i = 0;
    const interval = setInterval(() => {
      if (i >= chunks.length || res.destroyed) {
        clearInterval(interval);
        if (!res.destroyed) res.end();
        return;
      }
      res.write(chunks[i++]);
    }, 20);
    req.on("close", () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  try {
    const client = new OpenAICompatibleClient(`http://127.0.0.1:${address.port}`);
    let caught: any;
    try {
      await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 2 }, () => {});
      assert.fail("expected chat() to reject");
    } catch (err) {
      caught = err;
    }
    assert.match(caught.message, /Failed to parse tool call arguments as JSON/);
    assert.match(caught.message, /finish_reason=length/);
    assert.ok(caught.message.length < 400, "must not embed the whole generated content");
    assert.equal(caught.partialToolCalls[0].name, "write_file");
    assert.equal(caught.partialToolCalls[0].arguments, '{"path":"a.txt","content":"line1\\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a complete tool call still comes back normally (no regression)", () =>
  withFakeSSEServer(
    sseChunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" },
      ],
    }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const res = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 100 }, () => {});
      assert.equal(res.choices[0].message.tool_calls?.[0].function.arguments, '{"path":"a.txt"}');
    }
  ));
