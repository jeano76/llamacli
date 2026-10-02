import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashTree,
  readBuildStamp,
  writeBuildStamp,
  isSourceCheckout,
  checkBuildFreshness,
  stalenessMessage,
  BUILD_STAMP_FILE,
  LOCAL_VERSION_FILE,
  readLocalVersion,
} from "./buildStamp.js";

/**
 * Build provenance. The failure these tests exist for was reproduced three
 * times in a row and misread as a compiler problem:
 *
 *   npm run build  →  dist/ is correct
 *   run llamacli   →  self-update extracts the PUBLISHED archive over dist/
 *   grep dist/     →  the change is gone, and every file carries the published
 *                    build's mtime (tar restores archived mtimes)
 *
 * So the property under test throughout is not "hashing works" but "a dist/
 * that disagrees with its src/ is detectable, and distinguishable from a
 * dist/ that simply has nothing to compare against".
 */

async function tmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-buildstamp-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lays out a checkout: root/{src,dist}. */
async function checkout(root: string, files: Record<string, string> = { "index.tsx": "export {};" }): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"llamacli"}');
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, "src", path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

// ── hashTree ─────────────────────────────────────────────────────────────────

test("hashTree is deterministic across calls", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    const a = hashTree(join(dir, "src"));
    const b = hashTree(join(dir, "src"));
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

test("hashTree does not depend on filesystem enumeration order", async () => {
  // Directories are read in whatever order the OS returns. If the digest were
  // built from that order directly, two identical trees could hash
  // differently and every build would report itself stale forever.
  await tmp(async (dir) => {
    const one = join(dir, "one");
    const two = join(dir, "two");
    await checkout(one, { "z.ts": "z", "a.ts": "a", "m/b.ts": "b", "m/a.ts": "a" });
    await checkout(two, { "m/a.ts": "a", "a.ts": "a", "m/b.ts": "b", "z.ts": "z" });
    assert.equal(hashTree(join(one, "src")), hashTree(join(two, "src")));
  });
});

test("hashTree ignores mtimes — the reason tar-restored dates cannot mask a clobber", async () => {
  // This is the load-bearing property. The original bug was only identifiable
  // because dist/ files carried the published build's mtimes; a hash that
  // included mtimes would have "matched" a freshly extracted tree.
  await tmp(async (dir) => {
    await checkout(dir, { "a.ts": "same" });
    const before = hashTree(join(dir, "src"));
    await utimes(join(dir, "src", "a.ts"), new Date(0), new Date(0));
    assert.equal(hashTree(join(dir, "src")), before);
  });
});

test("hashTree changes when a file's contents change", async () => {
  await tmp(async (dir) => {
    await checkout(dir, { "a.ts": "one" });
    const before = hashTree(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "two");
    assert.notEqual(hashTree(join(dir, "src")), before);
  });
});

test("hashTree changes when a file is renamed, even with identical contents", async () => {
  // Content-only hashing would treat a rename as a no-op. Here the digest is
  // what proves which tree was compiled, so the path has to be part of it.
  await tmp(async (dir) => {
    await checkout(dir, { "old.ts": "same" });
    const before = hashTree(join(dir, "src"));
    await writeFile(join(dir, "src", "new.ts"), "same");
    await rm(join(dir, "src", "old.ts"));
    assert.notEqual(hashTree(join(dir, "src")), before);
  });
});

test("hashTree changes when a file is added or removed", async () => {
  await tmp(async (dir) => {
    await checkout(dir, { "a.ts": "a" });
    const before = hashTree(join(dir, "src"));
    await writeFile(join(dir, "src", "b.ts"), "b");
    const added = hashTree(join(dir, "src"));
    assert.notEqual(added, before);
    await rm(join(dir, "src", "b.ts"));
    assert.equal(hashTree(join(dir, "src")), before, "removal must restore the original digest");
  });
});

test("hashTree skips symlinks instead of following them out of the tree", async () => {
  // A link to content the build never compiled would make the digest describe
  // a tree that does not exist; a cycle would not terminate.
  await tmp(async (dir) => {
    await checkout(dir, { "a.ts": "a" });
    await mkdir(join(dir, "outside"), { recursive: true });
    await writeFile(join(dir, "outside", "secret.ts"), "not part of the build");
    const before = hashTree(join(dir, "src"));
    await symlink(join(dir, "outside", "secret.ts"), join(dir, "src", "link.ts"));
    assert.equal(hashTree(join(dir, "src")), before);
  });
});

test("hashTree of an empty directory is a valid digest, not a throw", async () => {
  await tmp(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    assert.match(hashTree(join(dir, "src")), /^[0-9a-f]{64}$/);
  });
});

