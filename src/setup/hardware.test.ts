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
