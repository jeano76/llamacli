import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLlamaServer,
  looksLikeUnsupportedModelFormat,
  probeModelCompatibility,
  runtimeCandidatesNearModel,
  MODEL_RUNTIME_SCAN_DEPTH,
  type ProbeSpawn,
} from "./llamaCpp.js";
import { B, P, SRV, PATHS, posix } from "../testSupport.js";


// ── a binary that runs but cannot read the model is a different failure ─────
//
// Two llama.cpp builds coexisted on this machine: a stock `~/llama.cpp` build
// (ggml types 0-42) and a newer build that adds further quantisation types.
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
  // With the newer-quant model it must be rejected specifically for the model, and
  // the search must continue to a build that can read it.
  const tried: string[] = [];
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p.endsWith(SRV) && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true, // runs fine — that was never the problem
    modelPath: "/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
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
    exists: async (p) => p.endsWith(SRV) && p.includes("llama.cpp"),
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/model.gguf",
    probeModel: async () => ({ ok: true }),
  });
  assert.ok(result.location, "a binary that reads the model must be accepted");
  assert.match(result.location!.binPath, /llama-server(\.exe)?$/);
  assert.deepEqual(result.rejectedForModel, []);
});

test("the search proceeds past a mismatched build to one that works", async () => {
  // The stock `~/llama.cpp` build is ranked FIRST, so this is the real shape of
  // the failure: the wrong build is found before the right one is even looked
  // at, and returning it ends the session. The working build is here on PATH,
  // which is the only route by which a second llama.cpp install is reachable
  // at all — see the test below for what happens when it is not.
  const stock = B("/usr/local/bin/llama-server");
  const fork = B("/opt/alt-runtime/llama-server");
  const seen: string[] = [];
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: { PATH: PATHS("/usr/local/bin", "/opt/alt-runtime") },
    exists: async (p) => p === stock || p === fork,
    listDirs: async () => [],
    probe: async () => true,
    modelPath: "/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
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
  // The build that reads the model on this machine lives in neither, so
  // there is no automatic route to it: the honest outcome is "nothing found,
  // here is what was checked", and the user's next move is to name the binary
  // in llama.binPath. Widening the search by guessing at directories is not
  // available as a fix here without inventing paths nobody can verify.
  const stock = B("/home/jeano/llama.cpp/build-opt/bin/llama-server");
  const unreachableFork = B("/media/jeano/nvme-usb/alt-runtime/llama-server");
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: { PATH: "/usr/bin" },
    exists: async (p) => p === stock || p === unreachableFork,
    listDirs: async () => ["build-opt"],
    probe: async () => true,
    modelPath: "/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
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
    exists: async (p) => p.endsWith(SRV) && p.includes("llama.cpp"),
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
    exists: async (p) => p.endsWith(SRV) && p.includes("llama.cpp"),
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
    exists: async (p) => p.endsWith(SRV) && p.includes("llama.cpp"),
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
  // `verdict` is included because it is what callers now branch on, and a
  // no-model probe is genuinely an "ok" rather than an absence of one.
  assert.deepEqual(await probeModelCompatibility(B("/nonexistent/llama-server"), undefined), {
    ok: true,
    verdict: "ok",
  });
});

