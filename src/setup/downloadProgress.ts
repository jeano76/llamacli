/**
 * Durable download progress: which byte-ranges are actually on disk.
 *
 * ── Why size is not enough ──────────────────────────────────────────────────
 * A parallel range download pre-truncates its `.part` file to the FINAL length
 * so every segment's pwrite lands in already-allocated space (download.ts does
 * this deliberately — without it a segment writing far ahead leaves a sparse
 * hole that reads as zeros). That means the file is full length from the first
 * second, and file SIZE therefore says nothing about how much is really there.
 *
 * Consequences, both reproduced (see downloadResume.test.ts):
 *
 *   1. An interrupted download was PROMOTED as complete. Next run saw a
 *      full-length `.part`, renamed it into place, and llamacli ended up with a
 *      model of exactly the right size whose unwritten regions are zero bytes —
 *      silently corrupt, with no error at download time and a failure much
 *      later inside llama-server.
 *   2. Nothing resumed. A 22 GB model at ~3 h restarted from byte 0 on every
 *      retry, because the only completion signal was the same unusable size.
 *
 * So completion is tracked here instead: an explicit list of finished ranges,
 * written durably as segments land. A file is complete when that list covers the
 * whole size AND the file is the right length — never from size alone.
 *
 * ── Why a sidecar and not a marker ──────────────────────────────────────────
 * A `.done` marker cannot express partial progress, which is the thing worth
 * keeping. And the state has to outlive the process to be shared at all: it is
 * written as each segment lands, so a second llamacli — or the next launch —
 * reads what already landed instead of re-fetching gigabytes.
 *
 * Kept deliberately small and human-readable: after a crash, "which ranges are
 * done" should be answerable with `cat`, because a state file you cannot
 * inspect is a state file you cannot trust into deleting.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface RangeSpan {
  start: number;
  end: number;
}

export interface DownloadProgress {
  /** The URL these ranges belong to. A mismatch discards the state: the remote
   *  file changed, so the bytes on disk are no longer what is being asked for. */
  url: string;
  /** Total size the ranges were planned against. */
  totalBytes: number;
  /** Finished ranges, merged and sorted. */
  ranges: RangeSpan[];
  /** Epoch ms of the last write, for staleness display. */
  updatedAt: number;
}

/** The sidecar path for a `.part` file. */
export function progressPathOf(partPath: string): string {
  return `${partPath}.progress.json`;
}

/**
 * Merges overlapping/adjacent spans.
 *
 * Written as a merge rather than an append per segment because a resumed run
 * re-plans the same partition: without merging, the list grows with every
 * attempt and eventually contains thousands of redundant entries describing the
 * same bytes.
 */
export function mergeRanges(ranges: RangeSpan[]): RangeSpan[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: RangeSpan[] = [{ ...sorted[0] }];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1];
    // +1 because ranges are INCLUSIVE on both ends, so end+1 is the next byte.
    if (r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Total bytes covered by a merged range list. */
export function coveredBytes(ranges: RangeSpan[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);
}

/** True when the ranges cover [0, totalBytes) completely. */
export function isComplete(progress: DownloadProgress): boolean {
  return progress.totalBytes > 0 && coveredBytes(progress.ranges) >= progress.totalBytes;
}

/**
 * Reads the sidecar. Returns null when it is missing, unreadable, malformed, or
 * does not match this url/size — every one of those means "cannot trust it", and
 * the safe response to an untrustworthy state file is to re-fetch, not to
 * promote bytes of unknown provenance into a model file.
 */
/** Query parameters that a CDN regenerates on every request (signatures, expiry, session/user ids). */
const VOLATILE_PARAM = /^(x-amz-.*|x-xet-.*|x-goog-.*|signature|sig|expires|policy|key-pair-id|hash-algorithm|user_id|xip|se|sp|sv|sr|st|token|response-content-disposition)$/i;

/**
 * Identity of a download source that survives re-signing. The Hub redirects to a CDN URL whose
 * signature and expiry differ on EVERY request, so comparing the full URL meant a saved resume state
 * never matched the next run and every interrupted download restarted from zero (observed: a 5.8 GB
 * model re-fetched from byte 0 on each retry). The host, the path (which carries the object's content
 * hash on the Hub's CDN) and the non-volatile query identify the object; the totalBytes check still applies.
 */
export function stableUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    const keep = [...u.searchParams.entries()].filter(([k]) => !VOLATILE_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    return `${u.origin}${u.pathname}${keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : ""}`;
  } catch {
    return raw;
  }
}

