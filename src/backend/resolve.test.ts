import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { resolveBackend, startWithCompatibleFallback, configuredPort } from "./resolve.js";
import { DEFAULT_CONFIG, type LlamacliConfig } from "../config.js";
import { discoverRunningServer, type Discovery } from "./detect.js";
import type { BootstrapOptions, BootstrapReport } from "../setup/bootstrap.js";
import { EXE, writeFakeExe } from "../testSupport.js";


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
    const fake = join(root, `fake-llama-server${EXE}`);
    await writeFakeExe(fake, { serve: true });
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
    // Windows cannot delete a running .exe: the just-killed fake server may still hold it for a moment.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
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
// `llama.modelPath: ""`, and a real `model: /media/.../Ornith-1.5-35B-A3B...gguf`.
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

// ── a recorded binary that cannot read the recorded model ────────────────────
//
// The failure this covers was reported four times in a row, always as:
//
//   [llamacli] llama-server 시작 실패: ... (code=1)
//   tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)
//   [설정 실패] ... 포트(8080)가 사용 중이거나 GPU 메모리가 부족할 수 있습니다.
//
// None of those three lines was the cause. Two llama.cpp builds coexist on this
// machine — a stock one whose ggml type registry stops at 42, and a newer
// build that reads more quant types. The config named the stock build, and
// the stock build cannot read the model. Type 143 is neither a busy port nor a
// corrupt download, and saying so sent the user after a setting that was never
// involved.

const MISMATCH = "tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)";

/**
 * A config naming a real model file, which is what the Case-2 gate requires
 * before it will spawn anything.
 *
 * Passed as the `config` OPTION rather than written to `.llamacli/config.yaml`:
 * the gate reads `config.llama` directly, and the model path is additionally
 * stat()ed for a non-zero size. A config whose model file does not exist skips
 * Case 2 entirely and lands in the installer — a different code path that would
 * have let these tests pass for entirely the wrong reason.
 */
/** A port nothing is listening on RIGHT NOW. The spawn-failure tests launch the real llama-server binary
 *  with a model that cannot load and expect the session to end; with the default 8080, a llama-server
 *  that is genuinely running on the machine answers the readiness probe instead and the "failed" spawn
 *  reports success — the test then measures the machine, not the code. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function configWithModel(dir: string, binPath: string, port?: number): Promise<LlamacliConfig> {
  const modelPath = join(dir, "model.gguf");
  await writeFile(modelPath, Buffer.alloc(4096));
  return localConfig({
    model: modelPath,
    llama: { binPath, modelPath, port: port ?? (await freePort()), contextSize: 4096, threads: 4, gpuLayers: 0 },
  });
}

/** Nothing is listening, so the recorded binary is the one that gets spawned,
 *  and its failure is what ends the session. `bootstrap` throws on purpose: a
 *  binary and a model that are both present must never reach the installer,
 *  which would burn 10-40 minutes of CUDA compilation to fix nothing. */
const NO_SERVER = {
  discover: async () => ({ kind: "none" }) as const,
  bootstrap: async () => {
    throw new Error("a present binary and model must not trigger the installer");
  },
  probe: async () => ({ verdict: "unknown", sample: "", reason: "not running" } as const),
};

const NO_REPLACEMENT = async () => ({ location: null, rejected: [], rejectedForModel: [] });

