import { test } from "node:test";
import assert from "node:assert/strict";
import { reportServer } from "./serverReport.js";
import { findRung } from "./modelMetrics.js";

/**
 * `/server` exists because "what is running right now, on which port, with
 * which build" had no route other than reading config.yaml by hand. These tests
 * pin the part that matters: it must never report something it did not verify,
 * and a restart must never quietly become a model switch.
 */

const bonsai = findRung("bonsai-27b")!;
const MODEL = "/media/jeano/nvme-usb/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf";

const cfg = (llama: Record<string, any> = {}) => ({ llama }) as Record<string, any>;

function deps(over: Partial<Parameters<typeof reportServer>[0]> = {}) {
  return {
    projectRoot: "/p",
    findServer: async () => ({ location: null, rejected: [], rejectedForModel: [] }) as any,
    // Machine-independent by default: without this the report scans the REAL listeners,
    // and on a box with a llama-server up the expected ports are the machine's, not the test's.
    detectRunningPort: async () => null,
    ...over,
  } as Parameters<typeof reportServer>[0];
}

test("reports the configured port, model and who holds it", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: MODEL, binPath: "/opt/llama-server" }),
      detectOwner: async () => ({ kind: "ours", pid: 42 }),
    })
  );
  assert.equal(r.configuredPort, 8084);
  assert.match(r.summary, /8084/);
  assert.match(r.summary, /Ternary-Bonsai-2-27B/, "the model must be named, not just its path");
  assert.match(r.summary, /실행 중/, "and the owner must be stated");
});

test("a port that cannot be inspected is reported as unknown, not free", async () => {
  // The bug class this project keeps hitting: a failed lookup read as an empty
  // result. "확인 불가" and "비어 있음" lead to opposite actions.
  const r = await reportServer(
    deps({ config: cfg({ port: 8084, modelPath: MODEL }), detectOwner: async () => ({ kind: "unknown", reason: "ss 없음" }) })
  );
  assert.match(r.summary, /확인 불가/);
  assert.doesNotMatch(r.summary, /비어 있음/);
  assert.match(r.restartPlan, /확인할 수 없|재시작하지 않/, "and the plan must refuse");
});

test("a systemd unit is reported as such, with the consequence", async () => {
  // "Restart the unit" does NOT load a new model — the unit names its own — so
  // the plan has to say that rather than implying a restart would help.
  const r = await reportServer(
    deps({
      config: cfg({ port: 8080, modelPath: MODEL }),
      detectOwner: async () => ({ kind: "systemd", unit: "llama-server.service" }),
    })
  );
  assert.match(r.summary, /llama-server\.service/);
  assert.match(r.restartPlan, /유닛/);
  assert.match(r.restartPlan, /재시작만으로|적용되지 않/, "must say a plain restart would not apply a new model");
});

test("a build that cannot read the quant is surfaced, not glossed", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: MODEL }),
      detectOwner: async () => ({ kind: "ours", pid: 1 }),
      findServer: async () => ({
        location: null,
        rejected: [],
        rejectedForModel: ["/home/u/llama.cpp/build-opt/bin/llama-server"],
      }) as any,
    })
  );
  assert.ok(r.build, "discovery ran, so a build section is expected");
  assert.equal(r.build!.canReadModel, false);
  assert.match(r.restartPlan, /읽지 못/, "and the plan must refuse to restart onto it");
  void bonsai;
});

test("a compatible build is reported as usable", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: MODEL }),
      detectOwner: async () => ({ kind: "ours", pid: 1 }),
      findServer: async () => ({ location: { binPath: "/opt/bonsai2-runtime/llama-server", source: "model-adjacent", backend: "cuda" }, rejected: [] }) as any,
    })
  );
  assert.equal(r.build!.canReadModel, true);
  assert.match(r.restartPlan, /같은 포트\(8084\)/, "the plan must name the port it will reuse");
});

test("no configured model means the plan says to pick one", async () => {
  const r = await reportServer(deps({ config: cfg({ port: 8080 }), detectOwner: async () => ({ kind: "none" }) }));
  assert.equal(r.configuredModel, undefined);
  assert.match(r.restartPlan, /\/models/, "must point at the command that fixes it");
});

test("a discovery failure does not fail the report", async () => {
  // The port and its owner are the part the user cannot get any other way, so a
  // thrown discovery must not cost them the answer.
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: MODEL }),
      detectOwner: async () => ({ kind: "ours", pid: 7 }),
      findServer: async () => {
        throw new Error("probe blew up");
      },
    })
  );
  assert.match(r.summary, /8084/);
  assert.match(r.summary, /실행 중/);
  assert.equal(r.build, undefined);
});

