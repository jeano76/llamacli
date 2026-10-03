import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNvidiaSmiCsv,
  parseNvidiaComputeAppsCsv,
  ownLlamaServerVramGiB,
  findOwnLlamaServerPids,
} from "./hardware.js";

// The per-process table is what lets the tuner discount OUR OWN llama-server's
// weights instead of treating them as someone else's — the free/total query
// alone cannot tell those apart, and getting it wrong shrinks the context 4x on
// a machine that is demonstrably running a much larger one.

test("parseNvidiaSmiCsv reads total and free memory per GPU", () => {
  const gpus = parseNvidiaSmiCsv("0, NVIDIA GeForce RTX 2070 SUPER, 8192, 7456\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].index, 0);
  assert.equal(gpus[0].name, "NVIDIA GeForce RTX 2070 SUPER");
  assert.equal(gpus[0].vramTotalBytes, 8192 * 1024 * 1024);
  assert.equal(gpus[0].vramFreeBytes, 7456 * 1024 * 1024);
});

test("parseNvidiaSmiCsv keeps a GPU name that itself contains a comma", () => {
  const gpus = parseNvidiaSmiCsv("0, NVIDIA GeForce RTX 4090 D, 24564, 24000\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, "NVIDIA GeForce RTX 4090 D");
  assert.equal(gpus[0].vramTotalBytes, 24564 * 1024 * 1024);
});

test("parseNvidiaSmiCsv treats an unreadable free-memory column as fully busy, not zero-vram", () => {
  // Some MIG/driver states report "N/A"; Number() makes that NaN. Falling back
  // to 0 would make a perfectly idle GPU look unusable, which is the opposite
  // of the safe direction.
  const gpus = parseNvidiaSmiCsv("0, RTX A4000, 16376, N/A\n");
  assert.equal(gpus[0].vramTotalBytes, 16376 * 1024 * 1024);
  assert.equal(gpus[0].vramFreeBytes, 0);
});

test("parseNvidiaComputeAppsCsv attributes memory to each pid", () => {
  const byPid = parseNvidiaComputeAppsCsv("1802867, 6080\n21552, 40\n");
  assert.equal(byPid.get(1802867), 6080 * 1024 * 1024);
  assert.equal(byPid.get(21552), 40 * 1024 * 1024);
  assert.equal(byPid.size, 2);
});

test("parseNvidiaComputeAppsCsv skips unusable rows instead of poisoning the map with NaN", () => {
  // A row we cannot attribute must read as "no measurable usage" so the caller
  // discounts nothing, rather than propagating a NaN into a memory budget.
  const byPid = parseNvidiaComputeAppsCsv("1802867, N/A\nnot-a-pid, 512\n, 99\n1802868, 512\n");
  assert.equal(byPid.has(1802867), false);
  assert.equal(byPid.has(NaN), false);
  assert.equal(byPid.get(1802868), 512 * 1024 * 1024);
});

test("parseNvidiaComputeAppsCsv returns an empty map when no CUDA process is running", () => {
  assert.equal(parseNvidiaComputeAppsCsv("").size, 0);
  assert.equal(parseNvidiaComputeAppsCsv("\n  \n").size, 0);
});

test("ownLlamaServerVramGiB sums only the pids it was given", async () => {
  const run = async () => "1802867, 6080\n21552, 40\n";
  // Our llama-server only — the 40 MiB process belongs to someone else and must
  // stay counted against the budget.
  const ours = await ownLlamaServerVramGiB([1802867], run);
  assert.ok(Math.abs(ours - 6080 / 1024) < 1e-6, `got ${ours}`);
  const both = await ownLlamaServerVramGiB([1802867, 21552], run);
  assert.ok(Math.abs(both - 6120 / 1024) < 1e-6, `got ${both}`);
});

test("ownLlamaServerVramGiB is 0 with no pids, so a first run keeps the plain reading", async () => {
  const run = async () => {
    throw new Error("must not be called");
  };
  assert.equal(await ownLlamaServerVramGiB([], run), 0);
});

test("ownLlamaServerVramGiB degrades to 0 when nvidia-smi is unavailable", async () => {
  // A MIG box or a container without the driver must not break setup; the
  // conservative direction is to credit nothing.
  const failing = async () => {
    throw new Error("nvidia-smi: command not found");
  };
  assert.equal(await ownLlamaServerVramGiB([1234], failing), 0);
});

test("ownLlamaServerVramGiB is 0 when our pid is not in the table (already exited)", async () => {
  const run = async () => "21552, 40\n";
  assert.equal(await ownLlamaServerVramGiB([999999], run), 0);
});
// Discovery is what makes the VRAM credit live rather than dead code: without a
// populated pid list, the context stays collapsed on a card whose own server is
// running. Attribution must stay narrow — a false positive hands out a context
// the card cannot hold.
test("findOwnLlamaServerPids credits a server running our own binary", async () => {
  const run = async (cmd: string, args: string[]) => {
    if (cmd === "pgrep") return "1802867\n";
    if (cmd === "readlink") return "/opt/llamacli/llama.cpp/build/bin/llama-server\n";
    throw new Error(`unexpected: ${cmd}`);
  };
  assert.deepEqual(await findOwnLlamaServerPids("/opt/llamacli/llama.cpp/build/bin", run), [1802867]);
});

test("findOwnLlamaServerPids ignores a llama-server outside our install", async () => {
  // The whole point of resolving /proc/<pid>/exe: a SYSTEM llama-server, or
  // another user's session, matches on name alone and must not be credited.
  const run = async (cmd: string) => {
    if (cmd === "pgrep") return "1802867\n";
    return "/usr/bin/llama-server\n";
  };
  assert.deepEqual(await findOwnLlamaServerPids("/opt/llamacli/llama.cpp/build/bin", run), []);
});

test("findOwnLlamaServerPids does not credit a sibling directory that shares a prefix", async () => {
  // "/opt/llamacli-2" starts with "/opt/llamacli" as a string but is not inside
  // it — a prefix test without a separator would wrongly accept it.
  const run = async (cmd: string) => {
    if (cmd === "pgrep") return "4242\n";
    return "/opt/llamacli-2/llama.cpp/build/bin/llama-server\n";
  };
  assert.deepEqual(await findOwnLlamaServerPids("/opt/llamacli/llama.cpp/build/bin", run), []);
});

test("findOwnLlamaServerPids returns nothing when pgrep finds nothing", async () => {
  // pgrep exits 1 when nothing matched; that is a normal answer, not a failure.
  const run = async () => {
    throw new Error("Command failed: pgrep");
  };
  assert.deepEqual(await findOwnLlamaServerPids("/opt/llamacli/build", run), []);
});

test("findOwnLlamaServerPids skips a pid it cannot read, rather than guessing", async () => {
  // Race (process exited between pgrep and readlink) or permissions: unprovable,
  // so not credited — crediting it would be the unsafe direction.
  const run = async (cmd: string, args: string[]) => {
    if (cmd === "pgrep") return "1802867\n2145416\n";
    if (cmd === "readlink") {
      if (args.join(" ").includes("2145416")) throw new Error("No such file or directory");
      return "/opt/llamacli/build/bin/llama-server\n";
    }
    throw new Error("unexpected");
  };
  assert.deepEqual(await findOwnLlamaServerPids("/opt/llamacli/build/bin", run), [1802867]);
});

test("findOwnLlamaServerPids is a no-op without a known install dir", async () => {
  const run = async () => {
    throw new Error("must not shell out without a dir to match against");
  };
  assert.deepEqual(await findOwnLlamaServerPids(undefined, run), []);
});

// ── cgroup limits (containers): the host's RAM/CPU must not be believed inside a limited cgroup ──
import { readCgroupLimits, applyCgroupLimits, detectHardware } from "./hardware.js";

const fsOf = (files: Record<string, string>) => (p: string) => (p in files ? files[p] : null);
const GiBc = 1024 ** 3;

test("cgroup v2: --memory 4g / --cpus 2 are read from memory.max and cpu.max", () => {
  const l = readCgroupLimits(fsOf({
    "/sys/fs/cgroup/memory.max": `${4 * GiBc}\n`, "/sys/fs/cgroup/memory.current": `${GiBc}\n`, "/sys/fs/cgroup/cpu.max": "200000 100000\n",
  }));
  assert.equal(l.memoryBytes, 4 * GiBc);
  assert.equal(l.memoryUsedBytes, GiBc);
  assert.equal(l.cpuCores, 2);
});

test("cgroup v2: 'max' means unlimited", () => {
  const l = readCgroupLimits(fsOf({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/cpu.max": "max 100000\n" }));
  assert.deepEqual(l, {});
});

test("cgroup v1: limit_in_bytes and cfs quota/period; the ~2^63 'no limit' value is unlimited", () => {
  const limited = readCgroupLimits(fsOf({
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${8 * GiBc}\n`, "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${2 * GiBc}\n`,
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
  }));
  assert.equal(limited.memoryBytes, 8 * GiBc);
  assert.equal(limited.cpuCores, 1.5);
  const none = readCgroupLimits(fsOf({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" }));
  assert.deepEqual(none, {});
});

test("a slice's own cgroup directory can be stricter than the root, and the tightest limit wins", () => {
  const l = readCgroupLimits(fsOf({
    "/proc/self/cgroup": "0::/user.slice/app.slice\n",
    "/sys/fs/cgroup/user.slice/app.slice/memory.max": `${2 * GiBc}\n`,
    "/sys/fs/cgroup/memory.max": `${16 * GiBc}\n`,
  }));
  assert.equal(l.memoryBytes, 2 * GiBc);
});

test("applyCgroupLimits clamps the host's figures and never raises them", () => {
  const host = { ramTotalBytes: 31 * GiBc, ramAvailableBytes: 24 * GiBc, cpuCount: 12 };
  assert.deepEqual(applyCgroupLimits(host, { memoryBytes: 4 * GiBc, memoryUsedBytes: GiBc, cpuCores: 1.2 }), { ramTotalBytes: 4 * GiBc, ramAvailableBytes: 3 * GiBc, cpuCount: 2 });
  assert.deepEqual(applyCgroupLimits(host, { memoryBytes: 64 * GiBc, cpuCores: 64 }), host, "a limit above the host changes nothing");
  assert.deepEqual(applyCgroupLimits(host, {}), host);
  assert.equal(applyCgroupLimits(host, { cpuCores: 0.2 }).cpuCount, 1, "never below one core");
});

test("the Hub and release endpoints default to the real services (overrides are opt-in)", async () => {
  const { HF_ENDPOINT } = await import("./modelCatalog.js");
  const { STOCK_RELEASES_URL } = await import("./stockRuntime.js");
  if (!process.env.LLAMACLI_HF_ENDPOINT) assert.equal(HF_ENDPOINT, "https://huggingface.co");
  if (!process.env.LLAMACLI_RELEASES_URL) assert.match(STOCK_RELEASES_URL, /^https:\/\/api\.github\.com\/repos\/ggml-org\/llama\.cpp\/releases/);
});

test("libc is detected from the dynamic loader on Linux (musl vs glibc) and left unset elsewhere", async () => {
  const run = (async () => { throw new Error("nf"); }) as never;
  const host = (platform: string, lib: string[]) => ({ platform, arch: "x64", ramTotalBytes: 8 * 1024 ** 3, ramAvailableBytes: 4 * 1024 ** 3, cpuCount: 4, readText: async () => null, listDir: async (p: string) => (p === "/lib" ? lib : []) });
  assert.equal((await detectHardware(run, host("linux", ["ld-musl-x86_64.so.1", "libc.musl-x86_64.so.1"]))).libc, "musl");
  assert.equal((await detectHardware(run, host("linux", ["x86_64-linux-gnu", "ld-linux-x86-64.so.2"]))).libc, "glibc");
  assert.equal((await detectHardware(run, host("darwin", []))).libc, undefined);
});
