import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractZip } from "./zip.js";

// ZIP is not optional on Windows: the stock llama.cpp release publishes
// .zip for win32 and .tar.gz everywhere else, so this is the path a Windows user
// actually takes.

interface Member { local: Buffer; central: Buffer; }

/** One stored (uncompressed) member. Local and central records are kept apart:
 *  the central directory's own offset is what locates them, so concatenating them
 *  into a single blob produces an archive whose directory points into itself. */
function zipStored(name: string, body: string, mode = 0o644): Member {
  const data = Buffer.from(body, "utf8");
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  // Local-header offset patched by finishZip, which knows where each one lands.
  central.writeUInt32LE(0, 42);

  return { local: Buffer.concat([local, nameBuf, data]), central: Buffer.concat([central, nameBuf]) };
}

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(path: string, members: Member[]): void {
  let offset = 0;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  for (const m of members) {
    m.central.writeUInt32LE(offset, 42);
    locals.push(m.local);
    centrals.push(m.central);
    offset += m.local.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, ...centrals, eocd]));
}

test("unpacks a stored zip and marks binaries executable", { skip: process.platform === "win32" ? "POSIX-only: Windows has no executable bit" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "zip-stored-"));
  const zip = join(root, "a.zip");
  writeZip(zip, [zipStored("llama-server.exe", "MZfake", 0o755)]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  const written = extractZip(zip, dest);
  assert.equal(written.length, 1);
  const exe = join(dest, "llama-server.exe");
  assert.ok(existsSync(exe));
  assert.ok(statSync(exe).mode & 0o111, "the binary must be executable");
});

test("unpacks what a real zip tool produced", () => {
  // The hand-built records prove the format; this proves the real thing, deflate
  // members and all, since a release zip is deflated.
  let available = true;
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("python3", ["-c", "import zipfile"], { stdio: "ignore" });
    } catch {
      available = false;
    }
  }
  if (!available) return;

  const root = mkdtempSync(join(tmpdir(), "zip-real-"));
  const stage = join(root, "stage");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "llama-common.dll"), "X".repeat(5000));
  writeFileSync(join(stage, "llama-server.exe"), "Y".repeat(9000));
  mkdirSync(join(stage, "sub"));
  writeFileSync(join(stage, "sub", "nested.txt"), "nested");
  const zip = join(root, "r.zip");
  // python's zipfile is deflate-by-default and always present where python3 is.
  execFileSync("python3", ["-c", `
import zipfile,os
z=zipfile.ZipFile(${JSON.stringify(zip)},"w",zipfile.ZIP_DEFLATED)
for r,_,fs in os.walk(${JSON.stringify(stage)}):
    for f in fs:
        p=os.path.join(r,f); z.write(p, os.path.relpath(p, ${JSON.stringify(stage)}))
z.close()
`]);

  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  const written = extractZip(zip, dest);
  assert.ok(written.length >= 3, `expected the real zip's members, got ${written.length}`);
  assert.ok(existsSync(join(dest, "llama-server.exe")));
  assert.ok(existsSync(join(dest, "sub", "nested.txt")), "nested paths must be recreated");
  assert.equal(statSync(join(dest, "llama-common.dll")).size, 5000, "deflated bytes must round-trip");
});

test("rejects a non-zip instead of yielding a silent empty directory", () => {
  // "installed successfully but nothing is there" is the failure this prevents.
  const root = mkdtempSync(join(tmpdir(), "zip-bad-"));
  const bad = join(root, "bad.zip");
  writeFileSync(bad, gzipSync(Buffer.from("not a zip at all")));
  assert.throws(() => extractZip(bad, join(root, "out")));
});

test("refuses an entry that would escape destDir", () => {
  const root = mkdtempSync(join(tmpdir(), "zip-escape-"));
  const zip = join(root, "e.zip");
  writeZip(zip, [zipStored("../escaped.txt", "nope")]);
  assert.throws(() => extractZip(zip, join(root, "out")));
  assert.ok(!existsSync(join(root, "escaped.txt")), "nothing may be written above destDir");
});