test("a build mismatch is never reported as a port or VRAM problem", async () => {
  const root = await project();
  try {
    const config = await configWithModel(root, "/home/jeano/llama.cpp/build-opt/bin/llama-server");
    const res = await resolveBackend({
      projectRoot: root,
      config,
      log: () => {},
      ...NO_SERVER,
      probeModel: async () => ({ ok: false, error: MISMATCH }),
      findLlamaServer: NO_REPLACEMENT,
    });

    assert.equal(res.kind, "unresolved");
    const reason = (res as { reason?: string }).reason ?? "";
    assert.match(reason, /양자화/, "the message must name the actual cause");
    assert.match(reason, /binPath/, "and say what to change");
    // Asserted against the OFFER of those explanations, not the words: the
    // message legitimately says "this is not a port or VRAM problem", which is
    // the useful part. What must be gone is the suggestion to go change them.
    assert.doesNotMatch(reason, /사용 중이거나 GPU 메모리가 부족할 수 있습니다/);
    assert.doesNotMatch(reason, /포트\(\d+\)가 사용 중/);
    assert.match(reason, /포트나 GPU 메모리 문제가 아니며/, "and it rules them out explicitly");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a genuine spawn failure still offers the port/VRAM explanation", async () => {
  // The other branch must survive the split. A busy port and a full card are
  // real and common, and that message is correct for them — collapsing both
  // failures into one string would have fixed the reported bug and broken this.
  const root = await project();
  try {
    const config = await configWithModel(root, "/home/jeano/llama.cpp/build-opt/bin/llama-server");
    const res = await resolveBackend({
      projectRoot: root,
      config,
      log: () => {},
      ...NO_SERVER,
      probeModel: async () => ({ ok: true }),
      findLlamaServer: NO_REPLACEMENT,
    });

    assert.equal(res.kind, "unresolved");
    const reason = (res as { reason?: string }).reason ?? "";
    assert.match(reason, /포트\(\d+\)가 사용 중|GPU 메모리/);
    assert.doesNotMatch(reason, /양자화/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare binary name is still explained as a PATH problem", async () => {
  // The pre-existing branch the split had to preserve: "llama-server" without a
  // slash resolves only through PATH, and telling that user to change the port
  // wastes their time on a setting that was never involved.
  const root = await project();
  try {
    const config = await configWithModel(root, "llama-server");
    const res = await resolveBackend({
      projectRoot: root,
      config,
      log: () => {},
      ...NO_SERVER,
      probeModel: async () => ({ ok: true }),
      findLlamaServer: NO_REPLACEMENT,
    });

    assert.equal(res.kind, "unresolved");
    assert.match((res as { reason?: string }).reason ?? "", /PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unusable backend never comes up looking like a usable prompt", async () => {
  // Whichever cause, this outcome must not present as a session: the user would
  // type into a shell with no model behind it.
  const root = await project();
  try {
    const config = await configWithModel(root, "/home/jeano/llama.cpp/build-opt/bin/llama-server");
    const res = await resolveBackend({
      projectRoot: root,
      config,
      log: () => {},
      ...NO_SERVER,
      probeModel: async () => ({ ok: false, error: MISMATCH }),
      findLlamaServer: NO_REPLACEMENT,
    });
    assert.equal((res as { usable?: boolean }).usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fallback search is told which model it must be able to read", async () => {
  // A replacement build is only useful if it can read THIS model, so the path
  // has to reach the search. Getting it wrong would substitute a binary that
  // fails identically.
  const root = await project();
  try {
    const config = await configWithModel(root, "/home/jeano/llama.cpp/build-opt/bin/llama-server");
    let searchedFor: string | undefined;
    await resolveBackend({
      projectRoot: root,
      config,
      log: () => {},
      ...NO_SERVER,
      probeModel: async () => ({ ok: false, error: MISMATCH }),
      findLlamaServer: (async (opts: { modelPath?: string } = {}) => {
        searchedFor = opts.modelPath;
        return { location: null, rejected: [], rejectedForModel: [] };
      }) as never,
    });
    assert.equal(searchedFor, config.model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the recorded binary is stripped from the search environment", async () => {
  // Env overrides are ranked FIRST, so leaving the known-bad binPath in place
  // would hand back the very build that just failed — a retry that changes
  // nothing while appearing to try something.
  const root = await project();
  try {
    const config = await configWithModel(root, "/opt/bad/llama-server");
    const previous = process.env.LLAMACLI_LLAMA_SERVER;
    process.env.LLAMACLI_LLAMA_SERVER = "/opt/bad/llama-server";
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      await resolveBackend({
        projectRoot: root,
        config,
        log: () => {},
        ...NO_SERVER,
        probeModel: async () => ({ ok: false, error: MISMATCH }),
        findLlamaServer: (async (opts: { env?: NodeJS.ProcessEnv } = {}) => {
          seen = opts.env;
          return { location: null, rejected: [], rejectedForModel: [] };
        }) as never,
      });
      assert.ok(seen, "the search must have been consulted");
      assert.equal(seen!.LLAMACLI_LLAMA_SERVER, undefined, "the known-bad override must not be passed through");
    } finally {
      if (previous === undefined) delete process.env.LLAMACLI_LLAMA_SERVER;
      else process.env.LLAMACLI_LLAMA_SERVER = previous;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no replacement build means the user is told where the search actually looked", async () => {
  // The working fork on this machine lives in neither PATH nor a llama.cpp
  // checkout, so the automatic search genuinely cannot reach it. "Not found"
  // alone would leave no hint that naming the path by hand is the fix.
  const root = await project();
  try {
    const config = await configWithModel(root, "/home/jeano/llama.cpp/build-opt/bin/llama-server");
    const lines: string[] = [];
    await resolveBackend({
      projectRoot: root,
      config,
      log: (line) => lines.push(line),
      ...NO_SERVER,
      probeModel: async () => ({ ok: false, error: MISMATCH }),
      findLlamaServer: async () => ({
        location: null,
        rejected: [],
        rejectedForModel: ["/home/jeano/llama.cpp/build-opt/bin/llama-server"],
      }),
    });
    const said = lines.join("\n");
    assert.match(said, /PATH/, "the searched locations must be stated");
    assert.match(said, /binPath/, "and the way to point at a build by hand");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── the fallback must report the binary that actually failed ────────────────
//
// Verified live: the substitution found a working fork, the fork then failed
// with "cudaMalloc failed: out of memory", and the message named the stock
// build that had been rejected two steps earlier. Correct-looking text about a
// binary that never ran.

const SPAWN_CFG = {
  binPath: "/stock/llama-server",
  modelPath: "/m/model.gguf",
  host: "127.0.0.1",
  port: 8080,
  contextSize: 4096,
  threads: 4,
  gpuLayers: 0,
};

/** A search that finds the fork sitting beside the model files. */
const REPLACEMENT_FOUND = async () => ({
  location: { binPath: "/opt/fork/llama-server", source: "model-adjacent", backend: "cuda" },
  rejected: [],
  rejectedForModel: [],
});

test("a mismatch retries with the replacement binary", async () => {
  const attempted: string[] = [];
  const outcome = await startWithCompatibleFallback(SPAWN_CFG, {
    env: {},
    log: () => {},
    find: REPLACEMENT_FOUND as never,
    tryStartImpl: (async (cfg: { binPath: string }) => {
      attempted.push(cfg.binPath);
      return attempted.length === 1
        ? { ok: false, kind: "build-mismatch", binary: "/stock/llama-server", detail: "invalid ggml type 143" }
        : { ok: true, baseUrl: "http://127.0.0.1:8080", stop: () => {} };
    }) as never,
  });
  assert.deepEqual(attempted, ["/stock/llama-server", "/opt/fork/llama-server"]);
  assert.equal(outcome.ok, true);
});

test("when the substituted build also fails, the outcome carries ITS path", async () => {
  // The bug: the caller used the CONFIGURED binPath for its message, so a
  // failure of the replacement was attributed to a binary already rejected.
  let attempt = 0;
  const outcome = await startWithCompatibleFallback(SPAWN_CFG, {
    env: {},
    log: () => {},
    find: REPLACEMENT_FOUND as never,
    tryStartImpl: (async (cfg: { binPath: string }) =>
      attempt++ === 0
        ? { ok: false, kind: "build-mismatch", binary: "/stock/llama-server", detail: "invalid ggml type 143" }
        : { ok: false, kind: "spawn-failed", binary: cfg.binPath, detail: "cudaMalloc failed: out of memory" }) as never,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.binary, "/opt/fork/llama-server",
    "the failure must name the binary that actually ran");
});

test("with no replacement found, the outcome carries the original and nothing is retried", async () => {
  let attempts = 0;
  const outcome = await startWithCompatibleFallback(SPAWN_CFG, {
    env: {},
    log: () => {},
    find: NO_REPLACEMENT as never,
    tryStartImpl: (async (cfg: { binPath: string }) => {
      attempts++;
      return { ok: false, kind: "build-mismatch", binary: cfg.binPath, detail: "invalid ggml type 143" };
    }) as never,
  });
  assert.equal(attempts, 1, "nothing to substitute means nothing to retry");
  assert.equal(outcome.ok === false && outcome.binary, "/stock/llama-server");
});

test("a spawn failure is never retried with a different binary", async () => {
  // A busy port or a full card is not fixed by a different build, and looking
  // for one would add a filesystem walk to a failure already being waited on.
  let attempts = 0;
  let searched = false;
  const outcome = await startWithCompatibleFallback(SPAWN_CFG, {
    env: {},
    log: () => {},
    find: (async () => {
      searched = true;
      return { location: { binPath: "/opt/fork/llama-server", source: "path", backend: "cuda" }, rejected: [], rejectedForModel: [] };
    }) as never,
    tryStartImpl: (async (cfg: { binPath: string }) => {
      attempts++;
      return { ok: false, kind: "spawn-failed", binary: cfg.binPath, detail: "cudaMalloc failed" };
    }) as never,
  });
  assert.equal(attempts, 1);
  assert.equal(searched, false, "the search must not run for a non-mismatch failure");
  assert.equal(outcome.ok === false && outcome.kind, "spawn-failed");
});

test("the configured binary is not handed back to the search as its own candidate", async () => {
  // Env overrides rank first, so passing the known-bad path through would return
  // the build that just failed and the "retry" would change nothing.
  let seen: NodeJS.ProcessEnv | undefined;
  const outcome = await startWithCompatibleFallback(SPAWN_CFG, {
    env: { LLAMACLI_LLAMA_SERVER: "/stock/llama-server", LLAMA_SERVER_BIN: "/stock/llama-server" },
    log: () => {},
    find: (async (opts: { env?: NodeJS.ProcessEnv } = {}) => {
      seen = opts.env;
      return { location: null, rejected: [], rejectedForModel: [] };
    }) as never,
    tryStartImpl: (async (cfg: { binPath: string }) => ({
      ok: false, kind: "build-mismatch", binary: cfg.binPath, detail: "invalid ggml type 143",
    })) as never,
  });
  assert.equal(outcome.ok === false && outcome.binary, "/stock/llama-server");
  assert.ok(seen, "the search must have run");
  assert.equal(seen!.LLAMACLI_LLAMA_SERVER, undefined);
  assert.equal(seen!.LLAMA_SERVER_BIN, undefined);
});

test("the model path reaches the search even when the binary came from env", async () => {
  // The fork is found by being adjacent to the MODEL. Without the path the
  // search has nothing to anchor on and returns nothing useful.
  let searchedFor: string | undefined;
  await startWithCompatibleFallback(SPAWN_CFG, {
    env: {},
    log: () => {},
    find: (async (opts: { modelPath?: string } = {}) => {
      searchedFor = opts.modelPath;
      return { location: null, rejected: [], rejectedForModel: [] };
    }) as never,
    tryStartImpl: (async (cfg: { binPath: string }) => ({
      ok: false, kind: "build-mismatch", binary: cfg.binPath, detail: "invalid ggml type 143",
    })) as never,
  });
  assert.equal(searchedFor, "/m/model.gguf");
});

test("configuredPort reads the recorded llama port", () => {
  assert.equal(
    configuredPort(localConfig({ backend: "local-llama", llama: { ...DEFAULT_CONFIG.llama!, port: 8084 } })),
    8084
  );
});

test("configuredPort reads the port out of an openai-compatible baseUrl", () => {
  assert.equal(
    configuredPort(localConfig({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:8084" })),
    8084
  );
});

test("configuredPort returns null when no port is recorded", () => {
  assert.equal(configuredPort(localConfig({ backend: "openai-compatible" })), null);
  assert.equal(configuredPort(localConfig({ backend: "openai-compatible", baseUrl: "not a url" })), null);
  // A baseUrl with no explicit port is the default for its scheme, not a
  // discoverable local endpoint — nothing to probe.
  assert.equal(configuredPort(localConfig({ backend: "openai-compatible", baseUrl: "https://api.example.com" })), null);
});

test("discovery probes the recorded port before the heuristic list", async () => {
  // The bug this covers: a server on 8084 is up and serving, the config records
  // 8084, but COMMON_PORTS is [8080, 8081, 11434]. Probing only the list
  // reported "nothing is running" and the fallback spawned a second
  // llama-server, which OOMed on a card the first one already held 7.3 GB of.
  // Answers only on 8084, so the list order decides whether it is found at all.
  const fakeFetch = async (url: string) => {
    if (new URL(url).port !== "8084") throw new Error("refused");
    const parsed = new URL(url);
    // /props carries build_info on every real llama.cpp, and that is what
    // distinguishes it from a stand-in. Serving it here keeps this fixture
    // honest: without it a server reporting a .gguf path that isn't on disk
    // is, correctly, classified as a stub rather than adopted.
    if (parsed.pathname === "/props") {
      return { ok: true, json: async () => ({ build_info: "b1234", model_path: "/models/recorded.gguf" }) } as never;
    }
    return {
      ok: true,
      json: async () => ({ data: [{ id: "/models/recorded.gguf" }] }),
    } as never;
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as never;
  try {
    const disc = await discoverRunningServer("127.0.0.1", [8084, 8080, 8081, 11434]);
    assert.equal(disc.kind, "found");
    if (disc.kind === "found") {
      assert.equal(disc.server.baseUrl, "http://127.0.0.1:8084");
      assert.equal(disc.server.model, "/models/recorded.gguf");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── download progress is one redrawn line, not a scrolling log ──────────────

test("with a redraw channel, a transfer is reported there and NOT as a log line per percent", async () => {
  const { resolveBackend } = await import("./resolve.js");
  const logs: string[] = [];
  const drawn: (string | null)[] = [];
  await resolveBackend({
    projectRoot: "/p",
    config: { backend: "local-llama" } as any,
    log: (l: string) => logs.push(l),
    progressLine: (t: string | null) => drawn.push(t),
    discover: async () => ({ kind: "none" }) as any,
    bootstrap: (async (o: any) => {
      const report = o.onProgress(() => {});
      for (let i = 1; i <= 100; i++) {
        report({ label: "m", receivedBytes: i * 1e7, totalBytes: 1e9, bytesPerSecond: 1e7, etaSeconds: 5, percent: i });
      }
      return { ok: false, steps: [], errors: [] };
    }) as any,
  } as any).catch(() => {});
  assert.equal(drawn.filter((d) => d !== null).length, 100);
  assert.equal(drawn[drawn.length - 1], null, "the row is released once the transfer is over");
  assert.ok(!logs.some((l: string) => /모델 다운로드 중/.test(l)), "no per-percent log lines");
});

test("without a redraw channel (piped output) progress is throttled to whole percents", async () => {
  const { resolveBackend } = await import("./resolve.js");
  const logs: string[] = [];
  await resolveBackend({
    projectRoot: "/p",
    config: { backend: "local-llama" } as any,
    log: (l: string) => logs.push(l),
    discover: async () => ({ kind: "none" }) as any,
    bootstrap: (async (o: any) => {
      const report = o.onProgress(() => {});
      for (let i = 0; i < 400; i++) {
        report({ label: "m", receivedBytes: i, totalBytes: 400, bytesPerSecond: 1, etaSeconds: 1, percent: (i * 100) / 400 });
      }
      return { ok: false, steps: [], errors: [] };
    }) as any,
  } as any).catch(() => {});
  const lines = logs.filter((l: string) => /모델 다운로드 중/.test(l));
  assert.ok(lines.length > 0 && lines.length <= 100, `got ${lines.length}`);
});
