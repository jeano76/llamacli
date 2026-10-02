import test from "node:test";
import assert from "node:assert/strict";
import {
  cudaTagFor, prismAssetFor, archTag, prismAssetUrl,
  downloadPrismRuntime, PRISM_RELEASE_TAG, PRISM_LLAMA_CPP_REPO,
  pickPublishedCudaTag, LINUX_CUDA_TAGS, WINDOWS_CUDA_TAGS_X64,
  type PrismMachine,
} from "./ternaryRuntime.js";

// These names are not ours to invent. The fork's own download_binaries.sh is the
// source of truth for how to run these models, and a name guessed here would be a
// 404 at exactly the moment a user is waiting on a multi-GB setup.
const LINUX = (over: Partial<PrismMachine> = {}): PrismMachine => ({
  platform: "linux",
  arch: "x64",
  gpuBackend: "none",
  ...over,
});

test("the pinned release and fork are what the model card names", () => {
  assert.equal(PRISM_LLAMA_CPP_REPO, "https://github.com/PrismML-Eng/llama.cpp");
  // The real tag is `prism-<short-sha>-<short-sha>`; the hyphen inside matters,
  // since a looser pattern would let a malformed tag through to a 404.
  assert.match(PRISM_RELEASE_TAG, /^prism-[0-9a-f]{6,}-[0-9a-f]{6,}$/);
  assert.ok(prismAssetUrl("x.tar.gz").startsWith(`${PRISM_LLAMA_CPP_REPO}/releases/download/${PRISM_RELEASE_TAG}/`));
});

test("CUDA versions bucket to the tags the release actually publishes", () => {
  // Buckets match the fork's own script. Getting this wrong does not degrade, it
  // 404s: the release only carries 12.4, 12.8 and 13.3.
  assert.equal(cudaTagFor("13.2"), "12.8");
  assert.equal(cudaTagFor("13.3"), "13.3");
  assert.equal(cudaTagFor("13.4"), "13.3");
  assert.equal(cudaTagFor("12.9"), "12.8");
  assert.equal(cudaTagFor("12.6"), "12.4");
  assert.equal(cudaTagFor("12.1"), "12.4");
  // Older than anything published: the fork falls back rather than giving up.
  assert.equal(cudaTagFor("11.8"), "12.4");
});

test("CUDA bucketing refuses to invent a tag from nonsense", () => {
  assert.equal(cudaTagFor(undefined), null);
  assert.equal(cudaTagFor(null), null);
  assert.equal(cudaTagFor(""), null);
  assert.equal(cudaTagFor("unknown"), null);
});

test("a CUDA driver picks the CUDA asset, not the CPU one", () => {
  const asset = prismAssetFor(LINUX({ gpuBackend: "cuda", cudaVersion: "13.2" }));
  assert.equal(asset?.asset, `llama-${PRISM_RELEASE_TAG}-bin-linux-cuda-12.8-x64.tar.gz`);
  assert.equal(asset?.subdir, "cuda-12.8");
});

test("no GPU picks the CPU asset", () => {
  const asset = prismAssetFor(LINUX());
  assert.equal(asset?.asset, `llama-${PRISM_RELEASE_TAG}-bin-ubuntu-x64.tar.gz`);
});

test("returns null where the release has no build, instead of guessing", () => {
  // A wrong pick here is worse than a compile: it downloads the wrong thing and
  // then the model still will not load.
  assert.equal(prismAssetFor(LINUX({ arch: "riscv64" })), null, "unsupported arch");
  assert.equal(prismAssetFor(LINUX({ gpuBackend: "cuda", cudaVersion: null })), null, "CUDA, version unreadable");
  assert.equal(
    prismAssetFor(LINUX({ gpuBackend: "cuda", arch: "arm64", cudaVersion: "12.8" })),
    null,
    "no CUDA arm64 build is published"
  );
});

test("Windows is supported: zip, flat, and .exe", () => {
  // Windows is a first-class target here, not a build-from-source consolation
  // prize: the release publishes zips, and they are FLAT (no wrapper directory),
  // so `strip` must be 0 and the binary carries `.exe`.
  const cpu = prismAssetFor({ platform: "win32", arch: "x64", gpuBackend: "none" });
  assert.equal(cpu?.asset, `llama-${PRISM_RELEASE_TAG}-bin-win-cpu-x64.zip`);
  assert.equal(cpu?.format, "zip");
  assert.equal(cpu?.strip, 0, "the Windows zips have no wrapper directory");
  assert.equal(cpu?.binName, "llama-server.exe");

  const arm = prismAssetFor({ platform: "win32", arch: "arm64", gpuBackend: "none" });
  assert.equal(arm?.asset, `llama-${PRISM_RELEASE_TAG}-bin-win-cpu-arm64.zip`);

  const cuda = prismAssetFor({ platform: "win32", arch: "x64", gpuBackend: "cuda", cudaVersion: "13.2" });
  assert.equal(cuda?.format, "zip");
  assert.equal(cuda?.binName, "llama-server.exe");
});

