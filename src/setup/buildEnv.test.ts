import { test } from "node:test";
import assert from "node:assert/strict";
import { planBuildEnv, applyBuildEnv, detectPackageManager, missingBuildTools } from "./buildEnv.js";
import { chooseBuildTarget, buildJobs, detectCudaArch } from "./buildTarget.js";

const GiB = 1024 ** 3;
const tools = (present: string[]) => Object.fromEntries(present.map((t) => [t, true]));
const full = ["git", "cmake", "g++", "make"];

test("nothing missing: no commands, no privilege, no sudo", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools([...full, "apt-get"]) }, { isRoot: false });
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.commands, []);
  assert.equal(plan.needsPrivilege, false);
});

test("only the missing tools are installed, not the whole list", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "g++", "make", "apt-get", "sudo"]) }, { isRoot: false });
  assert.deepEqual(plan.missing, ["cmake"]);
  assert.deepEqual(plan.packages, ["cmake"]);
  assert.equal(plan.commands[0].file, "apt-get");
  assert.ok(!plan.packages.includes("build-essential"));
  assert.equal(plan.needsPrivilege, true);
});

test("each distribution gets its own package manager and names", () => {
  const cases: [string, string, string][] = [
    ["dnf", "dnf", "gcc-c++"],
    ["pacman", "pacman", "gcc"],
    ["apk", "apk", "build-base"],
    ["zypper", "zypper", "gcc-c++"],
  ];
  for (const [tool, file, pkg] of cases) {
    const plan = planBuildEnv({ platform: "linux", tools: tools([tool, "sudo"]) }, { isRoot: false });
    assert.equal(detectPackageManager({ platform: "linux", tools: tools([tool]) }), tool);
    assert.equal(plan.commands[0].file, file, tool);
    assert.ok(plan.packages.includes(pkg), `${tool} → ${pkg}`);
    assert.ok(plan.packages.includes("git") && plan.packages.includes("cmake"));
  }
});

test("root needs no sudo", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["apt-get"]) }, { isRoot: true });
  assert.equal(plan.needsPrivilege, false);
  assert.equal(plan.commands[0].privileged, false);
});

test("not root and no sudo: a manual instruction, never a command that would hang or fail", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["apt-get"]) }, { isRoot: false });
  assert.deepEqual(plan.commands, []);
  assert.match(plan.manual ?? "", /sudo/);
});

test("an unknown package manager is reported, not guessed", () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools([]) }, { isRoot: true });
  assert.equal(plan.manager, null);
  assert.deepEqual(plan.commands, []);
  assert.ok(plan.manual);
});

test("macOS without a compiler is told to install the Command Line Tools, not given a brew line that cannot work", () => {
  const plan = planBuildEnv({ platform: "darwin", tools: tools(["brew", "git", "cmake"]) });
  assert.deepEqual(plan.commands, []);
  assert.match(plan.manual ?? "", /xcode-select/);
});

test("macOS missing only cmake uses brew without sudo", () => {
  const plan = planBuildEnv({ platform: "darwin", tools: tools(["brew", "git", "g++", "make"]) });
  assert.equal(plan.commands[0].file, "brew");
  assert.equal(plan.commands[0].privileged, false);
});

test("Windows uses winget and passes the C++ workload to the Build Tools", () => {
  const plan = planBuildEnv({ platform: "win32", tools: tools(["winget"]) });
  const bt = plan.commands.find((c) => c.args.includes("Microsoft.VisualStudio.2022.BuildTools"));
  assert.ok(bt);
  assert.ok(bt!.args.join(" ").includes("Workload.VCTools"));
  assert.ok(plan.commands.every((c) => c.file === "winget" && !c.privileged));
});

test("`cc` alone is not a C++ compiler", () => {
  assert.ok(missingBuildTools({ platform: "linux", tools: tools(["git", "cmake", "cc", "make"]) }).includes("compiler"));
});

test("ninja satisfies make", () => {
  assert.ok(!missingBuildTools({ platform: "linux", tools: tools(["git", "cmake", "g++", "ninja"]) }).includes("make"));
});

test("a Vulkan build also needs the shader compiler", () => {
  const m = missingBuildTools({ platform: "linux", tools: tools(full) }, { vulkan: true });
  assert.deepEqual(m, ["vulkan-sdk"]);
});

// ── apply ───────────────────────────────────────────────────────────────────

