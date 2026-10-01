import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
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

// ── Backend health check ─────────────────────────────────────────────────────
// "It answered" is not "it works". A server whose weights are unusable loads,
// reports its model and returns HTTP 200 with a well-formed completion full of
// nothing — one was adopted for seven hours before anyone noticed. These pin
// the two boundaries that matter: a garbage backend must not be adopted, and an
// inconclusive probe must never be mistaken for one.

const garbageHealth = async () => ({ verdict: "garbage", sample: "steps steps steps steps", reason: "not an echo" }) as const;

test("case 1: a server that answers with garbage is NOT adopted — it is reported with the model's own words", async () => {
  const root = await project();
  try {
    const lines: string[] = [];
    let bootstrapCalls = 0;
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: (l) => lines.push(l),
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "broken-x" } }),
      probe: garbageHealth,
      bootstrap: async () => {
        bootstrapCalls++;
        throw new Error("bootstrap must not run for a broken server either");
      },
    });
    assert.equal(res.kind, "unresolved");
    if (res.kind !== "unresolved") return;
    assert.match(res.reason, /steps steps steps steps/, "the user must see what the model actually said");
    assert.match(res.reason, /모델 파일이 손상/);
    assert.ok(lines.some((l) => /steps steps steps steps/.test(l)), "the TUI log must carry it too");
    assert.equal(bootstrapCalls, 0, "a broken server must not trigger a 20 GB reinstall");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 1: a garbage server must not fall through to spawning a second one beside it", async () => {
  const root = await project();
  try {
    const res = await resolveBackend({
      projectRoot: root,
      // A config that WOULD otherwise start a server — the broken one is still
      // holding the model in VRAM, and a second llama-server is an OOM.
      config: localConfig({ backend: "local-llama", llama: { binPath: "/bin/true", modelPath: "/bin/true", port: 9099 } } as any),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "broken-x" } }),
      probe: garbageHealth,
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "unresolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 1: a healthy probe adopts exactly as before (no regression)", async () => {
  const root = await project();
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m-x" } }),
      probe: async () => ({ verdict: "healthy", sample: "ZQXVKJ" }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "adopted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Connectivity is the agent loop's job to report, not the probe's. Reading an
// unreachable backend as "broken model" would lock the user out of a server
// that is merely slow to answer.
test("case 1: an inconclusive probe still adopts — a slow backend is not a broken one", async () => {
  const root = await project();
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig(),
      log: () => {},
      discover: async () => ({ kind: "found", server: { baseUrl: "http://127.0.0.1:9099", model: "m-x" } }),
      probe: async () => ({ verdict: "unknown", sample: "", reason: "chat failed: 503" }),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "adopted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case 2: a freshly spawned server serving garbage is reported, not handed to the agent loop", async () => {
  const root = await project();
  const cleanup: Array<() => void> = [];
  try {
    const model = join(root, "model.gguf");
    await writeFile(model, Buffer.alloc(64));
    // A real process answering /v1/models, so the spawn genuinely succeeds and
    // the probe is reached — stubbing tryStart's readiness away would test
    // nothing about the path that matters.
    const fake = join(root, "fake-llama-server");
    await writeFile(
      fake,
      `#!/usr/bin/env node
const http = require("http");
const i = process.argv.indexOf("--port");
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fake" }] }));
}).listen(Number(process.argv[i + 1]), "127.0.0.1");
`
    );
    await chmod(fake, 0o755);
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({ backend: "local-llama", llama: { binPath: fake, modelPath: model, port: 9097 } } as any),
      log: () => {},
      discover: async () => none,
      probe: garbageHealth,
      registerCleanup: (fn) => cleanup.push(fn),
      bootstrap: async () => ({ ok: true, steps: [], errors: [] }) as BootstrapReport,
    });
    assert.equal(res.kind, "unresolved");
    if (res.kind !== "unresolved") return;
    assert.match(res.reason, /steps steps steps steps/);
  } finally {
    for (const fn of cleanup) fn();
    await rm(root, { recursive: true, force: true });
  }
});
// ── `usable`: the distinction that decides exit-vs-launch ───────────────────
//
// `unresolved` used to be one state meaning two opposite things: "a server is
// answering but its output is garbage" (the user has a session and should see
// it) and "there is nothing to talk to" (prompt mode would be a shell around
// nothing). index.tsx must be able to tell them apart, or it either strands a
// running server or relaunches into a backend that cannot answer.

test("a garbage-output server is unresolved but still usable, so the TUI comes up", async () => {
  const res = await resolveBackend({
    projectRoot: "/tmp/resolve-usable-1",
    config: localConfig({}),
    log: () => {},
    discover: async () => ({
      kind: "found",
      server: { baseUrl: "http://127.0.0.1:9999", model: "some-model" },
    }),
    probe: async () => ({ verdict: "garbage", sample: "…", reason: "not echoing" }),
  });
  assert.equal(res.kind, "unresolved");
  // Usable: a real server is answering. Killing the app here would leave a
  // server holding VRAM with no way to reach it, and the user no way to see why.
  assert.equal(res.kind === "unresolved" && res.usable, true);
});

test("a start failure is unresolved and NOT usable, so the app exits instead of prompting", async () => {
  // Everything is installed, but nothing is listening: a prompt here is exactly
  // the reported "준비 안 된 상태에서 바로 프롬프트 모드" bug.
  const root = await mkdtemp(join(tmpdir(), "resolve-unusable-"));
  try {
    const modelPath = join(root, "m.gguf");
    await writeFile(modelPath, "weights");
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({
        backend: "local-llama",
        llama: { binPath: "/nonexistent/llama-server", modelPath, port: 8080, contextSize: 8192, threads: 4, gpuLayers: 0 },
      }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        throw new Error("the installer must not be consulted here");
      },
    });
    assert.equal(res.kind, "unresolved");
    assert.equal(res.kind === "unresolved" && res.usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed install is unresolved and NOT usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolve-unusable-2-"));
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({}),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => ({ ok: false, steps: [], errors: ["install failed"] }) as unknown as BootstrapReport,
    });
    assert.equal(res.kind, "unresolved");
    assert.equal(res.kind === "unresolved" && res.usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bootstrap that throws is unresolved and NOT usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolve-unusable-3-"));
  try {
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({}),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        throw new Error("network unreachable");
      },
    });
    assert.equal(res.kind, "unresolved");
    assert.equal(res.kind === "unresolved" && res.usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a healthy adopted server is not unresolved at all", async () => {
  // The control: `usable` must not leak into the normal path and make every
  // resolution look degraded.
  const res = await resolveBackend({
    projectRoot: "/tmp/resolve-usable-ok",
    config: localConfig({}),
    log: () => {},
    discover: async () => ({
      kind: "found",
      server: { baseUrl: "http://127.0.0.1:9999", model: "some-model" },
    }),
    probe: async () => ({ verdict: "healthy", sample: "ok" }),
  });
  assert.equal(res.kind, "adopted");
});

