import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLlamaServer,
  looksLikeUnsupportedModelFormat,
  probeModelCompatibility,
} from "./llamaCpp.js";

// ── a binary that runs but cannot read the model is a different failure ─────
//
// Two llama.cpp builds coexisted on this machine: a stock `~/llama.cpp` build
// (ggml types 0-42) and a PrismML fork that adds ternary 1-bit quantisation.
// The stock build RAN fine — `--version` succeeded, every probe passed — and
// then rejected the configured 1-bit model at server start with:
//
//   tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)
//
// which reads like a corrupt download and is not one. `findLlamaServer` ranked
// `~/llama.cpp/build-opt` first and returned it, because the only check was
// `probeLlamaServer`, which runs `--version` — a check that a binary unable to
// read the weights it is about to be handed passes perfectly.

test("an unsupported-format error is recognised as a build mismatch, not a bad file", () => {
  assert.equal(
    looksLikeUnsupportedModelFormat("tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)"),
    true
  );
  assert.equal(looksLikeUnsupportedModelFormat("unknown ggml type 99"), true);
});

test("a generic load failure is NOT claimed to be a build mismatch", () => {
  // Over-claiming here would make llamacli discard a perfectly good install
  // because the download was truncated — a worse outcome than the bug being
  // fixed, since the binary was never the problem.
  assert.equal(looksLikeUnsupportedModelFormat("llama_model_loader: failed to load model"), false);
  assert.equal(looksLikeUnsupportedModelFormat("failed to read tensor info"), false);
  assert.equal(looksLikeUnsupportedModelFormat(undefined), false);
  assert.equal(looksLikeUnsupportedModelFormat(""), false);
});

test("a build that cannot read the configured model is skipped in favour of the next candidate", async () => {
  // The stock build answers `--version` fine and would previously be accepted.
  // With the ternary model it must be rejected specifically for the model, and
  // the search must continue to a build that can read it.
  const tried: string[] = [];
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith("llama-server") && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true, // runs fine — that was never the problem
    modelPath: "/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf",
    probeModel: async (bin) => {
      tried.push(bin);
      return { ok: false, error: "invalid ggml type 143. should be in [0, 43)" };
    },
  });
  assert.ok(tried.length > 0, "the model-compatibility probe must actually be consulted");
  assert.equal(result.location, null, "no candidate can read it, so none should be chosen");
  assert.ok(
    (result.rejectedForModel ?? []).length > 0,
    "the skip must be attributed to the model, not to a broken binary"
  );
  assert.deepEqual(result.rejected, [], "a running binary is not 'rejected: cannot execute'");
});

test("a build that CAN read the model is accepted", async () => {
  // The other half of the previous test: the check must not reject everything,
  // or a working install would be discarded for a problem it does not have.
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith("llama-server") && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/model.gguf",
    probeModel: async () => ({ ok: true }),
  });
  assert.ok(result.location, "a binary that reads the model must be accepted");
  assert.match(result.location!.binPath, /llama-server$/);
  assert.deepEqual(result.rejectedForModel, []);
});

test("the search proceeds past a mismatched build to one that works", async () => {
  // The stock `~/llama.cpp` build is ranked FIRST, so this is the real shape of
  // the failure: the wrong build is found before the right one is even looked
  // at, and returning it ends the session. The working build is here on PATH,
  // which is the only route by which a second llama.cpp install is reachable
  // at all — see the test below for what happens when it is not.
  const stock = "/usr/local/bin/llama-server";
  const fork = "/opt/bonsai2-runtime/llama-server";
  const seen: string[] = [];
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: { PATH: "/usr/local/bin:/opt/bonsai2-runtime" },
    exists: async (p) => p === stock || p === fork,
    listDirs: async () => [],
    probe: async () => true,
    modelPath: "/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf",
    probeModel: async (bin) => {
      seen.push(bin);
      return bin === fork ? { ok: true } : { ok: false, error: "invalid ggml type 143. should be in [0, 43)" };
    },
  });
  assert.equal(result.location?.binPath, fork, "the fork is the only build that can read the model");
  assert.deepEqual(result.rejectedForModel, [stock]);
  assert.deepEqual(seen, [stock, fork], "the mismatch must be established before moving on");
});

test("a working build outside every searched location is genuinely unreachable", async () => {
  // Recorded deliberately rather than papered over. The search covers env
  // overrides, PATH, and llama.cpp checkouts under $HOME — and nothing else.
  // The fork that reads ternary models on this machine lives in neither, so
  // there is no automatic route to it: the honest outcome is "nothing found,
  // here is what was checked", and the user's next move is to name the binary
  // in llama.binPath. Widening the search by guessing at directories is not
  // available as a fix here without inventing paths nobody can verify.
  const stock = "/home/jeano/llama.cpp/build-opt/bin/llama-server";
  const unreachableFork = "/media/jeano/nvme-usb/bonsai2-runtime/llama-server";
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: { PATH: "/usr/bin" },
    exists: async (p) => p === stock || p === unreachableFork,
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf",
    probeModel: async () => ({ ok: false, error: "invalid ggml type 143. should be in [0, 43)" }),
  });
  assert.equal(result.location, null);
  assert.deepEqual(result.rejectedForModel, [stock], "only what was actually searched may be listed");
  assert.ok(
    !JSON.stringify(result.rejectedForModel).includes(unreachableFork),
    "a binary that was never probed must not be reported as tested"
  );
});

