#!/usr/bin/env node
// Requested directly: "최신 바이너리 빌드 버전을 github의 bin 폴더에 항상
// 머지" — run as part of `npm run build`, so bin/ is always in sync with
// whatever dist/ was just compiled.
//
// dist/ is TypeScript's per-module ESM output (dist/index.js imports
// dist/tui/App.js, dist/agent/loop.js, ...), not a single bundled file —
// hashing/shipping just dist/index.js alone (an earlier version of this
// script did exactly that) silently misses every change to any file it
// imports, and an "update" that only replaced index.js would leave the
// OTHER files stale or missing entirely at the download site. So the unit
// this publishes, hashes, and self-update installs is the whole dist/
// tree, tarred up.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const binDir = join(root, "bin");
const archivePath = join(binDir, "llamacli-dist.tar.gz");
const manifestPath = join(binDir, "manifest.json");

/** Shipped inside dist/ so an installed copy can name the build it is running.
 *  Kept in step with src/buildStamp.ts's LOCAL_VERSION_FILE. */
const VERSION_FILE = ".llamacli-version";

mkdirSync(binDir, { recursive: true });

// ── build provenance ─────────────────────────────────────────────────────────
// Written BEFORE the archive is taken, so the stamp ships inside it: an
// installed copy can say which src/ tree it came from, and — more to the point
// — a build that produced nothing still gets recorded as having produced
// nothing, instead of leaving a stale stamp that claims otherwise.
//
// hashTree comes from the just-compiled dist/, not from a second copy written
// here. Two implementations of one hashing scheme is two hashes waiting to
// disagree, and a disagreement shows up as a permanently "stale" build with no
// way to clear it. If dist/buildStamp.js is missing the build fails right here,
// which is the correct outcome: tsc did not emit what it was supposed to.
const stampModule = await import(pathToFileURL(join(distDir, "buildStamp.js")).href).catch((err) => {
  console.error(
    `build stamp unavailable: ${distDir}/buildStamp.js could not be imported (${err?.message ?? err}).\n` +
      `The build did not emit its output — check tsc's errors above.`
  );
  process.exit(1);
});
const { hashTree, writeBuildStamp } = stampModule;
const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const srcHash = hashTree(join(root, "src"));

// `vYYYYMMDD-<sha>`: the build date, then the commit it was built from.
//
// The date used to stand alone, taken from dist/index.js's mtime, and that made
// two builds on the same day indistinguishable: this repo shipped one at 03:21
// and another at 03:53 and both were `v20261002`. Nothing about the artifact
// said which was newer, so a rebuild looked like it had never been published.
// The sha is what actually distinguishes one build from another, and it doubles
// as provenance — the archive can name the commit it came from.
//
// Falls back to the bare date when git is unavailable or the tree is not a
// checkout (an exported tarball, a shallow copy with no .git): the date is still
// true, just not unique. `unknown` likewise — never a hash, because a bogus
// "sha" in a version string reads as a real provenance claim.
const mtime = statSync(join(distDir, "index.js")).mtime;
const pad = (n) => String(n).padStart(2, "0");
const date = `${mtime.getFullYear()}${pad(mtime.getMonth() + 1)}${pad(mtime.getDate())}`;
const shortSha = /^[0-9a-f]{7,40}$/.test(gitSha) ? gitSha.slice(0, 7) : null;
const version = shortSha ? `v${date}-${shortSha}` : `v${date}`;

// Written BEFORE the archive is taken, so it ships inside it. The banner reads
// this to show the same string the manifest carries; without it in the archive an
// installed copy could not know its own sha and would fall back to guessing the
// version from its file mtime, which is exactly the ambiguity this removes.
//
// Deliberately NOT the build stamp (dist/.build-stamp.json). That one claims a
// srcHash for the tree on disk, so overwriting a developer's with the published
// tree's would make their checkout look fresh when it is not. This file claims
// only which build these bytes are, which stays true after an overwrite.
writeFileSync(join(distDir, VERSION_FILE), version + "\n");

// Tar from INSIDE dist/ (-C distDir .) so archive entries are relative
// ("index.js", "tui/App.js", ...) — matches how src/selfUpdate.ts extracts
// it back over an existing dist/ directory.
execFileSync("tar", ["-czf", archivePath, "-C", distDir, "."]);

const archiveContent = readFileSync(archivePath);
const sha256 = createHash("sha256").update(archiveContent).digest("hex");

writeFileSync(manifestPath, JSON.stringify({ version, sha256, builtAt: new Date().toISOString() }, null, 2) + "\n");
// The LOCAL side of the comparison selfUpdate.ts's checkAndApplyUpdate()
// makes at every startup — reading this one small file is instant, versus
// re-tarring the whole dist/ tree just to find out nothing changed.
writeFileSync(join(distDir, ".self-update-sha256"), sha256);

// Written last so it is never ahead of the archive it describes. The archive
// deliberately does NOT contain this stamp: a self-update extracts over dist/,
// and shipping the stamp inside the archive would overwrite the local one with
// a claim about the published tree, making a developer's checkout look fresh
// after being overwritten — the exact failure this exists to make visible.
writeBuildStamp(distDir, { srcHash, gitSha, builtAt: new Date().toISOString(), version });

console.log(`bin/ updated: ${version} (sha256 ${sha256.slice(0, 12)}…, ${(archiveContent.length / 1024).toFixed(1)} KiB)`);
console.log(`build stamp: src ${srcHash.slice(0, 12)}… @ ${gitSha.slice(0, 7)}`);
