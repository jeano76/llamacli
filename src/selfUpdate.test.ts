import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import {
  sha256Hex, parseManifest, updateAvailable, checkAndApplyUpdate, LOCAL_HASH_FILE,
  updateRefusedForCheckout, selfUpdateForced, readAppliedUpdate, readWithProgress,
} from "./selfUpdate.js";
import { APPLIED_UPDATE_FILE } from "./buildStamp.js";

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
    // Relative archive name + cwd: GNU tar (Git for Windows) reads "C:\\..." as host "C" + path.
    await execFileAsync("tar", ["-czf", basename(archivePath), "-C", srcDir, "."], { cwd: dirname(archivePath) });
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

test("checkAndApplyUpdate calls onUpdateFound exactly once, before the archive download, only when an update is actually available", () =>
  withTempDir(async (distDir) => {
    // Reported directly: "업데이트 시작과 종료를 명시적으로 알려줘야
    // 하고" — the caller (index.tsx) needs a hook to announce the update
    // BEFORE the download/verify/install work starts, not only after
    // everything already finished, or the process-exit-and-restart
    // transition reads as a crash instead of an update in progress.
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");

    const { bytes: newArchive, sha256: newSha256 } = await buildFixtureArchive({ "index.js": "new index.js" });
    const manifestBody = JSON.stringify({ version: "v20260925", sha256: newSha256 });

    const calls: string[] = [];
    const foundManifests: Array<{ version: string; sha256: string }> = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url.endsWith("manifest.json") ? "manifest" : "archive");
      if (url.endsWith("manifest.json")) return { ok: true, status: 200, text: async () => manifestBody } as Response;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => newArchive.buffer.slice(newArchive.byteOffset, newArchive.byteOffset + newArchive.byteLength),
      } as Response;
    }) as typeof fetch;

    const result = await checkAndApplyUpdate(distDir, {
      fetchImpl,
      onUpdateFound: (manifest) => foundManifests.push(manifest),
    });

    assert.equal(result.updated, true);
    assert.equal(foundManifests.length, 1, "onUpdateFound must fire exactly once");
    assert.equal(foundManifests[0].version, "v20260925");
    // The callback must fire before the archive is fetched, not after —
    // that's the entire point (announce before the work, not after).
    assert.deepEqual(calls, ["manifest", "archive"]);
  }));

test("checkAndApplyUpdate never calls onUpdateFound when already up to date", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "a".repeat(64), "utf8");
    const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: "v1", sha256: "a".repeat(64) }) }) as Response) as typeof fetch;

    let fired = false;
    const result = await checkAndApplyUpdate(distDir, { fetchImpl, onUpdateFound: () => { fired = true; } });

    assert.equal(result.updated, false);
    assert.equal(fired, false);
  }));

test("checkAndApplyUpdate never calls onUpdateFound when the manifest fetch itself fails", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old index.js", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");
    const fetchImpl = (async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch;

    let fired = false;
    const result = await checkAndApplyUpdate(distDir, { fetchImpl, onUpdateFound: () => { fired = true; } });

    assert.equal(result.updated, false);
    assert.equal(fired, false);
  }));

// ── the opt-out ─────────────────────────────────────────────────────────────
// Added after the updater silently replaced a local `npm run build` during
// terminal-compatibility testing: it downloads the published archive straight
// over dist/, so you end up testing the published binary and believing you
// tested your change, with no way to stop it.

test("LLAMACLI_NO_UPDATE=1 disables the check entirely — no fetch, no write", async () => {
  await withTempDir(async (dir) => {
    // A fetchImpl that throws if called at all: the opt-out has to be
    // absolute, not merely "skip the install step".
    const boom = (async () => {
      throw new Error("network must not be touched when self-update is disabled");
    }) as unknown as typeof fetch;
    const result = await checkAndApplyUpdate(dir, {
      fetchImpl: boom,
      env: { LLAMACLI_NO_UPDATE: "1" },
    });
    assert.equal(result.updated, false);
    assert.match(result.reason, /LLAMACLI_NO_UPDATE/);
  });
});

