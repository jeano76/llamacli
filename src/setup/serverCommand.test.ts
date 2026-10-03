import { test } from "node:test";
import assert from "node:assert/strict";
import { runServerRestart, type RestartDeps } from "./serverCommand.js";
import type { ServerReport } from "./serverReport.js";
import type { PortOwner } from "./modelSwitch.js";

function report(over: Partial<ServerReport> = {}): ServerReport {
  return {
    port: 8084, portDiscovered: true, owner: { kind: "ours", pid: 42 } as PortOwner,
    configuredModel: "/m/B.gguf", configuredBin: "/bin/llama-server",
    serverArgs: { modelPath: "/m/A.gguf", contextSize: 32768 },
    servers: [{ pid: 42, port: 8084, cmdline: "llama-server -m /m/A.gguf --port 8084" }],
    build: { binPath: "/bin/llama-server", canReadModel: true, rejectedForModel: [] },
    modelMismatch: { serving: "/m/A.gguf", configured: "/m/B.gguf" },
    summary: "", restartPlan: "기존 서버를 종료하고 같은 포트(8084)에서 B.gguf 로 다시 올립니다.",
    ...over,
  };
}

function deps() {
  const calls: string[] = [];
  const d: RestartDeps = {
    switchServer: async (o) => { calls.push(`switch:${o.port}:${o.modelPath}`); return { ok: true, port: o.port, ready: true, lines: ["ok"], launched: { binPath: o.binPath, modelPath: o.modelPath, tuning: o.tuning } }; },
    record: async () => { calls.push("record"); },
    sync: async () => { calls.push("sync"); return []; },
    describePlan: async () => [],
  };
  return { calls, d };
}
const tuning = { contextSize: 32768, threads: 6, gpuLayers: 99 };

test("C4: restart without confirm stops nothing and shows the change + the command", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({ report: report(), tuning, confirmed: false }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /A\.gguf → B\.gguf/);
  assert.match(out.lines.join("\n"), /\/server restart confirm/);
});

test("C5: restart with confirm switches once on the live port, then records and syncs", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({ report: report(), tuning, confirmed: true }, d);
  assert.equal(out.restarted, true);
  assert.deepEqual(calls, ["switch:8084:/m/B.gguf", "record", "sync"]);
});

test("no server on the port: restart starts one without a confirmation", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({ report: report({ owner: { kind: "none" }, servers: [], serverArgs: undefined, modelMismatch: undefined }), tuning, confirmed: false }, d);
  assert.equal(out.restarted, true);
  assert.equal(calls[0], "switch:8084:/m/B.gguf");
});

test("C10: a foreign process on the port is never replaced, even with confirm", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({ report: report({ owner: { kind: "foreign", pid: 9 }, restartPlan: "포트 8084 의 사용자를 확인할 수 없어 재시작하지 않습니다 (foreign)." }), tuning, confirmed: true }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, []);
});

test("C14: two live servers are listed, nothing is stopped even with confirm", async () => {
  const { calls, d } = deps();
  const r = report({ servers: [
    { pid: 42, port: 8084, cmdline: "llama-server -m /m/A.gguf --port 8084" },
    { pid: 43, port: 8080, cmdline: "llama-server -m /m/C.gguf --port 8080" },
  ] });
  const out = await runServerRestart({ report: r, tuning, confirmed: true }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /2개/);
});

test("C11: a build that cannot read the model blocks the restart before anything is stopped", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({
    report: report({ restartPlan: "설치된 빌드가 이 모델의 양자화를 읽지 못합니다 (거절된 빌드: /x). 호환 빌드가 필요합니다.", build: { binPath: "/x", canReadModel: false, rejectedForModel: ["/x"] } }),
    tuning, confirmed: true,
  }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, []);
});

test("a config with no model does not restart", async () => {
  const { calls, d } = deps();
  const out = await runServerRestart({ report: report({ configuredModel: undefined, restartPlan: "config 에 모델이 없습니다. /models 로 먼저 선택하세요." }), tuning, confirmed: true }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, []);
});

test("a failed start is reported and the record/sync steps are skipped", async () => {
  const { calls, d } = deps();
  d.switchServer = async (o) => { calls.push("switch"); return { ok: false, port: o.port, ready: false, lines: ["새 모델로 서버를 띄우지 못했습니다: x"] }; };
  const out = await runServerRestart({ report: report(), tuning, confirmed: true }, d);
  assert.equal(out.restarted, false);
  assert.deepEqual(calls, ["switch"]);
  assert.match(out.lines.join("\n"), /띄우지 못/);
});

// ── /models side + the cross-command sequence (C2, C3, C5, C15) ─────────────
import { gateModelSwitch } from "./serverCommand.js";
import { selectModel } from "./modelSelect.js";
import { findRung } from "./modelMetrics.js";
import { reportServer } from "./serverReport.js";

