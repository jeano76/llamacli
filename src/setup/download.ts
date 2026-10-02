/**
 * Parallel, resumable, observable file downloader.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Requested directly: "초기 모델 바이너리 또는 설치에 필요한 큰 파일을 다운로드
 * 받을 때 다중파일 받기로 속도를 최적화해야 하고, 파일을 다운로드 받는 동안
 * 얼마나 받고 있는지와 남은 완료 시간을 표시해 줘야 해."
 *
 * The naive approach (one `curl`/one fetch, straight to disk) is wrong on both
 * counts, and both failures are specific to the files llamacli actually ships:
 *
 *   1. Speed. The first-run downloads are 5–22 GB GGUF weights. A single TCP
 *      stream to a well-known CDN is routinely 3–10x slower than the same
 *      connection count split across several streams, because a single flow
 *      cannot saturate the link and is pinned to one congestion window. The
 *      standard fix is HTTP range requests: probe the size, split the file into
 *      N byte-ranges, fetch them concurrently, and write each into the right
 *      offset of one output file. Hugging Face and every model CDN support
 *      `Range`, so this is universally available for exactly the files we need.
 *
 *   2. Visibility. A 22 GB download with no output looks identical to a hung
 *      process — which is why the previous laya installer buffered its progress
 *      "to the end" and the user saw nothing for minutes (see the git history
 *      for "실제로 스트림 진행률 표시"). This module reports *received* bytes
 *      (not just a percentage that can sit at 0%), the instantaneous rate, and
 *      a live ETA computed from the measured rate.
 *
 * The two requirements interact, which is why they live in one module: with N
 * parallel segments the ETA is only meaningful if it accounts for all segments
 * together, and a segment that finishes early must not make the progress bar
 * jump backwards. Both are handled by a single shared {@link Transfer}
 * accounting object.
 *
 * Everything that touches the network or the disk goes through an injectable
 * seam (`fetchImpl`, `openFile`), so the whole module — including the
 * range-splitting arithmetic and the progress math — is testable against a
 * local `http.Server` with no network and no real multi-gigabyte files.
 */

import { open, rename, rm, stat, writeFile, mkdir, copyFile, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256File, normalizeSha256, ChecksumMismatchError } from "./checksum.js";
import {
  loadProgress,
  saveProgress,
  clearProgress,
  withRange,
  isComplete,
  partitionRanges,
  progressPathOf,
  type DownloadProgress,
  type RangeSpan,
} from "./downloadProgress.js";
import type { FileHandle } from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// Progress accounting
// ─────────────────────────────────────────────────────────────────────────────

/** Progress of one whole transfer (a single file, or a set of files reported
 *  together). Byte counts, not percentages: on a 22 GB file "3%" is not a
 *  useful thing to show a user waiting on a cold start, whereas "4.1 GB of
 *  21.9 GB at 38 MB/s, about 9 minutes left" is. */
export interface TransferProgress {
  /** Human label — the filename, or "3 files" for a grouped transfer. */
  label: string;
  receivedBytes: number;
  /** -1 when the server did not send a usable Content-Length/Content-Range. */
  totalBytes: number;
  /** Smoothed instantaneous throughput in bytes/second. */
  bytesPerSecond: number;
  /** Seconds remaining, or -1 when it cannot be estimated yet. */
  etaSeconds: number;
  /** 0..100, or -1 when the total size is unknown. */
  percent: number;
  /** "verify": the finished file is being hashed (SHA-256) — `receivedBytes` is the bytes
   *  hashed so far. Same one-line channel as the transfer itself. */
  /** "build" for a compile reported through the same one-line channel as a download,
   *  so the TUI redraws it in place with no change of its own. Absent = a transfer. */
  phase?: "build" | "verify";
  /** Seconds since the compile started; only meaningful for phase "build". */
  elapsedSeconds?: number;
}

/** Mutable shared state behind {@link TransferProgress}. One instance is shared
 *  by every concurrent segment of a file (and by every file in a group), so
 *  the numbers a user sees aggregate the whole transfer rather than whichever
 *  segment last reported. */
export class Transfer {
  private received = 0;
  private declaredTotal: number;
  /** Timestamp of the last rate sample, and the bytes at that moment. */
  private lastSampleAt: number;
  private lastSampleBytes = 0;
  private rate: number;

  constructor(
    public label: string,
    totalBytes: number,
    /** Injectable clock so the rate/ETA math is testable without sleeping. */
    private now: () => number = () => Date.now()
  ) {
    this.declaredTotal = totalBytes;
    this.lastSampleAt = now();
    this.rate = 0;
  }

