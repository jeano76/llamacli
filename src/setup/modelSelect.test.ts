import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "./modelSelect.js";
import { findRung } from "./modelMetrics.js";

const ornith = findRung("ornith-35b")!;

/** Collect what selectModel wrote, without touching a real disk. */
function harness(existing: Record<string, any> | undefined, findResult: any) {
  const written: Record<string, any>[] = [];
  return {
    written,
    deps: {
      readConfigFile: async () => existing,
      writeConfigFile: async (_root: string, cfg: Record<string, unknown>) => {
        written.push(cfg as Record<string, any>);
      },
      findServer: async () => findResult,
      // Machine-independent by default: otherwise the port is taken from whatever
      // llama-server happens to be running on the box the suite runs on.
      detectRunningPort: async () => null as number | null,
      // And disk-independent: the family-reuse scan would otherwise find the models that
      // really are on the machine running the suite.
      listLocalModels: async () => [] as { path: string; sizeBytes: number }[],
    },
  };
}

const COMPATIBLE = { location: { binPath: "/usr/bin/llama-server", source: "path", backend: "cuda" }, rejected: [] };
const NONE = { location: null, rejected: [] };
const REJECTED_FOR_MODEL = {
  location: null,
  rejected: [],
  rejectedForModel: ["/home/u/llama.cpp/build/bin/llama-server"],
};

test("selecting REPLACES the model — it does not accumulate a list", async () => {
  // The config names exactly one model. Keeping the old one as a "fallback" would
  // mean a silent mismatch between what /models says is selected and what the
  // stale `model` field says the server is serving.
  const h = harness({ model: "/models/old.gguf", llama: { modelPath: "/models/old.gguf", port: 8080 } }, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: findRung("ornith-9b")!, modelsDir: "/models", ...h.deps });

  assert.equal(r.previousModel, "/models/old.gguf", "the previous model must be reported so the change is legible");
  assert.equal(h.written.length, 1);
  const cfg = h.written[0];
  assert.notEqual(cfg.model, "/models/old.gguf", "the old model must be replaced");
  assert.equal(cfg.llama.modelPath, cfg.model, "both fields must name the SAME model");
  assert.match(String(cfg.model), /Ornith/);
  assert.equal(cfg.llama.port, 8080, "and unrelated settings must survive the switch");
});

test("both model fields are written together, never one alone", async () => {
  // loadConfig treats the top-level `model` as a live cache refreshed from the
  // server, while `llama.modelPath` is what the binary is launched with. Writing
  // only one is how a config ends up pointing at a model that is not served.
  const h = harness(undefined, COMPATIBLE);
  await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  const cfg = h.written[0];
  assert.equal(typeof cfg.model, "string");
  assert.equal(cfg.model, cfg.llama.modelPath);
});

test("a selection reports when the build cannot read the quant: it needs a build that can read it", async () => {
  // The whole reason this check exists: a quant newer than the installed
  // llama.cpp is unreadable by it
  const h = harness(undefined, REJECTED_FOR_MODEL);
  const r = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.equal(r.llama.needsDifferentBuild, true, "a build mismatch must be flagged, not glossed over");
  assert.match(r.llama.detail, /읽지 못합니다|호환/, `detail should explain: ${r.llama.detail}`);
});

test("a compatible build is reported as such", async () => {
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, true);
  assert.equal(r.llama.binPath, "/usr/bin/llama-server");
  assert.match(r.llama.detail, /읽을 수 있습니다/);
});

test("the config is written even when the build is incompatible, and the problem reported", async () => {
  // Refusing to record the choice would leave the user with a selection that
  // silently does not happen. Recording it AND reporting the build gap is the
  // honest version -- the next launch's discovery already resolves it.
  const h = harness(undefined, REJECTED_FOR_MODEL);
  await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(h.written.length, 1, "the choice must still be recorded");
});

test("no installed server is reported honestly rather than as a failure", async () => {
  const h = harness(undefined, NONE);
  const r = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.match(r.llama.detail, /찾지 못했|빌드/, `detail should say what is missing: ${r.llama.detail}`);
});

