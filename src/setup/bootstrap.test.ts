import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPorts, COMMON_PORTS, LLAMA_PORT, type PortState } from "./ports.js";
import { findLlamaServer, installBuildPackages, candidatePaths } from "./llamaCpp.js";
import { checkBinaryAgainstChosenModel, ensureLocalStack } from "./bootstrap.js";
import { tuneForHardware, budgetVramGiB } from "./tuning.js";
import { pickPrimaryGpu, parseNvidiaSmiCsv, type Hardware } from "./hardware.js";
import { B, P, SRV, PATHS, posix } from "../testSupport.js";
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
  const { location } = await findLlamaServer({
    env: { LLAMACLI_LLAMA_SERVER: B("/opt/mine/llama-server"), PATH: "/usr/bin" },
    exists: only(B("/opt/mine/llama-server"), B("/usr/bin/llama-server")),
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/opt/mine/llama-server"));
  assert.equal(location?.source, "env");
});

test("the documented LLAMA_SERVER_BIN name is honoured too", async () => {
  // The header of llamaCpp.ts documented this variable while the code only
  // read LLAMACLI_LLAMA_SERVER, so a user who followed the documentation set
  // an environment variable nothing looked at and was told llama.cpp was not
  // installed. The doc/code mismatch was the bug.
  const { location } = await findLlamaServer({
    env: { LLAMA_SERVER_BIN: B("/opt/mine/llama-server"), PATH: "" },
    exists: only(B("/opt/mine/llama-server")),
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/opt/mine/llama-server"));
  assert.equal(location?.source, "env");
});

test("PATH is searched before any build tree, so an installed build wins", async () => {
  const { location } = await findLlamaServer({
    env: { PATH: PATHS("/usr/bin", "/bin") },
    exists: only(B("/usr/bin/llama-server"), B("/home/u/llama.cpp/build/bin/llama-server")),
    home: "/home/u",
    listDirs: async () => ["build"],
    probe: async () => true,
  });
  assert.equal(location?.source, "path");
});

test("a CUDA-flavoured build directory is preferred over a plain build beside it", async () => {
  // Finding a CPU-only build first and silently using it is the expensive
  // mistake: a 35B MoE on CPU instead of the GPU.
  const { location } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/llama.cpp/build/bin/llama-server"), B("/home/u/llama.cpp/build-opt/bin/llama-server")),
    home: "/home/u",
    listDirs: async () => ["build", "build-opt"],
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/home/u/llama.cpp/build-opt/bin/llama-server"));
  assert.equal(location?.source, "existing-build");
  assert.equal(location?.backend, "cuda");
});

test("nothing found means build, not a crash", async () => {
  const { location, rejected } = await findLlamaServer({
    env: { PATH: "" },
    exists: noExists,
    listDirs: async () => [],
    home: "/home/u",
  });
  assert.equal(location, null);
  assert.deepEqual(rejected, []);
});

test("build-cpu — the directory THIS module's builder creates — is found again", async () => {
  // The builder writes to `build-cpu` on a machine with no CUDA, and the
  // preference list did not contain that name. So a CPU-only machine that let
  // llamacli build its own server could not find it on the next launch, and
  // rebuilt it: 10 to 40 minutes of compilation, every single start.
  const { location } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/.llamacli/llama.cpp/build-cpu/bin/llama-server")),
    home: "/home/u",
    listDirs: async (dir) => (posix(dir).endsWith(".llamacli/llama.cpp") ? ["build-cpu"] : []),
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/home/u/.llamacli/llama.cpp/build-cpu/bin/llama-server"));
  assert.equal(location?.source, "llamacli-build");
});

test("a build directory nobody anticipated is still found", async () => {
  // People name build dirs after the CUDA version, the arch, or the date. A
  // hardcoded list made all of them invisible, which turned "you already have
  // a build" into a 10-40 minute rebuild.
  const { location } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/llama.cpp/build-cuda-12.4-rocm/bin/llama-server")),
    home: "/home/u",
    listDirs: async () => ["build-cuda-12.4-rocm", "build"],
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/home/u/llama.cpp/build-cuda-12.4-rocm/bin/llama-server"));
});

test("a `make`-built llama.cpp at the repo root is found", async () => {
  // `make` puts the binaries at the checkout root, which is what a first-time
  // user following llama.cpp's own README ends up with. Nothing looked there.
  const { location } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/llama.cpp/llama-server")),
    home: "/home/u",
    listDirs: async () => [],
    probe: async () => true,
  });
  assert.equal(location?.binPath, B("/home/u/llama.cpp/llama-server"));
});

