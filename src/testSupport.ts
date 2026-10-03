/**
 * Helpers that let tests written with POSIX literals run on Windows too.
 *
 * The product builds paths with `node:path` (backslashes on Windows) and names the binary `llama-server.exe` there;
 * tests that compared against `"/usr/local/bin/llama-server"` or wrote a fixture called `llama-server` could not pass
 * on Windows for reasons that had nothing to do with the code under test. On POSIX every helper is the identity, so
 * what these tests assert on Linux and macOS does not change.
 */
import { delimiter, normalize } from "node:path";

export const IS_WIN = process.platform === "win32";
/** Executable suffix of this platform. */
export const EXE = IS_WIN ? ".exe" : "";
/** The llama-server file name on this platform. */
export const SRV = `llama-server${EXE}`;

/** A POSIX-style literal as `node:path` would produce it here (separators only). */
export const P = (p: string): string => normalize(p);

/** Like `P`, for a path ending in the llama-server binary: also the platform's executable name. */
export const B = (p: string): string => normalize(p.replace(/llama-server$/, SRV));

/** A PATH value built with the platform's delimiter. */
export const PATHS = (...dirs: string[]): string => dirs.join(delimiter);

/** A path in the POSIX spelling the fixtures use ("\\m\\models" -> "/m/models"); for fake `exists`/`listDirs` lookups. */
export const posix = (p: string): string => p.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");

// ── a fake llama-server that REALLY runs, on every OS ────────────────────────────────────────────────────────────

export interface FakeExeSpec {
  /** Printed on stdout (e.g. `version: 1 (abc)` for the `--version` probe). */
  stdout?: string;
  stderr?: string;
  /** Exit status (default 0). Ignored when `serve` is set. */
  exit?: number;
  /** Write the received argv (space-joined) to this file — how a test observes the flags a launch used. */
  argsFile?: string;
  /** Answer `{"data":[{"id":"fake"}]}` on `--port <n>` and keep running, like a server that is up. */
  serve?: boolean;
}

/**
 * Writes an executable at `path` that behaves per `spec`. POSIX: a small script (what these tests always used).
 * Windows: a real `.exe` — Node cannot run `.cmd`/shebang scripts without a shell, and `node.exe` itself would try to
 * interpret flags like `-m` — so a Node single-executable application is built once per process (node.exe + a blob
 * injected with `postject`) and copied per fixture, with the spec in a sidecar JSON next to it.
 */
export async function writeFakeExe(path: string, spec: FakeExeSpec): Promise<void> {
  const { writeFile, chmod, copyFile } = await import("node:fs/promises");
  if (!IS_WIN && process.env.LLAMACLI_FORCE_SEA !== "1") {
    const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    if (spec.serve) {
      await writeFile(
        path,
        `#!/usr/bin/env node
const http = require("http");
const i = process.argv.indexOf("--port");
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fake" }] }));
}).listen(Number(process.argv[i + 1]), "127.0.0.1");
`
      );
    } else {
      const lines = ["#!/bin/sh"];
      if (spec.argsFile) lines.push(`echo "$@" > ${sh(spec.argsFile)}`);
      if (spec.stdout) lines.push(`echo ${sh(spec.stdout)}`);
      if (spec.stderr) lines.push(`echo ${sh(spec.stderr)} >&2`);
      if (spec.exit) lines.push(`exit ${spec.exit}`);
      await writeFile(path, lines.join("\n") + "\n");
    }
    await chmod(path, 0o755);
    return;
  }
  const base = await seaBase();
  await copyFile(base, path);
  await writeFile(`${path}.fake.json`, JSON.stringify(spec));
}

const FAKE_JS = `
const fs = require("fs");
let spec = {};
try { spec = JSON.parse(fs.readFileSync(process.execPath + ".fake.json", "utf8")); } catch {}
const args = process.argv.slice(2);
if (spec.argsFile) fs.writeFileSync(spec.argsFile, args.join(" ") + "\\n");
if (spec.stdout) process.stdout.write(spec.stdout + "\\n");
if (spec.stderr) process.stderr.write(spec.stderr + "\\n");
if (spec.serve) {
  const http = require("http");
  const i = args.indexOf("--port");
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake" }] }));
  }).listen(Number(args[i + 1]), "127.0.0.1");
} else process.exitCode = spec.exit ?? 0;
`;

let seaBaseCache: Promise<string> | undefined;
function seaBase(): Promise<string> {
  seaBaseCache ??= (async () => {
    const { mkdtemp, writeFile, copyFile } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRequire } = await import("node:module");
    const dir = await mkdtemp(join(tmpdir(), "llamacli-sea-"));
    await writeFile(join(dir, "fake.js"), FAKE_JS);
    await writeFile(join(dir, "sea.json"), JSON.stringify({ main: "fake.js", output: "fake.blob", disableExperimentalSEAWarning: true }));
    // LLAMACLI_SEA_NODE: a full (non-distro-stub) node binary, for exercising this path on Linux.
    const nodeBin = process.env.LLAMACLI_SEA_NODE || process.execPath;
    execFileSync(nodeBin, ["--experimental-sea-config", "sea.json"], { cwd: dir, stdio: "pipe" });
    const exe = join(dir, "base.exe");
    await copyFile(nodeBin, exe);
    const postject = createRequire(import.meta.url).resolve("postject/dist/cli.js");
    execFileSync(
      nodeBin,
      [postject, exe, "NODE_SEA_BLOB", join(dir, "fake.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"],
      { stdio: "pipe" }
    );
    return exe;
  })();
  return seaBaseCache;
}
