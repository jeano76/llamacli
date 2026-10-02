import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "./modelSelect.js";
import { findRung } from "./modelMetrics.js";

const bonsai = findRung("bonsai-27b")!;
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
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });

  assert.equal(r.previousModel, "/models/old.gguf", "the previous model must be reported so the change is legible");
  assert.equal(h.written.length, 1);
  const cfg = h.written[0];
  assert.notEqual(cfg.model, "/models/old.gguf", "the old model must be replaced");
  assert.equal(cfg.llama.modelPath, cfg.model, "both fields must name the SAME model");
  assert.match(String(cfg.model), /Bonsai/);
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

test("a Bonsai selection reports that PTQ1_0 needs a build that can read it", async () => {
  // The whole reason this check exists: PTQ1_0 is unreadable by a stock
  // llama.cpp, and it is the quant the Bonsai family is chosen FOR -- so picking
  // Bonsai is the common case for hitting this, not an edge case.
  const h = harness(undefined, REJECTED_FOR_MODEL);
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.equal(r.llama.needsDifferentBuild, true, "a build mismatch must be flagged, not glossed over");
  assert.match(r.llama.detail, /읽지 못합니다|호환/, `detail should explain: ${r.llama.detail}`);
});

test("a compatible build is reported as such", async () => {
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, true);
  assert.equal(r.llama.binPath, "/usr/bin/llama-server");
  assert.match(r.llama.detail, /읽을 수 있습니다/);
});

test("the config is written even when the build is incompatible, and the problem reported", async () => {
  // Refusing to record the choice would leave the user with a selection that
  // silently does not happen. Recording it AND reporting the build gap is the
  // honest version -- the next launch's discovery already resolves it.
  const h = harness(undefined, REJECTED_FOR_MODEL);
  await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(h.written.length, 1, "the choice must still be recorded");
});

test("no installed server is reported honestly rather than as a failure", async () => {
  const h = harness(undefined, NONE);
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.match(r.llama.detail, /찾지 못했|빌드/, `detail should say what is missing: ${r.llama.detail}`);
});

test("a changed model is flagged as needing a restart", async () => {
  // The running server has the OLD model loaded; nothing changes that without a
  // restart, so claiming the switch is already live would be false.
  const h = harness({ model: "/models/old.gguf", llama: { modelPath: "/models/old.gguf" } }, COMPATIBLE);
  const changed = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(changed.requiresRestart, true);

  const h2 = harness(undefined, COMPATIBLE);
  const fresh = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h2.deps });
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
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/models", ...h.deps });
  assert.equal(r.llama.ok, false);
  assert.match(r.llama.detail, /오류/);
});

test("the model path lands under the configured models directory", async () => {
  const h = harness(undefined, COMPATIBLE);
  const r = await selectModel({ projectRoot: "/p", rung: bonsai, modelsDir: "/mnt/nvme/models", ...h.deps });
  assert.ok(r.modelPath.startsWith("/mnt/nvme/models/"), `path should be under modelsDir: ${r.modelPath}`);
});