test("the update URLs are overridable from the environment", async () => {
  await withTempDir(async (dir) => {
    // A real tar.gz of a dist tree, so the install path actually runs and
    // the archive fetch is reached. The manifest's sha256 has to be the real
    // one or the install correctly bails on a hash mismatch before fetching.
    const stage = join(dir, "staged");
    await mkdir(join(stage, "tui"), { recursive: true });
    await writeFile(join(stage, "index.js"), "console.log('new')\n");
    await writeFile(join(stage, "tui", "App.js"), "export const x = 1;\n");
    const tgz = join(dir, "arch.tar.gz");
    await execFileAsync("tar", ["-czf", basename(tgz), "-C", stage, "."], { cwd: dirname(tgz) });
    const bytes = await readFile(tgz);
    const sha = createHash("sha256").update(bytes).digest("hex");

    // A local build hash is required before the archive is even fetched
    // (that comparison is the whole "is there an update" decision), so the
    // dist dir needs one that differs from the manifest's.
    await writeFile(join(dir, LOCAL_HASH_FILE), "0000");

    const archiveUrl = "https://example.invalid/arch.tar.gz";
    const manifestUrl = "https://example.invalid/manifest.json";
    const seen: string[] = [];
    const fetchImpl = (async (u: any) => {
      seen.push(String(u));
      if (String(u) === manifestUrl) {
        return new Response(JSON.stringify({ version: "v9", sha256: sha }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkAndApplyUpdate(dir, {
      fetchImpl,
      env: { LLAMACLI_UPDATE_MANIFEST_URL: manifestUrl, LLAMACLI_UPDATE_ARCHIVE_URL: archiveUrl },
    });
    assert.ok(seen.includes(manifestUrl), "should have fetched the overridden manifest URL");
    assert.ok(seen.includes(archiveUrl), "should have fetched the overridden archive URL");
    assert.equal(result.updated, true, `install did not complete: ${result.reason}`);
  });
});

test("with no opt-out set, the default URLs are still used", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = [];
    const fetchImpl = (async (u: any) => {
      seen.push(String(u));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    await checkAndApplyUpdate(dir, { fetchImpl, env: {} });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /manifest\.json$/);
  });
});

// ── never clobber a developer's build ────────────────────────────────────────
//
// This is the root cause behind "my fix compiled, the tests pass, and running
// the tool shows the old behaviour anyway", hit three times in a row while
// fixing an unrelated llama-server bug. The sequence, every time:
//
//   1. npm run build          → dist/ is correct
//   2. llamacli               → startup self-update runs
//   3. local sha != GitHub sha → true for ANY local build, by definition
//   4. download + extract     → the published archive lands on top of dist/
//
// Step 4 leaves the sources holding the change and the running program without
// it, which reads as a compiler failure. The published archive carries the
// published build's mtimes and tar restores them, so every file in dist/ then
// bears a date that is not the local build's — that discrepancy was the only
// thing that identified it.

/**
 * Runs `fn` with a live directory. `withTempDirReturning` cannot be used for
 * the cases below: it cleans up in a `finally` that runs before the caller
 * ever sees the path, so every assertion made afterwards is against a deleted
 * tree. The body has to run inside.
 */
async function withLiveDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-checkout-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** dist/ beside src/ — the layout whose contents must never be replaced. */
async function makeCheckout(root: string): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"llamacli"}');
  await writeFile(join(root, "src", "index.tsx"), "export {};");
  await writeFile(join(root, "dist", "index.js"), "// published build\n");
  return join(root, "dist");
}

/** dist/ with no src/ beside it — an ordinary installed package. */
async function makeInstalled(root: string): Promise<string> {
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.js"), "// old\n");
  return join(root, "dist");
}

/** A fetch double serving one manifest + one archive, counting archive hits. */
function publishDouble(sha256: string, bytes: Buffer) {
  const state = { archiveDownloads: 0, manifestFetches: 0 };
  const impl = (async (url: string) => {
    if (String(url).endsWith("manifest.json")) {
      state.manifestFetches++;
      return new Response(JSON.stringify({ version: "v20261002", sha256 }), { status: 200 });
    }
    state.archiveDownloads++;
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, state };
}

test("a checkout's dist/ is never overwritten by a published update", async () => {
  await withLiveDir(async (root) => {
    const distDir = await makeCheckout(root);
    const before = await readFile(join(distDir, "index.js"), "utf8");

    const { impl, state } = publishDouble("a".repeat(64), Buffer.from("unused"));
    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });

    assert.equal(result.updated, false);
    assert.match(result.reason ?? "", /source checkout/);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), before, "dist/ must be untouched");
    assert.equal(state.manifestFetches, 0, "the refusal must happen before any network call");
  });
});

