import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "./tarGz.js";

// A hand-built ustar record, so the extractor is tested against the format rather
// than against whatever tar happens to emit on this machine.
function tarRecord(name: string, data: Buffer, mode: number, typeflag = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write("        ", 148, "utf8"); // checksum placeholder
  header.write(typeflag, 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  // Checksum is computed with the checksum field read as spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

function makeArchive(root: string, entries: Array<{ name: string; body: string; mode: number; type?: string }>) {
  const parts = entries.map((e) =>
    tarRecord(e.name, Buffer.from(e.body, "utf8"), e.mode, e.type ?? "0")
  );
  parts.push(Buffer.alloc(1024)); // end-of-archive
  const gz = join(root, "a.tar.gz");
  writeFileSync(gz, gzipSync(Buffer.concat(parts)));
  return gz;
}

test("extracts files and PRESERVES THE EXECUTABLE BIT", () => {
  // The whole point: an unpacked llama-server that is not executable is a
  // non-executable llama-server, and that reads as a corrupt download.
  const root = mkdtempSync(join(tmpdir(), "targz-exec-"));
  const gz = makeArchive(root, [
    { name: "bin/llama-server", body: "#!/bin/sh\necho hi\n", mode: 0o755 },
    { name: "bin/libllama.so", body: "ELF", mode: 0o644 },
  ]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  const written = extractTarGz(gz, dest);

  assert.equal(written.length, 2);
  const bin = join(dest, "bin", "llama-server");
  assert.ok(existsSync(bin), "the binary must exist at its archived path");
  // 0o755 from the archive, plus whatever the umask allowed.
  assert.ok(statSync(bin).mode & 0o111, `llama-server must be executable, got ${(statSync(bin).mode & 0o7777).toString(8)}`);
  assert.ok(!(statSync(join(dest, "bin", "libllama.so")).mode & 0o111), "a .so must not become executable");
});

test("strip drops the single leading directory a release archive adds", () => {
  // Every entry in the PrismML release lives under `llama-<tag>/`, and the caller
  // wants the binaries in its own runtime dir with the .so files beside them.
  const root = mkdtempSync(join(tmpdir(), "targz-strip-"));
  const gz = makeArchive(root, [
    { name: "llama-prism-abc/llama-server", body: "x", mode: 0o755 },
    { name: "llama-prism-abc/libllama.so", body: "y", mode: 0o644 },
  ]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest, { strip: 1 });
  assert.ok(existsSync(join(dest, "llama-server")));
  assert.ok(existsSync(join(dest, "libllama.so")));
  assert.ok(!existsSync(join(dest, "llama-prism-abc")), "the wrapper directory must be gone");
});

test("creates directory entries", () => {
  const root = mkdtempSync(join(tmpdir(), "targz-dir-"));
  const gz = makeArchive(root, [
    { name: "pkg/", body: "", mode: 0o755, type: "5" },
    { name: "pkg/inside.txt", body: "hi", mode: 0o644 },
  ]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest);
  assert.ok(statSync(join(dest, "pkg")).isDirectory());
  assert.equal(statSync(join(dest, "pkg", "inside.txt")).size, 2);
});

test("skips links rather than half-writing them", () => {
  // A link entry whose target was never written looks like a present file. Better
  // absent, which is diagnosable.
  const root = mkdtempSync(join(tmpdir(), "targz-link-"));
  const gz = makeArchive(root, [{ name: "link", body: "target/path", mode: 0o777, type: "2" }]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest);
  assert.ok(!existsSync(join(dest, "link")));
});

test("survives a path longer than the 100-byte ustar name field", () => {
  const long = "deeply/" + "nested-directory-name/".repeat(6) + "llama-server";
  assert.ok(long.length > 100, "the fixture must actually exceed the field to be meaningful");
  const root = mkdtempSync(join(tmpdir(), "targz-long-"));
  const gz = makeArchive(root, [{ name: long.slice(0, 100), body: "x", mode: 0o755 }]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  // A truncated (non-GNU) long name is still written under the name we were given,
  // rather than crashing or writing outside destDir.
  const written = extractTarGz(gz, dest);
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith(dest), "nothing may be written outside destDir");
});

test("unpacks what GNU tar actually produced", () => {
  // The hand-built records above prove the format handling; this proves the real
  // thing round-trips, including the executable bit and long names that GNU emits
  // as separate 'L' records.
  let available = true;
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
  } catch {
    available = false;
  }
  if (!available) return; // no tar on this box: nothing to cross-check against

  const root = mkdtempSync(join(tmpdir(), "targz-real-"));
  const stage = join(root, "stage");
  mkdirSync(join(stage, "llama-prism-real"), { recursive: true });
  const longName = join(stage, "llama-prism-real", "a-very-long-shared-library-name-to-exceed-the-ustar-field.so");
  writeFileSync(join(stage, "llama-prism-real", "llama-server"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(longName, "ELF");
  const gz = join(root, "real.tar.gz");
  execFileSync("tar", ["czf", gz, "-C", stage, "."]);

  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest, { strip: 1 });
  const bin = join(dest, "llama-server");
  assert.ok(existsSync(bin), "the real archive's binary must be unpacked");
  assert.ok(statSync(bin).mode & 0o111, "and must be executable");
  assert.ok(existsSync(join(dest, "a-very-long-shared-library-name-to-exceed-the-ustar-field.so")),
    "a GNU long-name entry must be restored under its full name");
});

test("a non-tar payload throws instead of yielding a silent empty tree", () => {
  const root = mkdtempSync(join(tmpdir(), "targz-bad-"));
  const bad = join(root, "bad.tar.gz");
  writeFileSync(bad, gzipSync(Buffer.from("this is not a tar archive at all")));
  assert.throws(() => extractTarGz(bad, join(root, "out")));
});
test("materialises symlinks, because the shipped runtime depends on them", () => {
  // Not optional: the pinned llama.cpp release ships
  // `libllama-common.so.0 -> libllama-common.so.0.2.0`, and llama-server resolves
  // exactly that name. Without the link it dies with
  // "error while loading shared libraries" — which reads as a corrupt download.
  let available = true;
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
  } catch {
    available = false;
  }
  if (!available) return;

  const root = mkdtempSync(join(tmpdir(), "targz-symlink-"));
  const stage = join(root, "stage");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "libllama-common.so.0.2.0"), "REAL-SO-BYTES");
  execFileSync("ln", ["-s", "libllama-common.so.0.2.0", join(stage, "libllama-common.so.0")]);
  const gz = join(root, "s.tar.gz");
  execFileSync("tar", ["czf", gz, "-C", stage, "."]);

  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest);

  const link = join(dest, "libllama-common.so.0");
  assert.ok(existsSync(link), "the .so.0 name must exist after unpacking");
  // lstat, not stat: stat follows the link and would report the target's stats.
  assert.equal(lstatSync(link).isSymbolicLink(), true, "and must be a link, not a stub");
  assert.equal(readFileSync(link, "utf8"), "REAL-SO-BYTES", "and must resolve to the real bytes");
});

test("a symlink whose target is listed LATER still resolves", () => {
  // tar promises no ordering between a link and its target, so the link pass runs
  // after every file is written. A link created first would dangle.
  const root = mkdtempSync(join(tmpdir(), "targz-order-"));
  const gz = makeArchive(root, [
    { name: "libllama.so.0", body: "libllama.so.0.2.0", mode: 0o777, type: "2" },
    { name: "libllama.so.0.2.0", body: "REAL", mode: 0o644 },
  ]);
  const dest = join(root, "out");
  mkdirSync(dest, { recursive: true });
  extractTarGz(gz, dest);
  const link = join(dest, "libllama.so.0");
  assert.ok(existsSync(link), "the link must exist");
  assert.equal(readFileSync(link, "utf8"), "REAL");
});
