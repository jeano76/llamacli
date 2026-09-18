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
