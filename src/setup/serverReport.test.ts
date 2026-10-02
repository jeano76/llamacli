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
  assert.equal(recorded.portDiscovered, false);
  assert.doesNotMatch(recorded.summary, /확인/);
  assert.equal(recorded.port, 8084, "a recorded port must NOT be overridden by a discovered one");
});

test("8080 is used only when nothing is running and nothing is recorded", async () => {
  const r = await reportServer(
    deps({ config: cfg({ modelPath: MODEL }), detectRunningPort: async () => null, detectOwner: async () => ({ kind: "none" }) })
  );
  assert.equal(r.port, 8080);
});
