import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRunningServerPorts, detectRunningServerPort } from "./modelSwitch.js";

// The reported failure: a Bonsai llama-server started by hand on 8084 held 7.3 GB of an
// 8 GB card; discovery only knew 8080/8081/11434, saw nothing, and spawned a second
// server that died with cudaMalloc out of memory.
const ss = [
  "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'LISTEN 0 4096 127.0.0.1:8084 0.0.0.0:* users:(("llama-server",pid=128976,fd=3))',
  'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=4242,fd=19))',
  'LISTEN 0 4096 127.0.0.1:9090 0.0.0.0:* users:(("llama-server",pid=777,fd=3))',
].join("\n");
const cmdlines: Record<number, string> = {
  128976: "./llama-server -m /m/Ternary-Bonsai-2-27B-PTQ1_0.gguf --port 8084",
  4242: "node server.js",
  777: "/opt/llama-server --port 9090",
};
const deps = { platform: "linux" as const, run: async () => ss, readCmdline: async (pid: number) => cmdlines[pid] ?? null, readExe: async () => null };

test("a hand-started llama-server on an unlisted port is found, and unrelated listeners are not", async () => {
  assert.deepEqual(await detectRunningServerPorts(deps), [8084, 9090]);
});


test("no ss / no listeners is an empty list, never a throw", async () => {
  assert.deepEqual(await detectRunningServerPorts({ ...deps, run: async () => { throw new Error("ENOENT ss"); } }), []);
  assert.deepEqual(await detectRunningServerPorts({ ...deps, run: async () => "State\n" }), []);
});