  /** Fixes the total once a probe response reveals it (the initial value is
   *  often -1 until the first response carries Content-Range). */
  setTotal(totalBytes: number): void {
    // Only ever grows, and never below what we've already received — a server
    // that reports a smaller total than bytes already on disk would make the
    // bar run backwards past 100%.
    if (totalBytes > this.declaredTotal) this.declaredTotal = totalBytes;
  }

  add(bytes: number): void {
    this.received += bytes;
  }

  /** Current progress. Call this on a timer; it is cheap and side-effect free
   *  apart from advancing the rate sample. */
  progress(): TransferProgress {
    const t = this.now();
    const dt = (t - this.lastSampleAt) / 1000;
    if (dt > 0) {
      // Exponential smoothing over the sample window. A raw instantaneous rate
      // is unreadable — it swings between 0 (a stalled segment) and a huge
      // spike (a fast one) several times a second with N parallel segments,
      // and an ETA computed from that would flicker unusably.
      const instant = (this.received - this.lastSampleBytes) / dt;
      const alpha = 0.3;
      this.rate = this.rate === 0 ? instant : alpha * instant + (1 - alpha) * this.rate;
      this.lastSampleAt = t;
      this.lastSampleBytes = this.received;
    }
    const total = this.declaredTotal;
    const remaining = total > 0 ? Math.max(0, total - this.received) : -1;
    const hasRate = this.rate > 0 && remaining >= 0;
    return {
      label: this.label,
      receivedBytes: this.received,
      totalBytes: total,
      bytesPerSecond: Math.max(0, this.rate),
      // -1 (not Infinity) when we cannot estimate, so a caller can render
      // "확인 중" rather than a nonsense number.
      etaSeconds: hasRate ? remaining / this.rate : -1,
      percent: total > 0 ? Math.min(100, (this.received / total) * 100) : -1,
    };
  }
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 → "1.5 KB". Binary units, because that is what download sizes and
 *  disk tools both actually show. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** Seconds → "1:04" / "1:02:03". -1 renders as "확인 중" so the UI never shows
 *  "NaN" or "Infinity" to a user waiting on a cold start. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "확인 중";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** A fixed-width ASCII progress bar. Fixed width (not proportional to the
 *  total) because the total is often unknown at the start, and a bar that
 *  resizes as the size is discovered makes the whole line jitter. */
export function progressBar(percent: number, width = 24): string {
  if (!Number.isFinite(percent) || percent < 0) return "?".padEnd(width, " ");
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** OSC 52: the terminal-agnostic clipboard write.
 *  successive updates overwrite cleanly on a single terminal row — the reason
 *  a caller can print this in a loop without flooding the scrollback. */
export function formatProgress(p: TransferProgress, barWidth = 24): string {
  if (p.phase === "verify") {
    const pct = p.percent >= 0 ? `${p.percent.toFixed(0)}%` : "?%";
    return `[${progressBar(p.percent, barWidth)}] ${pct}  SHA-256 검증 중 ${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}  ${p.label}`;
  }
  if (p.phase === "build") {
    const pct = p.percent >= 0 ? `${p.percent.toFixed(0)}%` : "?%";
    const mins = Math.floor((p.elapsedSeconds ?? 0) / 60);
    return `[${progressBar(p.percent, barWidth)}] ${pct}  ${p.label} 빌드 ${mins}분 경과`;
  }
  const total = p.totalBytes > 0 ? `${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}` : formatBytes(p.receivedBytes);
  const pct = p.percent >= 0 ? `${p.percent.toFixed(0)}%` : "?%";
  return (
    `[${progressBar(p.percent, barWidth)}] ${pct}  ` +
    `${total}  ${formatBytes(p.bytesPerSecond)}/s  남은 시간 ${formatEta(p.etaSeconds)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Range probing
// ─────────────────────────────────────────────────────────────────────────────

/** What a `Range: bytes=0-0` probe tells us about a URL. */
export interface ProbeResult {
  totalBytes: number;
  /** Whether the server actually honoured the range request. Some CDNs answer
   *  200 with the whole body, which means parallel ranges are impossible and
   *  the caller must fall back to a single stream. */
  supportsRanges: boolean;
  /** Final URL after redirects, for the subsequent range requests — following a
   *  redirect with a Range header is the usual way to silently lose range
   *  support (the redirect target may not support it). */
  finalUrl: string;
  etag?: string;
}

/** Parses `Content-Range: bytes 0-0/12345` → 12345. Falls back to
 *  `Content-Length` for a 200. Returns -1 when neither is usable, which callers
 *  must treat as "unknown size" (show bytes + rate, no percent, no ETA)
 *  rather than as zero. */
export function parseContentRangeTotal(header: string | null, contentLength: string | null, status: number): number {
  if (header) {
    const m = /\/(\d+)\s*$/.exec(header);
    if (m) {
      const total = Number(m[1]);
      // "*" (unknown total) parses as NaN here and is correctly rejected.
      if (Number.isFinite(total)) return total;
    }
  }
  if (status === 200 && contentLength) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > 0) return len;
  }
  return -1;
}

/**
 * Splits `total` into contiguous byte-ranges covering exactly [0, total).
 *
 * Two independent inputs, and conflating them is the bug this function exists
 * to get right:
 *
 *   - `parts` — the caller's DESIRED parallelism (how many connections to use
 *     to saturate the link). With a 256 KB file and parts=4 you want 4 ranges,
 *     because using one range for a small file throws away parallelism for no
 *     reason.
 *   - `maxPartBytes` — a hard CAP on how many bytes any single request may
 *     carry. With a 22 GB file and a 64 MB cap you need ~350 ranges no matter
 *     how few connections the user asked for.
 *
 * So the count is the LARGER of the two (each constraint is a lower bound on
 * the part count), and it is the CONCURRENCY that gets capped separately, in
 * `downloadRanges`' pool — not the part count. Reducing the range count to
 * honour a concurrency limit was the original bug: it silently violated the
 * size cap, and made a small file fetch in a single stream.
 *
 * The tiling property (no gap, no overlap, every byte exactly once) is what
 * makes a corrupt 22 GB model impossible to detect at load time, so it is
 * asserted directly in the tests.
 */
export function planRanges(total: number, parts: number, maxPartBytes: number): { start: number; end: number }[] {
  if (total <= 0 || parts <= 0) return [];
  const byParallelism = Math.max(1, parts);
  const bySizeCap = Math.max(1, Math.ceil(total / Math.max(1, maxPartBytes)));
  const count = Math.max(byParallelism, bySizeCap);
  const ranges: { start: number; end: number }[] = [];
  // Ceil division, then clamp the last range to total-1. Floor + multiply-back
  // is what silently drops the tail bytes: total=1000, count=3 gives chunks of
  // 333, covering only 999.
  const chunk = Math.ceil(total / count);
  for (let start = 0; start < total; start += chunk) {
    ranges.push({ start, end: Math.min(total - 1, start + chunk - 1) });
  }
  return ranges;
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

export interface DownloadOptions {
  /** Shown in the progress line. */
  label?: string;
  /** Concurrent range requests. Defaults to 8 — enough to saturate a normal
   *  connection without looking abusive to a CDN. */
  connections?: number;
  /** Hard cap on any single range's size, so a 22 GB file is spread over many
   *  requests even when the user asks for fewer connections. */
  maxPartBytes?: number;
  onProgress?: (p: TransferProgress) => void;
  fetchImpl?: typeof fetch;
  /** Injected file opener for tests; defaults to fs/promises.open. */
  openFile?: (path: string) => Promise<FileHandle>;
  /** Injected clock for the rate math. */
  now?: () => number;
  signal?: AbortSignal;
  /** Bytes to skip when a previous run already wrote them (resume). */
  resumeFrom?: number;
  /** A size/range-support pair the caller already probed. Passed by
   *  downloadFiles, which has to probe every file anyway to build the
   *  aggregate progress total — without this, each file's probe is issued
   *  twice, which for an N-shard model is 2N extra round-trips before the
   *  first byte moves. */
  preProbed?: { totalBytes: number; supportsRanges: boolean; finalUrl: string; etag?: string };
  /** The publisher's SHA-256 for this file (any of "sha256:…", bare hex, quoted etag).
   *  When given, the file this call produces is hashed before it is returned. A mismatch
   *  deletes it (and its resume state) and re-fetches ONCE from scratch — a resume that
   *  stitched bytes from two versions of the object is the usual cause — then throws
   *  `ChecksumMismatchError`. Never applied to a file that was already complete when the
   *  call started: that one was not produced here, may legitimately differ from what the
   *  Hub serves today, and deleting a model that works would be worse than not checking. */
  expectedSha256?: string;
  /** A temporary folder to download into. The file is fetched, resumed and hash-verified
   *  THERE and only moved to `path` once it checks out, so the model directory never
   *  holds a half-written or unverified file. Should be on the same filesystem as `path`
   *  for an instant move (the default the callers use is a hidden folder beside it);
   *  across filesystems the move is a verified copy. */
  stagingDir?: string;
  /** Internal: this call is the single clean retry after a mismatch. */
  _verifyRetry?: boolean;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  /** True when the file was fetched as parallel byte-ranges. */
  parallel: boolean;
  /** True when the file's SHA-256 was checked against the publisher's and matched. */
  sha256Verified?: boolean;
  /** Connections actually used (1 for a single stream). */
  connections?: number;
  /** True when the final move had to copy (the staging folder was on another filesystem). */
  copiedAcrossFilesystems?: boolean;
}

/** Where an in-progress download is staged. Kept as a function rather than an
 *  inline template so the "is this already done?" check and the writer cannot
 *  disagree about the name — checking `path` while writing `path.part` is
 *  exactly the bug that made a completed download look incomplete. */
export function partPathOf(path: string): string {
  return `${path}.part`;
}

/** Where the in-progress copy of `path` lives. With a `stagingDir` it is a temporary folder
 *  (kept by name, so a restart resumes the same file); without one it is the `.part`
 *  beside the final name, as before. */
export function partPathFor(path: string, stagingDir?: string): string {
  return stagingDir ? join(stagingDir, `${basename(path)}.part`) : partPathOf(path);
}

/**
 * Puts a finished, verified file at its final path.
 *
 * `rename` when the staging folder is on the same filesystem (instant and atomic — a
 * reader never sees a half-written model). Across filesystems `rename` fails with EXDEV;
 * then the bytes are copied to a temporary name NEXT TO the destination and renamed from
 * there, so even that path never exposes a partial file under the final name.
 */
export async function moveIntoPlace(src: string, dest: string): Promise<{ copied: boolean }> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
    return { copied: false };
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
  }
  const tmp = `${dest}.copying`;
  try {
    await copyFile(src, tmp);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await rm(src, { force: true });
  return { copied: true };
}

/** Everything already on disk at `path`, or 0. Used to skip a completed
 *  download on a re-run (llamacli's bootstrap is idempotent, and re-fetching
 *  22 GB because a process died at 99% is the failure this avoids). */
export async function existingSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Downloads `url` to `path`, in parallel byte-ranges when the server supports
 * it and as a single stream when it doesn't.
 *
 * Segments write into ONE output file at their own offsets (pwrite), so there
 * is no concatenation step and no per-segment temp files to clean up. The
 * write is committed to disk before the final rename, so an interrupted run
 * never leaves a truncated file that looks complete — a `.part` file is
 * renamed into place only on success.
 */
export async function downloadFile(url: string, path: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const {
    connections = 8,
    maxPartBytes = 64 * 1024 * 1024,
    onProgress,
    fetchImpl = fetch,
    openFile = (p: string) => open(p, "r+"),
    now = () => Date.now(),
    signal,
    label = path.split("/").pop() ?? path,
  } = opts;

  const expected = normalizeSha256(opts.expectedSha256);
  const probe = opts.preProbed ?? (await probeUrl(url, fetchImpl, signal));
  const transfer = new Transfer(label, probe.totalBytes, now);

  const partPath = partPathFor(path, opts.stagingDir);
  if (opts.stagingDir) await mkdir(opts.stagingDir, { recursive: true });
  // A fully-downloaded file from a previous run: nothing to do.
  //
  // Both names are checked, because there are two ways a previous run can have
  // finished: it renamed .part into place, or it was interrupted between the
  // last byte and the rename. In the second case the bytes are all there and
  // re-downloading them is pure waste — so the .part is PROMOTED (renamed) and
  // reported complete, rather than being treated as a download that never
  // happened.
  //
  // SIZE IS NOT THE COMPLETION SIGNAL, and treating it as one was a data
  // corruption bug. `downloadRanges` pre-truncates the .part to the FINAL
  // length so every segment's pwrite lands in allocated space, so the file is
  // full length from the first second; an interrupted run's next attempt saw
  // `atPart >= total`, promoted it, and llamacli ended up with a model of
  // exactly the right size whose unwritten regions are zero bytes. Silent, and
  // discovered much later inside llama-server.
  //
  // The durable range list in the sidecar is what says "this is finished".
  // Where there is no usable state (an older .part, a corrupt sidecar) the
  // answer is to re-fetch, because promoting bytes of unknown provenance is the
  // failure this exists to prevent.
  const completeAt = probe.totalBytes > 0 ? probe.totalBytes : 0;
  const atFinal = await existingSize(path);
  const atPart = await existingSize(partPath);
  const state = await loadProgress(partPath, probe.finalUrl, completeAt);
  const finished = state !== null && isComplete(state) && atPart >= completeAt;
  // A file at the FINAL name is only trustworthy when this run's own state says
  // the same url/size completed, or when the caller vouches for it explicitly
  // (resumeFrom) -- which is how an install that predates the sidecar keeps
  // working without silently re-fetching 22 GB.
  const finalIsDone = atFinal >= completeAt && (state === null || isComplete(state) || (opts.resumeFrom ?? 0) >= completeAt);
  if (completeAt > 0 && (finished || finalIsDone)) {
    transfer.setTotal(completeAt);
    transfer.add(completeAt);
    onProgress?.(transfer.progress());
    // A complete .part from an interrupted run: check it (it was produced by THIS downloader),
    // and only then move it into place. One already complete under its final name is left
    // alone (see `expectedSha256`).
    if (atPart >= completeAt && atFinal < completeAt) {
      if (expected) {
        const v = await verifyOrDiscard(partPath, expected, label, onProgress, signal);
        if (!v.ok) {
          if (!opts._verifyRetry) return downloadFile(url, path, { ...opts, _verifyRetry: true });
          throw new ChecksumMismatchError(path, expected, v.actual);
        }
      }
      const moved = await moveIntoPlace(partPath, path);
      // The .part is gone, so its state must go too — a stale sidecar at the same path would
      // let a later, DIFFERENT download inherit a "complete" verdict from this one.
      await clearProgress(partPath);
      await cleanStaging(opts.stagingDir);
      if (expected) await recordVerified(path, expected);
      return { path, bytes: completeAt, parallel: false, sha256Verified: expected ? true : undefined, connections: 0, copiedAcrossFilesystems: moved.copied };
    }
    return { path, bytes: completeAt, parallel: false };
  }

  // 'r+' — read/write at an explicit position — or 'w+' to create.
  //
  // NOT 'a+' (append). Append mode makes the kernel move every write to the
  // current end of file and IGNORE the position argument, so the parallel
  // segments' `handle.write(buf, 0, len, offset)` calls would all pile up at
  // the end instead of landing at their own offsets. The result is a file
  // exactly twice the expected length whose first half is right and whose
  // second half is a re-write of the same bytes — a 22 GB model that fails to
  // load with no error at download time. This was caught by a byte-exactness
  // assertion on a 256 KB fixture.
  let handle: FileHandle;
  try {
    handle = await open(partPath, "r+");
  } catch {
    handle = await open(partPath, "w+");
  }

  try {
    if (probe.supportsRanges && probe.totalBytes > 0) {
      await downloadRanges(probe, partPath, handle, transfer, {
        connections, maxPartBytes, fetchImpl, onProgress, signal,
      });
    } else {
      await downloadSingle(probe.finalUrl, partPath, handle, transfer, {
        // connections/maxPartBytes are not meaningful for a single stream, but
        // the ctx type requires them; pass the real values so a future
        // retry-with-ranges inside this path is not silently mis-tuned.
        connections, maxPartBytes, fetchImpl, onProgress, signal,
        headers: probe.etag ? { "If-Match": probe.etag } : undefined,
      });
    }
    await handle.close();
    const finalTotal = transfer.progress().totalBytes;
    onProgress?.(transfer.progress());
    const used = probe.supportsRanges && probe.totalBytes > 0 ? connections : 1;
    // VERIFY FIRST, in the staging area: nothing reaches the model directory until the hash
    // says the bytes are the publisher's. A mismatch is discarded where it lies.
    if (expected) {
      const v = await verifyOrDiscard(partPath, expected, label, onProgress, signal);
      if (!v.ok) {
        if (!opts._verifyRetry) return downloadFile(url, path, { ...opts, _verifyRetry: true });
        throw new ChecksumMismatchError(path, expected, v.actual);
      }
    }
    // Only now is the file whole and checked: move it into place (atomic on one filesystem).
    const moved = await moveIntoPlace(partPath, path);
    await clearProgress(partPath);
    await cleanStaging(opts.stagingDir);
    if (expected) await recordVerified(path, expected);
    return {
      path,
      bytes: finalTotal > 0 ? finalTotal : await existingSize(path),
      parallel: probe.supportsRanges,
      connections: used,
      copiedAcrossFilesystems: moved.copied,
      ...(expected ? { sha256Verified: true } : {}),
    };
  } catch (err) {
    try { await handle.close(); } catch { /* already closed */ }
    throw err;
  }
}

/** Leaves `<file>.sha256` beside a verified download, in the format `sha256sum -c` reads. */
async function recordVerified(path: string, sha: string): Promise<void> {
  await writeFile(`${path}.sha256`, `${sha}  ${path.split("/").pop()}\n`, "utf8").catch(() => {});
}

/** Hashes `path` and compares it with `expected`. On a match returns true. On a mismatch
 *  removes the file and every piece of resume state so the next attempt starts clean. */
async function verifyOrDiscard(
  file: string,
  expected: string,
  label: string,
  onProgress: ((p: TransferProgress) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<{ ok: true } | { ok: false; actual: string }> {
  const started = Date.now();
  const actual = await sha256File(file, {
    signal,
    onProgress: ({ hashedBytes, totalBytes }) =>
      onProgress?.({
        label, receivedBytes: hashedBytes, totalBytes, bytesPerSecond: hashedBytes / Math.max(0.001, (Date.now() - started) / 1000),
        etaSeconds: -1, percent: totalBytes > 0 ? (hashedBytes / totalBytes) * 100 : -1, phase: "verify",
      }),
  });
  if (actual === expected) return { ok: true };
  // The file under test is the staged .part (or, for a legacy caller, the final name): remove
  // it with its resume state so the next attempt starts from zero.
  await rm(file, { force: true });
  await clearProgress(file);
  await clearProgress(`${file}`);
  return { ok: false, actual };
}

/** Removes the staging folder once it is empty (best effort — a sibling download may still
 *  be using it, in which case `rmdir` refuses and nothing is lost). */
async function cleanStaging(dir: string | undefined): Promise<void> {
  if (dir) await rmdir(dir).catch(() => {});
}

async function probeUrl(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ProbeResult> {
  // Range: bytes=0-0 asks for exactly one byte. A compliant server answers 206
  // with `Content-Range: bytes 0-0/TOTAL`; a non-compliant one answers 200
  // with the entire body, which we immediately discard.
  const res = await fetchImpl(url, { headers: { Range: "bytes=0-0" }, signal });
  const supportsRanges = res.status === 206;
  const totalBytes = parseContentRangeTotal(
    res.headers.get("content-range"),
    res.headers.get("content-length"),
    res.status
  );
  const etag = res.headers.get("etag") ?? undefined;
  const finalUrl = res.url || url;
  // Drain and release the connection; otherwise the socket stays checked out
  // of the agent's pool and a parallel download immediately stalls on it.
  try { await res.arrayBuffer(); } catch { /* body may be absent */ }
  return { totalBytes, supportsRanges, finalUrl, etag };
}

interface RangeCtx {
  connections: number;
  maxPartBytes: number;
  fetchImpl: typeof fetch;
  onProgress?: (p: TransferProgress) => void;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function downloadRanges(
  probe: ProbeResult,
  partPath: string,
  handle: FileHandle,
  transfer: Transfer,
  ctx: RangeCtx
): Promise<void> {
  const planned = planRanges(probe.totalBytes, ctx.connections, ctx.maxPartBytes);
  if (planned.length === 0) {
    await downloadSingle(probe.finalUrl, partPath, handle, transfer, ctx);
    return;
  }

  // Resume: ranges a previous run recorded as finished are skipped, and their
  // bytes are added to the progress total so the bar starts where it left off
  // instead of at zero. Without this a 22 GB model at ~3 h restarts from byte 0
  // on every retry, which is the whole complaint.
  const prior = await loadProgress(partPath, probe.finalUrl, probe.totalBytes);
  const { skip, todo: ranges } = partitionRanges(planned, prior?.ranges ?? []);
  if (skip.length > 0) {
    transfer.add(skip.reduce((n, r) => n + (r.end - r.start + 1), 0));
  }

  // Shared, mutable, and written after each segment: the state has to outlive
  // the process for a resume to be possible at all. Serialised through a chain
  // so two segments finishing at once cannot interleave a read-modify-write.
  let progress: DownloadProgress = prior ?? { url: probe.finalUrl, totalBytes: probe.totalBytes, ranges: [], updatedAt: 0 };
  let writeChain: Promise<void> = Promise.resolve();
  const recordRange = (span: RangeSpan): Promise<void> => {
    writeChain = writeChain
      .then(async () => {
        progress = withRange(progress, span);
        await saveProgress(partPath, progress);
      })
      .catch(() => {});
    return writeChain;
  };
  // Start the file at its full length so every segment's pwrite at its own
  // offset lands in already-allocated space. Without this the first segment
  // (offset 0) would extend the file only as far as it writes, and a later
  // segment writing far ahead would leave a sparse hole that reads as zeros.
  await handle.truncate(probe.totalBytes);

  // reportProgress is shared by all segments; `lastReport` throttles to ~4/s so
  // N concurrent segments don't each trigger a render.
  let lastReport = 0;
  const report = (force = false) => {
    const t = Date.now();
    if (!force && t - lastReport < 250) return;
    lastReport = t;
    ctx.onProgress?.(transfer.progress());
  };

  // Run the ranges through a BOUNDED pool. The range count is driven by
  // `connections` (see planRanges) but the per-request size cap can push it
  // higher — a 22 GB file at a 64 MB cap is ~350 ranges. Firing all of those
  // at once is not "faster", it is how a CDN rate-limits you into a slower
  // download than a single stream would have got.
  let cursor = 0;
  const settleOne = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= ranges.length) return;
      await downloadOneRange(ranges[i]);
    }
  };
  const pool = Array.from(
    { length: Math.max(1, Math.min(ctx.connections, ranges.length)) },
    settleOne
  );

  // allSettled, not all: one failed segment must not leave the others'
  // rejections dangling, and the first real error is what the caller needs —
  // not an AggregateError it has to unpack.
  const settled = await Promise.allSettled(pool);

  async function downloadOneRange(range: { start: number; end: number }): Promise<void> {
      const res = await ctx.fetchImpl(probe.finalUrl, {
        headers: { Range: `bytes=${range.start}-${range.end}` },
        signal: ctx.signal,
      });
      // A server that agreed to ranges at probe time but 200s one segment is
      // broken/misbehaving; writing it as a range would corrupt the file, so
      // this is a hard error rather than a silent fallback.
      if (res.status !== 206) {
        const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
        throw new Error(`range request ${range.start}-${range.end} returned HTTP ${res.status} (${body.byteLength} bytes)`);
      }
      // pwrite at this segment's own offset — the reason there is no
      // concatenation step and no chance of two segments interleaving.
      let offset = range.start;
      for await (const chunk of streamBytes(res)) {
        if (ctx.signal?.aborted) throw new Error("download aborted");
        const buf = Buffer.from(chunk);
        await handle.write(buf, 0, buf.length, offset);
        offset += buf.length;
        transfer.add(buf.length);
        report();
      }
      // The segment's bytes are on disk: record it durably BEFORE moving on, so
      // a crash costs at most this one segment rather than everything since the
      // last checkpoint.
      await recordRange(range);
  }
  report(true);
  const failure = settled.find((r) => r.status === "rejected");
  if (failure && failure.status === "rejected") {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
}

async function downloadSingle(
  url: string,
  partPath: string,
  handle: FileHandle,
  transfer: Transfer,
  ctx: RangeCtx
): Promise<void> {
  const res = await ctx.fetchImpl(url, { headers: ctx.headers, signal: ctx.signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const total = parseContentRangeTotal(res.headers.get("content-range"), res.headers.get("content-length"), res.status);
  if (total > 0) transfer.setTotal(total);
  // Resume offset. When the total was unknown at probe time the .part file may
  // already hold bytes from a previous run, and appending after them is what
  // makes a re-run cheap. It is deliberately NOT computed from `total`: a
  // 200 response's Content-Length is the length of the body we are about to
  // receive (the whole remaining file), not a file position, so using it here
  // would seek past the end and write a file padded with a hole of zeros —
  // which loads as a corrupt model with no error at download time.
  let offset = await existingSize(partPath);
  let lastReport = 0;
  for await (const chunk of streamBytes(res)) {
    if (ctx.signal?.aborted) throw new Error("download aborted");
    const buf = Buffer.from(chunk);
    await handle.write(buf, 0, buf.length, offset);
    offset += buf.length;
    transfer.add(buf.length);
    const t = Date.now();
    if (t - lastReport >= 250) {
      lastReport = t;
      ctx.onProgress?.(transfer.progress());
    }
  }
  ctx.onProgress?.(transfer.progress());
  void partPath;
}

/** Yields a fetch Response's body as Uint8Array chunks. Works for both a
 *  web ReadableStream (undici / global fetch) and a Node Readable (node-fetch),
 *  so the module doesn't care which fetch implementation is injected. */
async function* streamBytes(res: Response): AsyncGenerator<Uint8Array> {
  const body: any = (res as any).body;
  if (!body) return;
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<Uint8Array>) yield chunk;
    return;
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
    return;
  }
  throw new Error("response body is not a readable stream");
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-file
// ─────────────────────────────────────────────────────────────────────────────

export interface DownloadFileSpec {
  url: string;
  path: string;
  label?: string;
}

export interface DownloadManyResult {
  results: DownloadResult[];
  /** Total bytes across every file, for a final summary line. */
  totalBytes: number;
  /** True when at least one file was already complete (skipped). */
  skippedComplete: number;
  /** Set when one or more files failed. The successes are still returned —
   *  a partial multi-shard download that reports which shards landed is more
   *  useful than an exception that throws all that work away. */
  errors: Error[];
}

/**
 * Downloads several files CONCURRENTLY, each of which may itself be split into
 * parallel ranges.
 *
 * This is the "다중파일" half of the request: a 22 GB model that ships as
 * multiple shards must not be fetched shard-after-shard, and neither must a
 * multi-file install (llama.cpp source + several GGUFs) serialise its fetches.
 * `fileConcurrency` is deliberately separate from each file's own
 * `connections` so the total in-flight request count stays bounded — the
 * product of the two is what a CDN sees, and an unbounded product is how a
 * download gets rate-limited into being *slower* than a single stream.
 *
 * Progress is reported as ONE aggregate transfer (sum of all files), because
 * the user asked one question — "how far along is the install?" — and three
 * independently-jumping bars answer it worse than one combined one. Per-file
 * progress is still available via `onFileProgress`.
 */
export async function downloadFiles(
  files: DownloadFileSpec[],
  opts: DownloadOptions & { fileConcurrency?: number; onFileProgress?: (path: string, p: TransferProgress) => void } = {}
): Promise<DownloadManyResult> {
  const { fileConcurrency = 3, onFileProgress, onProgress, ...rest } = opts;

  // Probe sizes first so the aggregate bar has a denominator from the start.
  // Probing is one tiny ranged request per file — cheap, and it is what makes
  // "3 files, 41.2 GB of 43.0 GB" possible instead of a bar stuck at 0%.
  const sizes = new Map<string, number>();
  const probes = new Map<string, boolean>();
  const etags = new Map<string, string | undefined>();
  await Promise.all(
    files.map(async (f) => {
      try {
        const probe = await probeUrl(f.url, rest.fetchImpl ?? fetch, rest.signal);
        sizes.set(f.path, probe.totalBytes);
        probes.set(f.path, probe.supportsRanges);
        etags.set(f.path, probe.etag);
      } catch {
        sizes.set(f.path, -1); // unknown; contributes 0 to the denominator
        // Left absent from `probes` so downloadFile probes for itself: a
        // failed probe here must not be cached as "no range support", which
        // would silently downgrade a perfectly capable server to one stream.
      }
    })
  );
  const totalKnown = [...sizes.values()].reduce((n, v) => n + (v > 0 ? v : 0), 0);
  const aggregate = new Transfer(
    files.length === 1 ? (files[0].label ?? files[0].path) : `${files.length} files`,
    totalKnown,
    rest.now
  );

  // Splice the aggregate's own accounting into each file's onProgress so the
  // combined numbers advance even while an individual file streams.
  const wrap = (path: string) => (p: TransferProgress) => {
    onFileProgress?.(path, p);
    // Each file reports its own received; add the delta since the last call so
    // the aggregate counts each byte exactly once across interleaved files.
    const seen = seenBytes.get(path) ?? 0;
    if (p.receivedBytes > seen) {
      aggregate.add(p.receivedBytes - seen);
      seenBytes.set(path, p.receivedBytes);
    }
    onProgress?.(aggregate.progress());
  };

  const results: DownloadResult[] = [];
  const errors: Error[] = [];
  let skippedComplete = 0;
  const seenBytes = new Map<string, number>();

  // Simple bounded-concurrency pool over the files.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        // "Already whole" has to consider the `.part` file as well as the final
        // name, for the same reason downloadFile does: an interrupted run
        // leaves the complete bytes in the .part. Only the FINAL name counts
        // toward skippedComplete, though — a .part still has to be promoted by
        // downloadFile's rename, so claiming it as "skipped" here would leave
        // the user with no file at all.
        const known = sizes.get(f.path) ?? -1;
        const atFinal = await existingSize(f.path);
        const atPart = await existingSize(partPathFor(f.path, rest.stagingDir));
        if (known > 0 && atFinal >= known) {
          skippedComplete++;
          aggregate.add(known);
          seenBytes.set(f.path, known);
          continue;
        }
        if (known > 0 && atPart >= known) {
          // All the bytes are already on disk, staged under the `.part` name
          // because a previous run was interrupted between the last write and
          // the rename. Still a "skipped" download — no byte is transferred —
          // but the file must be PROMOTED here rather than skipped outright, or
          // the user is left with no model at their expected path.
          try { await moveIntoPlace(partPathFor(f.path, rest.stagingDir), f.path); } catch { /* falls through to a real download */ }
          if (await existingSize(f.path) >= known) {
            skippedComplete++;
            aggregate.add(known);
            seenBytes.set(f.path, known);
            continue;
          }
        }
        const r = await downloadFile(f.url, f.path, {
          ...rest,
          label: f.label ?? f.path.split("/").pop() ?? f.path,
          onProgress: wrap(f.path),
          // Hand over the probe we already did. Its finalUrl is what the range
          // requests must use (a redirect target may not support Range), so
          // re-probing here could pick a different URL than the one whose
          // support we just verified.
          preProbed: known > 0 || probes.has(f.path)
            ? { totalBytes: known, supportsRanges: probes.get(f.path) === true, finalUrl: f.url, etag: etags.get(f.path) }
            : undefined,
        });
        results.push(r);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(fileConcurrency, files.length)) }, worker));

  return {
    results,
    totalBytes: aggregate.progress().totalBytes,
    skippedComplete,
    errors,
  };
}
