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

// ── `-c` is the TOTAL across slots, not per-slot ───────────────────────────
//
// llama.cpp divides the context by the slot count (llama-context.cpp:294,
// n_ctx_seq = n_ctx / n_seq_max, with n_seq_max = n_parallel at
// common/common.cpp:1722). Confirmed against a live server launched
// `-c 40960 -np 1`, whose startup log reads `n_slots = 1, n_ctx_slot = 40960`.
//
// `contextSize` means PER-SLOT everywhere else in this project (config.yaml,
// tuning.ts's VRAM budget, the compaction thresholds), so the multiplication
// belongs at this boundary. Getting it wrong halves the user's working memory
// with no error message anywhere.

test("-c is multiplied by the slot count so each conversation keeps its full context", () => {
  // A naive `-c contextSize` here would give `-c 16384` with 2 slots = 8,192
  // usable per conversation — half of what config.yaml promises.
  assert.equal(valueOf(buildServerArgs({ ...base, contextSize: 16384, parallel: 2 }), "-c"), "32768");
  assert.equal(valueOf(buildServerArgs({ ...base, contextSize: 16384, parallel: 4 }), "-c"), "65536");
  // 1 slot must be byte-identical to the pre-existing behavior — this is the
  // default every current user is on, and a regression here would silently
  // change everyone's context size.
  assert.equal(valueOf(buildServerArgs({ ...base, contextSize: 16384, parallel: 1 }), "-c"), "16384");
});

test("-c still reflects a per-slot context when parallel is left undefined", () => {
  // `parallel` is optional on the config. Undefined must behave as 1 rather than
  // as NaN (which would produce `-c NaN` and a server that never starts).
  assert.equal(valueOf(buildServerArgs({ ...base, contextSize: 8192 }), "-c"), "8192");
});

test("kv_unified is explicitly disabled, because llama.cpp's auto slot count turns it on", () => {
  // server.cpp:156-160: n_parallel < 0 resolves to 4 slots AND kv_unified=true,
  // and kv_unified is the one case where the KV pool genuinely grows with slots
  // (llama-context.cpp:290-292 keeps n_ctx_seq = n_ctx, shared). Passing -np
  // explicitly already takes the other branch, but -no-kvu keeps that true if a
  // future llama.cpp changes what "auto" resolves to — this project sizes its
  // whole context budget from there being exactly one conversation.
  const args = buildServerArgs({ ...base, parallel: 1 });
  assert.ok(args.includes("-no-kvu"), "unified KV must be off, not left to llama.cpp's auto default");
});

// ── Speculative decoding ─────────────────────────────────────────────────────
//
// Included because compaction latency is ~100% decode: the summary request's
// prompt is a verbatim prefix of the turn that just ran, so llama-server serves
// its prefill from the prompt cache (~0.3 s measured) and everything after it
// is generation. Speculation is the only lever that makes generation itself
// cheaper, as opposed to generating less of it.

test("speculative decoding is off unless configured", () => {
  // llama.cpp's own default for --spec-type is `none`, and passing it
  // explicitly would make a server with speculation deliberately disabled
  // indistinguishable on the command line from one that never considered it —
  // the same reasoning --n-cpu-moe uses below.
  const args = buildServerArgs({ ...base });
  assert.equal(args.includes("--spec-type"), false, "must not enable speculation by implication");
  assert.equal(args.includes("--spec-draft-n-max"), false);
});

test("--spec-type reaches the process, so the model-free methods are usable", () => {
  // These need no draft checkpoint. The methods that do (draft-simple, eagle3,
  // mtp, dflash, dspark) require a separately trained draft for this exact
  // target model, which is why they are not the default suggestion here.
  const args = buildServerArgs({ ...base, speculativeTypes: "ngram-mod,ngram-simple" });
  assert.equal(valueOf(args, "--spec-type"), "ngram-mod,ngram-simple");
  assert.equal(args.includes("--spec-draft-n-max"), false, "no length override unless one was asked for");

  const tuned = buildServerArgs({ ...base, speculativeTypes: "ngram-mod", speculativeDraftNMax: 8 });
  assert.equal(valueOf(tuned, "--spec-draft-n-max"), "8", "the draft length must be passable — it is the tuning knob");
});

test("speculation composes with every other flag rather than replacing the argv shape", () => {
  // Regression guard for the interaction: enabling speculation must not disturb
  // the per-slot -c multiplication or the explicit -no-kvu, both of which exist
  // for reasons unrelated to it.
  const args = buildServerArgs({
    ...base,
    contextSize: 16384,
    parallel: 2,
    speculativeTypes: "ngram-mod",
    cpuMoeLayers: 30,
  });
  assert.equal(valueOf(args, "-c"), "32768", "per-slot context still multiplied by slots");
  assert.ok(args.includes("-no-kvu"));
  assert.equal(valueOf(args, "--spec-type"), "ngram-mod");
  assert.equal(valueOf(args, "--n-cpu-moe"), "30", "MoE paging must survive alongside it");
});