test("a candidate that cannot even run is reported separately from a model mismatch", async () => {
  // The two lists answer different questions and lead to different fixes, so
  // collapsing them would lose the distinction that makes the message useful:
  // "cannot execute" means a broken install, "cannot read this quant" means the
  // wrong build.
  const broken = B("/home/jeano/llama.cpp/build-x86/bin/llama-server");
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
  const working = B("/home/jeano/llama.cpp/build-opt/bin/llama-server");
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
  const bin = B("/home/jeano/llama.cpp/build-opt/bin/llama-server");
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
  const bin = B("/home/jeano/llama.cpp/build-opt/bin/llama-server");
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

// ── runtimes installed beside the models ─────────────────────────────────────
//
// A second real install shape, and the one that left the reported session dead
// ended. llama.cpp publishes prebuilt release archives that get unpacked rather
// than compiled, putting a complete runtime — its own `llama-server` and `.so`
// files — wherever the user keeps their models. That is not a llama.cpp
// *checkout*, so it was in neither PATH nor any searched root.
//
// Observed on this machine: the model is at
// `<drive>/models/gguf/Ornith-1.5-35B-A3B-Q4_K_M.gguf` and the only build
// that can read it is <drive>/alt-runtime/llama-server — same disk, two
// directories away, invisible to every existing rule.

test("a runtime beside the model directory is found", async () => {
  const tree: Record<string, string[]> = {
    "/m/models/gguf": [],
    "/m/models": [],
    "/m": ["models", "alt-runtime", "llmwiki"],
    "/": ["m", "home"],
  };
  const found = await runtimeCandidatesNearModel("/m/models/gguf/Ornith-1.5-35B-A3B-Q4_K_M.gguf", {
    listDirs: async (dir) => tree[posix(dir)] ?? [],
    exists: async (p) => p === B("/m/alt-runtime/llama-server"),
  });
  assert.deepEqual(found, [B("/m/alt-runtime/llama-server")]);
});

test("the scan is bounded and stops at the filesystem root", async () => {
  // An unbounded walk up from /media/<user>/<volume> would reach the entire
  // filesystem; without the root check, dirname("/") === "/" and it spins.
  const asked: string[] = [];
  const found = await runtimeCandidatesNearModel("/a/b/c/model.gguf", {
    listDirs: async (dir) => {
      asked.push(dir);
      return [];
    },
    exists: async () => false,
  });
  assert.deepEqual(found, []);
  assert.ok(asked.length <= MODEL_RUNTIME_SCAN_DEPTH + 1, `scanned ${asked.length} levels`);
  assert.ok(!asked.includes("/"), "must not scan the filesystem root's children forever");
});

test("no model means no adjacent-runtime scan", async () => {
  // With no model there is nothing to be adjacent to, and guessing at
  // directories is precisely what this function exists to avoid.
  let listed = false;
  const found = await runtimeCandidatesNearModel(undefined, {
    listDirs: async () => {
      listed = true;
      return [];
    },
    exists: async () => true,
  });
  assert.deepEqual(found, []);
  assert.equal(listed, false, "the filesystem must not be touched");
});

test("llama-server is never treated as its own parent directory", async () => {
  // Harmless but wrong: <dir>/llama-server/llama-server is not a candidate,
  // and reporting it would put a nonexistent path in front of the user.
  const found = await runtimeCandidatesNearModel("/m/models/m.gguf", {
    listDirs: async () => ["llama-server", "runtime"],
    exists: async (p) => p === B("/m/runtime/llama-server"),
  });
  assert.deepEqual(found, [B("/m/runtime/llama-server")]);
});

test("the search prefers a declared location over an adjacent runtime", async () => {
  // Ranking matters: a build the user put in PATH is a decision, whereas an
  // adjacent runtime is a guess about where a tarball was unpacked. The guess
  // may be tried, but must never outrank the decision.
  const inPath = B("/usr/local/bin/llama-server");
  const adjacent = B("/m/alt-runtime/llama-server");
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: { PATH: "/usr/local/bin" },
    exists: async (p) => p === inPath || p === adjacent,
    listDirs: async (dir) => (posix(dir) === "/m" ? ["alt-runtime"] : posix(dir) === "/home/jeano/llama.cpp" ? [] : []),
    probe: async () => true,
    modelPath: "/m/models/gguf/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
    probeModel: async () => ({ ok: true }),
  });
  assert.equal(result.location?.binPath, inPath);
  assert.equal(result.location?.source, "path");
});