test("a changed model is flagged as needing a restart", async () => {
  // The running server has the OLD model loaded; nothing changes that without a
  // restart, so claiming the switch is already live would be false.
  const h = harness({ model: "/models/old.gguf", llama: { modelPath: "/models/old.gguf" } }, COMPATIBLE);
  const changed = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(changed.requiresRestart, true);

  const h2 = harness(undefined, COMPATIBLE);
  const fresh = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h2.deps });
  // Still a restart: whatever the server currently has loaded will not change
  // itself. An earlier version of this test asserted `false` here on the
  // reasoning that "nothing was configured, so nothing is being replaced" --
  // which is true of the CONFIG and false of the PROCESS.
  assert.equal(fresh.requiresRestart, true, "a running server never reloads itself");
});

test("a discovery error is reported, not thrown", async () => {
  const h = harness(undefined, COMPATIBLE);
  h.deps.findServer = async () => {
    throw new Error("probe blew up");
  };
  const r = await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.match(r.llama.detail, /오류/);
});

test("when nothing is on disk, the path lands under the configured models directory", async () => {
  // Only reached when the search comes up empty, which cannot be arranged from a
  // test on a machine that really has these models on an external drive — so
  // `modelsDir` is pointed at a temp dir AND the rung is one that genuinely does
  // not exist here. The earlier version of this test asserted the path lands
  // under modelsDir for a model that WAS on disk elsewhere, i.e. it asserted the
  // bug: that a real existing copy is ignored in favour of the requested dir.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "msel3-"));
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p",
    rung: findRung("ornith-9b")!,
    modelsDir: dir,
    searchDirs: [dir],
    ...h.deps,
    detectRunningPort: async () => null,
  });
  assert.ok(r.modelPath.startsWith(dir + "/"), `should be under modelsDir: ${r.modelPath}`);
  assert.equal(r.presentOnDisk, false, "nothing there means a download, which must be reported as such");
});

test("an existing model in a SUBDIRECTORY is found, not re-downloaded", async () => {
  // The real layout on this machine splits the two cases: some models sit at the
  // top of the models dir and some in a per-family subdirectory. A flat check
  // found the first and proposed re-downloading the second — several GiB the
  // user already had.
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "msel2-"));
  const sub = join(root, "models", "gguf");
  await mkdir(sub, { recursive: true });
  const real = join(sub, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
  await writeFile(real, "x");

  const r = await selectModel({
    projectRoot: root,
    rung: ornith,
    detectRunningPort: async () => null,
    readConfigFile: async () => ({}),
    writeConfigFile: async () => {},
    findServer: async () => COMPATIBLE as any,
    // The models dir is not the default, so the search is pointed at it.
    modelsDir: join(root, "models"),
  });
  assert.equal(r.modelPath, real, "a model in a subdirectory must be found, not re-downloaded");
  assert.equal(r.presentOnDisk, true);
});

// ── Tuning, port, and the two defects found by checking the real config ──────

test("re-tuning for the new model does NOT move the port", async () => {
  // The regression this guards: the tuning write and the port live in the same
  // `llama` block, so a re-tune that re-derives the port would relocate the
  // server on every model switch -- and a port that moves on every switch is a
  // port nobody can predict. The port is carried over untouched.
  const h = harness({ model: "/models/old.gguf", llama: { modelPath: "/models/old.gguf", port: 8084 } }, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p",
    rung: ornith,
    tuning: { contextSize: 16384, threads: 10, cpuMoeLayers: 4 } as any,
    ...h.deps,
  });
  assert.equal(r.port, 8084, "the port must be reported for the server switch to reuse");
  assert.equal(h.written[0].llama.port, 8084, "and must survive into the config untouched");
  assert.equal(h.written[0].llama.contextSize, 16384, "while the model-specific flags ARE re-derived");
  assert.equal(h.written[0].llama.cpuMoeLayers, 4);
});

