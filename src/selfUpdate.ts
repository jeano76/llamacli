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
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { isSourceCheckout, APPLIED_UPDATE_FILE } from "./buildStamp.js";
import { extractTarGz } from "./setup/tarGz.js";
import { Transfer, type TransferProgress } from "./setup/download.js";

const { existsSync } = fs;

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

/** The sha of the archive the last successful install claims to have applied,
 *  or null when there has never been one or the file is unreadable. */
export async function readAppliedUpdate(distDir: string): Promise<string | null> {
  try {
    const value = (await readFile(join(distDir, APPLIED_UPDATE_FILE), "utf8")).trim().toLowerCase();
    return SHA256_HEX_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/jeano76/llamacli/main/bin/manifest.json";
export const DEFAULT_ARCHIVE_URL = "https://raw.githubusercontent.com/jeano76/llamacli/main/bin/llamacli-dist.tar.gz";

/**
 * Opt-outs. Both matter for anyone who is *developing* this tool rather
 * than just using it.
 *
 * `LLAMACLI_NO_UPDATE=1` was a real gap, hit while building this: the
 * updater downloads the published archive straight over `dist/`, so
 * `npm run build` followed by one launch was silently undone — you end up
 * testing the published binary and believing you tested your change. There
 * was no way to turn it off, and no equivalent of npm's `--ignore-scripts`.
 *
 * The URLs are overridable for the same reason (point them at a local
 * manifest to test the update path itself without publishing).
 */
export function selfUpdateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLAMACLI_NO_UPDATE === "1";
}

/** The escape hatch for "I really do want the published build here".
 *
 *  Separate from `LLAMACLI_NO_UPDATE=1` on purpose. That one means "stop
 *  touching my dist at all"; this one means "yes, I understand this is a
 *  checkout, overwrite it anyway" — a deliberate act that destroys local work,
 *  so it should never be the default response to running the tool. */
export function selfUpdateForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLAMACLI_FORCE_UPDATE === "1";
}

/**
 * Refuses to install an update when `distDir` belongs to a source checkout.
 *
 * This is the root cause of "my change compiled, the tests pass, and the
 * program still behaves as if it were never written" — reproduced three times
 * while fixing a llama-server build-mismatch bug, each time as:
 *
 *   1. `npm run build`, `grep` confirms the new symbol is in dist/.
 *   2. `llamacli` is run to try the change.
 *   3. Startup compares the local build's sha256 to the published one, sees a
 *      difference — which for ANY local build is guaranteed, since it is not
 *      the published build — downloads the published archive and extracts it
 *      over dist/.
 *   4. The local build is gone, replaced byte for byte by the published one.
 *
 * Step 4 is invisible from the outside: the sources still have the change, so
 * the natural conclusion is a compiler or file-watcher problem. The giveaway is
 * that every file in dist/ then carries the *published* build's mtime, because
 * `tar` restores archived mtimes.
 *
 * For an installed user the overwritten directory is disposable. For someone
 * building llamacli it is the only copy of the work they just did, so the
 * default has to be refusal. The cost is one missed auto-update for a
 * developer, against silently reverting their work; `LLAMACLI_FORCE_UPDATE=1`
 * picks the other trade explicitly.
 */
export function updateRefusedForCheckout(
  distDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): { refused: boolean; reason?: string } {
  if (!isSourceCheckout(distDir, exists)) return { refused: false };
  if (selfUpdateForced(env)) return { refused: false };
  return {
    refused: true,
    reason:
      `refusing to self-update over a source checkout (${distDir}) — it would ` +
      `replace the local build with the published one. Set ` +
      `LLAMACLI_FORCE_UPDATE=1 to do it anyway.`,
  };
}

export type UpdateStage =
  | "manifest"
  | "download"
  | "verify"
  | "extract";

export const UPDATE_STAGE_LABEL: Record<UpdateStage, string> = {
  manifest: "원격 매니페스트 확인 중",
  download: "아카이브 다운로드 중",
  verify: "해시 검증 중",
  extract: "압축 푸는 중",
};

export interface SelfUpdateResult {
  updated: boolean;
  reason: string;
}

