/**
 * Pure-stdlib `.tar.gz` extraction.
 *
 * Two reasons this exists rather than a `tar` exec:
 *
 *  - Windows has no `tar` by default, and a missing executable that gets caught
 *    and swallowed looks exactly like "the archive contained nothing".
 *  - The archives llamacli unpacks (a llama.cpp release) must
 *    keep their EXECUTABLE BIT. A build that unpacks into a tree of
 *    non-executable files produces a llama-server that cannot be run, which
 *    reads as a corrupt download.
 *
 * ── Why this is synchronous where selfUpdate.ts's version is not ──────────────
 * That one issues every `fs.writeFile` and then calls `resolve()` immediately, so
 * its promise settles before the bytes are on disk. It is safe there only because
 * a self-update restarts the process afterwards. The caller here extracts and then
 * EXECUTES the binary in the same turn, so settling early would be a race the
 * caller cannot see. `writeFileSync` makes extraction atomic from the caller's
 * point of view.
 *
 * Symlinks are materialised, and they are not optional. The pinned llama.cpp
 * release ships its shared libraries the way every build does —
 * `libllama-common.so.0 -> libllama-common.so.0.2.0`, `libllama.so -> libllama.so.0`
 * — and the binary resolves exactly those names. Unpack without the links and
 * `llama-server` does not start at all:
 *
 *     error while loading shared libraries: libllama-common.so.0: cannot open shared object file
 *
 * which reads as a corrupt download rather than as a missing link. Where a
 * filesystem refuses symlinks (Windows without the privilege), the target's bytes
 * are copied instead — larger, but it runs.
 *
 * Links are created in a SECOND pass, after every regular file is written. tar
 * does not promise that a link's target appears first, and a link created against
 * a file that is not there yet would be a dangling link rather than an error.
 *
 * Hardlinks, sparse files and pax extended headers are still skipped rather than
 * half-handled — a half-written link is worse than a missing file, because it looks
 * present.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, copyFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";

const BLOCK = 512;

/** Octal-ASCII field in a tar header, NUL/space padded. */
function readOctal(buf: Buffer, off: number, len: number): number {
  let n = 0;
  for (let i = 0; i < len && off + i < buf.length; i++) {
    const c = buf[off + i];
    if (c === 0 || c === 32) break;
    n = n * 8 + (c - 48);
  }
  return n;
}

/** The GNU long-name payload when this record is one, else null. */
function readLongName(header: Buffer, body: Buffer): string | null {
  if ((header[156] || 48) !== 120) return null; // typeflag 'x'
  const len = readOctal(header, 124, 12);
  return body.subarray(0, len).toString("utf8").replace(/\0+$/, "");
}

/**
 * Extracts `archivePath` into `destDir`, preserving the executable bit.
 *
 * `strip` drops that many leading path components, which is what these release
 * archives need: every entry lives under one `llama-<tag>/` directory, and the
 * caller wants the binaries directly in its own runtime dir.
 *
 * Throws on an unreadable or non-tar payload. A caller that must not die on a bad
 * download catches it; silently producing an empty tree is the failure this
 * avoids.
 */
export function extractTarGz(
  archivePath: string,
  destDir: string,
  opts: { strip?: number } = {}
): string[] {
  const strip = opts.strip ?? 0;
  const uncompressed = gunzipSync(readFileSync(archivePath));
  const written: string[] = [];
  /** Symlinks, applied after every regular file exists. */
  const links: Array<{ target: string; linkTo: string }> = [];
  let sawRecord = false;

  // `pos` is advanced explicitly inside the loop, NOT by a for-statement
  // increment. A tar record is a 512-byte header plus padded data; adding the
  // header in both places skips 512 bytes and lands mid-file, which silently
  // unpacks some entries and drops the rest.
  let pos = 0;
  while (pos + BLOCK <= uncompressed.length) {
    const header = uncompressed.subarray(pos, pos + BLOCK);

    let allZero = true;
    for (let i = 0; i < BLOCK && allZero; i++) if (header[i] !== 0) allZero = false;
    if (allZero) break; // end-of-archive marker

    // The ustar magic is what separates a real archive from a gzip of something
    // else. Checking it is the difference between "this download is corrupt" and a
    // silent empty directory that looks like a successful install.
    const magic = header.subarray(257, 262).toString("latin1");
    if (magic !== "ustar") {
      throw new Error(
        `tar 아카이브가 아닙니다 (위치 ${pos}의 헤더 매직이 "${magic}"). ` +
          `다운로드가 손상되었거나 tar.gz 가 아닌 것 같습니다.`
      );
    }
    sawRecord = true;

    const size = readOctal(header, 124, 12);
    const dataStart = pos + BLOCK;
    const data = uncompressed.subarray(dataStart, dataStart + size);
    const longName = readLongName(header, uncompressed.subarray(dataStart, dataStart + size));

    // Advance past this record: its header, its data, and the padding that keeps
    // the next header 512-aligned. `Math.max` keeps a bogus size from leaving
    // `pos` stuck and spinning forever on one malformed record.
    const pad = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    pos += Math.max(BLOCK + size + pad, BLOCK);

    const typeflag = String.fromCharCode(header[156] || 48);
    const rawName = longName ?? Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0+$/, "");
    if (!rawName || typeflag === "x" || typeflag === "g" || typeflag === "L") continue;

    const parts = rawName.split("/").filter((p) => p && p !== ".");
    const kept = parts.slice(strip);
    if (kept.length === 0) continue;
    const target = join(destDir, ...kept);

    if (typeflag === "5") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    // Symlink: the target is the record's (empty) data field, stored as a path.
    // Deferred to a second pass so it can never be created against a file that has
    // not been written yet.
    if (typeflag === "2") {
      // GNU tar stores the link target in the header's 100-byte `linkname` field at
      // offset 157 and leaves `size` at 0 — NOT in the data block. Reading the data
      // block yields an empty target and produces a link to "", which fails the same
      // way a missing link does. The data block is consulted only as a fallback for
      // writers that do put it there.
      const linkname = header.subarray(157, 257).toString("utf8").replace(/\0+$/, "");
      links.push({ target, linkTo: linkname || data.toString("utf8").replace(/\0+$/, "") });
      continue;
    }
    // Not a regular file (hardlink, device, fifo). Skip it outright.
    if (typeflag !== "0" && typeflag !== "7") continue;

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    // Owner-execute, taken from the tar mode when it carries one. Without this
    // every unpacked binary is non-executable.
    const mode = readOctal(header, 100, 8);
    try {
      chmodSync(target, mode & 0o777 || 0o644);
    } catch {
      /* a filesystem without chmod support still gets the bytes */
    }
    written.push(target);
  }
  if (!sawRecord) {
    throw new Error("tar 아카이브가 비어 있거나 손상되었습니다 (헤더 레코드가 없음).");
  }

  for (const { target, linkTo } of links) {
    mkdirSync(dirname(target), { recursive: true });
    const resolved = join(dirname(target), linkTo);
    try {
      symlinkSync(linkTo, target);
      written.push(target);
    } catch {
      // No symlink privilege (Windows without Developer Mode). Copying the bytes
      // is larger but produces something that actually loads.
      if (existsSync(resolved)) {
        try {
          copyFileSync(resolved, target);
          written.push(target);
        } catch {
          /* leave it absent rather than write a truncated file */
        }
      }
    }
  }
  return written;
}