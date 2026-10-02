import { test } from "node:test";
import assert from "node:assert/strict";
import { describeGpuPlan, summarizeGpuOffload, waitForGpuRelease, GPU_LOG_LINE } from "./gpuReport.js";
import { switchModelAndServer, listLlamaServers, resolveLiveServerPort } from "./modelSwitch.js";
import type { Hardware } from "./hardware.js";

const GiB = 1024 ** 3;
const hw = (gpus: Hardware["gpus"], backend: Hardware["gpuBackend"] = gpus.length ? "cuda" : "none"): Hardware => ({
  cpuCount: 8, ramTotalBytes: 30 * GiB, ramAvailableBytes: 20 * GiB, gpus, gpuBackend: backend, canBuildCuda: false, tools: {}, platform: "linux",
});
const rtx = [{ index: 0, name: "RTX 2070 SUPER", vramTotalBytes: 8 * GiB, vramFreeBytes: 7.2 * GiB }];

test("plan: names the GPU, its FREE memory, and that the reading was taken after the old server stopped", () => {
  const l = describeGpuPlan(hw(rtx), { gpuLayers: 999, contextSize: 16384, cpuMoeLayers: 0 });
  assert.match(l[0], /RTX 2070 SUPER.*8\.0 GiB 중 7\.2 GiB 사용 가능.*재측정/);
  assert.match(l[1], /GPU 오프로드: 전체 레이어.*16,384/);
});

test("plan: partial offload and MoE-on-CPU are spelled out", () => {
  assert.match(describeGpuPlan(hw(rtx), { gpuLayers: 20, contextSize: 8192, cpuMoeLayers: 12 })[1], /20개 레이어.*MoE expert 12개 층은 CPU/);
});

test("plan: no GPU means CPU, said plainly, including the has-a-backend-but-no-VRAM-figure case", () => {
  assert.match(describeGpuPlan(hw([]), { gpuLayers: 0, contextSize: 4096, cpuMoeLayers: 0 })[0], /CPU 전용.*가속기 미검출/);
  assert.match(describeGpuPlan(hw([], "vulkan"), { gpuLayers: 0, contextSize: 4096, cpuMoeLayers: 0 })[0], /vulkan 백엔드는 있으나/);
});

test("plan: a GPU present but -ngl 0 says the model will NOT use it", () => {
  assert.match(describeGpuPlan(hw(rtx), { gpuLayers: 0, contextSize: 4096, cpuMoeLayers: 0 })[1], /올리지 않습니다/);
});

test("result: read from the server's own log", () => {
  const log = "ggml_cuda_init: found 1 CUDA devices:\nllama_model_load_internal: using device CUDA0 (NVIDIA GeForce RTX 2070 SUPER) - 7123 MiB free\nload_tensors: offloaded 65/65 layers to GPU";
  assert.match(summarizeGpuOffload(log, { gpuLayers: 999 }), /GPU 적용: 예 — 65\/65.*CUDA0/);
});

test("result: 0 layers offloaded is reported as NOT applied even though -ngl 999 was asked", () => {
  assert.match(summarizeGpuOffload("load_tensors: offloaded 0/65 layers to GPU", { gpuLayers: 999 }), /아니오.*0\/65.*CPU/);
});

test("result: no offload line is 'could not confirm', never assumed", () => {
  assert.match(summarizeGpuOffload("", { gpuLayers: 999 }), /확인하지 못했습니다/);
  assert.match(summarizeGpuOffload("cudaMalloc failed: out of memory", { gpuLayers: 999 }), /메모리 부족/);
  assert.match(summarizeGpuOffload("", { gpuLayers: 0 }), /CPU 전용/);
});

test("the manager keeps exactly the accelerator lines", () => {
  assert.ok(GPU_LOG_LINE.test("load_tensors: offloaded 33/33 layers to GPU"));
  assert.ok(GPU_LOG_LINE.test("llama_model_load_internal: using device CUDA0 (x)"));
  assert.ok(!GPU_LOG_LINE.test("srv  load_model: loading model"));
});

test("waitForGpuRelease polls until the pid leaves the compute-process list", async () => {
  let calls = 0;
  const run = async () => (++calls < 3 ? "128976\n2027226\n" : "2027226\n");
  const r = await waitForGpuRelease(128976, run, { sleep: async () => {}, pollMs: 10 });
  assert.equal(r.released, true);
  assert.equal(calls, 3);
});

