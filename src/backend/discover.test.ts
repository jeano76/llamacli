import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { createServer as createNetServer, Server as NetServer } from "node:net";
import { discoverRunningServer, isListening, modelLoadBudgetMs, COMMON_PORTS } from "./detect.js";
import { LLAMA_PORT } from "../setup/ports.js";

/** A TCP listener that accepts connections and never speaks HTTP — the state a
 *  llama-server is in for the whole multi-minute model load, and the state a
 *  single fast probe cannot tell apart from "nothing is here".
 *
 *  Accepted sockets are tracked and destroyed before closing, because
 *  `server.close()` does not complete until every open connection ends. Without
 *  that, a probe that connected and timed out leaves a socket the probe itself
 *  never closes, the close callback never fires, and the test hangs in its own
 *  teardown — which is how the first version of this file reported five
 *  cancellations and no failures. */
async function withSilentListener(fn: (port: number) => Promise<void>): Promise<void> {
  const server: NetServer = createNetServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withFakeServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server: Server = createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── The two-server bug, reproduced ─────────────────────────────────────────

test("a port that is LISTENING but still loading its model is waited out, not declared absent", async () => {
  // This is the whole defect. llama-server binds its port before the weights
  // are resident and answers nothing until they are. A single fast probe sees
  // "nothing on 8080", the bootstrap plans 8081, and a SECOND llama-server is
  // spawned beside a healthy one — which on the 8 GB card this was written for
  // is an OOM, not a slowdown.
  await withSilentListener(async (port) => {
    // The precondition, stated: something IS there, holding the port.
    assert.equal(await isListening("127.0.0.1", port), "in-use");

    const started = Date.now();
    const found = await discoverRunningServer("127.0.0.1", [port], {
      loadingWaitMs: 600,
      probeTimeoutMs: 100,
      pollMs: 50,
    });
    // Nothing started serving inside the budget. The result must say the port
    // is HELD, not that it is free: collapsing this into "none" is what let the
    // caller plan a different port and bind a second llama-server onto the same
    // GPU as the one that is still loading.
    assert.equal(found.kind, "loading");
    if (found.kind !== "loading") throw new Error("unreachable");
    assert.equal(found.port, port);
    assert.equal(found.baseUrl, `http://127.0.0.1:${port}`);
    assert.ok(
      Date.now() - started >= 500,
      "a LISTENING port must be waited out, not dismissed on the first probe"
    );
  });
});

test("a server that is slow to answer is adopted rather than declared absent", async () => {
  // The real llama.cpp shape: the port is bound immediately, and /v1/models
  // only answers once the weights are resident. Here the handler stalls for
  // 300 ms, so the first probe times out at 100 ms and the port looks silent —
  // and the wait then picks it up.
  let served = 0;
  await withFakeServer(
    (_req, res) => {
      // Only the FIRST request stalls, standing in for the one probe that
      // arrives while the weights are still loading. Every later one answers at
      // once, so the wait can actually succeed.
      const delay = served++ === 0 ? 300 : 0;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "/models/loaded.gguf" }] }));
      }, delay);
    },
    async (port) => {
      const started = Date.now();
      const found = await discoverRunningServer("127.0.0.1", [port], {
        loadingWaitMs: 3000,
        probeTimeoutMs: 100,
        pollMs: 50,
      });
      assert.equal(found.kind, "found", "a server that answers during the wait must be adopted");
      if (found.kind !== "found") throw new Error("unreachable");
      assert.equal(found.server.baseUrl, `http://127.0.0.1:${port}`);
      assert.equal(found.server.model, "/models/loaded.gguf");
      // The first request was abandoned at the 100 ms probe timeout, so a
      // SECOND request can only have been made by the loading-wait re-probing.
      // That re-probe is the behaviour under test: without it the port reads as
      // "nothing here" and the caller spawns a rival server.
      assert.ok(served >= 2, `expected a re-probe after the first timed out, saw ${served} request(s)`);
      assert.ok(Date.now() - started >= 100, "the first probe must have run to its timeout");
    }
  );
});

test("discovery gives up rather than hanging on a permanently silent listener", async () => {
  await withSilentListener(async (port) => {
    const started = Date.now();
    const found = await discoverRunningServer("127.0.0.1", [port], {
      loadingWaitMs: 300,
      probeTimeoutMs: 100,
      pollMs: 50,
    });
    assert.equal(found.kind, "loading", "a held port is reported as held");
    assert.ok(Date.now() - started < 5000, "the budget must actually bound the wait");
  });
});

test("nothing listening anywhere returns immediately, without waiting", async () => {
  // The common case must stay fast: a genuinely empty port refuses the
  // connection, and that is a definitive answer.
  const started = Date.now();
  const found = await discoverRunningServer("127.0.0.1", [39321, 39322, 39323], {
    loadingWaitMs: 30_000,
    probeTimeoutMs: 200,
  });
  assert.equal(found.kind, "none", "a refused connection is genuinely nothing there");
  assert.ok(Date.now() - started < 3000, "a refused connection is not a loading server");
});

test("a held port is reported as HELD, never as free", async () => {
  // The invariant the two-server bug turned on. `none` means "you may bind
  // this"; `loading` means "someone else has it". Collapsing the second into
  // the first is what let the caller choose a different port and spawn a rival
  // llama-server while a healthy one was still loading the same 21 GB model.
  await withSilentListener(async (port) => {
    const found = await discoverRunningServer("127.0.0.1", [port], {
      loadingWaitMs: 200,
      probeTimeoutMs: 50,
      pollMs: 40,
    });
    assert.equal(found.kind, "loading");
  });
});

// ── The wait budget has to outlast a real load ─────────────────────────────

test("the loading budget scales with the model and covers a 21 GB USB load", () => {
  const GiB = 1024 ** 3;
  // A fixed 2-minute budget expired while a 21.8 GB model was still loading off
  // a USB drive, and the caller fell straight through to spawning a second
  // server. Size is the only input that predicts the duration.
  const big = modelLoadBudgetMs(21.7 * GiB);
  assert.ok(big > 3 * 60_000, `a 21.7 GB load needs minutes; budget was ${Math.round(big / 1000)}s`);
  // Monotonic, and bounded at both ends.
  assert.ok(modelLoadBudgetMs(40 * GiB) >= big);
  assert.ok(modelLoadBudgetMs(0) <= 2 * 60_000, "an unknown size keeps a short floor, not an unbounded wait");
  assert.ok(modelLoadBudgetMs(10_000 * GiB) <= 20 * 60_000, "a pathological size must not park a launch forever");
});

test("a small model still gets a usable floor", () => {
  const GiB = 1024 ** 3;
  assert.ok(modelLoadBudgetMs(5.5 * GiB) >= 2 * 60_000);
});

// ── One port list, so the two call sites cannot drift apart ────────────────

test("8081 is in the shared list — it is the port a user's own server is most likely on", async () => {
  // This list used to be `[8080, 11434]` here and `[8080, 8081, 11434]` in
  // backend/detect.ts. The bootstrap read the first, config loading read the
  // second, so a llama-server on 8081 was adopted by one and invisible to the
  // other — which then planned a different port and spawned a rival.
  assert.ok(COMMON_PORTS.includes(8081), "8081 must be probed for adoption");
  assert.equal(COMMON_PORTS[0], LLAMA_PORT, "our own port leads");
});