test("an adjacent runtime is used when the declared builds cannot read the model", async () => {
  // The case that was actually dead-ended: a stock build in PATH that runs fine
  // and cannot read the model, and one working runtime beside the model files.
  const inPath = B("/home/jeano/llama.cpp/build-opt/bin/llama-server");
  const adjacent = B("/m/alt-runtime/llama-server");
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === inPath || p === adjacent,
    listDirs: async (dir) => (posix(dir) === "/m" ? ["alt-runtime"] : ["build-opt"]),
    probe: async () => true,
    modelPath: "/m/models/gguf/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
    probeModel: async (bin) =>
      bin === adjacent ? { ok: true } : { ok: false, error: "invalid ggml type 143. should be in [0, 43)" },
  });
  assert.equal(result.location?.binPath, adjacent, "the one build that can read the model must win");
  assert.equal(result.location?.source, "model-adjacent");
  assert.deepEqual(result.rejectedForModel, [inPath]);
});

test("an unrelated sibling llama-server is probed and rejected, not launched", async () => {
  // Widening WHERE we look is only safe because the probe still decides WHAT we
  // accept. A sibling project that happens to contain a llama-server must not
  // be able to talk its way in.
  const stray = B("/m/some-project/llama-server");
  const good = B("/m/alt-runtime/llama-server");
  const result = await findLlamaServer({
    home: "/home/jeano",
    env: {},
    exists: async (p) => p === stray || p === good,
    listDirs: async (dir) => (posix(dir) === "/m" ? ["some-project", "alt-runtime"] : []),
    probe: async () => true,
    modelPath: "/m/models/gguf/Ornith-1.5-35B-A3B-Q4_K_M.gguf",
    probeModel: async (bin) =>
      bin === good ? { ok: true } : { ok: false, error: "invalid ggml type 143. should be in [0, 43)" },
  });
  assert.equal(result.location?.binPath, good);
  assert.deepEqual([...new Set(result.rejectedForModel ?? [])], [stray], "the stray build is reported, not used");
});

// ── The streaming probe: 60s -> 3s, and "verified" vs "not disproven" ───────

/** A fake spawn that emits scripted output and records whether it was killed. */
function fakeSpawn(script: string[], exitWith?: number) {
  const state = { killed: false, calls: 0 };
  const spawn: ProbeSpawn = (_bin, _args, { onOutput, onError, onExit }) => {
    state.calls++;
    for (const chunk of script) onOutput(chunk);
    // A script that printed its verdict and exited is the common real case.
    if (exitWith !== undefined) onExit(exitWith);
    return {
      kill: () => {
        state.killed = true;
      },
    };
  };
  return { spawn, state };
}

test("a build that reads the model is killed as soon as the verdict is known", async () => {
  // The bug: the probe awaited a process that never exits, so a WORKING build
  // always burned the full timeout. If the process is not killed on a verdict,
  // the probe is back to waiting, and each un-killed probe also leaves a second
  // llama-server on the machine holding the model's VRAM.
  const { spawn, state } = fakeSpawn(["load_model: initializing, n_slots = 4\n"]);
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn });
  assert.equal(r.verdict, "ok");
  assert.equal(state.killed, true, "the process must be killed, not left serving");
});

test("an unreadable quant is detected from output, not from the exit code", async () => {
  // The stock build refuses in ~180ms with this exact message. Waiting for the
  // exit code cannot tell it apart from any other failure.
  const { spawn, state } = fakeSpawn([
    "gguf_init_from_reader: tensor 'output.weight' has invalid ggml type 143\n",
  ]);
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn });
  assert.equal(r.verdict, "unsupported");
  assert.equal(r.ok, false);
  assert.equal(state.killed, true);
  assert.match(r.error ?? "", /invalid ggml type/);
});

