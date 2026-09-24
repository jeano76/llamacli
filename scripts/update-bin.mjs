#!/usr/bin/env node
// Requested directly: "최신 바이너리 빌드 버전을 github의 bin 폴더에 항상
// 머지" — run as part of `npm run build`, so bin/llamacli.js and
// bin/manifest.json are always in sync with whatever dist/index.js was
// just compiled. manifest.json's sha256 is what src/selfUpdate.ts's
// checkAndApplyUpdate() verifies a downloaded binary against, both before
// AND after writing it to disk.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = join(root, "dist", "index.js");
const binDir = join(root, "bin");
const binPath = join(binDir, "llamacli.js");
const manifestPath = join(binDir, "manifest.json");

const content = readFileSync(distPath);
const sha256 = createHash("sha256").update(content).digest("hex");

// Same vYYYYMMDD shape as banner.ts's buildVersionString, computed the same
// way (dist/index.js's own mtime) — so the manifest's version always
// matches what the running CLI's own startup banner would show for this
// exact build.
const mtime = statSync(distPath).mtime;
const pad = (n) => String(n).padStart(2, "0");
const version = `v${mtime.getFullYear()}${pad(mtime.getMonth() + 1)}${pad(mtime.getDate())}`;

mkdirSync(binDir, { recursive: true });
writeFileSync(binPath, content, { mode: 0o755 });
writeFileSync(manifestPath, JSON.stringify({ version, sha256, builtAt: new Date().toISOString() }, null, 2) + "\n");

console.log(`bin/ updated: ${version} (sha256 ${sha256.slice(0, 12)}…)`);
