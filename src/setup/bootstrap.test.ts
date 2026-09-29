import { test } from "node:test";
import assert from "node:assert/strict";
import { planPorts, COMMON_PORTS, LLAMA_PORT, type PortState } from "./ports.js";
import { findLlamaServer, installBuildPackages } from "./llamaCpp.js";
import { tuneForHardware, budgetVramGiB } from "./tuning.js";
import { pickPrimaryGpu, parseNvidiaSmiCsv, type Hardware } from "./hardware.js";

const GiB = 1024 ** 3;

/** A probe over a fixed set of busy ports. */
const probeFor = (busy: number[]): ((p: number) => Promise<PortState>) =>
  async (p) => (busy.includes(p) ? "in-use" : "free");

// ── Ports ───────────────────────────────────────────────────────────────────

test("a clean machine gets the canonical ports and nothing is reported as moved", async () => {
  const plan = await planPorts({ probe: probeFor([]) });
  assert.equal(plan.llamaPort, LLAMA_PORT);
  assert.equal(plan.llamaPort, LLAMA_PORT);
  assert.deepEqual(plan.moved, []);
});

test("an occupied llama port is moved, and the move is reported rather than absorbed silently", async () => {
  const plan = await planPorts({ probe: probeFor([LLAMA_PORT]) });
  assert.notEqual(plan.llamaPort, LLAMA_PORT, "must not stay on a busy port");
  assert.ok(plan.moved.some((m) => m.what === "llama"), "the move is reported");
  // There is only one port now, so the surviving contract is that a recorded
  // move actually says where it went and why — not merely that it happened.
  const move = plan.moved.find((m) => m.what === "llama")!;
  assert.equal(move.from, LLAMA_PORT, "the move records where it came from");
  assert.equal(move.to, plan.llamaPort, "and where it went");
  assert.notEqual(move.to, move.from, "a move that does not move is not a move");
  assert.ok(move.because.length > 0, "and it says why");
});

test("a port the firewall silently drops is treated as usable, not as a failure", async () => {
  // 'unknown' means a DROP, not a REJECT. Refusing to start on that evidence
  // would make llamacli unusable on a locked-down network for no reason.
  const plan = await planPorts({ probe: async () => "unknown" });
  assert.equal(plan.llamaPort, LLAMA_PORT);
  assert.ok(plan.notes.some((n) => /방화벽/.test(n)));
});

test("an already-recorded port is kept when it is free, so an install does not migrate every launch", async () => {
  const plan = await planPorts({ probe: probeFor([]), llamaPort: 18080 });
  assert.equal(plan.llamaPort, 18080, "an established install keeps the port it recorded");
  assert.deepEqual(plan.moved, [], "and nothing is reported as moved");
});

test("the probe list leads with our own port so a running llamacli is the obvious match", () => {
  assert.equal(COMMON_PORTS[0], LLAMA_PORT);
});

// ── llama.cpp discovery ─────────────────────────────────────────────────────

const noExists = async () => false;
const only = (...paths: string[]) => {
  const set = new Set(paths);
  return async (p: string) => set.has(p);
};

test("an explicit LLAMACLI_LLAMA_SERVER wins over everything else", async () => {
  const found = await findLlamaServer({
    env: { LLAMACLI_LLAMA_SERVER: "/opt/mine/llama-server", PATH: "/usr/bin" },
    exists: only("/opt/mine/llama-server", "/usr/bin/llama-server"),
  });
  assert.equal(found?.binPath, "/opt/mine/llama-server");
  assert.equal(found?.source, "env");
});

test("PATH is searched before any build tree, so an installed build wins", async () => {
  const found = await findLlamaServer({
    env: { PATH: "/usr/bin:/bin" },
    exists: only("/usr/bin/llama-server", "/home/u/llama.cpp/build/bin/llama-server"),
    home: "/home/u",
  });
  assert.equal(found?.source, "path");
});

test("a CUDA-flavoured build directory is preferred over a plain build beside it", async () => {
  // Finding a CPU-only build first and silently using it is the expensive
  // mistake: a 35B MoE on CPU instead of the GPU.
  const found = await findLlamaServer({
    env: { PATH: "" },
    exists: only("/home/u/llama.cpp/build/bin/llama-server", "/home/u/llama.cpp/build-opt/bin/llama-server"),
    home: "/home/u",
  });
  assert.equal(found?.binPath, "/home/u/llama.cpp/build-opt/bin/llama-server");
  assert.equal(found?.source, "existing-build");
  assert.equal(found?.backend, "cuda");
});

test("nothing found means build, not a crash", async () => {
  assert.equal(await findLlamaServer({ env: { PATH: "" }, exists: noExists, home: "/home/u" }), null);
});

