import test from "node:test";
import assert from "node:assert/strict";
import { probeBackendHealth, describeUnhealthyBackend } from "./healthCheck.js";
import type { ModelBackend, ChatCompletionRequest, ChatCompletionResponse } from "./types.js";

/** A backend that replies with exactly the given content, and records the
 *  request so the test can assert what the probe actually sent. */
function replying(content: string | null): { backend: ModelBackend; seen: ChatCompletionRequest[] } {
  const seen: ChatCompletionRequest[] = [];
  const backend: ModelBackend = {
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      seen.push(req);
      return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
    },
    async listModels(): Promise<string[]> {
      return ["m"];
    },
  };
  return { backend, seen };
}

function throwing(message: string): ModelBackend {
  return {
    async chat(): Promise<ChatCompletionResponse> {
      throw new Error(message);
    },
    async listModels(): Promise<string[]> {
      return ["m"];
    },
  };
}

test("a model that echoes the sentinel is healthy, however it wraps it", async () => {
  for (const reply of ["ZQXVKJ", "ZQXVKJ.", '"ZQXVKJ"', "**ZQXVKJ**", "Sure! ZQXVKJ", "zqxvkj"]) {
    const { backend } = replying(reply);
    const health = await probeBackendHealth(backend);
    assert.equal(health.verdict, "healthy", `"${reply}" must count as healthy`);
  }
});

test("the garbage this was written for is reported as garbage, not adopted quietly", async () => {
  // Verbatim from the live failure: temperature 0, byte-identical across runs.
  const { backend } = replying('most也是最!!"голо!!"sten lem!!"culator!!"炫!!"leo!!"gyodar!!"快!!');
  const health = await probeBackendHealth(backend);
  assert.equal(health.verdict, "garbage");
  assert.match(health.verdict === "garbage" ? health.reason : "", /돌려주지 못했습니다/);
});

// The reasoning-budget trap, measured on this project's own backend: with
// thinking left on, 12,288 tokens of invisible `reasoning_content` and zero
// characters of answer. An empty content must read as broken rather than
// silently passing.
test("an empty answer is garbage — a model that spent the whole budget thinking is not working", async () => {
  const { backend } = replying(null);
  const health = await probeBackendHealth(backend);
  assert.equal(health.verdict, "garbage");
  assert.equal(health.verdict === "garbage" ? health.sample : "x", "");
  assert.match(health.verdict === "garbage" ? health.reason : "", /빈 응답/);
});

test("the degenerate repetition this was written for is caught too", async () => {
  const { backend } = replying("steps steps steps steps steps steps steps steps steps steps steps");
  assert.equal((await probeBackendHealth(backend)).verdict, "garbage");
});

// Connectivity is not this probe's job, and misreading it as a broken model
// would lock a user out of a backend that is merely slow to answer.
test("an unreachable backend is 'unknown', never 'garbage'", async () => {
  const health = await probeBackendHealth(throwing("chat failed: 503"));
  assert.equal(health.verdict, "unknown");
  assert.match(health.reason, /503/);
});

test("the probe is deterministic and cheap: greedy, no tools, thinking off, small budget", async () => {
  const { backend, seen } = replying("ZQXVKJ");
  await probeBackendHealth(backend);
  const req = seen[0];
  assert.equal(req.temperature, 0, "greedy, so the verdict does not flap between runs");
  assert.equal(req.stream, false, "nothing should stream into the TUI during startup");
  assert.equal(req.tools, undefined, "the point is raw text quality, not tool use");
  assert.equal(req.chat_template_kwargs?.enable_thinking, false, "otherwise the budget goes to reasoning_content and content comes back empty");
  assert.ok((req.max_tokens ?? 0) <= 64, `probe budget must stay tiny, got ${req.max_tokens}`);
});

// A garbage model can produce a very long run of it, and this string goes
// into a status line — so it must be bounded.
test("a long garbage run is truncated in the reported sample", async () => {
  const { backend } = replying("steps ".repeat(500));
  const health = await probeBackendHealth(backend);
  assert.equal(health.verdict, "garbage");
  assert.ok(health.verdict === "garbage" && health.sample.length <= 121, "sample must stay bounded");
  assert.match(health.verdict === "garbage" ? health.sample : "", /…$/);
});

test("the failure message shows the user the model's actual words, not just a verdict", async () => {
  const { backend } = replying("most也是最!!");
  const health = await probeBackendHealth(backend);
  assert.equal(health.verdict, "garbage");
  if (health.verdict !== "garbage") return;
  const message = describeUnhealthyBackend("http://127.0.0.1:8080 (모델 m)", health);
  assert.match(message, /most也是最!!/, "the user must be able to check the claim themselves");
  assert.match(message, /모델 파일이 손상/);
  assert.match(message, /서버를 종료하고 다시 실행/);
});
// ── a busy server is not a broken one: startup must not queue behind someone else's turn ──

const slotsFetch = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;

test("a server whose only slot is processing is skipped (unknown), and the probe is never sent", async () => {
  const { backend, seen } = replying("anything");
  (backend as any).baseUrl = "http://127.0.0.1:8080";
  const h = await probeBackendHealth(backend, { fetchImpl: slotsFetch([{ id: 0, is_processing: true }]) });
  assert.equal(h.verdict, "unknown");
  assert.equal(seen.length, 0, "no request queued behind the user's turn");
});

test("an idle slot is probed as before", async () => {
  const { backend, seen } = replying("anything");
  (backend as any).baseUrl = "http://127.0.0.1:8080";
  await probeBackendHealth(backend, { fetchImpl: slotsFetch([{ id: 0, is_processing: false }]) });
  assert.equal(seen.length, 1);
});

test("a server without /slots is probed, but never waited on for longer than the budget", async () => {
  const slow: ModelBackend = {
    chat: () => new Promise(() => {}), // never answers: queued behind a long request
    listModels: async () => ["m"],
  };
  const t0 = Date.now();
  const h = await probeBackendHealth(slow, { waitMs: 80 });
  assert.equal(h.verdict, "unknown");
  assert.ok(Date.now() - t0 < 2000);
  assert.match((h as any).reason, /건강 확인 응답이/);
});

test("a /slots lookup that fails is treated as not busy", async () => {
  const { backend, seen } = replying("x");
  (backend as any).baseUrl = "http://127.0.0.1:1";
  await probeBackendHealth(backend, { fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch });
  assert.equal(seen.length, 1);
});
