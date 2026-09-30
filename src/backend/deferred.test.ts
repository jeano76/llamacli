import test from "node:test";
import assert from "node:assert/strict";
import { DeferredBackend } from "./deferred.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelBackend, ToolDef } from "./types.js";

/** A minimal backend that answers immediately, so what a test is asserting is
 *  the proxy's behavior rather than any real HTTP. */
function fake(over: Partial<ModelBackend> = {}): ModelBackend {
  return {
    chat: async (): Promise<ChatCompletionResponse> => ({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    listModels: async () => ["m"],
    tokenize: async (t: string) => t.length,
    countPromptTokens: async () => 1,
    getContextSize: async () => 4096,
    ...over,
  };
}

const req: ChatCompletionRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("calls wait for the resolution instead of failing against a backend that does not exist yet", async () => {
  let release!: (b: ModelBackend) => void;
  const pending = new Promise<ModelBackend>((r) => {
    release = r;
  });
  const backend = new DeferredBackend(pending);
  // The whole reason this class exists: a turn typed during setup must run once
  // setup finishes, not throw against a dead port.
  const call = backend.chat(req);
  release(fake());
  const res = await call;
  assert.equal(res.choices[0].message.content, "ok");
});

test("a turn queued before resolution still reaches the real backend", async () => {
  const backend = new DeferredBackend(Promise.resolve(fake()));
  assert.equal(await backend.listModels().then((m) => m[0]), "m");
  assert.equal(await backend.tokenize("hello"), 5);
  assert.equal(await backend.getContextSize(), 4096);
  assert.equal(await backend.countPromptTokens([]), 1);
});

test("a resolution failure becomes a message naming what the user can do", async () => {
  const backend = new DeferredBackend(Promise.reject(new Error("huggingface unreachable")));
  // Wait a tick so the rejection handler has recorded the failure.
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(
    () => backend.chat(req),
    (err: Error) => {
      // Actionable, not a bare "fetch failed" — the cause was setup, minutes
      // before this turn ran, so the turn's own error would be a dead end.
      assert.match(err.message, /huggingface unreachable/);
      assert.match(err.message, /config\.yaml|llama-server/);
      return true;
    }
  );
});

test("optional llama.cpp methods are forwarded, not silently hidden", async () => {
  // Callers feature-detect with `backend.tokenize?.(...)`. A proxy that omitted
  // these would make every llama.cpp-specific capability look unavailable on
  // every backend, so they must be present on the proxy itself.
  const backend = new DeferredBackend(Promise.resolve(fake()));
  assert.equal(typeof backend.tokenize, "function");
  assert.equal(typeof backend.countPromptTokens, "function");
  assert.equal(typeof backend.getContextSize, "function");
  assert.equal(await backend.countPromptTokens([] as ChatCompletionRequest["messages"], undefined as unknown as ToolDef[]), 1);
});

test("a backend without an optional method still throws rather than answering wrongly", async () => {
  const bare: ModelBackend = { chat: fake().chat, listModels: fake().listModels };
  const backend = new DeferredBackend(Promise.resolve(bare));
  await assert.rejects(() => backend.tokenize("x"), /지원하지 않습니다/);
});

test("cancel() before resolution is a no-op rather than a throw", async () => {
  let cancelled = 0;
  const backend = new DeferredBackend(Promise.resolve(fake({ cancel: () => cancelled++ })));
  backend.cancel();
  assert.equal(cancelled, 0, "nothing is in flight yet, so there is nothing to abort");
  await backend.listModels();
  backend.cancel();
  assert.equal(cancelled, 1, "once resolved, cancel reaches the real backend");
});

test("peek() reports the real backend only after resolution", async () => {
  let release!: (b: ModelBackend) => void;
  const backend = new DeferredBackend(new Promise<ModelBackend>((r) => {
    release = r;
  }));
  assert.equal(backend.peek(), null);
  const real = fake();
  release(real);
  await backend.listModels();
  assert.equal(backend.peek(), real);
});