export async function loadProgress(
  partPath: string,
  url: string,
  totalBytes: number
): Promise<DownloadProgress | null> {
  if (totalBytes <= 0) return null;
  try {
    const raw = await readFile(progressPathOf(partPath), "utf8");
    const parsed = JSON.parse(raw) as DownloadProgress;
    if (!parsed || typeof parsed !== "object") return null;
    if (stableUrlKey(String(parsed.url)) !== stableUrlKey(url)) return null;
    if (parsed.totalBytes !== totalBytes) return null;
    if (!Array.isArray(parsed.ranges)) return null;
    const ranges = parsed.ranges
      .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start && r.start >= 0 && r.end < totalBytes)
      .map((r) => ({ start: r.start, end: r.end }));
    return { url, totalBytes, ranges: mergeRanges(ranges), updatedAt: parsed.updatedAt ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Writes the sidecar durably: temp file + rename, so a crash mid-write cannot
 * leave a truncated JSON that parses as valid-but-wrong. That is the same
 * reasoning as the config write in bootstrap.ts, and the failure it prevents is
 * worse here — a corrupt state file that reads as "mostly done" would skip
 * gigabytes that were never fetched.
 */
export async function saveProgress(partPath: string, progress: DownloadProgress): Promise<void> {
  const target = progressPathOf(partPath);
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true }).catch(() => {});
  await writeFile(tmp, JSON.stringify(progress), "utf8");
  await rename(tmp, target);
}

/** Records a finished range and returns the updated, merged state. */
export function withRange(progress: DownloadProgress, span: RangeSpan): DownloadProgress {
  return {
    ...progress,
    ranges: mergeRanges([...progress.ranges, span]),
    updatedAt: Date.now(),
  };
}

/** Removes the sidecar. Called once the `.part` has been renamed into place —
 *  leaving it behind would let a later, different download at the same path
 *  inherit a "complete" verdict from this one. */
export async function clearProgress(partPath: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(progressPathOf(partPath), { force: true }).catch(() => {});
}

/** Splits the planned ranges into those already done (skip) and those still
 *  needed (fetch). */
export function partitionRanges(
  planned: RangeSpan[],
  done: RangeSpan[]
): { skip: RangeSpan[]; todo: RangeSpan[] } {
  if (done.length === 0) return { skip: [], todo: planned };
  const skip: RangeSpan[] = [];
  const todo: RangeSpan[] = [];
  for (const p of planned) {
    // A planned range is fully done only if ONE recorded span covers all of it.
    const covered = done.some((d) => d.start <= p.start && d.end >= p.end);
    if (covered) skip.push(p);
    else todo.push(p);
  }
  return { skip, todo };
}

/** A short human summary of persisted progress, for a status line. */
export function describeProgress(p: DownloadProgress | null): string {
  if (!p) return "저장된 진행 상태 없음";
  if (isComplete(p)) return "완료";
  const done = coveredBytes(p.ranges);
  const pct = p.totalBytes > 0 ? ((done / p.totalBytes) * 100).toFixed(1) : "?";
  return `${pct}% (${(done / 1024 ** 3).toFixed(1)}/${(p.totalBytes / 1024 ** 3).toFixed(1)} GiB, 구간 ${p.ranges.length}개)`;
}