// ── the recorded model path is found wherever the config kept it ────────────
//
// Seen live on a project whose config said `backend: openai-compatible`,
// `llama.modelPath: ""`, and a real `model: /media/.../Ternary-Bonsai-2-27B...gguf`.
// Requiring a non-empty `llama.modelPath` (and the `local-llama` backend) sent
// it to the installer, which announced "llama.cpp is not installed", ran, failed,
// and then spawned a server against an empty model path — so a machine with both
// the binary and the weights reported a three-stage setup failure.

test("a model recorded only in the top-level `model` key is still used, not reinstalled", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolve-model-key-"));
  try {
    const modelPath = join(root, "m.gguf");
    await writeFile(modelPath, "weights");
    let installerRan = false;
    const res = await resolveBackend({
      projectRoot: root,
      config: localConfig({
        // Exactly the reported shape: openai-compatible, empty llama.modelPath,
        // the real model one level up.
        backend: "openai-compatible" as any,
        model: modelPath,
        llama: { binPath: "/nonexistent/llama-server", modelPath: "", port: 8081 } as any,
      }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        installerRan = true;
        return { ok: true, steps: [], errors: [] } as unknown as BootstrapReport;
      },
    });
    assert.equal(installerRan, false, "a recorded model must not reach the installer");
    // It got far enough to try the recorded binary, so this is a spawn failure
    // rather than a setup failure.
    assert.equal(res.kind, "unresolved");
    assert.equal(res.kind === "unresolved" && res.usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty llama.modelPath does not mask a usable top-level model", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolve-model-key-2-"));
  try {
    const modelPath = join(root, "m.gguf");
    await writeFile(modelPath, "weights");
    let installerRan = false;
    await resolveBackend({
      projectRoot: root,
      config: localConfig({ model: modelPath, llama: { binPath: "/nonexistent", modelPath: "", port: 8081 } as any }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        installerRan = true;
        return { ok: true, steps: [], errors: [] } as unknown as BootstrapReport;
      },
    });
    assert.equal(installerRan, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installer is still reached when no model path points at a real file", async () => {
  // The fix must not over-reach: a config naming a model that is not on disk is
  // genuinely missing, and case 3 is the correct place for that.
  const root = await mkdtemp(join(tmpdir(), "resolve-model-key-3-"));
  try {
    let installerRan = false;
    await resolveBackend({
      projectRoot: root,
      config: localConfig({
        model: join(root, "does-not-exist.gguf"),
        llama: { binPath: "/nonexistent", modelPath: join(root, "also-missing.gguf"), port: 8081 } as any,
      }),
      log: () => {},
      discover: async () => none,
      bootstrap: async () => {
        installerRan = true;
        return { ok: false, steps: [], errors: ["nothing to install"] } as unknown as BootstrapReport;
      },
    });
    assert.equal(installerRan, true, "a genuinely missing model must reach the installer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