test("waitForGpuRelease gives up and says it was not confirmed; no nvidia-smi means nothing to wait for", async () => {
  const stuck = await waitForGpuRelease(1, async () => "1\n", { sleep: async () => {}, pollMs: 100, timeoutMs: 300 });
  assert.equal(stuck.released, false);
  const none = await waitForGpuRelease(1, async () => { throw new Error("ENOENT"); }, { sleep: async () => {} });
  assert.equal(none.released, true);
});

// ── the switch, end to end with seams ───────────────────────────────────────

test("switch: stops the old server, confirms its VRAM is back, RE-MEASURES, then starts — in that order", async () => {
  const order: string[] = [];
  const res = await switchModelAndServer({
    modelPath: "/m/new.gguf", port: 8084, binPath: "/bin/llama-server",
    tuning: { contextSize: 4096, threads: 4, gpuLayers: 0 },
    detectOwner: async () => ({ kind: "ours", pid: 128976 }),
    stopProcess: async (pid) => { order.push(`stop ${pid}`); },
    waitGpuRelease: async () => { order.push("vram-released"); return { released: true, waitedMs: 1000 }; },
    retune: async () => { order.push("retune"); return { tuning: { contextSize: 16384, threads: 6, gpuLayers: 999 }, lines: ["GPU: plan line"] }; },
    makeServer: (cfg) => ({
      async start() { order.push(`start ngl=${cfg.gpuLayers} ctx=${cfg.contextSize} port=${cfg.port}`); },
      stop() {}, logTail: () => "",
      gpuLog: () => "load_tensors: offloaded 65/65 layers to GPU",
    }),
  });
  assert.deepEqual(order, ["stop 128976", "vram-released", "retune", "start ngl=999 ctx=16384 port=8084"]);
  assert.equal(res.ok, true);
  assert.ok(res.lines.some((l) => /GPU 메모리를 반환/.test(l)));
  assert.ok(res.lines.some((l) => l === "GPU: plan line"));
  assert.ok(res.lines.some((l) => /GPU 적용: 예 — 65\/65/.test(l)), "and the RESULT is read back from the new server");
});

test("switch: VRAM not confirmed back is warned about, not hidden", async () => {
  const res = await switchModelAndServer({
    modelPath: "/m/new.gguf", port: 8084, binPath: "/b", tuning: { contextSize: 4096, threads: 4, gpuLayers: 0 },
    detectOwner: async () => ({ kind: "ours", pid: 1 }), stopProcess: async () => {},
    waitGpuRelease: async () => ({ released: false, waitedMs: 15000 }),
    makeServer: () => ({ async start() {}, stop() {}, logTail: () => "" }),
  });
  assert.ok(res.lines.some((l) => /반환이 아직 확인되지 않습니다/.test(l)));
});

test("switch: a failing retune falls back to the previous tuning and says so", async () => {
  let ngl = -1;
  const res = await switchModelAndServer({
    modelPath: "/m/new.gguf", port: 8084, binPath: "/b", tuning: { contextSize: 4096, threads: 4, gpuLayers: 33 },
    detectOwner: async () => ({ kind: "none" }),
    retune: async () => { throw new Error("nvidia-smi hung"); },
    makeServer: (cfg) => ({ async start() { ngl = cfg.gpuLayers ?? -1; }, stop() {}, logTail: () => "" }),
  });
  assert.equal(ngl, 33);
  assert.ok(res.lines.some((l) => /GPU 재측정에 실패.*nvidia-smi hung/.test(l)));
});

// ── finding the server that is really there ─────────────────────────────────

const ss = 'LISTEN 0 4096 127.0.0.1:8084 0.0.0.0:* users:(("llama-server",pid=128976,fd=3))';
const deps = { platform: "linux" as const, run: async () => ss, readCmdline: async () => "./llama-server -m /m/x.gguf --port 8084", readExe: async () => null };

test("listLlamaServers returns pid + port + cmdline", async () => {
  assert.deepEqual(await listLlamaServers(deps), [{ pid: 128976, port: 8084, cmdline: "./llama-server -m /m/x.gguf --port 8084" }]);
});

test("the live server beats a stale record; a record with a server on it wins; idle record is kept", async () => {
  const servers = await listLlamaServers(deps);
  assert.deepEqual((await resolveLiveServerPort(8080, { servers })).port, 8084);
  assert.equal((await resolveLiveServerPort(8080, { servers })).source, "live");
  assert.equal((await resolveLiveServerPort(8084, { servers })).source, "recorded");
  assert.deepEqual(await resolveLiveServerPort(9090, { servers: [] }), { port: 9090, source: "recorded-idle", servers: [] });
  assert.deepEqual(await resolveLiveServerPort(undefined, { servers: [] }), { port: 8080, source: "default", servers: [] });
});