test("LLAMACLI_FORCE_UPDATE=1 opts back in, for a developer who means it", async () => {
  await withLiveDir(async (root) => {
    const distDir = await makeCheckout(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// from github\n" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const { impl } = publishDouble(sha256, bytes);

    const result = await checkAndApplyUpdate(distDir, {
      env: { LLAMACLI_FORCE_UPDATE: "1" },
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });

    assert.equal(result.updated, true, result.reason);
    assert.match(await readFile(join(distDir, "index.js"), "utf8"), /from github/);
  });
});

test("an installed package still self-updates — the fix is not a blanket disable", async () => {
  // The whole point of detecting a checkout rather than disabling updates.
  await withLiveDir(async (root) => {
    const distDir = await makeInstalled(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// new\n" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const { impl } = publishDouble(sha256, bytes);

    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });

    assert.equal(result.updated, true, result.reason);
    assert.match(await readFile(join(distDir, "index.js"), "utf8"), /new/);
  });
});

test("updateRefusedForCheckout decides without touching the filesystem", () => {
  // Injected so the decision itself is testable independently of the layout,
  // including the case where the layout is exactly what it claims to be.
  const all = () => true;
  const none = () => false;
  assert.equal(updateRefusedForCheckout("/x/dist", {}, all).refused, true);
  assert.equal(updateRefusedForCheckout("/x/dist", {}, none).refused, false);
  assert.equal(updateRefusedForCheckout("/x/dist", { LLAMACLI_FORCE_UPDATE: "1" }, all).refused, false);
  assert.match(updateRefusedForCheckout("/x/dist", {}, all).reason ?? "", /LLAMACLI_FORCE_UPDATE/);
  assert.equal(selfUpdateForced({ LLAMACLI_FORCE_UPDATE: "1" }), true);
  assert.equal(selfUpdateForced({ LLAMACLI_FORCE_UPDATE: "0" }), false);
  assert.equal(selfUpdateForced({ LLAMACLI_FORCE_UPDATE: "true" }), false);
});

test("LLAMACLI_NO_UPDATE=1 still wins over everything, including the force flag", async () => {
  await withLiveDir(async (root) => {
    const distDir = await makeCheckout(root);
    const result = await checkAndApplyUpdate(distDir, {
      env: { LLAMACLI_NO_UPDATE: "1", LLAMACLI_FORCE_UPDATE: "1" },
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.updated, false);
    assert.match(result.reason ?? "", /NO_UPDATE/);
  });
});

// ── an update that did not take must not loop ────────────────────────────────

test("a successful install records the sha it applied", async () => {
  await withLiveDir(async (root) => {
    const distDir = await makeInstalled(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// applied\n" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const { impl } = publishDouble(sha256, bytes);

    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });
    assert.equal(result.updated, true, result.reason);
    assert.equal(await readAppliedUpdate(distDir), sha256);
  });
});