/** Reads a response body fully, reporting byte progress as it arrives (the whole archive used to be awaited in
 *  one `arrayBuffer()` call, so nothing could be shown while it downloaded). Total comes from Content-Length;
 *  without it the bar shows bytes received only. */
export async function readWithProgress(
  res: Response,
  label: string,
  onProgress?: (p: TransferProgress) => void,
  now: () => number = Date.now
): Promise<Buffer> {
  const total = Number(res.headers?.get?.("content-length") ?? 0);
  if (!onProgress || !res.body) return Buffer.from(await res.arrayBuffer());
  const transfer = new Transfer(label, Number.isFinite(total) && total > 0 ? total : 0, now);
  const chunks: Buffer[] = [];
  const reader = res.body.getReader();
  let last = 0;
  onProgress(transfer.progress());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    transfer.add(value.byteLength);
    const t = now();
    if (t - last >= 100) { last = t; onProgress(transfer.progress()); }
  }
  onProgress(transfer.progress());
  return Buffer.concat(chunks);
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
    // Reported directly: the update-and-restart transition looked like a
    // malfunction — the process just silently exited back to a bare shell
    // prompt with nothing explaining why. Fired once an update is actually
    // confirmed available (never on "already up to date" or a failure), so
    // the caller can announce it clearly BEFORE the download/verify/install
    // work starts, not only after everything already succeeded.
    onUpdateFound?: (manifest: UpdateManifest) => void;
    /**
     * Reports each stage as it BEGINS, with the elapsed time since startup.
     *
     *  The update banner used to be one block of text printed once, after which
     *  the process went silent for the whole download-and-install. Nothing said
     *  which stage was running, so a slow step was indistinguishable from a
     *  hang — and before the manifest resolves there was no output AT ALL, so
     *  the worst case (a slow or unreachable GitHub) looked exactly like a
     *  frozen startup.
     *
     *  `elapsedMs` is there so the caller can show that time is passing. A stage
     *  with no elapsed time looks stalled whether or not it is; the same stage
     *  with "(7초)" reads as working.
     */
    onStage?: (stage: UpdateStage, elapsedMs: number) => void;
    /** Byte progress of the archive download (received / total / speed / ETA), so a slow link reads as
     *  progress rather than a frozen startup. Not called when there is nothing to download. */
    onProgress?: (p: TransferProgress) => void;
    /** Injected so the opt-out and URL overrides are testable without
     *  mutating the real process environment. */
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<SelfUpdateResult> {
  // Checked first so the opt-out is absolute: no manifest fetch, no archive
  // download, and above all no write to dist/. See selfUpdateDisabled's
  // comment for why this matters when working on the tool itself.
  // Every stage is timed from here, and announced when it BEGINS rather than
  // when it ends -- so the user is told what is happening while it happens.
  const startedAt = Date.now();
  const stage = (name: UpdateStage) => opts.onStage?.(name, Date.now() - startedAt);

  if (selfUpdateDisabled(opts.env)) {
    return { updated: false, reason: "self-update disabled via LLAMACLI_NO_UPDATE=1" };
  }
  // Before any network call, and for the same reason as the opt-out above:
  // the answer cannot change what is already on disk, so there is nothing to
  // learn from asking GitHub. See updateRefusedForCheckout for the failure
  // this prevents — it is the one that silently reverted three local builds.
  const refusal = updateRefusedForCheckout(distDir, opts.env ?? process.env);
  if (refusal.refused) {
    return { updated: false, reason: refusal.reason! };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const manifestUrl = opts.manifestUrl ?? opts.env?.LLAMACLI_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
  const archiveUrl = opts.archiveUrl ?? opts.env?.LLAMACLI_UPDATE_ARCHIVE_URL ?? DEFAULT_ARCHIVE_URL;

  // Announced BEFORE the request, not after it succeeds. This window is where a
  // slow or unreachable GitHub used to produce total silence: the process had
  // started, printed nothing, and looked frozen until the timeout fired.
  stage("manifest");
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

  // Loop breaker. Reaching here means the manifest's sha disagrees with what
  // this dist/ records about itself. If the sha we last CLAIMED to install is
  // this same one, then a previous startup already downloaded and extracted
  // this exact archive, wrote LOCAL_HASH_FILE from the manifest anyway, and
  // the disagreement survived — so the bytes that run are still not the bytes
  // the manifest describes. Repeating the download cannot fix that; it can only
  // loop forever, because each pass restarts the process and the next pass
  // sees the same mismatch.
  //
  // An extraction that "succeeds" but does not take effect is a real mode
  // here: `tar` missing (Windows), an archive whose entries land somewhere
  // unexpected, or a dist/ tree the process is not actually running from. In
  // every such case the honest outcome is a refusal with an explanation, not
  // an unbounded restart loop.
  const previouslyApplied = await readAppliedUpdate(distDir);
  if (previouslyApplied && previouslyApplied === manifest.sha256.toLowerCase()) {
    return {
      updated: false,
      reason:
        `already applied ${manifest.version} (${manifest.sha256.slice(0, 12)}…) on a previous ` +
        `startup, and this build still doesn't match it — the update did not take effect. ` +
        `Not retrying; run \`npm run build\` to rebuild from source.`,
    };
  }

  opts.onUpdateFound?.(manifest);
  stage("download");

  let downloaded: Buffer;
  try {
    const res = await fetchImpl(archiveUrl, { signal: AbortSignal.timeout(opts.archiveTimeoutMs ?? 30000) });
    if (!res.ok) return { updated: false, reason: `archive fetch failed: HTTP ${res.status}` };
    downloaded = await readWithProgress(res, "llamacli 업데이트", opts.onProgress);
  } catch (err: any) {
    return { updated: false, reason: `archive fetch failed: ${err.message ?? err}` };
  }

  stage("verify");
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
    // Only after BOTH hash checks pass does anything about the actual running
    // dist/ tree change. Extraction prefers `tar` (scripts/update-bin.mjs
    // extracts the same way, and it preserves the permissions the release
    // tarball relies on). On Windows, where no `tar` executable ships by
    // default — the exact bug this fix targets — fall back to a pure-Node
    // gzip+tar extractor below (zero new dependencies), so Windows installs
    // don't silently throw and leave dist/ untouched.
    stage("extract");
    if (process.platform === "win32") {
      // The shared extractor, not a private copy. The copy this replaced unpacked
      // ZERO files out of the real 122-file dist archive: it advanced `pos` by
      // `512 + 512 + size + pad`, double-counting the header and so landing
      // mid-record, AND compared a 6-byte magic field against the 5-character
      // "ustar", which GNU tar writes as "ustar " — every record was skipped. It
      // also resolved its promise before the writes it had issued completed. On
      // Windows that made self-update a no-op that reported success, leaving the
      // next startup to report "the update did not take effect".
      extractTarGz(tmpArchivePath, distDir);
    } else {
      await execFileAsync("tar", ["-xzf", tmpArchivePath, "-C", distDir]);
    }
    await writeFile(join(distDir, LOCAL_HASH_FILE), manifest.sha256);
    // Recorded only after both hash checks and the extraction succeeded, and
    // read back at the next startup as the loop breaker above: the honest
    // signal that this sha was installed here, so a surviving mismatch means
    // the install did not take rather than meaning there is something new.
    await writeFile(join(distDir, APPLIED_UPDATE_FILE), manifest.sha256);
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

// ── Windows extraction fallback ─────────────────────────────────────────────
// The updater extracts the downloaded dist archive OVER the existing one. On
// every other platform that's an execFileAsync("tar") call — but no `tar`
// executable ships on a default Windows install, which is the exact bug this
// fix targets (the exec threw, got swallowed by checkAndApplyUpdate's try/
// catch, and dist/ was left untouched). The pure-Node path is
// setup/tarGz.ts's `extractTarGz` — stdlib only, zero new dependencies, and
// shared with the engine installers so there is one implementation to be
// right.

/** Extract a `.tar.gz` into `destDir`, pure stdlib fallback for `tar` on
 *  Windows (see extract block in checkAndApplyUpdate). Returns a Promise so it
 *  composes with the surrounding `await` flow without blocking the event loop
 *  like gunzipSync would. */
