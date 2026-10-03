import test from "node:test";
import assert from "node:assert/strict";
import { cudaTagFor, pickPublishedCudaTag, archTag, detectCudaVersion, verifyLlamaServer } from "./engineCommon.js";

const LINUX_TAGS = ["12.4", "12.8", "13.3"] as const;
const WINDOWS_TAGS = ["12.4", "13.3"] as const;

test("CUDA versions bucket to the tags a release publishes", () => {
  assert.equal(cudaTagFor("13.2"), "12.8");
  assert.equal(cudaTagFor("13.3"), "13.3");
  assert.equal(cudaTagFor("13.4"), "13.3");
  assert.equal(cudaTagFor("12.9"), "12.8");
  assert.equal(cudaTagFor("12.6"), "12.4");
  assert.equal(cudaTagFor("12.1"), "12.4");
  assert.equal(cudaTagFor("11.8"), "12.4", "older than anything published: fall back rather than give up");
});

test("CUDA bucketing refuses to invent a tag from nonsense", () => {
  for (const bad of [undefined, null, "", "unknown"]) assert.equal(cudaTagFor(bad as never), null);
});

test("pickPublishedCudaTag chooses the newest the driver can run, from what the release actually lists", () => {
  assert.equal(pickPublishedCudaTag("13.2", LINUX_TAGS), "12.8");
  assert.equal(pickPublishedCudaTag("13.3", LINUX_TAGS), "13.3");
  assert.equal(pickPublishedCudaTag("12.9", LINUX_TAGS), "12.8");
  assert.equal(pickPublishedCudaTag("12.6", LINUX_TAGS), "12.4");
  assert.equal(pickPublishedCudaTag("11.0", LINUX_TAGS), "12.4", "older than everything published: the oldest, not a nonexistent tag");
  assert.equal(pickPublishedCudaTag("13.2", WINDOWS_TAGS), "12.4", "Windows has no 12.8");
  assert.equal(pickPublishedCudaTag("13.9", WINDOWS_TAGS), "13.3");
  assert.equal(pickPublishedCudaTag(undefined, LINUX_TAGS), null);
  assert.equal(pickPublishedCudaTag("12.8", []), null);
});

test("archTag normalises node's naming", () => {
  assert.equal(archTag("amd64"), "x64");
  assert.equal(archTag("x64"), "x64");
  assert.equal(archTag("aarch64"), "arm64");
  assert.equal(archTag("arm64"), "arm64");
  assert.equal(archTag("mips"), null);
});

test("detectCudaVersion reads the DRIVER's version first, nvcc only as a fallback", async () => {
  assert.equal(await detectCudaVersion((async (f: string) => (f === "nvidia-smi" ? "| NVIDIA-SMI 570 Driver Version: 570.1  CUDA Version: 12.8 |" : "release 12.0")) as never), "12.8");
  assert.equal(await detectCudaVersion((async (f: string) => { if (f === "nvidia-smi") throw new Error("no"); return "Cuda compilation tools, release 12.4, V12.4"; }) as never), "12.4");
  assert.equal(await detectCudaVersion((async () => { throw new Error("none"); }) as never), null);
});

test("verifyLlamaServer: a binary that will not run, or whose accelerator will not initialise, is not 'installed'", async () => {
  const dead = await verifyLlamaServer("/x/llama-server", (async () => { throw new Error("cannot execute"); }) as never);
  assert.equal(dead.ok, false);
  const noGpu = await verifyLlamaServer("/x/llama-server", (async (_f: string, a: string[]) => {
    if (a.includes("--list-devices")) throw new Error("no CUDA runtime");
    return "version: 1 (abc)";
  }) as never, undefined, true);
  assert.equal(noGpu.ok, false);
  assert.match(noGpu.detail ?? "", /가속기를 초기화할 수 없음/);
});