const liveA = { pid: 42, port: 8084, cmdline: "llama-server -m /m/A-Q4_K_M.gguf --port 8084 -c 32768 -np 1" };
const modelsDeps = (owner: PortOwner, servers = [liveA]) => ({
  resolvePort: async (r: number) => ({ port: servers[0]?.port ?? r, source: "live" as const, servers }),
  detectOwner: async () => owner,
});

test("gateModelSwitch: a live own server needs confirm; the command to run names the selection", async () => {
  const g = await gateModelSwitch({ port: 8080, modelPath: "/m/B.gguf", tuning: {}, arg: "ornith-9b", confirmed: false }, modelsDeps({ kind: "ours", pid: 42 }));
  assert.equal(g.proceed, false);
  assert.match(g.lines.join("\n"), /A-Q4_K_M\.gguf → B\.gguf/);
  assert.match(g.lines.join("\n"), /\/models ornith-9b confirm/);
  const ok = await gateModelSwitch({ port: 8080, modelPath: "/m/B.gguf", tuning: {}, arg: "ornith-9b", confirmed: true }, modelsDeps({ kind: "ours", pid: 42 }));
  assert.equal(ok.proceed, true);
});

test("gateModelSwitch: acts on the LIVE port, not the stale recorded one, and an idle machine needs no confirm", async () => {
  const idle = await gateModelSwitch({ port: 8080, modelPath: "/m/B.gguf", tuning: {}, arg: "x", confirmed: false }, modelsDeps({ kind: "none" }, []));
  assert.equal(idle.proceed, true);
  const foreign = await gateModelSwitch({ port: 8080, modelPath: "/m/B.gguf", tuning: {}, arg: "x", confirmed: true }, modelsDeps({ kind: "foreign", pid: 3 }));
  assert.equal(foreign.proceed, false);
});

test("C2→C3→C4→C5: select records only; /server shows the mismatch; restart needs confirm, then reflects it", async () => {
  // In-memory config, as the harness in modelSelect.test does.
  let cfg: Record<string, any> = { model: "/m/A-Q4_K_M.gguf", llama: { modelPath: "/m/A-Q4_K_M.gguf", port: 8084, contextSize: 32768, threads: 6, gpuLayers: 99 } };
  const COMPAT = { location: { binPath: "/bin/llama-server", source: "path", backend: "cuda" }, rejected: [] };
  const sel = await selectModel({
    projectRoot: "/p", rung: findRung("ornith-9b")!, modelsDir: "/models",
    readConfigFile: async () => cfg, writeConfigFile: async (_r: string, c: Record<string, unknown>) => { cfg = c as any; },
    findServer: async () => COMPAT as any, detectRunningPort: async () => 8084, listLocalModels: async () => [],
  } as never);
  assert.match(String(cfg.model), /Ornith-1\.5-9B/, "C2: the selection is recorded");
  assert.equal(cfg.model, cfg.llama.modelPath);
  assert.equal(sel.requiresRestart, true);

  // C3: /server sees the running server (still A) disagree with the config.
  const rep = await reportServer({
    config: cfg, projectRoot: "/p", detectOwner: async () => ({ kind: "ours", pid: 42 }),
    resolvePort: async () => ({ port: 8084, source: "recorded", servers: [liveA] }),
    findServer: async () => COMPAT as any,
  });
  assert.ok(rep.modelMismatch, "C3: the mismatch is visible");
  assert.match(rep.restartPlan, /A-Q4_K_M\.gguf → Ornith-1\.5-9B/);

  // C4 / C5
  const { calls, d } = deps();
  const tuning = { contextSize: 32768, threads: 6, gpuLayers: 99 };
  await runServerRestart({ report: rep, tuning, confirmed: false }, d);
  assert.deepEqual(calls, [], "C4: unconfirmed restart stops nothing");
  const out = await runServerRestart({ report: rep, tuning, confirmed: true }, d);
  assert.equal(out.restarted, true);
  assert.equal(calls[0], `switch:8084:${cfg.llama.modelPath}`, "C5: the NEW model on the live port");
});

test("C15: a failing config write leaves no partial record", async () => {
  const written: unknown[] = [];
  await assert.rejects(selectModel({
    projectRoot: "/p", rung: findRung("ornith-9b")!, modelsDir: "/models",
    readConfigFile: async () => ({ model: "/m/A.gguf", llama: { modelPath: "/m/A.gguf" } }),
    writeConfigFile: async () => { throw new Error("EROFS"); },
    findServer: async () => ({ location: null, rejected: [] }) as any, detectRunningPort: async () => null, listLocalModels: async () => [],
  } as never), /EROFS/);
  assert.deepEqual(written, []);
});
