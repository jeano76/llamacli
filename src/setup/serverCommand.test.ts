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