// ── stamp read/write ─────────────────────────────────────────────────────────

test("a written stamp reads back with its fields intact", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    const stamp = { srcHash: hashTree(join(dir, "src")), gitSha: "abc1234", builtAt: "2026-10-02T00:00:00.000Z", version: "v20261002" };
    writeBuildStamp(join(dir, "dist"), stamp);
    assert.deepEqual(readBuildStamp(join(dir, "dist")), stamp);
  });
});

test("a missing stamp reads as null rather than throwing", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    assert.equal(readBuildStamp(join(dir, "dist")), null);
  });
});

test("an unreadable stamp reads as null — never as a valid stamp", async () => {
  // A stamp is evidence. A corrupt one must not be able to assert freshness,
  // which is the one claim it is relied upon for.
  await tmp(async (dir) => {
    await checkout(dir);
    await writeFile(join(dir, "dist", BUILD_STAMP_FILE), "{ not json");
    assert.equal(readBuildStamp(join(dir, "dist")), null);
    await writeFile(join(dir, "dist", BUILD_STAMP_FILE), JSON.stringify({ srcHash: "nope" }));
    assert.equal(readBuildStamp(join(dir, "dist")), null);
    await writeFile(join(dir, "dist", BUILD_STAMP_FILE), JSON.stringify({ srcHash: 42 }));
    assert.equal(readBuildStamp(join(dir, "dist")), null);
  });
});

test("a stamp missing optional fields still yields a usable srcHash", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    const srcHash = hashTree(join(dir, "src"));
    await writeFile(join(dir, "dist", BUILD_STAMP_FILE), JSON.stringify({ srcHash }));
    const stamp = readBuildStamp(join(dir, "dist"));
    assert.equal(stamp?.srcHash, srcHash);
    assert.equal(stamp?.gitSha, "unknown");
  });
});

// ── checkout detection ───────────────────────────────────────────────────────

test("a dist/ beside src/ is recognised as a source checkout", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    assert.equal(isSourceCheckout(join(dir, "dist")), true);
  });
});

test("an installed package's dist/ is NOT a checkout", async () => {
  // The updater must keep working for real users. Only a developer running from
  // a checkout is refused, and this is the shape it distinguishes on.
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    assert.equal(isSourceCheckout(join(dir, "dist")), false);
  });
});

test("checkout detection requires both markers, not just one", async () => {
  // A stray src/ (a user project vendoring one file) must not disable
  // auto-update, and a package.json without a src entry is not a build tree.
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");
    assert.equal(isSourceCheckout(join(dir, "dist")), false);
  });
});

// ── freshness ────────────────────────────────────────────────────────────────

test("a dist/ built from the src/ beside it is fresh", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    writeBuildStamp(join(dir, "dist"), {
      srcHash: hashTree(join(dir, "src")),
      gitSha: "abc",
      builtAt: "2026-10-02T00:00:00.000Z",
    });
    assert.equal(checkBuildFreshness(join(dir, "dist")).state, "fresh");
  });
});

test("editing src/ after the build is detected as stale", async () => {
  // The property the whole module exists for: after the published archive was
  // extracted over dist/, src/ kept the change and dist/ lost it. That must
  // read as stale rather than looking fine.
  await tmp(async (dir) => {
    await checkout(dir, { "index.tsx": "export const a = 1;" });
    writeBuildStamp(join(dir, "dist"), {
      srcHash: hashTree(join(dir, "src")),
      gitSha: "abc",
      builtAt: "2026-10-02T00:00:00.000Z",
    });
    await writeFile(join(dir, "src", "index.tsx"), "export const a = 2;");
    const freshness = checkBuildFreshness(join(dir, "dist"));
    assert.equal(freshness.state, "stale");
    assert.notEqual(freshness.state === "stale" && freshness.stamp.srcHash, freshness.currentSrcHash);
  });
});

test("a checkout whose build predates stamps reports no-stamp, not stale", async () => {
  // Distinguished deliberately: "this build cannot prove anything" is a
  // different instruction from "your build is out of date", and reporting the
  // latter would send someone to rebuild a perfectly current dist/.
  await tmp(async (dir) => {
    await checkout(dir);
    assert.equal(checkBuildFreshness(join(dir, "dist")).state, "no-stamp");
  });
});