test("a binary that exists but cannot run is skipped in favour of one that can", async () => {
  // Existence is not usability. A build against an unavailable CUDA version, or
  // one missing its libggml-cuda.so, is present and executable and still fails
  // to start — and accepting it meant the failure surfaced later as an opaque
  // spawn error instead of here, where the next candidate could be tried.
  //
  // The BROKEN one is the preferred directory on purpose: the search reaches it
  // first, has to reject it, and only then fall through.
  const { location, rejected } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/llama.cpp/build/bin/llama-server"), B("/home/u/llama.cpp/build-opt/bin/llama-server")),
    home: "/home/u",
    listDirs: async () => ["build", "build-opt"],
    probe: async (p) => !p.includes("build-opt"),
  });
  assert.equal(location?.binPath, B("/home/u/llama.cpp/build/bin/llama-server"));
  assert.deepEqual(rejected, [B("/home/u/llama.cpp/build-opt/bin/llama-server")]);
});

test("when every candidate is broken, the reason is reported instead of 'not installed'", async () => {
  const { location, rejected } = await findLlamaServer({
    env: { PATH: "" },
    exists: only(B("/home/u/llama.cpp/build/bin/llama-server")),
    home: "/home/u",
    listDirs: async () => ["build"],
    probe: async () => false,
  });
  assert.equal(location, null);
  assert.deepEqual(rejected, [B("/home/u/llama.cpp/build/bin/llama-server")]);
});

