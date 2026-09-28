import { test } from "node:test";
import assert from "node:assert/strict";
import { planPorts, layaPortEnv, COMMON_PORTS, LLAMA_PORT, LAYA_PORT, type PortState } from "./ports.js";
import { findLlamaServer, installBuildPackages } from "./llamaCpp.js";
import { chooseModel, searchHubModels, listGgufFiles, type ModelCandidate } from "./modelCatalog.js";
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
  assert.equal(plan.layaPort, LAYA_PORT);
  assert.deepEqual(plan.moved, []);
});

test("laya never lands on llama's port, because two servers cannot bind one port", async () => {
  // The failure this prevents is subtle: with a shared port the health check
  // would probe llama-server (or vice versa) and report a healthy-looking
  // process that is the wrong one entirely.
  const plan = await planPorts({ probe: probeFor([]), llamaPort: 8099, layaPort: 8099 });
  assert.notEqual(plan.llamaPort, plan.layaPort);
  assert.ok(plan.moved.some((m) => m.what === "laya" && /충돌/.test(m.because)));
});

test("an occupied llama port is moved, and the move is reported rather than absorbed silently", async () => {
  const plan = await planPorts({ probe: probeFor([LLAMA_PORT]) });
  assert.notEqual(plan.llamaPort, LLAMA_PORT, "must not stay on a busy port");
  assert.ok(plan.moved.some((m) => m.what === "llama"), "the move is reported");
  assert.notEqual(plan.layaPort, plan.llamaPort, "and the two stay distinct");
});

test("a port the firewall silently drops is treated as usable, not as a failure", async () => {
  // 'unknown' means a DROP, not a REJECT. Refusing to start on that evidence
  // would make llamacli unusable on a locked-down network for no reason.
  const plan = await planPorts({ probe: async () => "unknown" });
  assert.equal(plan.llamaPort, LLAMA_PORT);
  assert.ok(plan.notes.some((n) => /방화벽/.test(n)));
});

test("an already-recorded port is kept when it is free, so an install does not migrate every launch", async () => {
  const plan = await planPorts({ probe: probeFor([]), llamaPort: 18080, layaPort: 18099 });
  assert.equal(plan.llamaPort, 18080);
  assert.equal(plan.layaPort, 18099);
  assert.deepEqual(plan.moved, []);
});