test("an unrecorded port falls back to 8080 and says so", async () => {
  // Reported rather than invented: the config has no port, so 8080 is a
  // convention. The detector is stubbed to null because without it this reaches
  // the REAL running server on this machine and asserts nothing about the
  // fallback — the same vacuous-pass mistake this file already caught once.
  const r = await reportServer(
    deps({ config: cfg({ modelPath: MODEL }), detectRunningPort: async () => null, detectOwner: async () => ({ kind: "none" }) })
  );
  assert.equal(r.configuredPort, undefined);
  assert.match(r.summary, /포트 8080/);
});

test("the restart plan never proposes a DIFFERENT port", async () => {
  // The invariant the whole switch module exists for. Asserted on the report
  // because a user reads the plan and trusts it.
  for (const port of [8080, 8084, 9090]) {
    const r = await reportServer(
      deps({ config: cfg({ port, modelPath: MODEL }), detectOwner: async () => ({ kind: "ours", pid: 1 }) })
    );
    assert.ok(r.restartPlan.includes(String(port)), `plan must name port ${port}: ${r.restartPlan}`);
    assert.doesNotMatch(r.restartPlan, /(\d{4,5})로 옮|새 포트/, "must never propose moving the port");
  }
});

test("an unrecorded port is taken from the RUNNING server, not defaulted to 8080", async () => {
  // The live bug: this config has no `llama` block at all, so the first version
  // reported "포트 8080 · 서버 없음" on a machine with a live server on 8084.
  // A user who believed it would conclude their server had died. Asserted
  // because the summary and the inspected port must be the SAME number.
  const r = await reportServer(
    deps({
      config: cfg({ modelPath: MODEL }),
      detectRunningPort: async () => 8084,
      detectOwner: async (p) => (p === 8084 ? { kind: "ours", pid: 128976 } : { kind: "none" }) as any,
    })
  );
  assert.equal(r.port, 8084, "the inspected port must be the running server's");
  assert.match(r.summary, /8084/, "and the summary must not name a different one");
  assert.doesNotMatch(r.summary, /포트 8080/, "or claim the default while inspecting another port");
});

test("a discovered port is marked, so it reads as a different kind of claim", async () => {
  // "8084 (실행 중인 서버에서 확인)" is visibly not the same assertion as a
  // recorded "8084", and the difference matters when the two disagree.
  const discovered = await reportServer(
    deps({ config: cfg({ modelPath: MODEL }), detectRunningPort: async () => 8084, detectOwner: async () => ({ kind: "none" }) })
  );
  assert.equal(discovered.portDiscovered, true);
  assert.match(discovered.summary, /실행 중인 서버에서 확인/);

  const recorded = await reportServer(
    deps({ config: cfg({ port: 8084, modelPath: MODEL }), detectRunningPort: async () => 9999, detectOwner: async () => ({ kind: "none" }) })
  );
  assert.equal(recorded.portDiscovered, true);
  // The recorded port is no longer trusted blindly. With nothing on 8084 and a server on
  // 9999, the record is STALE (this was the live failure: config said 8080, the server
  // was on 8084) and what is actually listening wins. A recorded port that HAS a server
  // on it is kept — see the next test.
  assert.equal(recorded.port, 9999, "a stale recorded port yields to the server that is really running");
  assert.deepEqual(recorded.stalePort, { recorded: 8084, actual: 9999 });
  assert.match(recorded.summary, /config 에는 8084/);
});

test("8080 is used only when nothing is running and nothing is recorded", async () => {
  const r = await reportServer(
    deps({ config: cfg({ modelPath: MODEL }), detectRunningPort: async () => null, detectOwner: async () => ({ kind: "none" }) })
  );
  assert.equal(r.port, 8080);
});

test("a recorded port that has a llama-server on it is kept even if another one is also listening", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: MODEL }),
      resolvePort: async (rec) => (await import("./modelSwitch.js")).resolveLiveServerPort(rec, {
        servers: [{ pid: 1, port: 9999, cmdline: "llama-server" }, { pid: 2, port: 8084, cmdline: "llama-server" }],
      }),
      detectOwner: async () => ({ kind: "ours", pid: 2 }),
    })
  );
  assert.equal(r.port, 8084);
  assert.equal(r.stalePort, undefined);
});

test("the stale-config case from the field: config says 8080, the server is on 8084", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8080, modelPath: MODEL }),
      detectRunningPort: async () => 8084,
      detectOwner: async (p) => (p === 8084 ? { kind: "ours", pid: 128976 } : { kind: "none" }) as any,
    })
  );
  assert.equal(r.port, 8084);
  assert.match(r.summary, /8084.*config 에는 8080/);
  assert.match(r.summary, /실행 중 \(pid 128976/);
  assert.match(r.restartPlan, /8084/, "a restart must act on the port the server is really on");
});

// ── a server the user started by hand ───────────────────────────────────────

import { parseLlamaServerArgs } from "./modelSwitch.js";

const HAND = "./llama-server -m /media/jeano/nvme-usb/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf --host 127.0.0.1 --port 8084 -ngl 999 -c 40960 -np 2 --cache-type-k q8_0 --cache-type-v q8_0 -fa on -t 6 -tb 11 -b 2048 -ub 256 --n-cpu-moe 32";

