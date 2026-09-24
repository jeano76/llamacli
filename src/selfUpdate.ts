/** Self-update: checks GitHub for a newer dist/ build at startup, verifies
 *  it by hash BEFORE writing it to disk and AGAIN by re-reading the
 *  written file AFTER, and only then extracts it and restarts — requested
 *  directly: "최신 바이너리 빌드 버전을 github의 bin 폴더에 항상 머지하고
 *  CLI 구동시 신규 버전의 바이너리가 github에 존재를 하면 해당 버전을
 *  업데이트 하고 cli는 재구동을 하는 기능을 넣어줘. 바이너리 변경은 해쉬
 *  값으로 확인하고 설치 이후 업데이트 전 반드시 해쉬 값으로 증명을 해야
 *  됨" — and the explicit fallback: "네트웍이 불가능하거나 ... 해쉬값
 *  검사시에 일치하지 않으면 그냥 현재 버전의 cli를 구동하는거야".
 *
 *  What ships is dist/ as a whole (tarred), not a single JS file. dist/ is
 *  TypeScript's per-module ESM output — dist/index.js imports
 *  dist/tui/App.js, dist/agent/loop.js, and so on — so hashing/replacing
 *  index.js alone would silently miss every change to a file it imports.
 *  See scripts/update-bin.mjs, which produces bin/manifest.json and
 *  bin/llamacli-dist.tar.gz from the real dist/ output.
 *
 *  What the hash check proves and what it doesn't: it proves the bytes
 *  written to disk are exactly the bytes the manifest declared (catching
 *  transfer corruption and a partial/interrupted write) — it does NOT
 *  prove those bytes are trustworthy in the first place. A compromised
 *  GitHub repo could publish a malicious archive with a matching hash for
 *  itself. That's an inherent limit of this design (no code signing), not
 *  a bug in it. */

import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface UpdateManifest {
  version: string;
  sha256: string;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function parseManifest(json: string): UpdateManifest {
  const parsed = JSON.parse(json);
  if (typeof parsed?.version !== "string" || typeof parsed?.sha256 !== "string" || !SHA256_HEX_RE.test(parsed.sha256)) {
    throw new Error("malformed update manifest (expected {version: string, sha256: 64-hex-char string})");
  }
  return { version: parsed.version, sha256: parsed.sha256.toLowerCase() };
}

/** Compares HASHES, not version strings — the version is just a
 *  human-readable build date; two different builds made on the same day
 *  would otherwise look identical and never update. */
export function updateAvailable(localSha256: string, manifest: UpdateManifest): boolean {
  return manifest.sha256.toLowerCase() !== localSha256.toLowerCase();
}

/** Name of the small local file (written by scripts/update-bin.mjs, next
 *  to index.js) holding the running build's own archive sha256 — reading
 *  this one file is instant, versus re-tarring the whole dist/ tree on
 *  every startup just to find out nothing changed. */
export const LOCAL_HASH_FILE = ".self-update-sha256";

export const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/jeano76/llamacli/main/bin/manifest.json";
export const DEFAULT_ARCHIVE_URL = "https://raw.githubusercontent.com/jeano76/llamacli/main/bin/llamacli-dist.tar.gz";

export interface SelfUpdateResult {
  updated: boolean;
  reason: string;
}

/** The actual check-and-install. `fetchImpl`/URLs are injectable so this
 *  is testable without a real network call or a real GitHub repo.
 *  `distDir` is the running build's own dist/ directory (index.js's own
 *  dirname) — both what's compared against and what gets overwritten.
 *  Every failure path (network, malformed manifest, hash mismatch,
 *  extract failure) returns `updated: false` and leaves the existing
 *  dist/ directory completely untouched — never a partial or unverified
 *  install. */
export async function checkAndApplyUpdate(
  distDir: string,
  opts: {
    fetchImpl?: typeof fetch;
    manifestUrl?: string;
    archiveUrl?: string;
    manifestTimeoutMs?: number;
    archiveTimeoutMs?: number;
  } = {}
): Promise<SelfUpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const manifestUrl = opts.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const archiveUrl = opts.archiveUrl ?? DEFAULT_ARCHIVE_URL;

  let manifest: UpdateManifest;
  try {
    const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(opts.manifestTimeoutMs ?? 5000) });
    if (!res.ok) return { updated: false, reason: `manifest fetch failed: HTTP ${res.status}` };
    manifest = parseManifest(await res.text());
  } catch (err: any) {
    return { updated: false, reason: `manifest fetch failed: ${err.message ?? err}` };
  }

  let localSha256: string;
  try {
    localSha256 = (await readFile(join(distDir, LOCAL_HASH_FILE), "utf8")).trim();
  } catch (err: any) {
    return { updated: false, reason: `couldn't read local build hash: ${err.message ?? err}` };
  }

  if (!updateAvailable(localSha256, manifest)) {
    return { updated: false, reason: "already up to date" };
  }

  let downloaded: Buffer;
  try {
    const res = await fetchImpl(archiveUrl, { signal: AbortSignal.timeout(opts.archiveTimeoutMs ?? 30000) });
    if (!res.ok) return { updated: false, reason: `archive fetch failed: HTTP ${res.status}` };
    downloaded = Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    return { updated: false, reason: `archive fetch failed: ${err.message ?? err}` };
  }

  // Verify #1: the downloaded bytes, before anything touches disk.
  if (sha256Hex(downloaded) !== manifest.sha256) {
    return { updated: false, reason: "downloaded archive's hash doesn't match the manifest — refusing to install it" };
  }

  const tmpArchivePath = join(distDir, `.self-update-tmp-${process.pid}.tar.gz`);
  try {
    await writeFile(tmpArchivePath, downloaded);
    // Verify #2: re-hash from DISK, not the in-memory buffer just written —
    // a corrupted write (full disk, killed mid-write) must never be
    // trusted just because the bytes looked right in memory a moment ago.
    const onDiskSha256 = sha256Hex(await readFile(tmpArchivePath));
    if (onDiskSha256 !== manifest.sha256) {
      return { updated: false, reason: "on-disk hash after write didn't match the manifest — refusing to install it" };
    }
    // Only after BOTH hash checks pass does anything about the actual
    // running dist/ tree change.
    await execFileAsync("tar", ["-xzf", tmpArchivePath, "-C", distDir]);
    await writeFile(join(distDir, LOCAL_HASH_FILE), manifest.sha256);
  } catch (err: any) {
    return { updated: false, reason: `install failed: ${err.message ?? err}` };
  } finally {
    await rm(tmpArchivePath, { force: true }).catch(() => {});
  }

  return { updated: true, reason: `updated to ${manifest.version}` };
}

/** Restarts as a NEW, independent process running the (now updated)
 *  entry point, then lets the caller exit the current one. Detached so it
 *  outlives this process's own exit rather than being killed with it. */
export function spawnRestart(entryPath: string, args: string[] = process.argv.slice(2)): void {
  const child = spawn(process.execPath, [entryPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: true,
  });
  child.unref();
}