test("a spawn that cannot start is NOT reported as ok", async () => {
  // The failure mode found while verifying this: a lazy `require` in an ESM
  // module threw, every probe returned a non-format error, and because that is
  // not a format complaint the candidate was KEPT -- silently reporting the
  // stock build as able to read a newer quant. A probe that never ran must
  // never look like one that passed.
  const spawn: ProbeSpawn = (_bin, _args, { onError }) => {
    onError(new Error("spawn ENOENT"));
    return { kill: () => {} };
  };
  const r = await probeModelCompatibility(B("/nope/llama-server"), "/m.gguf", { spawn });
  assert.equal(r.ok, false);
  assert.notEqual(r.verdict, "ok");
});

test("a process that never reports anything is inconclusive, not ok", async () => {
  // Silence used to be read as consent: the timeout produced a generic error,
  // which is not a format complaint, so the binary was kept and reported as
  // able to read the model. It was only ever "not disproven".
  const spawn: ProbeSpawn = () => ({ kill: () => {} });
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn, timeoutMs: 5 });
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.ok, false);
});

test("a non-type load failure is 'other', kept but not blamed on the build", async () => {
  // A corrupt file says nothing about the binary, so it must not be reported as
  // a build mismatch -- that would send the user rebuilding a working install
  // over a bad download.
  const { spawn } = fakeSpawn(["llama_model_loader: failed to load model\n"]);
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn });
  assert.equal(r.verdict, "other");
  assert.equal(r.ok, false);
});

test("findLlamaServer records a kept-but-unconfirmed build as unverified", async () => {
  // Kept because discarding a working install over a bad download is worse, but
  // recorded, because "kept" means "not disproven" and presenting that as a
  // positive result is how a wrong build gets reported as usable.
  const r = await findLlamaServer({
    env: { LLAMACLI_LLAMA_SERVER: B("/bin/llama-server") } as NodeJS.ProcessEnv,
    // modelPath is required: without it the compatibility check is skipped
    // entirely, which is correct behaviour and would make this test vacuous.
    modelPath: "/m.gguf",
    exists: async () => true,
    probe: async () => true,
    spawnProbe: () => ({ kill: () => {} }),
    probeModel: async () => ({ ok: false, verdict: "inconclusive" as const }),
  });
  assert.equal(r.location?.binPath, B("/bin/llama-server"), "still chosen -- it is the best candidate");
  assert.deepEqual(r.unverified, [B("/bin/llama-server")], "but not presented as confirmed");
  assert.deepEqual(r.rejectedForModel, [], "and not blamed for the model");
});

test("a process that EXITS is a verdict, not a reason to wait for the timeout", async () => {
  // The defect the project harness caught: the probe resolved only on a marker
  // or the timeout, so a binary that ended on its own — a wrapper script, or any
  // build that fails before printing a recognisable line — waited the full 60 s
  // for an answer that had already been given. A stub that exits instantly cost
  // a minute per probe, which is how this was found.
  const { spawn, state } = fakeSpawn([], 0);
  const t0 = Date.now();
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn, timeoutMs: 60_000 });
  assert.equal(r.verdict, "ok", "exit 0 with no complaint means the load was done");
  assert.ok(Date.now() - t0 < 1000, `must not wait for the timeout, took ${Date.now() - t0}ms`);
  assert.equal(state.calls, 1);
});

test("a non-zero exit is 'other' — the file failed, not the build", async () => {
  // Reporting this as a build mismatch would send the user rebuilding a working
  // install over a bad download.
  const { spawn } = fakeSpawn(["some unrecognised failure\n"], 1);
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn, timeoutMs: 60_000 });
  assert.equal(r.verdict, "other");
  assert.equal(r.ok, false);
});

test("output that already decided the verdict wins over a later exit", async () => {
  // The order the two events arrive in must not change the answer: a build that
  // printed "invalid ggml type" and then exited 0 is still a build mismatch.
  const { spawn } = fakeSpawn(["tensor 'output.weight' has invalid ggml type 143\n"], 0);
  const r = await probeModelCompatibility(B("/bin/llama-server"), "/m.gguf", { spawn, timeoutMs: 60_000 });
  assert.equal(r.verdict, "unsupported");
});