test("the same sha is not re-applied on the next startup — the restart loop breaks", async () => {
  // Without this, an extraction that "succeeds" without taking effect loops
  // forever: each pass writes LOCAL_HASH_FILE from the manifest, restarts,
  // sees the same mismatch, downloads again. Reported live as the terminal
  // silently dropping to a bare shell prompt and coming back.
  await withLiveDir(async (root) => {
    const distDir = await makeInstalled(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// applied\n" });
    // Stands in for the pre-update build, which by definition is not the
    // published one — otherwise there is no update to apply and the loop this
    // guards against never starts.
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const first = publishDouble(sha256, bytes);

    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: first.impl,
    });
    assert.equal(result.updated, true, result.reason);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "// applied\n");

    // The next startup sees LOCAL_HASH_FILE rewritten to the manifest's sha and
    // STILL disagrees — which is the state the marker exists to catch.
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const second = publishDouble(sha256, bytes);
    const again = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: second.impl,
    });

    assert.equal(again.updated, false);
    assert.match(again.reason ?? "", /did not take effect/);
    assert.equal(second.state.archiveDownloads, 0, "the archive must not be downloaded again");
    assert.equal(await readAppliedUpdate(distDir), sha256);
  });
});

test("a different published sha is still applied after a previous one", async () => {
  // The marker gates on the SPECIFIC sha, not on having updated before —
  // otherwise the second genuine update would be refused as a repeat.
  await withLiveDir(async (root) => {
    const distDir = await makeInstalled(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// second\n" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "1".repeat(64));
    await writeFile(join(distDir, APPLIED_UPDATE_FILE), "2".repeat(64));
    const { impl } = publishDouble(sha256, bytes);

    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });
    assert.equal(result.updated, true, result.reason);
  });
});

test("an absent or junk applied-marker is ignored rather than fatal", async () => {
  await withLiveDir(async (dir) => {
    assert.equal(await readAppliedUpdate(dir), null);
    await writeFile(join(dir, APPLIED_UPDATE_FILE), "not-a-sha");
    assert.equal(await readAppliedUpdate(dir), null, "a malformed marker must not gate anything");
  });
});

test("a genuine newer build after a mismatched one is not mistaken for a stuck loop", async () => {
  // The guard above must not become a permanent disable: once the local build
  // agrees with what the updater applied, a later, different published sha has
  // to go through.
  await withLiveDir(async (root) => {
    const distDir = await makeInstalled(root);
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "// v2\n" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "0".repeat(64));
    const { impl } = publishDouble(sha256, bytes);
    const result = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: impl,
    });
    assert.equal(result.updated, true, result.reason);
    // Now local == manifest, so the ordinary path reports up-to-date.
    const quiet = publishDouble(sha256, bytes);
    const next = await checkAndApplyUpdate(distDir, {
      env: {},
      manifestUrl: "https://example.test/manifest.json",
      archiveUrl: "https://example.test/dist.tar.gz",
      fetchImpl: quiet.impl,
    });
    assert.equal(next.updated, false);
    assert.match(next.reason ?? "", /up to date/);
  });
});

// ── the archive download shows progress ─────────────────────────────────────

function streamed(body: Buffer, chunk: number, withLength = true): Response {
  let i = 0;
  const rs = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= body.length) return c.close();
      c.enqueue(new Uint8Array(body.subarray(i, i + chunk)));
      i += chunk;
    },
  });
  return new Response(rs, { status: 200, headers: withLength ? { "content-length": String(body.length) } : {} });
}

test("readWithProgress returns the exact bytes and reports growing progress up to 100%", async () => {
  const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const seen: { received: number; percent: number }[] = [];
  let t = 0;
  const out = await readWithProgress(streamed(body, 700), "x", (p) => seen.push({ received: p.receivedBytes, percent: p.percent }), () => (t += 200));
  assert.deepEqual(out, body);
  assert.ok(seen.length >= 3, "several updates for a multi-chunk body");
  assert.ok(seen.every((s, i) => i === 0 || s.received >= seen[i - 1].received), "monotonic");
  assert.equal(seen[seen.length - 1].percent, 100);
});

test("readWithProgress without Content-Length still reports bytes (percent unknown)", async () => {
  const body = Buffer.alloc(3000, 1);
  const seen: number[] = [];
  const out = await readWithProgress(streamed(body, 1000, false), "x", (p) => seen.push(p.percent), () => 1e9);
  assert.equal(out.length, 3000);
  assert.ok(seen.length >= 2, "bytes are reported even when the total is unknown");
});

