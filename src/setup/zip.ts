/**
 * Pure-stdlib `.zip` extraction.
 *
 * Exists because the ternary-capable llama.cpp release ships Windows builds as
 * `.zip`, not `.tar.gz` (see setup/ternaryRuntime.ts), and Windows is a supported
 * platform here — not an afterthought. The alternatives were both unacceptable:
 * shelling out to `tar` is not dependable across Windows versions, and PowerShell's
 * `Expand-Archive` is slower, writes BOM surprises on some files, and is absent
 * from Server Core images.
 *
 * Node ships `zlib.inflateRawSync`, which is exactly what a deflated zip member
 * needs, so this needs no dependency — the same constraint `tarGz.ts` works under.
 *
 * Reads the CENTRAL DIRECTORY rather than scanning local headers, because only the
 * central directory is authoritative about a member's real name and offset; local
 * headers can disagree after an edit.
 *
 * Scope: stored (method 0) and deflate (method 8), which is what a build archive
 * contains. Zip64 is detected and rejected loudly rather than mis-read — silently
 * truncating a 5 GB member is far worse than saying so. 4 GB and 65535 members are
 * the limits, and the pinned release stays inside both.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join, basename } from "node:path";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;

/** Extensions that must stay executable on a POSIX filesystem. */
const EXECUTABLE_EXT = new Set([".exe", ".dll", ".so", ""]);

/**
 * Extracts `archivePath` into `destDir`, creating directories as needed.
 *
 * `strip` drops that many leading path components per entry, matching tarGz.ts so
 * the two releases can be handled by one code path.
 */
export function extractZip(
  archivePath: string,
  destDir: string,
  opts: { strip?: number } = {}
): string[] {
  const strip = opts.strip ?? 0;
  const buf = readFileSync(archivePath);

  // EOCD lives in the last 64 KiB (its comment field can be up to 65535 bytes).
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 아카이브가 아닙니다 (EOCD 레코드를 찾을 수 없음).");

  // A Zip64 EOCD locator sits immediately before the EOCD when any field would
  // overflow 32 bits. Refuse rather than read a truncated offset.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === EOCD64_LOCATOR_SIG) {
    throw new Error("Zip64 아카이브는 지원하지 않습니다 (이 릴리스 자산은 4 GiB 미만입니다).");
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const written: string[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new Error(`zip 중앙 디렉터리 항목 ${i}의 시그니처가 잘못되었습니다 (손상된 다운로드?).`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    // Directory member: the name ends in "/" and carries no data.
    if (name.endsWith("/")) {
      const dir = resolveEntry(destDir, name, strip);
      if (dir) mkdirSync(dir, { recursive: true });
      continue;
    }

    const target = resolveEntry(destDir, name, strip);
    if (!target) continue;

    // Follow the local header to the data: its filename/extra lengths are what
    // position the member, and they need not match the central directory's.
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`zip 항목 "${name}"의 로컬 헤더 시그니처가 잘못되었습니다.`);
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (err) {
        throw new Error(`zip 항목 "${name}" 압축 해제 실패: ${(err as Error).message}`);
      }
    } else {
      throw new Error(`zip 항목 "${name}"의 압축 방식(${method})은 지원하지 않습니다.`);
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);

    // Unix permissions live in the high half of the external attributes; the low
    // half is the DOS attribute byte. Only meaningful when the archive was made on
    // a POSIX system, so it is treated as a hint and never as a requirement.
    const unixMode = (externalAttrs >>> 16) & 0o777;
    const looksExecutable =
      unixMode & 0o111 ? true : EXECUTABLE_EXT.has(extname(basename(target)));
    try {
      chmodSync(target, looksExecutable ? 0o755 : 0o644);
    } catch {
      /* filesystem without chmod still gets the bytes */
    }
    written.push(target);
  }
  return written;
}

function resolveEntry(destDir: string, name: string, strip: number): string | null {
  const parts = name.split("/").filter((p) => p && p !== ".");
  const kept = parts.slice(strip);
  if (kept.length === 0) return null;
  // A `..` in an archive entry would write outside destDir.
  if (kept.includes("..")) throw new Error(`zip 항목 "${name}"이 destDir 밖을 가리킵니다.`);
  return join(destDir, ...kept);
}

function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}