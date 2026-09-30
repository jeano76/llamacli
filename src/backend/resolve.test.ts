import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { resolveBackend } from "./resolve.js";
import { DEFAULT_CONFIG, type LlamacliConfig } from "../config.js";
import type { Discovery } from "./detect.js";
import type { BootstrapOptions, BootstrapReport } from "../setup/bootstrap.js";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "llamacli-resolve-"));
}

const localConfig = (over: Partial<LlamacliConfig> = {}): LlamacliConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
});

/** A discovery result, defaulted to "nothing is running" so each test states
 *  only the case it is about. */
const none: Discovery = { kind: "none" };

test("case 1: an already-running server is adopted, nothing is installed or spawned", async () => {
  const root = await project();
  try {
    let bootstrapCalls = 0;
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m-x" } }),
      bootstrap: async () => {
        bootstrapCalls++;
        throw new Error("bootstrap must not run when a server is already up");
      },
    });
    assert.equal(res.kind, "adopted");
    if (res.kind !== "adopted") return;
    assert.equal(res.baseUrl, "http://127.0.0.1:9099");
    assert.equal(res.model, "m-x");
    assert.equal(res.port, 9099);
    assert.equal(bootstrapCalls, 0, "an adopted server must not trigger the installer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 1: the adopted endpoint is persisted so the next launch is a known-good read", async () => {
  const root = await project();
  try {
    await mkdir(join(root, ".llamacli"), { recursive: true });
    await writeFile(join(root, ".llamacli", "config.yaml"), stringify({ backend: "local-llama", model: "m" }));
    await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m-x" } }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    const saved = parse(await readFile(join(root, ".llamacli", "config.yaml"), "utf8")) as any;
    assert.equal(saved.backend, "openai-compatible");
    assert.equal(saved.baseUrl, "http://127.0.0.1:9099");
    assert.equal(saved.model, "m-x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 1: a config already pointing at the running server is left untouched", async () => {
  const root = await project();
  try {
    await mkdir(join(root, ".llamacli"), { recursive: true });
    const original = stringify({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:9099", model: "m-x", apiKey: "sk-typed" });
    await writeFile(join(root, ".llamacli", "config.yaml"), original);
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:9099", model: "m-x", apiKey: "sk-typed" }),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m-x" } }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "adopted");
    // Byte-identical: rewriting an already-correct config on every launch would
    // churn a user-reviewed file, and any hand-added key must survive.
    assert.equal(await readFile(join(root, ".llamacli", "config.yaml"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 1: a LOADING server is adopted rather than answered with a second server", async () => {
  const root = await project();
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      // The whole point: `loading` must not be treated as `none`. Treating it as
      // none is how a second llama-server gets spawned onto a GPU the first one
      // is already holding most of — an OOM at load, not a slowdown.
      discover: async () => ({ kind: "loading", baseUrl: "http://127.0.0.1:8080", port: 8080, waitedMs: 120_000 }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "adopted");
    if (res.kind !== "adopted") return;
    assert.equal(res.baseUrl, "http://127.0.0.1:8080");
    assert.equal(res.port, 8080);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 2: an installed binary with a recorded model starts WITHOUT reaching the installer", async () => {
  const root = await project();
  try {
    // A real file, because the "is the model actually there" check reads its
    // size — a fake path would read as no model and fall through to case 3.
    const modelPath = join(root, "model.gguf");
    await writeFile(modelPath, Buffer.alloc(2048));
    let bootstrapCalls = 0;
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({
        backend: "local-llama",
        llama: { binPath: "/nonexistent/llama-server", modelPath, port: 8080, contextSize: 8192, threads: 4, gpuLayers: 0 },
      }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        bootstrapCalls++;
        return { ok: true, steps: [], errors: [], config: {} } as unknown as BootstrapReport;
      },
    });
    // The spawn itself cannot succeed here (no real binary), so this asserts the
    // part that matters: the installer was never consulted. A machine that
    // already has both a binary and a model must not go to the Hub.
    assert.equal(bootstrapCalls, 0, "an install with a recorded model must not reach the installer");
    assert.equal(res.kind, "unresolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 3: no binary and no model falls through to the installer", async () => {
  const root = await project();
  try {
    let sawInstall = false;
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      discover: async () => none,
      bootstrap: async (o: BootstrapOptions) => {
        sawInstall = true;
        assert.equal(o.projectRoot, root, "the installer must be told which project to write a config for");
        // An installer that attached to a server of its own reports it through
        // config.backend — the decision is read back, not re-derived.
        return {
          ok: true,
          steps: [],
          errors: [],
          config: { backend: "openai-compatible", baseUrl: "http://127.0.0.1:8081", model: "m-new" },
        } as unknown as BootstrapReport;
      },
    });
    assert.ok(sawInstall, "nothing installed and nothing recorded must trigger the installer");
    assert.equal(res.kind, "adopted");
    if (res.kind !== "adopted") return;
    assert.equal(res.baseUrl, "http://127.0.0.1:8081");
    assert.equal(res.port, 8081);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recorded model path that no longer exists is treated as NO model, not as a zero-byte one", async () => {
  const root = await project();
  try {
    const missing = join(root, "deleted.gguf");
    let bootstrapCalls = 0;
    await resolveBackend({
      projectRoot: root,
      config: localConfig({
        backend: "local-llama",
        llama: { binPath: "/nonexistent/llama-server", modelPath: missing, port: 8080, contextSize: 8192, threads: 4, gpuLayers: 0 },
      }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        bootstrapCalls++;
        return { ok: true, steps: [], errors: [], config: {} } as unknown as BootstrapReport;
      },
    });
    assert.equal(bootstrapCalls, 1, "a model deleted off disk must be re-prepared, not treated as usable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bootstrap that THROWS still yields a usable backend rather than a failed launch", async () => {
  const root = await project();
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:8080" }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        throw new Error("huggingface unreachable");
      },
    });
    // A bootstrap that throws must not take down a working install — the
    // session starts on whatever was already configured and says why.
    assert.equal(res.kind, "unresolved");
    if (res.kind !== "unresolved") return;
    assert.match(res.reason, /huggingface unreachable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the TUI never gets a progress reporter that writes to the terminal directly", async () => {
  const root = await project();
  try {
    const lines: string[] = [];
    let progressFactory: ((d: (p: any) => void) => (p: any) => void) | undefined;
    await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: (l) => lines.push(l),
      discover: async () => none,
      bootstrap: async (o) => {
        progressFactory = o.onProgress;
        return { ok: true, steps: [], errors: [], config: {} } as unknown as BootstrapReport;
      },
    });
    assert.ok(progressFactory, "the installer must be told how to report progress");
    const report = progressFactory!((p) => lines.push(`DEFAULT:${p.percent}`)) as (p: any) => void;
    // A whole-percent tick, then the same tick again: the default reporter
    // rewrites one terminal line with `\r\x1b[2K`, which would cut an Ink app
    // rendering into the same terminal in half — so it must be replaced, and
    // the replacement must throttle rather than log every tick.
    report({ label: "m.gguf", receivedBytes: 1_000_000_000, totalBytes: 4_000_000_000, bytesPerSecond: 1, etaSeconds: 1, percent: 25 });
    report({ label: "m.gguf", receivedBytes: 1_100_000_000, totalBytes: 4_000_000_000, bytesPerSecond: 1, etaSeconds: 1, percent: 25 });
    const progressLines = lines.filter((l) => l.startsWith("모델 다운로드"));
    assert.deepEqual(progressLines, ["모델 다운로드 중… 25%"], "a repeated tick must not produce a second line");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every log line is non-empty — a blank status line explains nothing", async () => {
  const root = await project();
  try {
    const lines: string[] = [];
    await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: (l) => lines.push(l),
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m" } }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.ok(lines.length > 0, "the adopted case must report which endpoint it took");
    for (const l of lines) assert.ok(l.trim().length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});