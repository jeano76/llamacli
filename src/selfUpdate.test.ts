import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, parseManifest, updateAvailable, checkAndApplyUpdate } from "./selfUpdate.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-selfupdate-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("sha256Hex is a real, deterministic sha256 of its input", () => {
  const a = sha256Hex("hello world");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, sha256Hex("hello world"));
  assert.notEqual(a, sha256Hex("hello world!"));
  // Cross-checked against Node's own crypto module directly, not a
  // hand-typed literal — sha256("hello world") is easy to mistype.
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

test("checkAndApplyUpdate installs a new binary only when its hash matches the manifest, both before AND after the write", () =>
  withTempDir(async (dir) => {
    const binPath = join(dir, "llamacli.js");
    await writeFile(binPath, "old binary content", "utf8");

    const newContent = Buffer.from("new binary content");
    const newSha256 = sha256Hex(newContent);
    const manifestBody = JSON.stringify({ version: "v20260925", sha256: newSha256 });

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, text: async () => manifestBody } as Response;
      }
      if (url.endsWith("llamacli.js")) {
        return { ok: true, status: 200, arrayBuffer: async () => newContent.buffer.slice(newContent.byteOffset, newContent.byteOffset + newContent.byteLength) } as Response;
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(binPath, { fetchImpl });
    assert.equal(result.updated, true);
    assert.match(result.reason, /v20260925/);
    assert.equal(await readFile(binPath, "utf8"), "new binary content");
  }));

test("checkAndApplyUpdate reports already up to date, and touches nothing, when local and remote hashes match", () =>
  withTempDir(async (dir) => {
    const binPath = join(dir, "llamacli.js");
    const content = "same binary content";
    await writeFile(binPath, content, "utf8");
    const sameSha256 = sha256Hex(content);

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ version: "v20260924", sha256: sameSha256 }) } as Response;
      }
      throw new Error("binary should never be fetched when already up to date");
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(binPath, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /up to date/);
    assert.equal(await readFile(binPath, "utf8"), content, "the existing binary must be untouched");
  }));

test("checkAndApplyUpdate refuses to install when the downloaded binary's hash doesn't match the manifest — the exact scenario the two-hash-check requirement exists for", () =>
  withTempDir(async (dir) => {
    const binPath = join(dir, "llamacli.js");
    await writeFile(binPath, "old binary content", "utf8");

    // Manifest claims one hash; the actual downloaded bytes are different
    // (corrupted in transit, or a mismatched/stale manifest) — this must
    // never be installed.
    const claimedButWrongSha256 = sha256Hex("something else entirely");
    const actuallyDownloaded = Buffer.from("tampered or corrupted content");

    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ version: "v20260925", sha256: claimedButWrongSha256 }) } as Response;
      }
      if (url.endsWith("llamacli.js")) {
        return { ok: true, status: 200, arrayBuffer: async () => actuallyDownloaded.buffer.slice(actuallyDownloaded.byteOffset, actuallyDownloaded.byteOffset + actuallyDownloaded.byteLength) } as Response;
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(binPath, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /hash/i);
    assert.equal(await readFile(binPath, "utf8"), "old binary content", "must never overwrite the working binary with unverified content");
  }));

test("checkAndApplyUpdate never throws and leaves the binary alone when the network is unreachable", () =>
  withTempDir(async (dir) => {
    const binPath = join(dir, "llamacli.js");
    await writeFile(binPath, "old binary content", "utf8");

    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(binPath, { fetchImpl });
    assert.equal(result.updated, false);
    assert.match(result.reason, /network unreachable/);
    assert.equal(await readFile(binPath, "utf8"), "old binary content");
  }));

test("checkAndApplyUpdate reports failure (not a throw) when the manifest is malformed", () =>
  withTempDir(async (dir) => {
    const binPath = join(dir, "llamacli.js");
    await writeFile(binPath, "old binary content", "utf8");

    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => "not valid json" }) as Response) as typeof fetch;

    const result = await checkAndApplyUpdate(binPath, { fetchImpl });
    assert.equal(result.updated, false);
    assert.equal(await readFile(binPath, "utf8"), "old binary content");
  }));
