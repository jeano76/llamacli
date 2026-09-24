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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const binDir = join(root, "bin");
const archivePath = join(binDir, "llamacli-dist.tar.gz");
const manifestPath = join(binDir, "manifest.json");

mkdirSync(binDir, { recursive: true });
// Tar from INSIDE dist/ (-C distDir .) so archive entries are relative
// ("index.js", "tui/App.js", ...) — matches how src/selfUpdate.ts extracts
// it back over an existing dist/ directory.
execFileSync("tar", ["-czf", archivePath, "-C", distDir, "."]);

const archiveContent = readFileSync(archivePath);
const sha256 = createHash("sha256").update(archiveContent).digest("hex");

// Same vYYYYMMDD shape as banner.ts's buildVersionString, computed the same
// way (dist/index.js's own mtime) — so the manifest's version always
// matches what the running CLI's own startup banner would show.
const mtime = statSync(join(distDir, "index.js")).mtime;
const pad = (n) => String(n).padStart(2, "0");
const version = `v${mtime.getFullYear()}${pad(mtime.getMonth() + 1)}${pad(mtime.getDate())}`;

writeFileSync(manifestPath, JSON.stringify({ version, sha256, builtAt: new Date().toISOString() }, null, 2) + "\n");
// The LOCAL side of the comparison selfUpdate.ts's checkAndApplyUpdate()
// makes at every startup — reading this one small file is instant, versus
// re-tarring the whole dist/ tree just to find out nothing changed.
writeFileSync(join(distDir, ".self-update-sha256"), sha256);

console.log(`bin/ updated: ${version} (sha256 ${sha256.slice(0, 12)}…, ${(archiveContent.length / 1024).toFixed(1)} KiB)`);