test("a model-compatibility failure that is NOT a format mismatch keeps the binary", async () => {
  // A truncated download says nothing about the build. Discarding a working
  // install over it would be worse than the original problem.
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith("llama-server") && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/big.gguf",
    probeModel: async () => ({ ok: false, error: "llama_model_loader: failed to load model" }),
  });
  assert.ok(result.location, "a non-format load failure must not disqualify a working binary");
  assert.deepEqual(result.rejectedForModel, []);
});

test("model compatibility is not checked when no model is known yet", async () => {
  // A first run has no model. Probing for compatibility with nothing would be
  // both meaningless and a wasted process spawn per candidate.
  let probed = false;
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith("llama-server") && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    probeModel: async () => {
      probed = true;
      return { ok: false, error: "invalid ggml type 143" };
    },
  });
  assert.equal(probed, false, "with no model there is nothing to be incompatible with");
  assert.ok(result.location);
});

test("checkModel: false skips the pass entirely", async () => {
  // Callers that have already established compatibility elsewhere, and tests,
  // must be able to opt out rather than pay for a spawn per candidate.
  let probed = false;
  await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith("llama-server") && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/model.gguf",
    checkModel: false,
    probeModel: async () => {
      probed = true;
      return { ok: false, error: "invalid ggml type 143" };
    },
  });
  assert.equal(probed, false);
});

test("probeModelCompatibility resolves ok without a model path", async () => {
  // A first run has no model yet; this must not fail the binary search, and it
  // must not spawn anything.
  assert.deepEqual(await probeModelCompatibility("/nonexistent/llama-server", undefined), { ok: true });
});

test("a candidate that cannot even run is reported separately from a model mismatch", async () => {
  // The two lists answer different questions and lead to different fixes, so
  // collapsing them would lose the distinction that makes the message useful:
  // "cannot execute" means a broken install, "cannot read this quant" means the
  // wrong build.
  const broken = "/home/jeano/llama.cpp/build-x86/bin/llama-server";
  const onlyBroken = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === broken,
    listDirs: async () => ["build-x86"],
    probe: async () => false,
    modelPath: "/models/m.gguf",
    probeModel: async () => {
      throw new Error("a binary that will not run must never be asked about the model");
    },
  });
  assert.equal(onlyBroken.location, null);
  assert.deepEqual(onlyBroken.rejected, [broken]);
  assert.deepEqual(onlyBroken.rejectedForModel, []);

  // And a working build is chosen with both lists empty.
  const working = "/home/jeano/llama.cpp/build-opt/bin/llama-server";
  const chosen = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === working,
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/m.gguf",
    probeModel: async () => ({ ok: true }),
  });
  assert.equal(chosen.location?.binPath, working);
  assert.deepEqual(chosen.rejected, []);
  assert.deepEqual(chosen.rejectedForModel, []);
});

test("one binary reachable through several layouts is probed only once", async () => {
  // `candidatePaths` yields the same binary under each of the three real build
  // layouts (bin/, build/bin/, Release/), and the search tries all three. Both
  // probes are process spawns — `--version`, and a GGUF header parse for
  // model compatibility — so without memoisation a single stock build was
  // launched and re-read up to three times, and reported to the user three
  // times over as three different "incompatible" builds.
  const bin = "/home/jeano/llama.cpp/build-opt/bin/llama-server";
  let modelProbes = 0;
  let versionProbes = 0;
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === bin,
    listDirs: async () => ["build-opt"],
    probe: async () => {
      versionProbes++;
      return false;
    },
    modelPath: "/models/m.gguf",
    probeModel: async () => {
      modelProbes++;
      return { ok: false, error: "invalid ggml type 143" };
    },
  });
  assert.equal(result.location, null);
  assert.deepEqual(result.rejected, [bin], "listed once, not once per layout");
  assert.deepEqual(result.rejectedForModel, [], "a binary that will not run is never model-probed");
  assert.equal(modelProbes, 0);
  assert.equal(versionProbes, 1, "the same path must not be executed three times");
});

test("a binary rejected for the model is listed once however many layouts expose it", async () => {
  const bin = "/home/jeano/llama.cpp/build-opt/bin/llama-server";
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === bin,
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/m.gguf",
    probeModel: async () => ({ ok: false, error: "invalid ggml type 143. should be in [0, 43)" }),
  });
  assert.equal(result.location, null);
  assert.deepEqual(
    result.rejectedForModel,
    [bin],
    "one path that failed once must not appear three times in the user's report"
  );
});