test("apply: passwordless sudo first, and the prompting form only when interactive", async () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "g++", "make", "apt-get", "sudo"]) }, { isRoot: false });
  const calls: string[] = [];
  const run = async (f: string, a: string[]) => {
    calls.push([f, ...a].join(" "));
    if (a.includes("-n")) throw new Error("a password is required");
    return "";
  };
  const headless = await applyBuildEnv(plan, { run: run as never, interactive: false });
  assert.equal(calls.filter((c) => c.startsWith("sudo")).length, 1, "headless never prompts");
  assert.equal(headless.ok, false);

  calls.length = 0;
  await applyBuildEnv(plan, { run: run as never, interactive: true });
  assert.equal(calls.filter((c) => c.startsWith("sudo")).length, 2);
});

test("apply: an install that exits 0 but leaves cmake unrunnable is NOT ok", async () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["git", "g++", "make", "apt-get"]) }, { isRoot: true });
  const run = async (f: string) => {
    if (f === "cmake") throw new Error("not found");
    return "";
  };
  const res = await applyBuildEnv(plan, { run: run as never });
  assert.equal(res.ok, false);
  assert.equal(res.verified.cmake, false);
});

test("apply: success is verified by running the tools", async () => {
  const plan = planBuildEnv({ platform: "linux", tools: tools(["apt-get"]) }, { isRoot: true });
  const ran: string[] = [];
  const res = await applyBuildEnv(plan, { run: (async (f: string) => { ran.push(f); return ""; }) as never });
  assert.equal(res.ok, true);
  assert.ok(ran.includes("cmake") && ran.includes("git") && ran.includes("g++"));
});

// ── targets ─────────────────────────────────────────────────────────────────

const hwOf = (o: object) => ({ gpuBackend: "none" as const, canBuildCuda: false, canBuildVulkan: false, platform: "linux", arch: "x64", ...o });

test("target: NVIDIA + nvcc is CUDA, narrowed to the card's architecture", () => {
  const t = chooseBuildTarget(hwOf({ gpuBackend: "cuda", canBuildCuda: true }), "75");
  assert.equal(t.backend, "cuda");
  assert.ok(t.flags.includes("-DGGML_CUDA=ON"));
  assert.ok(t.flags.includes("-DCMAKE_CUDA_ARCHITECTURES=75"));
});

test("target: NVIDIA without nvcc never asks for CUDA", () => {
  const t = chooseBuildTarget(hwOf({ gpuBackend: "cuda", canBuildCuda: false }));
  assert.ok(!t.flags.some((f) => f.includes("CUDA")));
});

test("target: AMD with glslc is Vulkan; without it, CPU", () => {
  assert.equal(chooseBuildTarget(hwOf({ gpuBackend: "vulkan", canBuildVulkan: true })).backend, "vulkan");
  assert.equal(chooseBuildTarget(hwOf({ gpuBackend: "vulkan", canBuildVulkan: false })).backend, "cpu");
});

test("target: Apple Silicon is Metal", () => {
  assert.equal(chooseBuildTarget(hwOf({ platform: "darwin", arch: "arm64", gpuBackend: "metal" })).backend, "metal");
});

test("target: forced cpu ignores accelerators", () => {
  assert.equal(chooseBuildTarget(hwOf({ gpuBackend: "cuda", canBuildCuda: true }), "75", "cpu").backend, "cpu");
});

test("jobs: capped by free RAM, not just cores", () => {
  assert.equal(buildJobs({ cpuCount: 12, ramAvailableBytes: 8 * GiB }, "cuda"), 2);
  assert.equal(buildJobs({ cpuCount: 12, ramAvailableBytes: 64 * GiB }, "cpu"), 12);
  assert.equal(buildJobs({ cpuCount: 32, ramAvailableBytes: 128 * GiB }, "cpu"), 16);
  assert.equal(buildJobs({ cpuCount: 4, ramAvailableBytes: 1 * GiB }, "cpu"), 1, "never zero");
});

test("cuda arch: reads compute capability, drops the dot, dedupes", async () => {
  assert.equal(await detectCudaArch((async () => "7.5\n7.5\n") as never), "75");
  assert.equal(await detectCudaArch((async () => "7.5\n8.9\n") as never), "75;89");
  assert.equal(await detectCudaArch((async () => { throw new Error("no"); }) as never), null);
  assert.equal(await detectCudaArch((async () => "N/A\n") as never), null);
});