test("without a progress callback the body is read as before", async () => {
  const body = Buffer.alloc(100, 7);
  assert.deepEqual(await readWithProgress(streamed(body, 10), "x"), body);
});

test("checkAndApplyUpdate reports download progress while installing", () =>
  withTempDir(async (distDir) => {
    await writeFile(join(distDir, "index.js"), "old", "utf8");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "new" });
    const manifestBody = JSON.stringify({ version: "v1", sha256 });
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("manifest.json")) return { ok: true, status: 200, text: async () => manifestBody } as Response;
      return streamed(Buffer.from(bytes), 64);
    }) as typeof fetch;
    const seen: number[] = [];
    const r = await checkAndApplyUpdate(distDir, { fetchImpl, onProgress: (p) => seen.push(p.receivedBytes) });
    assert.equal(r.updated, true, r.reason);
    assert.ok(seen.length > 1 && seen[seen.length - 1] === bytes.length, `progress ended at ${seen[seen.length - 1]} of ${bytes.length}`);
  }));

test("checkForUpdate reports availability without downloading anything", () =>
  withTempDir(async (distDir) => {
    const newSha = "c".repeat(64);
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");
    let archiveRequested = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith(".tar.gz")) { archiveRequested = true; throw new Error("must not fetch archive during check"); }
      return { ok: true, status: 200, text: async () => JSON.stringify({ version: "20990101-abcd", sha256: newSha }) };
    }) as unknown as typeof fetch;
    const { checkForUpdate } = await import("./selfUpdate.js");
    const r = await checkForUpdate(distDir, { fetchImpl });
    assert.equal(r.available, true);
    assert.equal(r.available && r.manifest.sha256, newSha);
    assert.equal(archiveRequested, false, "check must not touch the network beyond the manifest");
  }));

test("checkForUpdate says up to date when hashes match, and never throws offline", () =>
  withTempDir(async (distDir) => {
    const { checkForUpdate } = await import("./selfUpdate.js");
    await writeFile(join(distDir, LOCAL_HASH_FILE), "c".repeat(64), "utf8");
    const same = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: "x", sha256: "c".repeat(64) }) })) as unknown as typeof fetch;
    assert.equal((await checkForUpdate(distDir, { fetchImpl: same })).available, false);
    const down = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const r = await checkForUpdate(distDir, { fetchImpl: down });
    assert.equal(r.available, false, "offline must be a quiet no, not a throw");
  }));

test("applyUpdate installs a checked manifest (download→double-verify→extract)", () =>
  withTempDir(async (distDir) => {
    const { applyUpdate } = await import("./selfUpdate.js");
    const { bytes, sha256 } = await buildFixtureArchive({ "index.js": "new" });
    await writeFile(join(distDir, LOCAL_HASH_FILE), "b".repeat(64), "utf8");
    const fetchImpl = (async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes })) as unknown as typeof fetch;
    const r = await applyUpdate(distDir, { version: "20990101-abcd", sha256 }, { fetchImpl });
    assert.equal(r.updated, true, `apply failed: ${r.reason}`);
    assert.equal(await readFile(join(distDir, "index.js"), "utf8"), "new");
  }));

test("askUpdateConfirm: y/Enter yes, n no, EOF no", async () => {
  const { askUpdateConfirm } = await import("./selfUpdate.js");
  const { Readable, Writable } = await import("node:stream");
  const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
  const ask = (input: string | null) =>
    askUpdateConfirm({ version: "v", sha256: "c".repeat(64) }, {
      input: input === null ? Readable.from([]) : Readable.from([input]),
      output: sink(),
    });
  assert.equal(await ask("y\n"), true);
  assert.equal(await ask("\n"), true, "plain Enter keeps the historical auto-update default");
  assert.equal(await ask("n\n"), false);
  assert.equal(await ask(null), false, "a piped/closed stdin must never trigger an install");
});
