import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { WebSocketServer } from "ws";
import { listTabs, navigate, evaluate, screenshot, setCdpTimeoutForTests } from "./browser.js";

/** Full CDP round-trips need a real browser (verified manually against
 *  headless Chrome — see README). What's unit-testable without one is the
 *  target-selection/error-handling logic around /json/list, using a fake
 *  HTTP server that only implements that one endpoint. */
async function withFakeDebugServer(
  targets: unknown[],
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/json/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(targets));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function unusedPort(): number {
  // High, unlikely-to-be-bound port for "nothing is listening here" tests.
  return 39217;
}

test("listTabs reports a clear error when the debug port is unreachable", async () => {
  const config = { debugPort: unusedPort(), host: "127.0.0.1" };
  await assert.rejects(() => listTabs(config), /couldn't reach the browser debug port/);
});

test("navigate reports a clear error when the debug port is unreachable", async () => {
  const config = { debugPort: unusedPort(), host: "127.0.0.1" };
  await assert.rejects(() => navigate(config, "https://example.com"), /couldn't reach the browser debug port/);
});

test("listTabs returns a friendly message when there are no open page tabs", () =>
  withFakeDebugServer([{ id: "1", type: "background_page", title: "ext", url: "chrome-extension://x" }], async (port) => {
    const result = await listTabs({ debugPort: port, host: "127.0.0.1" });
    assert.equal(result, "(no open page tabs)");
  }));

test("listTabs formats each page tab as 'id  title  url'", () =>
  withFakeDebugServer(
    [{ id: "abc123", type: "page", title: "Example", url: "https://example.com/" }],
    async (port) => {
      const result = await listTabs({ debugPort: port, host: "127.0.0.1" });
      assert.equal(result, "abc123  Example  https://example.com/");
    }
  ));

test("navigate throws when there are no page tabs to attach to", () =>
  withFakeDebugServer([], async (port) => {
    await assert.rejects(() => navigate({ debugPort: port, host: "127.0.0.1" }, "https://example.com"), /no open page tabs/);
  }));

test("evaluate throws when the requested target_id doesn't exist", () =>
  withFakeDebugServer(
    [{ id: "real-id", type: "page", title: "t", url: "https://x", webSocketDebuggerUrl: "ws://x" }],
    async (port) => {
      await assert.rejects(
        () => evaluate({ debugPort: port, host: "127.0.0.1" }, "1+1", "missing-id"),
        /no open page tab with id missing-id/
      );
    }
  ));

test("screenshot throws when there are no page tabs to attach to", () =>
  withFakeDebugServer([], async (port) => {
    await assert.rejects(
      () => screenshot({ debugPort: port, host: "127.0.0.1" }, "/tmp/out.png"),
      /no open page tabs/
    );
  }));

/** A fake CDP server that accepts the WebSocket connection but never
 *  replies to any command sent over it — simulating a hung/crashed tab
 *  that stops responding mid-session. `/json/list` points at the fake
 *  WebSocket endpoint like a real browser's debug port would. */
async function withHangingCdpServer(fn: (port: number) => Promise<void>): Promise<void> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    // Accept the connection and the CDP handshake, but deliberately never
    // send a response to anything the client sends — this is the hang.
    ws.on("message", () => {});
  });

  httpServer.on("request", (req, res) => {
    if (req.url === "/json/list") {
      const address = httpServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { id: "hang-id", type: "page", title: "stuck tab", url: "https://example.com", webSocketDebuggerUrl: `ws://127.0.0.1:${port}` },
        ])
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

// Found while auditing for the same class of bug already fixed for
// run_shell (tools/index.ts, PROMPT.md-adjacent stability work): a CDP
// command's response promise had no timeout at all — if the browser tab
// crashed, hung, or otherwise just stopped responding mid-session, the
// tool call (and the whole agent turn waiting on it) would hang forever.
test("a browser tool call times out instead of hanging forever when the tab stops responding", () =>
  withHangingCdpServer(async (port) => {
    setCdpTimeoutForTests(300);
    try {
      const start = Date.now();
      await assert.rejects(
        () => evaluate({ debugPort: port, host: "127.0.0.1" }, "1+1"),
        /timed out waiting for a response/
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `expected the timeout to fire near 300ms, took ${elapsed}ms`);
    } finally {
      setCdpTimeoutForTests(15_000);
    }
  }));
