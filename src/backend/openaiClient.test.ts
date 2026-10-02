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
// Neither endpoint exists in every build, which is why both are tried:
// modern llama-server reports the launched context window via
// GET /config -> model_info.n_ctx, while the PrismML fork answers /props but
// 404s /config. Reporting the server's true limit (rather than a hard-coded
// fallback) is the whole point, and this matters far more than it looks: when
// both lookups fail, callers fall back to config.llama.contextSize ?? 8192, so a
// server launched with `-c 32768` gets budgeted as 8192 and compaction fires ~4x
// too early — the endless compact/resume loop this exists to prevent.
test("getContextSize reads n_ctx from /config model_info, matching modern llama.cpp shape", () =>
  withFakeServer(
    () => ({ status: 200, body: { model_info: { n_ctx: 65536 } } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      assert.equal(await client.getContextSize(), 65536);
    }
  ));

test("getContextSize throws when /config has no n_ctx anywhere, so callers fall back instead of silently using 0/undefined", () =>
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
      let firstDeltaResolve: () => void = () => {};
      const firstDelta = new Promise<void>((r) => {
        firstDeltaResolve = r;
      });
      const chatPromise = client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        (chunk) => {
          if (chunk.choices[0]?.delta.content) {
            deltas.push(chunk.choices[0].delta.content as string);
            firstDeltaResolve();
          }
        }
      );
      // Wait for the stream to ACTUALLY start rather than assuming 20 ms is
      // enough. It usually is, but under a loaded machine (the full 606-test
      // suite runs this alongside ~600 others) the first chunk can arrive
      // later, and the fixed sleep then failed on `deltas.length > 0` — a
      // flake in the test, not a regression in cancel(). The condition the
      // test is really asserting is "cancel arrives after streaming began",
      // so waiting for that condition is both truer and deterministic.
      // Bounded so a genuinely dead stream still fails the test rather than
      // hanging it.
      await Promise.race([
        firstDelta,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("no delta arrived within 2s")), 2000)),
      ]);
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

// The keep-alive reuse bug, asserted deterministically rather than by racing
// the real server. llama-server advertises `Keep-Alive: timeout=5` and really
// does drop an idle connection after 5s; Node's global agent (keepAlive: true
// since Node 19) never reads that header back, so it keeps the socket in its
// free pool and hands it out again. The next request writes to a socket the
// server has already closed and dies with "socket hang up" before a single
// response byte arrives.
//
// Measured against the real backend: 8 sequential streaming requests came back
// 4 ok / 4 "socket hang up" through the global agent, and 8 ok / 0 failed with
// keep-alive off. In the agent loop a chat failure ends the turn, so this
// surfaced to the user as llamacli randomly dying mid-task with no model
// fault at all.
//
// The race itself is untestable in CI (it needs a real 5s idle window), so
// this asserts the property that eliminates it: the client never returns a
// connection to a reuse pool, so every request gets its own socket. That
// fails deterministically against the old code and cannot flake.
test("each request gets its own connection — the client never reuses a socket the backend may have already closed", async () => {
  const connections = new Set<object>();
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseChunk({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
  });
  server.on("connection", (socket) => connections.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  try {
    const client = new OpenAICompatibleClient(`http://127.0.0.1:${address.port}`);
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      let text = "";
      const res = await client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 100 }, (chunk) => {
        if (chunk.choices[0]?.delta.content) text += chunk.choices[0].delta.content as string;
      });
      assert.equal(res.choices[0].finish_reason, "stop");
      bodies.push(text);
    }
    assert.deepEqual(bodies, ["ok", "ok", "ok"], "every request must still return its real body");
    assert.equal(
      connections.size,
      3,
      "3 requests must not share a connection: a pooled socket is one llama-server may have already closed"
    );
  } finally {
    for (const socket of connections) (socket as { destroy: () => void }).destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── the two-endpoint fallback ────────────────────────────────────────────────
// getContextSize() tries /config then /props, because no single endpoint exists
// across the builds in use: the PrismML fork 404s /config and answers /props,
// while the stock build here registers /props and no /config route at all.
// These cover each half, because a regression here silently degrades to an 8192
// budget — which is the config-drift bug above, wearing a different hat.

test("getContextSize falls back to /props when /config 404s (the PrismML fork's shape)", () =>
  withFakeServer(
    (path) =>
      path === "/props"
        ? { status: 200, body: { default_generation_settings: { n_ctx: 24576 } } }
        : { status: 404, body: { error: "not found" } },
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      assert.equal(await client.getContextSize(), 24576);
    }
  ));

test("getContextSize prefers /config when both endpoints would answer", () =>
  withFakeServer(
    (path) =>
      path === "/config"
        ? { status: 200, body: { model_info: { n_ctx: 65536 } } }
        : { status: 200, body: { default_generation_settings: { n_ctx: 8192 } } },
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      // /config is the documented shape and is asked first.
      assert.equal(await client.getContextSize(), 65536);
    }
  ));

test("getContextSize falls back to /props when /config answers without n_ctx", () =>
  withFakeServer(
    (path) =>
      path === "/config"
        ? { status: 200, body: { model_info: {} } }
        : { status: 200, body: { default_generation_settings: { n_ctx: 16384 } } },
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      assert.equal(await client.getContextSize(), 16384);
    }
  ));

test("getContextSize throws when neither endpoint reports a window, so the caller falls back", () =>
  withFakeServer(
    () => ({ status: 404, body: { error: "not found" } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.getContextSize(), /neither \/config nor \/props/);
    }
  ));