test("an unrecorded port asks the RUNNING server, never defaults to 8080", async () => {
  // The config here has no `llama.port` at all while a real server listens on
  // 8084. Defaulting to 8080 there would start a SECOND server -- the exact
  // two-server OOM the switch exists to prevent -- so the running process is
  // asked where it actually is.
  const h = harness({ model: "/models/old.gguf", llama: { modelPath: "/models/old.gguf" } }, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p",
    rung: ornith,
    ...h.deps,
    detectRunningPort: async () => 8084,
  });
  assert.equal(r.port, 8084, "the running server's port must win over the 8080 default");
});

test("a recorded port yields to the llama-server that is really running elsewhere", async () => {
  // The field failure: config said 8080, the server was started by hand on 8084. Trusting
  // the record sent the switch to a port with nothing on it, so nothing was stopped and a
  // second server was started beside a full card. The detector only reports llama-server
  // processes, so "whatever some other process is on" cannot move the install.
  const h = harness({ llama: { modelPath: "/m.gguf", port: 9090 } }, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p",
    rung: ornith,
    ...h.deps,
    detectRunningPort: async () => 8084,
  });
  assert.equal(r.port, 8084);
});

test("a recorded port is kept when no llama-server is running", async () => {
  const h = harness({ llama: { modelPath: "/m.gguf", port: 9090 } }, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: ornith, ...h.deps, detectRunningPort: async () => null });
  assert.equal(r.port, 9090);
});

test("the port the server is really on is written back to the config", async () => {
  const h = harness({ llama: { modelPath: "/m.gguf", port: 8080 } }, COMPATIBLE);
  await selectModel({ projectRoot: "/p", rung: ornith, ...h.deps, detectRunningPort: async () => 8084 });
  assert.equal(h.written[0].llama.port, 8084, "the stale 8080 must not be written back");
});

test("with nothing running, an unrecorded port falls back to 8080", async () => {
  // It is correct as a fallback precisely because nothing is listening, so
  // binding it cannot collide.
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p",
    rung: ornith,
    ...h.deps,
    detectRunningPort: async () => null,
  });
  assert.equal(r.port, 8080);
});

test("a model already on disk is recorded at its REAL path, not a guessed one", async () => {
  // The regression: guessing `$HOME/models` recorded a path that does not exist
  // for a model the user already had on an external drive, which reports
  // "not downloaded yet" and then re-downloads GiB they already have. The
  // config's own path wins when the file is really there.
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "msel4-"));
  const real = join(root, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
  await mkdir(join(root, ".llamacli"), { recursive: true });
  await writeFile(real, "x");

  const r = await selectModel({
    projectRoot: root,
    rung: ornith,
    detectRunningPort: async () => null,
    readConfigFile: async () => ({ llama: { modelPath: real } }),
    writeConfigFile: async () => {},
    findServer: async () => COMPATIBLE as any,
  });
  assert.equal(r.modelPath, real, "the existing on-disk copy must be recorded, not re-downloaded");
  assert.equal(r.presentOnDisk, true);
});

test("/models: the same model on disk in the quant a download would fetch counts as already downloaded", async () => {
  // The table says 9B Q4_K_M, but the user may hold the Q8_0 file. A user who has the Q8_0 file
  // already has this model; asking them to download it again (and to type `confirm`) was
  // the bug.
  const eight = findRung("ornith-9b")!;
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p", rung: eight, modelsDir: "/models", ...h.deps, searchDirs: ["/models"],
    listLocalModels: async () => [{ path: "/media/disk2/models/Ornith-1.5-9B-Q8_0.gguf", sizeBytes: 2_000_000_000 }],
  });
  assert.equal(r.modelPath, "/media/disk2/models/Ornith-1.5-9B-Q8_0.gguf");
  assert.equal(h.written[0].llama.modelPath, r.modelPath, "and the config records where it really is");
});

test("/models: a file of another FAMILY is never taken for the chosen model", async () => {
  const eight = findRung("ornith-9b")!;
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({
    projectRoot: "/p", rung: eight, modelsDir: "/models", ...h.deps,
    listLocalModels: async () => [{ path: "/media/disk2/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf", sizeBytes: 5_500_000_000 }],
  });
  assert.doesNotMatch(r.modelPath, /35B/);
});