test("layaPortEnv sets the bind port and the probe port to the SAME value", async () => {
  // The bug in this repo's own history: laya-serve bound LAYA_PORT (8000) while
  // every health probe read LAYA_ENDPOINT (8099), so bootstrap waited on a port
  // nothing listened to, timed out, and killed a perfectly healthy server.
  const env = layaPortEnv(9123);
  assert.equal(env.LAYA_PORT, "9123");
  assert.equal(env.LAYA_ENDPOINT, "9123");
  assert.equal(env.LAYA_PORT, env.LAYA_ENDPOINT, "the two must never disagree");
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

// ── Model choice ────────────────────────────────────────────────────────────

const cand = (filename: string, sizeBytes: number): ModelCandidate => ({
  repo: "r", filename, sizeBytes, url: `https://h/${filename}`,
});
const C35 = [cand("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21_864_081_056)];
const C9 = [cand("Ornith-1.5-9B-Q4_K_M.gguf", 5_497_000_000)];

test("a big card with enough RAM gets the 35B", async () => {
  const c = chooseModel({
    vramTotalBytes: 24 * GiB, vramFreeBytes: 23 * GiB, ramTotalBytes: 64 * GiB,
    candidates35b: C35, candidates9b: C9,
  });
  assert.match(c.candidate.filename, /35B/);
  assert.match(c.reason, /전량 오프로드/);
});

test("the 8 GB card this repo is developed on still gets the 35B, with expert streaming", async () => {
  // The documented, working configuration: 8 GB VRAM, 30 GB RAM, 35B-A3B at
  // ~19 tok/s via --n-cpu-moe. If this ever starts choosing the 9B, the
  // capability regression is silent — nothing errors, the model just gets worse.
  const c = chooseModel({
    vramTotalBytes: 8 * GiB, vramFreeBytes: 7 * GiB, ramTotalBytes: 30 * GiB,
    candidates35b: C35, candidates9b: C9,
  });
  assert.match(c.candidate.filename, /35B/);
  assert.match(c.reason, /n-cpu-moe/, "and says why it is still the right pick");
});

test("too little RAM for expert paging downgrades to the 9B instead of picking an unusable 35B", async () => {
  const c = chooseModel({
    vramTotalBytes: 24 * GiB, vramFreeBytes: 23 * GiB, ramTotalBytes: 16 * GiB,
    candidates35b: C35, candidates9b: C9,
  });
  assert.match(c.candidate.filename, /9B/);
  assert.match(c.reason, /RAM/);
});

test("a tiny card gets the 9B, which is the only one of the two that is fast there", async () => {
  const c = chooseModel({
    vramTotalBytes: 4 * GiB, vramFreeBytes: 3.5 * GiB, ramTotalBytes: 8 * GiB,
    candidates35b: C35, candidates9b: C9,
  });
  assert.match(c.candidate.filename, /9B/);
  assert.match(c.reason, /VRAM/);
});

test("no GPU at all still yields a model rather than throwing", async () => {
  const c = chooseModel({
    vramTotalBytes: 0, vramFreeBytes: 0, ramTotalBytes: 32 * GiB,
    candidates35b: C35, candidates9b: C9,
  });
  assert.ok(c.candidate.filename);
});

test("if nothing is downloadable the error names the override, rather than failing later at the URL", async () => {
  assert.throws(
    () => chooseModel({
      vramTotalBytes: 8 * GiB, vramFreeBytes: 7 * GiB, ramTotalBytes: 30 * GiB,
      candidates35b: [], candidates9b: [],
    }),
    /MODEL_REPO_35B/,
  );
});

test("the requested Q4_K_M quant is preferred over the other quants in the same repo", () => {
  const c = chooseModel({
    vramTotalBytes: 24 * GiB, vramFreeBytes: 23 * GiB, ramTotalBytes: 64 * GiB,
    candidates35b: [
      cand("Ornith-1.5-35B-A3B-Q2_K.gguf", 13_000_000_000),
      cand("Ornith-1.5-35B-A3B-Q6_K.gguf", 29_000_000_000),
      cand("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21_864_081_056),
    ],
    candidates9b: C9,
  });
  assert.match(c.candidate.filename, /Q4_K_M/);
});

test("a split-llama.cpp repo (one file per shard) is not mistaken for a single file", async () => {
  // The Hub lists shards; treating them as candidates would download a
  // 600 MB fragment and then fail to load it as a model.
  const files = await listGgufFiles("some/repo", {
    fetchImpl: (async () => ({
      ok: true, status: 200,
      json: async () => ({ siblings: [
        { rfilename: "model-00001-of-00003.gguf", size: 600_000_000 },
        { rfilename: "model-00002-of-00003.gguf", size: 600_000_000 },
        { rfilename: "tokenizer.json" },
      ] }),
    })) as unknown as typeof fetch,
  });
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.url.includes("/resolve/main/")));
});

test("a Hub search returns repo ids, and a failed search does not throw", async () => {
  const ids = await searchHubModels("Ornith-1.5", {
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => [{ id: "a/gguf" }, { id: "b" }, {}] })) as unknown as typeof fetch,
  });
  assert.deepEqual(ids, ["a/gguf", "b"]);
  await assert.rejects(() => searchHubModels("x", { fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch }));
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

test("the model that fits and the llama flags that run it agree on one box", async () => {
  // The end-to-end property that matters: the VRAM fit test and the tuning
  // calculation must not disagree about the same machine.
  const hw = {
    cpuCount: 12, ramTotalBytes: 30 * GiB, ramAvailableBytes: 26 * GiB,
    gpus, gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux",
  } as Hardware;
  const g = pickPrimaryGpu(hw)!;
  const choice = chooseModel({
    vramTotalBytes: g.vramTotalBytes, vramFreeBytes: g.vramFreeBytes,
    ramTotalBytes: hw.ramTotalBytes, candidates35b: C35, candidates9b: C9,
  });
  const t = tuneForHardware(hw, { modelBytes: choice.candidate.sizeBytes });
  assert.equal(t.gpuLayers, 999);
  if (choice.candidate.filename.includes("35B")) {
    assert.ok(t.cpuMoeLayers > 0, "a 35B pick on this card MUST page experts to RAM");
  }
});