test("Windows CUDA never names a tag the release does not publish there", () => {
  // The trap: the Linux rule maps a 13.x driver to 12.8, and Windows has no 12.8
  // asset at all. Picking from the published set is what stops a 404 behind a
  // 245 MB download.
  for (const v of ["11.8", "12.4", "12.6", "12.9", "13.0", "13.2", "13.3", "13.9"]) {
    const a = prismAssetFor({ platform: "win32", arch: "x64", gpuBackend: "cuda", cudaVersion: v });
    assert.ok(a, `no asset for CUDA ${v}`);
    assert.doesNotMatch(
      a!.asset,
      /cuda-12\.8/,
      `CUDA ${v} named a 12.8 asset, which Windows does not publish`
    );
    assert.match(a!.asset, /win-cuda-12\.4-x64\.zip|win-cuda-13\.3-x64\.zip/);
  }
});

test("pickPublishedCudaTag chooses the newest the driver can run", () => {
  assert.equal(pickPublishedCudaTag("13.2", LINUX_CUDA_TAGS), "12.8");
  assert.equal(pickPublishedCudaTag("13.3", LINUX_CUDA_TAGS), "13.3");
  assert.equal(pickPublishedCudaTag("12.9", LINUX_CUDA_TAGS), "12.8");
  assert.equal(pickPublishedCudaTag("12.6", LINUX_CUDA_TAGS), "12.4");
  // Older than everything published: the oldest, not a nonexistent tag.
  assert.equal(pickPublishedCudaTag("11.0", LINUX_CUDA_TAGS), "12.4");
  // Windows has no 12.8.
  assert.equal(pickPublishedCudaTag("13.2", WINDOWS_CUDA_TAGS_X64), "12.4");
  assert.equal(pickPublishedCudaTag("13.3", WINDOWS_CUDA_TAGS_X64), "13.3");
  assert.equal(pickPublishedCudaTag("13.9", WINDOWS_CUDA_TAGS_X64), "13.3");
  assert.equal(pickPublishedCudaTag(undefined, LINUX_CUDA_TAGS), null);
});

test("macOS names match the published assets", () => {
  assert.equal(
    prismAssetFor({ platform: "darwin", arch: "arm64", gpuBackend: "none" })?.asset,
    `llama-${PRISM_RELEASE_TAG}-bin-macos-arm64.tar.gz`
  );
  assert.equal(
    prismAssetFor({ platform: "darwin", arch: "x64", gpuBackend: "none" })?.asset,
    `llama-${PRISM_RELEASE_TAG}-bin-macos-x64.tar.gz`
  );
});

test("archTag normalises node's naming to the fork's", () => {
  assert.equal(archTag("amd64"), "x64");
  assert.equal(archTag("x64"), "x64");
  assert.equal(archTag("aarch64"), "arm64");
  assert.equal(archTag("arm64"), "arm64");
  assert.equal(archTag("mips"), null);
});

test("a failed download reports and does not pretend to have installed anything", async () => {
  // The caller's cue to build the fork instead. Never stock: a stock build cannot
  // read these models, so "no prebuilt" and "stock" are not interchangeable.
  const res = await downloadPrismRuntime({
    machine: LINUX(),
    destRoot: "/tmp/does-not-matter-" + process.pid,
    extract: () => [],
    download: (async () => {
      throw new Error("HTTP 404");
    }) as never,
  });
  assert.equal(res.ok, false);
  assert.equal(res.binPath, undefined);
  assert.match(res.lines.join("\n"), /빌드/);
});

test("no published asset for this platform says so, and still offers a build", async () => {
  const res = await downloadPrismRuntime({
    // Linux CUDA on arm64: genuinely unpublished, so this is the build path.
    machine: LINUX({ gpuBackend: "cuda", arch: "arm64", cudaVersion: "12.8" }),
    destRoot: "/tmp/does-not-matter-" + process.pid,
  });
  assert.equal(res.ok, false);
  assert.match(res.lines.join("\n"), /직접 빌드합니다/);
  // The fork URL in the message is what makes the fallback actionable.
  assert.match(res.lines.join("\n"), /PrismML-Eng\/llama\.cpp/);
});

test("a successful download extracts with the leading directory stripped and returns the binary", async () => {
  const destRoot = `/tmp/llamacli-prism-test-${process.pid}`;
  const res = await downloadPrismRuntime({
    machine: LINUX(),
    destRoot,
    extract: (archive, dest, opts) => {
      // Assert the seam the caller's correctness depends on: entries live under one
      // `llama-<tag>/` directory, and the shared .so files must land beside the
      // binary rather than a level up.
      assert.equal(opts.strip, 1);
      assert.ok(dest.endsWith("cpu"));
      return [`${dest}/llama-server`];
    },
    download: (async () => {
      // Pretend the unpacked tree is executable by touching the marker file the
      // function checks for.
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(destRoot, "cpu"), { recursive: true });
      const bin = join(destRoot, "cpu", "llama-server");
      await writeFile(bin, "#!/bin/sh\n");
      await chmod(bin, 0o755);
      return { path: "x", bytes: 1 } as never;
    }) as never,
  });
  assert.equal(res.ok, true);
  assert.ok(res.binPath?.endsWith("/cpu/llama-server"));
  assert.match(res.lines.join("\n"), /준비 완료/);
});