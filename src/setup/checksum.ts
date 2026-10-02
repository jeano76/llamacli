/**
 * SHA-256 of a downloaded file, and what to do when it is not the one the publisher states.
 *
 * Why a size check was not enough: the downloader pre-allocates the output to its final
 * length (so parallel ranges can write at their own offsets), which means a file that is
 * missing regions, or whose resumed bytes came from a different object after the origin
 * changed, still has exactly the right size. The hash is the only thing that says the
 * bytes are the right bytes — and a model with zero-filled regions loads fine and fails
 * far from the cause.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/** "sha256:ABC…" / "ABC…" / 'W/"abc…"' → lowercase 64-hex, or null when it is not one. */
export function normalizeSha256(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(?:^|[:"\s])([0-9a-fA-F]{64})(?:["\s]|$)/.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

export interface HashProgress {
  hashedBytes: number;
  totalBytes: number;
}

/** Streams the file through SHA-256 in 4 MiB reads — a 22 GB model never sits in memory. */
export async function sha256File(
  path: string,
  opts: { onProgress?: (p: HashProgress) => void; signal?: AbortSignal; throttleMs?: number; now?: () => number } = {}
): Promise<string> {
  const total = (await stat(path)).size;
  const hash = createHash("sha256");
  const now = opts.now ?? Date.now;
  const every = opts.throttleMs ?? 200;
  let done = 0;
  let last = -Infinity;
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) {
    if (opts.signal?.aborted) {
      stream.destroy();
      throw new Error("checksum aborted");
    }
    hash.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    const t = now();
    if (opts.onProgress && t - last >= every) {
      last = t;
      opts.onProgress({ hashedBytes: done, totalBytes: total });
    }
  }
  opts.onProgress?.({ hashedBytes: total, totalBytes: total });
  return hash.digest("hex");
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `SHA-256 이 일치하지 않습니다 (${path.split("/").pop()}): 기대 ${expected.slice(0, 16)}…, 실제 ${actual.slice(0, 16)}…`
    );
    this.name = "ChecksumMismatchError";
  }
}
