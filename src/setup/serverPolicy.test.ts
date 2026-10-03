import { test } from "node:test";
import assert from "node:assert/strict";
import { diffServer, gateServerReplacement } from "./serverPolicy.js";
import type { PortOwner, LiveLlamaServer } from "./modelSwitch.js";

const gate = (owner: PortOwner, o: { servers?: LiveLlamaServer[]; confirmed?: boolean; changes?: string[] } = {}) =>
  gateServerReplacement({ owner, port: 8084, servers: o.servers, changes: o.changes ?? [], confirmed: o.confirmed ?? false, confirmCommand: "/x confirm" });

test("nothing on the port: start without asking", () => {
  const g = gate({ kind: "none" });
  assert.equal(g.proceed, true);
  assert.equal((g as any).stopFirst, false);
});

test("our own server: without confirm nothing is stopped, the change and the command are shown", () => {
  const g = gate({ kind: "ours", pid: 7 }, { changes: ["모델: A → B"] });
  assert.equal(g.proceed, false);
  assert.equal((g as any).reason, "needs-confirm");
  assert.match(g.lines.join("\n"), /pid 7/);
  assert.match(g.lines.join("\n"), /A → B/);
  assert.match(g.lines.join("\n"), /\/x confirm/);
});

test("our own server: with confirm it is stopped first", () => {
  const g = gate({ kind: "ours", pid: 7 }, { confirmed: true });
  assert.deepEqual([g.proceed, (g as any).stopFirst], [true, true]);
});

test("a foreign / systemd / unknown owner is never replaced, even with confirm", () => {
  for (const owner of [{ kind: "foreign", pid: 5 }, { kind: "systemd", unit: "llama.service" }, { kind: "unknown", reason: "no ss" }] as PortOwner[]) {
    const g = gate(owner, { confirmed: true });
    assert.equal(g.proceed, false, owner.kind);
    assert.equal((g as any).reason, owner.kind);
  }
});

test("several live servers are listed and never resolved automatically, even with confirm", () => {
  const servers: LiveLlamaServer[] = [
    { pid: 1, port: 8080, cmdline: "llama-server -m /m/a.gguf --port 8080" },
    { pid: 2, port: 8084, cmdline: "llama-server -m /m/b.gguf --port 8084" },
  ];
  const g = gate({ kind: "ours", pid: 1 }, { servers, confirmed: true });
  assert.equal(g.proceed, false);
  assert.equal((g as any).reason, "multiple");
  assert.match(g.lines.join("\n"), /a\.gguf/);
  assert.match(g.lines.join("\n"), /b\.gguf/);
});

test("diffServer reports only real differences", () => {
  const d = diffServer(
    { modelPath: "/m/A.gguf", contextSize: 32768, cpuMoeLayers: 33 }, "/old/llama-server",
    { modelPath: "/n/B.gguf", binPath: "/new/llama-server", tuning: { contextSize: 32768, cpuMoeLayers: 30 } }
  );
  assert.deepEqual(d, ["모델: A.gguf → B.gguf", "빌드: /old/llama-server → /new/llama-server", "--n-cpu-moe: 33 → 30"]);
  assert.deepEqual(diffServer({ modelPath: "/a/A.gguf", contextSize: 1 }, undefined, { modelPath: "/b/A.gguf", tuning: { contextSize: 1 } }), []);
});