test("parseLlamaServerArgs reads the model, port and tuning back from a command line", () => {
  const a = parseLlamaServerArgs(HAND);
  assert.equal(a.modelPath, "/media/jeano/nvme-usb/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf");
  assert.equal(a.port, 8084);
  assert.equal(a.gpuLayers, 999);
  assert.equal(a.contextSize, 20480, "-c is the TOTAL across slots; the per-slot value is c / np");
  assert.equal(a.parallel, 2);
  assert.equal(a.threads, 6);
  assert.equal(a.threadsBatch, 11);
  assert.equal(a.cpuMoeLayers, 32);
  assert.equal(a.flashAttn, true);
  assert.equal(a.cacheTypeK, "q8_0");
});

test("parseLlamaServerArgs: absent flags are undefined, not invented defaults", () => {
  const a = parseLlamaServerArgs("llama-server -m /m.gguf");
  assert.equal(a.gpuLayers, undefined);
  assert.equal(a.contextSize, undefined);
  assert.equal(a.flashAttn, undefined);
  assert.equal(parseLlamaServerArgs("llama-server -fa off -m /m").flashAttn, false);
});

test("a hand-started server with NO llama block is still reported with its model and build", async () => {
  // This is the field state: the adopted config records only a URL, so the report used to
  // say "config 에 모델이 없습니다" about a server that was plainly running one.
  const r = await reportServer(
    deps({
      config: { backend: "openai-compatible", baseUrl: "http://127.0.0.1:8084" },
      resolvePort: async (rec) => (await import("./modelSwitch.js")).resolveLiveServerPort(rec, {
        servers: [{ pid: 128976, port: 8084, cmdline: HAND, exe: "/media/jeano/nvme-usb/bonsai2-runtime/llama-server" }],
      }),
      detectOwner: async () => ({ kind: "ours", pid: 128976 }),
    })
  );
  assert.equal(r.fromRunningServer, true);
  assert.equal(r.configuredModel, "/media/jeano/nvme-usb/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf");
  assert.equal(r.configuredBin, "/media/jeano/nvme-usb/bonsai2-runtime/llama-server");
  assert.doesNotMatch(r.restartPlan, /모델이 없습니다/);
  assert.match(r.restartPlan, /8084/);
  assert.equal(r.serverArgs?.gpuLayers, 999);
});

test("a config that DOES record the model is never overridden by the running server's arguments", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: "/m/from-config.gguf", binPath: "/opt/llama-server" }),
      resolvePort: async (rec) => (await import("./modelSwitch.js")).resolveLiveServerPort(rec, {
        servers: [{ pid: 1, port: 8084, cmdline: HAND, exe: "/other/llama-server" }],
      }),
      detectOwner: async () => ({ kind: "ours", pid: 1 }),
    })
  );
  assert.equal(r.configuredModel, "/m/from-config.gguf");
  assert.equal(r.configuredBin, "/opt/llama-server");
  assert.equal(r.fromRunningServer, false);
});

test("the config names one model but the running server loaded another: both are shown and the restart says it will change", async () => {
  // Field state: a /models selection (8B) was recorded in config.yaml but the server on
  // 8084 was never switched and still serves the 27B. Reporting only the config's model
  // said the opposite of what is answering.
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: "/home/jeano/models/Ternary-Bonsai-8B-PTQ1_0.gguf" }),
      resolvePort: async (rec) => (await import("./modelSwitch.js")).resolveLiveServerPort(rec, {
        servers: [{ pid: 128976, port: 8084, cmdline: HAND }],
      }),
      detectOwner: async () => ({ kind: "ours", pid: 128976 }),
    })
  );
  assert.deepEqual(r.modelMismatch, {
    serving: "/media/jeano/nvme-usb/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf",
    configured: "/home/jeano/models/Ternary-Bonsai-8B-PTQ1_0.gguf",
  });
  assert.match(r.summary, /실행 중인 서버의 모델 Ternary-Bonsai-2-27B/);
  assert.match(r.summary, /config 의 모델 Ternary-Bonsai-8B.*서버와 다름/);
  assert.match(r.restartPlan, /Ternary-Bonsai-2-27B-PTQ1_0\.gguf → Ternary-Bonsai-8B-PTQ1_0\.gguf 로 바뀝니다/);
});

test("same model, no mismatch noise", async () => {
  const r = await reportServer(
    deps({
      config: cfg({ port: 8084, modelPath: "/elsewhere/Ternary-Bonsai-2-27B-PTQ1_0.gguf" }),
      resolvePort: async (rec) => (await import("./modelSwitch.js")).resolveLiveServerPort(rec, { servers: [{ pid: 1, port: 8084, cmdline: HAND }] }),
      detectOwner: async () => ({ kind: "ours", pid: 1 }),
    })
  );
  assert.equal(r.modelMismatch, undefined);
  assert.doesNotMatch(r.summary, /서버와 다름/);
});
