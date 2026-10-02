import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import type { ModelBackend, ChatCompletionResponse } from "../backend/types.js";

async function withProject(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-rate-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Streams `chunks` content deltas 25 ms apart on an injected clock (= 40 tok/s). */
function streamingBackend(chunks: number, clock: { t: number }, opts: { reasoningFirst?: number; usage?: number } = {}): ModelBackend {
  return {
    async chat(_req, onDelta) {
      clock.t += 5_000; // prefill
      for (let i = 0; i < (opts.reasoningFirst ?? 0); i++) {
        onDelta?.({ choices: [{ delta: { reasoning_content: "t " } as never, finish_reason: null }] });
        clock.t += 25;
      }
      for (let i = 0; i < chunks; i++) {
        onDelta?.({ choices: [{ delta: { content: "w " }, finish_reason: null }] });
        clock.t += 25;
      }
      const res: ChatCompletionResponse = {
        choices: [{ message: { role: "assistant", content: "w ".repeat(chunks) }, finish_reason: "stop" }],
        ...(opts.usage ? { usage: { prompt_tokens: 10, completion_tokens: opts.usage, total_tokens: 10 + opts.usage } } : {}),
      };
      return res;
    },
    async listModels() { return ["m"]; },
    async tokenize() { return 5; },
  };
}

test("the loop reports a live rate while streaming and the exact one at the end", () =>
  withProject(async (dir) => {
    const clock = { t: 0 };
    const rates: Array<[number, boolean]> = [];
    const loop = new AgentLoop({
      projectRoot: dir, model: "m", systemPrompt: "s", backend: streamingBackend(80, clock, { usage: 80 }),
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100_000 },
      rateClock: () => clock.t,
      onDecodeRate: (tps, final) => rates.push([Math.round(tps), final]),
    });
    await loop.send("hi");
    assert.ok(rates.length >= 2, `got ${JSON.stringify(rates)}`);
    assert.ok(rates.slice(0, -1).every(([, f]) => f === false), "live updates come first");
    assert.deepEqual(rates[rates.length - 1][1], true, "and the last one is final");
    // 80 tokens, first one starts the interval: 79 over 79 * 25 ms = 40 t/s; prefill excluded.
    assert.ok(Math.abs(rates[rates.length - 1][0] - 40) <= 1, `final ${rates[rates.length - 1][0]}`);
    assert.ok(rates.every(([r]) => r >= 38 && r <= 42), `a rate that counted the 5 s prefill would be far lower: ${JSON.stringify(rates)}`);
  }));

test("no rate is reported for a response that produced no assistant text (reasoning only)", () =>
  withProject(async (dir) => {
    const clock = { t: 0 };
    const backend = streamingBackend(0, clock, { reasoningFirst: 60 });
    const rates: number[] = [];
    const loop = new AgentLoop({
      projectRoot: dir, model: "m", systemPrompt: "s", backend,
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100_000 }, rateClock: () => clock.t,
      onDecodeRate: (tps) => rates.push(tps),
    });
    await loop.send("hi");
    assert.deepEqual(rates, [], "there is no assistant line for it to be attached to");
  }));

test("reasoning tokens count toward the speed once text appears (they are decoded too)", () =>
  withProject(async (dir) => {
    const clock = { t: 0 };
    const rates: number[] = [];
    const loop = new AgentLoop({
      projectRoot: dir, model: "m", systemPrompt: "s", backend: streamingBackend(40, clock, { reasoningFirst: 40 }),
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100_000 }, rateClock: () => clock.t,
      onDecodeRate: (tps) => rates.push(Math.round(tps)),
    });
    await loop.send("hi");
    assert.ok(rates.length > 0 && rates.every((r) => r >= 38 && r <= 42), JSON.stringify(rates));
  }));
