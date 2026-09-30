import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServerArgs, readyTimeoutMs, DEFAULT_8GB_PROFILE } from "./llamaServer.js";

const base = {
  binPath: "/usr/bin/llama-server",
  modelPath: "/models/m.gguf",
  host: "127.0.0.1",
  port: 8080,
  contextSize: 16384,
  threads: 6,
  gpuLayers: 999,
};

/** Reads the value that follows `flag`, or undefined if absent. */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── The flag list is the whole point of this file ───────────────────────────

test("every flag the tuning layer computes reaches the process", () => {
  // This is the regression. The previous argv carried six of the fourteen
  // values the bootstrap derives, so `--n-cpu-moe` was computed, persisted to
  // config.yaml, displayed to the user — and then never handed to the server.
  // On an 8 GB card that is the difference between a 35B MoE model loading and
  // an OOM on load.
  const args = buildServerArgs({
    ...base,
    threadsBatch: 11,
    batchSize: 2048,
    ubatchSize: 512,
    cpuMoeLayers: 30,
    flashAttn: true,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    parallel: 1,
  });
  assert.equal(valueOf(args, "-m"), "/models/m.gguf");
  assert.equal(valueOf(args, "--host"), "127.0.0.1");
  assert.equal(valueOf(args, "--port"), "8080");
  assert.equal(valueOf(args, "-c"), "16384");
  assert.equal(valueOf(args, "-t"), "6");
  assert.equal(valueOf(args, "-ngl"), "999");
  assert.equal(valueOf(args, "-tb"), "11");
  assert.equal(valueOf(args, "-b"), "2048");
  assert.equal(valueOf(args, "-ub"), "512");
  assert.equal(valueOf(args, "--n-cpu-moe"), "30", "the flag that makes 35B-A3B fit an 8 GB card");
  assert.equal(valueOf(args, "-fa"), "on");
  assert.equal(valueOf(args, "--cache-type-k"), "q8_0");
  assert.equal(valueOf(args, "--cache-type-v"), "q8_0");
  assert.equal(valueOf(args, "-np"), "1");
});

test("--n-cpu-moe is omitted, not zeroed, when there is no MoE paging to do", () => {
  // `--n-cpu-moe 0` is llama.cpp's default, so passing it would make a server
  // that intends full GPU offload indistinguishable on the command line from
  // one that never considered the flag.
  assert.equal(buildServerArgs({ ...base, cpuMoeLayers: 0 }).includes("--n-cpu-moe"), false);
  assert.equal(buildServerArgs({ ...base }).includes("--n-cpu-moe"), false);
  assert.equal(valueOf(buildServerArgs({ ...base, cpuMoeLayers: 12 }), "--n-cpu-moe"), "12");
});

test("unset optional flags are omitted so llama.cpp's own defaults apply", () => {
  // Inventing a default here would silently override a llama.cpp default that
  // is newer and better tuned than this module's guess.
  const args = buildServerArgs({ ...base, threadsBatch: undefined, flashAttn: undefined, parallel: undefined });
  for (const flag of ["-tb", "-fa", "-np", "-b", "-ub", "--cache-type-k", "--cache-type-v"]) {
    assert.equal(args.includes(flag), false, `${flag} should be absent when unset`);
  }
  // The required six are always there.
  for (const flag of ["-m", "--host", "--port", "-c", "-t", "-ngl"]) {
    assert.ok(args.includes(flag), `${flag} must always be passed`);
  }
});

test("flash attention off is passed explicitly rather than dropped", () => {
  // `false` is a decision, not an absence: dropping it would leave llama.cpp's
  // default (on, in current builds) in force while the config said off.
  assert.equal(valueOf(buildServerArgs({ ...base, flashAttn: false }), "-fa"), "off");
});

// ── The readiness budget has to outlast a real model load ──────────────────

test("the ready budget scales with the model and never drops below a real load", () => {
  const GB = 1024 ** 3;
  // A 21 GB model is the one this was written against; the old fixed 30 s was
  // shorter than the load, so a correct server was reported as failed and left
  // running as an orphan holding VRAM.
  assert.ok(readyTimeoutMs(21 * GB) > 60_000, "a 21 GB model needs minutes, not seconds");
  // And a small model still fails fast rather than hanging for ten minutes.
  assert.ok(readyTimeoutMs(0) >= 5 * 60_000, "even an unknown size gets a bounded, generous floor");
  // Monotonic: a bigger model never gets a shorter deadline.
  assert.ok(readyTimeoutMs(30 * GB) >= readyTimeoutMs(5 * GB));
});

test("the default profile points at the canonical llama port", () => {
  // 8081 was llamacli's old spawn default and appears nowhere else any more.
  // A profile pointing at a port nothing listens on is how a fresh install
  // ends up silently talking to a dead URL.
  assert.equal(DEFAULT_8GB_PROFILE.port, 8080);
});
