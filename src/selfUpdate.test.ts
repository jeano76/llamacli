import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, parseManifest, updateAvailable, checkAndApplyUpdate, LOCAL_HASH_FILE } from "./selfUpdate.js";

const execFileAsync = promisify(execFile);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-selfupdate-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Builds a real tar.gz (using the actual `tar` binary, same as
 *  scripts/update-bin.mjs and checkAndApplyUpdate itself use) from a set
 *  of {path: content} files, and returns its bytes + sha256 — so these
 *  tests exercise real archive creation/extraction rather than mocking it
 *  away, the one part of this module that genuinely needs a real
 *  filesystem + subprocess to mean anything. */
async function buildFixtureArchive(files: Record<string, string>): Promise<{ bytes: Buffer; sha256: string }> {
  return withTempDirReturning(async (srcDir) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(srcDir, join(path, "..")), { recursive: true });
      await writeFile(join(srcDir, path), content, "utf8");
    }
    const archivePath = join(srcDir, "..", `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
    await execFileAsync("tar", ["-czf", archivePath, "-C", srcDir, "."]);
    const bytes = await readFile(archivePath);
    await rm(archivePath, { force: true });
    return { bytes, sha256: sha256Hex(bytes) };
  });
}

async function withTempDirReturning<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-fixture-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("sha256Hex is a real, deterministic sha256 of its input", () => {
  const a = sha256Hex("hello world");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, sha256Hex("hello world"));
  assert.notEqual(a, sha256Hex("hello world!"));
  assert.equal(a, createHash("sha256").update("hello world").digest("hex"));
});

test("parseManifest accepts a well-formed manifest and rejects a malformed one", () => {
  const good = parseManifest(JSON.stringify({ version: "v20260924", sha256: "a".repeat(64) }));
  assert.equal(good.version, "v20260924");
  assert.equal(good.sha256, "a".repeat(64));

  assert.throws(() => parseManifest(JSON.stringify({ version: "v20260924", sha256: "not-hex" })));
  assert.throws(() => parseManifest(JSON.stringify({ sha256: "a".repeat(64) })));
  assert.throws(() => parseManifest("not json at all"));
});

test("updateAvailable compares hashes (case-insensitively), not version strings", () => {
  const manifest = { version: "v20260924", sha256: "a".repeat(64) };
  assert.equal(updateAvailable("b".repeat(64), manifest), true);
  assert.equal(updateAvailable("a".repeat(64), manifest), false);
  assert.equal(updateAvailable("A".repeat(64), manifest), false, "hash comparison must not be case-sensitive");
});

test("checkAndApplyUpdate extracts a new dist/ archive over the local one, only when its hash matches the manifest both before AND after the write", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await mkdir(join(distDir, "tui"), { recursive: true });
    await writeFile(join(distDir, "tui", "App.js"), "old App.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");

    const { bytes: newArchive, sha256: newSha256 } = await buildFixtureArchive({
      "index.js": "new index.js",
      "tui/App.js": "new App.js",
    });
    const manifestBody = JSON.stringify({ version: "v20260925", sha256: newSha256 });

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) return { ok: true, status: 200, text: async () => manifestBody } as Response;
      if (url.endsWith(".tar.gz")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => newArchive.buffer.slice(newArchive.byteOffset, newArchive.byteOffset + newArchive.byteLength),
        } as Response;
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, true);
    assert.match(result.reason, /v20260925/);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "new index.js");
    assert.equal(await readFile(join(distDir, "tui", "App.js"), "utf8"), "new App.js");
    assert.equal(await readFile(join(distDir, LOCAL_HASH_FILE), "utf8"), newSha256, "the local hash marker must be updated too, or the next startup would try to update again forever");
  }));

test("checkAndApplyUpdate reports already up to date, and touches nothing, when local and remote hashes match", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "same content", "utf8");
    const sameSha256 = "c".repeat(64);
    await writeFile(join(distDir, LOCAL_HASH_FILE), sameSha256, "utf8");

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ version: "v20260924", sha256: sameSha256 }) } as Response;
      }
      throw new Error("the archive should never be fetched when already up to date");
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /up to date/);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "same content");
  }));

test("checkAndApplyUpdate refuses to install when the downloaded archive's hash doesn't match the manifest — the exact scenario the two-hash-check requirement exists for", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");

    // Manifest claims one hash; the actual downloaded bytes are a
    // DIFFERENT (validly-built!) archive — corrupted in transit, or a
    // stale/mismatched manifest. This must never be installed.
    const claimedButWrongSha256 = "f".repeat(64);
    const { bytes: actuallyDownloaded } = await buildFixtureArchive({ "index.js": "tampered index.js" });

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ version: "v20260925", sha256: claimedButWrongSha256 }) } as Response;
      }
      if (url.endsWith(".tar.gz")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            actuallyDownloaded.buffer.slice(actuallyDownloaded.byteOffset, actuallyDownloaded.byteOffset + actuallyDownloaded.byteLength),
        } as Response;
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /hash/i);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "old index.js", "must never overwrite the working dist/ with unverified content");
  }));

test("checkAndApplyUpdate never throws and leaves dist/ alone when the network is unreachable", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");

    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /network unreachable/);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "old index.js");
  }));

test("checkAndApplyUpdate reports failure (not a throw) when the manifest is malformed", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");

    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => "not valid json" }) as Response) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, false);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "old index.js");
  }));

test("checkAndApplyUpdate fails gracefully (not a throw) when there's no local hash file to compare against yet", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    // No LOCAL_HASH_FILE written — simulates a dist/ built before this
    // mechanism existed.
    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: "v1", sha256: "a".repeat(64) }) }) as Response) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /local build hash/);
  }));