test("the three real build layouts are all covered", () => {
  const root = "/llama.cpp";
  const paths = candidatePaths(root, ["build"]);
  // cmake, the usual case
  assert.ok(paths.includes(B(`${root}/build/bin/llama-server`)));
  // MSVC multi-config generators put the configuration last
  assert.ok(paths.includes(B(`${root}/build/bin/Release/llama-server`)));
  // plain `make`, binaries at the checkout root
  assert.ok(paths.includes(B(`${root}/llama-server`)));
  // and nothing invents paths that exist nowhere
  assert.equal(paths.some((p) => posix(p).includes("/bin/bin/")), false);
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
  // An agent is one conversation, so 1 slot is what it NEEDS. The reason is no
  // longer "a slot multiplies the KV cache" — that is false for an explicit
  // -np (llama-context.cpp:294 divides n_ctx by n_seq_max). The real reason to
  // pass -np explicitly is that OMITTING it makes llama.cpp auto-resolve to 4
  // slots WITH kv_unified=true (server.cpp:156-160), and that is the case where
  // the KV pool really does grow. See tuning.ts's parallel-slots comment.
  assert.equal(t.parallel, 1);
  assert.ok(
    t.rationale.some((r) => /kv_unified/.test(r)),
    "the slot decision must explain the unified-KV trap, not repeat the disproven claim"
  );
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


test("with the model already on disk, the binary is asked instead of the filename", async () => {
  // The definitive branch. It is worth a seam: without one this can only be
  // exercised against whatever llama-server the test machine happens to have,
  // and the branch that produces a certain verdict would be the one untested.
  const root = await mkdtemp(join(tmpdir(), "llamacli-compat-"));
  try {
    const model = join(root, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
    await writeFile(model, Buffer.alloc(1024));

    const mismatch = await checkBinaryAgainstChosenModel(B("/stock/llama-server"), basename(model), model, {
      probeModel: async () => ({ ok: false, error: "invalid ggml type 143. should be in [0, 43)" }),
    });
    assert.match(mismatch ?? "", /읽지 못합니다/);
    assert.match(mismatch ?? "", /143/, "the actual reason must be quoted, not paraphrased");

    // A build that CAN read the model says nothing, even though the filename is
    // unsupported-quant — the exact probe decides.
    const readable = await checkBinaryAgainstChosenModel(B("/fork/llama-server"), basename(model), model, {
      probeModel: async () => ({ ok: true }),
    });
    assert.equal(readable, null, "the file is present and readable: no warning is warranted");

    // A load failure that is NOT a format mismatch says nothing about the
    // binary either, and must not be turned into a build warning.
    const corrupt = await checkBinaryAgainstChosenModel(B("/fork/llama-server"), basename(model), model, {
      probeModel: async () => ({ ok: false, error: "llama_model_loader: failed to load model" }),
    });
    assert.equal(corrupt, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A compatibility warning was a false positive on a machine whose build reads the
// model perfectly well, and the cause was a path, not a quantisation. These two
// drive the real bootstrap rather than the extracted helper, because the bug was
// never in the helper: it was the caller handing it a reconstructed path.
test("ensureLocalStack probes the real model file, kept outside modelsDir", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "llamacli-bs-"));
  const modelsDir = join(projectRoot, "models-dir-with-nothing-in-it");
  const elsewhere = join(projectRoot, "usb", "usb-models");
  const modelFile = join(elsewhere, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
  const binPath = join(projectRoot, SRV);

  try {
    await mkdir(elsewhere, { recursive: true });
    await writeFile(modelFile, "pretend weights");
    await writeFile(binPath, "#!/bin/sh\n");
    await chmod(binPath, 0o755);
    await writeFile(
      join(projectRoot, ".llamacli", "config.yaml") as string,
      ""
    ).catch(() => {}); // no config dir yet is fine
    await mkdir(join(projectRoot, ".llamacli"), { recursive: true });
    await writeFile(
      join(projectRoot, ".llamacli", "config.yaml"),
      `backend: local-llama\nmodel: ${modelFile}\nllama:\n  binPath: ${binPath}\n  modelPath: ${modelFile}\n  port: 8080\n  contextSize: 4096\n  threads: 4\n  gpuLayers: 0\n`
    );

    const lines: string[] = [];
    const report = await ensureLocalStack({
      projectRoot,
      modelsDir,
      offline: true,
      allowBuild: false,
      log: (l: string) => lines.push(l),
      run: async () => "",
      probe: async () => "free",
      detectServer: async () => ({ kind: "none" }),
      listExistingModels: async () => [],
      serverPids: [],
      hardware: {
        cpus: 12,
        ramTotalBytes: 32 * 1024 ** 3,
        gpus: [],
        os: "linux",
      } as never,
    });

    const compat = report.steps.find((s) => s.name === "모델/빌드 호환성");
    assert.equal(
      compat,
      undefined,
      `the model is on disk and the build reads it, so no compatibility step should have failed: ${JSON.stringify(compat)}`
    );
    assert.doesNotMatch(lines.join("\n"), /읽지 못합니다/, "no invented incompatibility");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("with no model on disk there is nothing to probe, so no warning is raised", async () => {
  const missing = join(tmpdir(), "definitely-not-here-12345", "model.gguf");
  assert.equal(await checkBinaryAgainstChosenModel(B("/build/llama-server"), "Ornith-1.5-35B-A3B-Q4_K_M.gguf", missing), null);
});

// ── /reset must not undo a /models selection ────────────────────────────────
import { keepSelectedModelOnReset } from "./bootstrap.js";


test("reset keeps the model the user selected when its file is on disk and it still fits", async () => {
  const root = await mkdtemp(join(tmpdir(), "llamacli-keep-"));
  try {
    const f = join(root, "Ornith-1.5-9B-Q4_K_M.gguf");
    await writeFile(f, Buffer.alloc(2048));
    const hw = { cpuCount: 12, ramTotalBytes: 32 * 1024 ** 3, ramAvailableBytes: 24 * 1024 ** 3,
      gpus: [{ index: 0, name: "g", vramTotalBytes: 12 * 1024 ** 3, vramFreeBytes: 11 * 1024 ** 3 }],
      gpuBackend: "cuda", canBuildCuda: true, tools: {}, platform: "linux" } as never;
    const kept = await keepSelectedModelOnReset({ model: f, llama: { modelPath: f, contextSize: 4096 } }, { apiKey: "k" }, hw);
    assert.equal(kept?.model, f);
    assert.equal(kept?.llama.modelPath, f);
    assert.equal(kept?.llama.contextSize, undefined, "machine-derived values are still re-derived");
    assert.equal(kept?.apiKey, "k");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reset drops a selection whose file is gone", async () => {
  const hw = { cpuCount: 4, ramTotalBytes: 8 * 1024 ** 3, ramAvailableBytes: 6 * 1024 ** 3, gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux" } as never;
  const kept = await keepSelectedModelOnReset({ model: "/nope/x.gguf", llama: { modelPath: "/nope/x.gguf" } }, { apiKey: "k" }, hw);
  assert.deepEqual(kept, { apiKey: "k" });
});

test("reset drops a catalogue model that no longer runs on this hardware", async () => {
  const root = await mkdtemp(join(tmpdir(), "llamacli-keep-"));
  try {
    const f = join(root, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
    await writeFile(f, Buffer.alloc(2048));
    const tiny = { cpuCount: 2, ramTotalBytes: 4 * 1024 ** 3, ramAvailableBytes: 3 * 1024 ** 3, gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux" } as never;
    const kept = await keepSelectedModelOnReset({ model: f }, {}, tiny);
    assert.equal(kept?.model, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