test("an installed package reports not-a-checkout and is never called stale", async () => {
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    assert.equal(checkBuildFreshness(join(dir, "dist")).state, "not-a-checkout");
  });
});

test("freshness accepts an injected existence check", async () => {
  // Needed so the distinction above is testable without inventing a real
  // installed-package layout on disk for every case.
  const pretendCheckout = () => true;
  const pretendInstalled = () => false;
  assert.equal(isSourceCheckout("/nowhere/dist", pretendCheckout), true);
  assert.equal(isSourceCheckout("/nowhere/dist", pretendInstalled), false);
});

// ── the message ──────────────────────────────────────────────────────────────

test("a stale build produces a message naming the fix", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    writeBuildStamp(join(dir, "dist"), { srcHash: "0".repeat(64), gitSha: "abc", builtAt: "2026-10-02T00:00:00.000Z" });
    const msg = stalenessMessage(checkBuildFreshness(join(dir, "dist"))) ?? "";
    assert.match(msg, /npm run build/, "the message must say what to do");
    assert.match(msg, /LLAMACLI_NO_UPDATE/, "and name the other way this state is reached");
  });
});

test("fresh and not-a-checkout say nothing", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    writeBuildStamp(join(dir, "dist"), {
      srcHash: hashTree(join(dir, "src")),
      gitSha: "abc",
      builtAt: "2026-10-02T00:00:00.000Z",
    });
    assert.equal(stalenessMessage(checkBuildFreshness(join(dir, "dist"))), null);
  });
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    assert.equal(stalenessMessage(checkBuildFreshness(join(dir, "dist"))), null);
  });
});

test("a no-stamp checkout is told to build once, and not that it is out of date", async () => {
  await tmp(async (dir) => {
    await checkout(dir);
    const msg = stalenessMessage(checkBuildFreshness(join(dir, "dist"))) ?? "";
    assert.match(msg, /npm run build/);
    assert.doesNotMatch(msg, /오래되었/);
  });
});
// The version a build reports used to come from dist/index.js's mtime, which
// cannot tell two builds from the same day apart: this project published one at
// 03:21 and another at 03:53 and both said `v20261002`. The sha suffix is what
// makes a rebuild distinguishable from the one it replaced.
test("readLocalVersion reports the version the build recorded, sha and all", async () => {
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", LOCAL_VERSION_FILE), "v20261002-55461f7\n");
    assert.equal(readLocalVersion(join(dir, "dist")), "v20261002-55461f7");
  });
});

test("readLocalVersion accepts a bare date for a build with no git sha", async () => {
  // A build outside a checkout has no sha. The date is still true, just not
  // unique, so it is shown rather than hidden.
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", LOCAL_VERSION_FILE), "v20261002");
    assert.equal(readLocalVersion(join(dir, "dist")), "v20261002");
  });
});

test("readLocalVersion returns null when absent or unrecognisable", async () => {
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    // No file — a dist/ built before this change, or a tsx dev run.
    assert.equal(readLocalVersion(join(dir, "dist")), null);
    // Present but not a version string: the banner falls back rather than
    // printing arbitrary file contents into the UI.
    await writeFile(join(dir, "dist", LOCAL_VERSION_FILE), "rm -rf /\n");
    assert.equal(readLocalVersion(join(dir, "dist")), null);
    await writeFile(join(dir, "dist", LOCAL_VERSION_FILE), "v2026\n");
    assert.equal(readLocalVersion(join(dir, "dist")), null);
  });
});

test("two same-day builds are distinguishable only by the sha", async () => {
  // The concrete regression: these two builds were an hour apart and produced
  // byte-identical version strings under the old mtime scheme.
  await tmp(async (dir) => {
    await mkdir(join(dir, "dist"), { recursive: true });
    const path = join(dir, "dist", LOCAL_VERSION_FILE);
    await writeFile(path, "v20261002-55461f7");
    const first = readLocalVersion(join(dir, "dist"));
    await writeFile(path, "v20261002-6bb0635");
    const second = readLocalVersion(join(dir, "dist"));
    assert.equal(first, "v20261002-55461f7");
    assert.equal(second, "v20261002-6bb0635");
    assert.notEqual(first, second);
  });
});