import { recordServerState } from "./modelSelect.js";

test("selecting a model records the build that can READ it, not the one that cannot", async () => {
  const h = harness({ llama: { modelPath: "/m/old.gguf", binPath: "/home/u/llama.cpp/build-opt/bin/llama-server", port: 8084 } },
    { location: { binPath: "/home/u/.llamacli/llama.cpp-new/cuda-12.8/llama-server", source: "x", backend: "cuda" }, rejected: [] });
  await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(h.written[0].llama.binPath, "/home/u/.llamacli/llama.cpp-new/cuda-12.8/llama-server");
});

test("no compatible build found: the existing binPath is left alone rather than blanked", async () => {
  const h = harness({ llama: { modelPath: "/m/old.gguf", binPath: "/keep/llama-server" } }, NONE);
  await selectModel({ projectRoot: "/p", rung: ornith, modelsDir: "/models", ...h.deps });
  assert.equal(h.written[0].llama.binPath, "/keep/llama-server");
});

test("recordServerState writes port, binary, model and the tuning actually launched — and keeps the rest", async () => {
  let saved: any;
  const changed = await recordServerState(
    "/p",
    { port: 8084, binPath: "/b/llama-server", modelPath: "/m/new.gguf", tuning: { gpuLayers: 999, contextSize: 16384, threads: 6, cpuMoeLayers: 0 } },
    {
      read: async () => ({ apiKey: "keep", backend: "openai-compatible", baseUrl: "http://127.0.0.1:8080", model: "/m/old.gguf", llama: { port: 8080, modelPath: "/m/old.gguf", flashAttn: true } }),
      write: async (_r, c) => { saved = c; },
    }
  );
  assert.equal(changed, true);
  assert.equal(saved.apiKey, "keep");
  assert.equal(saved.model, "/m/new.gguf");
  assert.equal(saved.llama.modelPath, "/m/new.gguf");
  assert.equal(saved.llama.binPath, "/b/llama-server");
  assert.equal(saved.llama.port, 8084);
  assert.equal(saved.llama.contextSize, 16384);
  assert.equal(saved.llama.gpuLayers, 999);
  assert.equal(saved.baseUrl, "http://127.0.0.1:8084", "a local baseUrl follows the real port");
  assert.equal(saved.llama.flashAttn, true, "unrelated llama keys survive");
});

test("recordServerState is a no-op (no write) when the config already says it", async () => {
  let writes = 0;
  const cfg = { model: "/m/a.gguf", llama: { port: 8084, modelPath: "/m/a.gguf", binPath: "/b" } };
  const changed = await recordServerState("/p", { port: 8084, binPath: "/b", modelPath: "/m/a.gguf" }, { read: async () => cfg, write: async () => { writes++; } });
  assert.equal(changed, false);
  assert.equal(writes, 0);
});

// ── the 35B rung must never record another model's file ─────────────────────

test("selecting the 35B while the config names the 9B records the 35B file, not the 9B", async () => {
  const h = harness({ model: "/m/Ornith-1.5-9B-Q4_K_M.gguf", llama: { modelPath: "/m/Ornith-1.5-9B-Q4_K_M.gguf", port: 8080 } }, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: findRung("ornith-35b")!, modelsDir: "/models", searchDirs: [], ...h.deps });
  assert.match(r.modelPath, /Ornith-1\.5-35B/);
  assert.doesNotMatch(r.modelPath, /9B/);
  assert.equal(h.written[0].model, h.written[0].llama.modelPath);
  assert.match(String(h.written[0].model), /35B/);
});

test("selecting the 35B keeps the spelling of the 35B file the config already uses (the Hub's two names)", async () => {
  const h = harness({ model: "/m/Ornith-1.5-35B-Q4_K_S.gguf", llama: { modelPath: "/m/Ornith-1.5-35B-Q4_K_S.gguf" } }, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: findRung("ornith-35b")!, modelsDir: "/models", searchDirs: [], ...h.deps });
  assert.match(r.modelPath, /Ornith-1\.5-35B-Q4_K_S\.gguf$/);
});