test("build dependencies try passwordless sudo first so the common case never prompts", async () => {
  // A hanging sudo prompt in a first-run bootstrap is the worst outcome: the
  // user cannot see it, the app looks frozen, and nothing explains why.
  const calls: string[][] = [];
  const res = await installBuildPackages({
    cuda: true,
    run: async (file, args) => { calls.push([file, ...args]); return ""; },
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, "no prompt needed");
  assert.deepEqual(calls[0].slice(0, 4), ["sudo", "-n", "apt-get", "install"]);
  assert.ok(calls[0].includes("build-essential"));
  assert.ok(calls[0].some((a) => /cuda/i.test(a)), "CUDA packages are added on a CUDA box");
});

test("a failing passwordless sudo falls back to the interactive one", async () => {
  const calls: string[][] = [];
  const res = await installBuildPackages({
    cuda: false,
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes("-n")) throw new Error("sudo: a password is required");
      return "";
    },
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].includes("-n"), "the retry is allowed to prompt");
});

// ── Hardware → tuning, the two halves together ──────────────────────────────

const gpuCsv = "0, NVIDIA GeForce RTX 2070 SUPER, 8192, 7456";
const gpus = parseNvidiaSmiCsv(gpuCsv);
assert.equal(gpus.length, 1, "module-level sanity");

test("nvidia-smi CSV is parsed into real bytes", () => {
  assert.equal(gpus[0].vramTotalBytes, 8192 * 1024 * 1024);
  assert.equal(gpus[0].vramFreeBytes, 7456 * 1024 * 1024);
  assert.match(gpus[0].name, /RTX 2070/);
});

test("a card with a comma in its name does not shift the memory columns", () => {
  const [g] = parseNvidiaSmiCsv('0, Intel, Arc, 16384, 16000');
  assert.equal(g.vramTotalBytes, 16384 * 1024 * 1024);
  assert.equal(g.name, "Intel, Arc");
});

test("'N/A' free memory does not read as zero free VRAM", () => {
  // Number("N/A") is NaN. Falling back to 0 would make an idle GPU look
  // completely full and drive the model choice to the small model.
  const [g] = parseNvidiaSmiCsv("0, Some GPU, 8192, [N/A]");
  assert.equal(Number.isFinite(g.vramFreeBytes), true);
});

test("with several GPUs the one with the most FREE memory wins, not the biggest", () => {
  // A 24 GB compute card and an 8 GB card in one chassis must not average into
  // "16 GB, fine"; the question is where the model fits right now.
  const hw = {
    cpuCount: 16, ramTotalBytes: 64 * GiB, ramAvailableBytes: 60 * GiB,
    gpus: [
      { index: 0, name: "big-busy", vramTotalBytes: 24 * GiB, vramFreeBytes: 0.5 * GiB },
      { index: 1, name: "small-free", vramTotalBytes: 8 * GiB, vramFreeBytes: 7.5 * GiB },
    ],
    gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
  } as Hardware;
  assert.equal(pickPrimaryGpu(hw)?.index, 1);
});

test("NVIDIA GPU is prioritised over CPU on a multi-core box", () => {
  // The explicit requirement: with several CPUs, the GPU comes first. The old
  // default was gpuLayers 0 (CPU only) on a 12-core machine with 8 GB of VRAM.
  const hw = {
    cpuCount: 12, ramTotalBytes: 30 * GiB, ramAvailableBytes: 26 * GiB,
    gpus, gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
  } as Hardware;
  const t = tuneForHardware(hw, { modelBytes: 21_864_081_056 });
  assert.equal(t.gpuLayers, 999, "offload everything to the GPU");
  assert.equal(t.gpu?.index, 0);
  assert.ok(t.rationale.some((r) => /NVIDIA GPU/.test(r)));
  // The MoE trick that makes an 8 GB card viable at all.
  assert.ok(t.cpuMoeLayers > 0, "experts are paged to RAM because the model does not fit");
  // Threads are halved rather than oversubscribed, matching the hand-tuned
  // working config on this very box (-t 6 of 12 cores).
  assert.equal(t.threads, 6);
  assert.equal(t.parallel, 1, "an agent is one conversation; more slots only waste KV");
});

test("a box with no GPU gets gpuLayers 0 and threads up to the core count", () => {
  const hw = {
    cpuCount: 8, ramTotalBytes: 16 * GiB, ramAvailableBytes: 12 * GiB,
    gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux",
  } as Hardware;
  const t = tuneForHardware(hw);
  assert.equal(t.gpuLayers, 0);
  assert.equal(t.threads, 7, "leaves one core for the OS when there is no GPU to share with");
  assert.ok(t.rationale.some((r) => /CPU 전용/.test(r)));
});

test("the VRAM budget holds back a reserve for the compositor and load-time allocations", () => {
  // Planning against the full 8 GB produced a model that OOMed two seconds into
  // loading — gnome-shell alone holds ~150 MiB on GPU 0 here.
  const hw = {
    cpuCount: 12, ramTotalBytes: 30 * GiB, ramAvailableBytes: 26 * GiB,
    gpus, gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
  } as Hardware;
  const budget = budgetVramGiB(hw, pickPrimaryGpu(hw));
  assert.ok(budget < 8, `budget ${budget} must be under the card's 8 GiB`);
  assert.ok(budget > 5, "but not so conservative that nothing fits");
});