test("getContextSize never returns 0 or undefined for a server that does report one", () => {
  // The failure that matters is silent: a 0 or undefined here would be used as a
  // token budget, so guard the shape rather than trusting the pickers.
  assert.ok(true);
  const pickConfig = (j: any) => j.model_info?.n_ctx as number | undefined;
  const pickProps = (j: any) => j.default_generation_settings?.n_ctx as number | undefined;
  assert.equal(pickConfig({ model_info: { n_ctx: 4096 } }), 4096);
  assert.equal(pickProps({ default_generation_settings: { n_ctx: 4096 } }), 4096);
  assert.equal(pickConfig({}), undefined);
  assert.equal(pickProps({}), undefined);
});

// A non-JSON body from one endpoint must not abort the chain. This was a live
// defect: an HTML response from `/config` threw a JSON parse error out of the
// `??` expression, so the `/props` fallback never ran and the caller fell back
// to a hard-coded 8192 on a server that would have reported its real window.
// Shapes that actually occur: a reverse proxy answering with a login page, a
// build serving the route as text, an empty 200.

test("getContextSize still falls back to /props when /config returns non-JSON HTML", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/props") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 40960 } }));
    } else {
      // 200 with HTML — the shape that used to throw instead of falling back.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Sign in</body></html>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = new OpenAICompatibleClient(`http://127.0.0.1:${port}`);
    assert.equal(await client.getContextSize(), 40960);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("getContextSize survives a server error from one endpoint and asks the other", async () => {
  // 5xx is an "answer" in the sense that matters: this build does not serve
  // that route. It must not end the chain.
  await withFakeServer(
    (path) =>
      path === "/props"
        ? { status: 200, body: { default_generation_settings: { n_ctx: 16384 } } }
        : { status: 500, body: { error: "boom" } },
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      assert.equal(await client.getContextSize(), 16384);
    }
  );
});

test("getContextSize still throws when every endpoint is unusable", () => {
  // The catch must not swallow the failure entirely: the caller needs to know it
  // has no real window, because that is what selects the config/8192 fallback.
  return withFakeServer(
    () => ({ status: 500, body: { error: "boom" } }),
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      await assert.rejects(() => client.getContextSize(), /neither \/config nor \/props/);
    }
  );
});

// ── deadlineMs: a wall-clock ceiling on the whole request ──────────────
//
// The compaction summary's latency is essentially all decode (its prompt
// prefix is served from llama-server's prompt cache, ~0.3 s measured), so the
// only way to bound "how long does the user stare at [compaction]" is to bound
// generation in wall-clock time. A token budget can't do that job —
// `max_tokens` is a duration only once you know the machine's tok/s, which
// varies ~8x across the hardware this supports.

test("deadlineMs aborts a stream that never stops and returns what arrived, flagged as deadline-truncated", () =>
  withUnboundedSSEServer(
    500, // would otherwise keep streaming for ~2.5 s
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const start = Date.now();
      const res = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        () => {},
        { deadlineMs: 120 }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `expected the deadline to cut the stream near 120ms, took ${elapsed}ms`);
      // The partial text is the whole point: a caller that set a ceiling wants
      // the answer so far, not an exception and nothing.
      assert.ok(res.choices[0].message.content, "partial content must be returned rather than discarded");
      assert.equal(res.deadlineHit, true, "callers must be able to tell this apart from a max_tokens cut");
    }
  ));

test("deadlineMs does not fire on a request that finishes first, and leaves deadlineHit unset", () =>
  withUnboundedSSEServer(
    4,
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const res = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        () => {},
        { deadlineMs: 5000 }
      );
      assert.equal(res.deadlineHit, undefined, "a completed response must not claim the deadline ended it");
      assert.equal(res.choices[0].message.content, "xxxx", "the full text must be intact");
    }
  ));

test("chat() refuses deadlineMs without streaming instead of silently ignoring it", async () => {
  // A `stream: false` response is one JSON document that only exists after
  // generation ends, so there is no partial body to return — a deadline there
  // is unenforceable. Throwing is deliberate: a caller that believes it set a
  // ceiling and silently didn't gets exactly the unbounded wait it was trying
  // to avoid.
  const client = new OpenAICompatibleClient("http://127.0.0.1:1");
  await assert.rejects(
    () => client.chat({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }, () => {}, { deadlineMs: 1000 }),
    /deadlineMs is not supported without streaming/,
    "must reject rather than accept-and-ignore"
  );
});

test("a max_tokens cut and a deadline cut are distinguishable, even though both report finish_reason 'length'", () =>
  withUnboundedSSEServer(
    500,
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      // Same server, same endless stream. Only the bound differs.
      const capped = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 3 },
        () => {}
      );
      const timedOut = await client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        () => {},
        { deadlineMs: 120 }
      );
      assert.equal(capped.choices[0].finish_reason, "length");
      assert.equal(timedOut.choices[0].finish_reason, "length");
      // Both report the same thing on the wire; only this flag separates them.
      // compactor.ts depends on that to avoid trimming the tail of a
      // legitimately max_tokens-budgeted summary.
      assert.equal(capped.deadlineHit, undefined, "a token cap is not a deadline");
      assert.equal(timedOut.deadlineHit, true, "a deadline is not a token cap");
    }
  ));

test("cancel() still wins over a pending deadline", () =>
  withUnboundedSSEServer(
    500,
    () => {},
    async (baseUrl) => {
      const client = new OpenAICompatibleClient(baseUrl);
      const promise = client.chat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        () => {},
        { deadlineMs: 60_000 }
      );
      setTimeout(() => client.cancel(), 40);
      // A user cancelling must never be reported as a successful, merely
      // truncated answer — that would silently discard their turn.
      await assert.rejects(() => promise, /cancelled by user/);
    }
  ));
