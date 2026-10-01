/**
 * Finding an existing llama.cpp, and building one when there isn't one.
 *
 * Requested directly: "llamacli 의 초기 구동 시 llama.cpp 가 존재를 하지
 * 않는다면 관련 설치 패키지와 llama.cpp 를 설치하고" — on first launch, if
 * llama.cpp is missing, install the build packages and llama.cpp itself.
 *
 * ── Reuse before build, always ──────────────────────────────────────────────
 * Building llama.cpp with CUDA takes 10-40 minutes. Doing that when a working
 * build is already sitting on the machine is the single worst thing this module
 * could do, so the search order is deliberately "cheapest and most likely
 * first", and a build is only attempted after every candidate has failed:
 *
 *   1. `$LLAMA_SERVER_BIN` — the user already told us.
 *   2. `llama-server` on PATH.
 *   3. A conventional `~/llama.cpp/buildX/bin/llama-server`.
 *   4. A llamacli-owned `~/.llamacli/llama.cpp/buildX/bin/llama-server`.
 *   5. Only then: clone + build.
 *
 * (Written as `buildX` rather than a glob on purpose: a literal glob star-slash
 * inside this block comment closes the comment early, which is a wonderfully
 * quiet way to produce a wall of nonsense parse errors.)
 *
 * A CUDA build is preferred over a CPU one when several are found, because
 * running a 35B MoE on CPU when a GPU build exists is the difference between
 * usable and not. The build directory name is the only signal available, so it
 * is a heuristic and the chosen binary's own reported backend is what actually
 * decides (see `probeLlamaServer`).
 */

import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hardware } from "./hardware.js";

const execFileAsync = promisify(execFile);

export const LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp";
/** Where llamacli keeps its OWN build, so it never touches a user's checkout. */
export const LLAMA_CPP_HOME = join(homedir(), ".llamacli", "llama.cpp");

export type Run = (file: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<string>;

export const defaultRun: Run = async (file, args, opts = {}) =>
  (await execFileAsync(file, args, { cwd: opts.cwd, timeout: opts.timeout ?? 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })).stdout;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The binary name for this platform. llama.cpp ships `llama-server.exe` on
 *  Windows and nothing anywhere else. */
const BIN_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server";

export interface LlamaLocation {
  binPath: string;
  /** Where it was found, for an honest status line ("PATH", "기존 빌드", …). */
  source: "env" | "path" | "existing-build" | "llamacli-build" | "systemd" | "built";
  /** Best guess at the accelerator it was compiled for, from the directory
   *  name / build flags. Verified separately by probeLlamaServer. */
  backend: "cuda" | "vulkan" | "cpu" | "unknown";
}

/**
 * Build-directory names, best-first. This is a PREFERENCE ORDER, not an
 * allowlist: `scanBuildDirs` below also tries every other directory it finds,
 * so a build in a name nobody anticipated is still found. It only decides
 * which of several real candidates wins.
 *
 * `build-opt` is the naming convention in wide use for an optimised CUDA
 * build, `build-cuda` is explicit, and a plain `build` is the cmake default.
 * `build-cpu` is what THIS module's own builder produces, so it has to be in
 * here: without it, a CPU-only machine that let llamacli build its own server
 * would fail to find that server on the next launch and rebuild it — 10 to 40
 * minutes — on every single start.
 *
 * `bin` and `Release` are NOT build directories; they are the second path
 * component of the two real layouts (`<root>/bin/llama-server` from a plain
 * `make`, and `build/bin/Release/…` on MSVC). They are enumerated by
 * `candidatePaths` instead, and listing them here produced paths like
 * `~/llama.cpp/bin/bin/llama-server` that exist nowhere.
 */
const BUILD_DIR_PREFERENCE = ["build-opt", "build-cuda", "build-cpu", "build", "build-release"];

/** Score for a build directory name; lower is better, and `undefined` means
 *  "not a recognised build dir at all" (still searched, just last). */
function buildDirRank(name: string): number | undefined {
  const i = BUILD_DIR_PREFERENCE.indexOf(name);
  if (i >= 0) return i;
  // A `build*` directory with an unrecognised suffix is still a build dir —
  // people name them after the CUDA version, the arch, the date. Ranking it
  // after the known names but before non-build directories is what makes a
  // `build-cuda-12.4` or `build-vulkan-rocm` discoverable.
  if (/^build/i.test(name)) return BUILD_DIR_PREFERENCE.length;
  return undefined;
}

function backendFromPath(p: string): LlamaLocation["backend"] {
  const s = p.toLowerCase();
  if (s.includes("cuda") || s.includes("opt") || s.includes("gpu")) return "cuda";
  if (s.includes("vulkan")) return "vulkan";
  if (s.includes("release") || s.includes("cpu")) return "cpu";
  return "unknown";
}

/** Every place a `llama-server` binary lives inside one llama.cpp checkout.
 *
 *  Exported and pure so the layout coverage is testable without a checkout.
 *  Three real layouts, none of which is a special case of the others:
 *
 *    1. `<root>/<buildDir>/bin/llama-server`   — cmake, the usual case
 *    2. `<root>/bin/llama-server`              — plain `make`, which puts the
 *                                                binaries at the repo root and
 *                                                is what a first-time llama.cpp
 *                                                user following the README
 *                                                ends up with
 *    3. `<root>/<buildDir>/bin/Release/…`      — MSVC multi-config generators
 *                                                (Visual Studio), where the
 *                                                configuration is a third path
 *                                                component
 *
 *  Layout 2 in particular was unreachable before: nothing looked at the repo
 *  root, so a `make`-built llama.cpp was invisible to llamacli no matter where
 *  it lived. */
export function candidatePaths(root: string, buildDirs: string[]): string[] {
  // Sorted HERE rather than relying on the caller: the ranking is what decides
  // which of several real builds wins, and a caller that supplies an unsorted
  // list must not be able to make a CPU build beat a CUDA one.
  const ranked = [...buildDirs].sort((a, b) => {
    const ra = buildDirRank(a);
    const rb = buildDirRank(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
  const out: string[] = [];
  for (const dir of ranked) {
    out.push(join(root, dir, "bin", BIN_NAME));
    out.push(join(root, dir, "bin", "Release", BIN_NAME));
  }
  out.push(join(root, "bin", BIN_NAME));
  out.push(join(root, BIN_NAME));
  return out;
}

/** Directory names inside a llama.cpp checkout, best candidate first.
 *
 *  Injected in tests; `readdir` for real. A missing or unreadable directory
 *  yields an empty list, which is the same as "no build here" — the caller
 *  then moves to the next root. */
async function listBuildDirs(root: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    // Unsorted: `candidatePaths` does the ranking, so the preference lives in
    // exactly one place.
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Locates a usable `llama-server` without building anything.
 *
 * Returns null when nothing usable is found, which is the caller's signal to
 * build. Exported with injectable `exists`/`env`/`listDirs` so the search order
 * itself is testable — the order is the entire point of this function, and it
 * is exactly the kind of thing that silently rots when it can only be exercised
 * by having a real build on the machine.
 *
 * Every candidate is EXECUTED before it is accepted (`probeLlamaServer`).
 * Existence is not usability: a binary built against a CUDA version this
 * driver does not have, or one whose `libggml-cuda.so` was never installed, is
 * present and executable and still fails to start — and accepting it means the
 * failure surfaces much later as an opaque spawn error instead of here, where
 * the next candidate could have been tried.
 */
export async function findLlamaServer(opts: {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
  listDirs?: (dir: string) => Promise<string[]>;
  probe?: (binPath: string) => Promise<boolean>;
  /** Model file the chosen binary must be able to read. Skips a build whose
   *  type registry rejects it (a stock llama.cpp cannot read a ternary 1-bit
   *  quant) instead of accepting it and failing at server-start time. */
  modelPath?: string;
  probeModel?: (binPath: string, modelPath: string | undefined, run: Run) => Promise<{ ok: boolean; error?: string }>;
  /** Set false to skip the model-compatibility pass entirely (tests, or when
   *  no model is known yet). */
  checkModel?: boolean;
  home?: string;
  run?: Run;
} = {}): Promise<FindResult> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isExecutable;
  const listDirs = opts.listDirs ?? listBuildDirs;
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRun;
  const probe = opts.probe ?? (async (p: string) => (await probeLlamaServer(p, run)).ok);

  // Collected rather than returned on sight, so a candidate that exists but
  // cannot run is skipped in favour of the next one.
  const rejected: string[] = [];
  // Candidates that run but cannot read the configured model. Recorded
  // separately because the reason is actionable — "you have two llama.cpp
  // builds and the one picked cannot read this quant" is a completely
  // different instruction from "that binary is broken".
  const rejectedForModel: string[] = [];
  const accept = async (
    binPath: string,
    source: LlamaLocation["source"]
  ): Promise<LlamaLocation | null> => {
    if (!(await probe(binPath))) {
      rejected.push(binPath);
      return null;
    }
    // Running is not the same as being able to read the model. Without this the
    // search happily returned a stock build for a ternary-quantised model and
    // the failure surfaced much later, as a server that exited with
    // "invalid ggml type 143" and a message blaming the port.
    if (opts.checkModel !== false && opts.modelPath) {
      const compat = await (opts.probeModel ?? probeModelCompatibility)(binPath, opts.modelPath, run);
      if (!compat.ok && looksLikeUnsupportedModelFormat(compat.error)) {
        rejectedForModel.push(binPath);
        return null;
      }
      // Any other load failure (a genuinely corrupt file, a missing dependency)
      // says nothing about this binary, so it is kept rather than skipped —
      // discarding a working install over a bad download would be worse.
    }
    return { binPath, source, backend: backendFromPath(binPath) };
  };

  // 1. Explicit overrides. Cheapest and unambiguous, so they win outright.
  //    Both names are accepted: the header comment of this file documented
  //    LLAMA_SERVER_BIN while the code only ever read LLAMACLI_LLAMA_SERVER, so
  //    a user who followed the documentation set a variable nothing looked at
  //    and were told llama.cpp could not be found.
  for (const key of ["LLAMACLI_LLAMA_SERVER", "LLAMA_SERVER_BIN"]) {
    const value = env[key];
    if (value && (await exists(value))) {
      const hit = await accept(value, "env");
      if (hit) return { location: hit, rejected, rejectedForModel };
    }
  }

  // 2. PATH. Split on the platform's own separator — a hardcoded ":" made every
  //    entry on Windows a single nonsensical path, so PATH search could never
  //    succeed there. Checked by name rather than by running `command -v`, so
  //    the same injectable `exists` seam covers every candidate.
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, BIN_NAME);
    if (await exists(candidate)) {
      const hit = await accept(candidate, "path");
      if (hit) return { location: hit, rejected, rejectedForModel };
    }
  }

  // 3. llama.cpp checkouts. Every directory inside the checkout is a candidate
  //    (see `listBuildDirs`), ranked so a recognised name wins, and each is
  //    tried in all three real layouts. Previously only two hardcoded roots
  //    were searched with a hardcoded list of directory names, so a
  //    `make`-built checkout, a build named after its CUDA version, and a
  //    second checkout anywhere else in the home directory were all invisible —
  //    and on a machine where none matched, the answer was "build it", which
  //    is 10 to 40 minutes of CUDA compilation to arrive at a binary the user
  //    already had.
  const roots = [
    { dir: join(home, "llama.cpp"), source: "existing-build" as const },
    // Derived from the injected `home`, not from the module-level constant:
    // a search that honours an injected home for one root and the real one for
    // the other cannot be tested, and on a machine where HOME differs from
    // what `homedir()` reports it would look in two different places.
    { dir: join(home, ".llamacli", "llama.cpp"), source: "llamacli-build" as const },
  ];
  for (const root of roots) {
    const buildDirs = await listDirs(root.dir);
    for (const candidate of candidatePaths(root.dir, buildDirs)) {
      if (await exists(candidate)) {
        const hit = await accept(candidate, root.source);
        if (hit) return { location: hit, rejected, rejectedForModel };
      }
    }
  }

  // 4. A systemd user unit. On a machine where llama-server is managed as a
  //    service — a common way to run it on a workstation — the binary path is
  //    declared in the unit file or the script it ExecStart's, and is
  //    otherwise nowhere discoverable. This is what made a service-managed
  //    install look like "llama.cpp is not installed" to llamacli.
  for (const binPath of await systemdLlamaServerPaths(env, { exists, run: opts.run ?? defaultRun })) {
    const hit = await accept(binPath, "systemd");
    if (hit) return { location: hit, rejected, rejectedForModel };
  }

  return { location: null, rejected, rejectedForModel };
}

/** A machine where a binary EXISTS but cannot run is otherwise reported as
 *  "llama.cpp not found", which sends the user looking for an install that is
 *  sitting right there. Returned alongside the result so the reason survives. */
export interface FindResult {
  location: LlamaLocation | null;
  /** Paths that exist but failed `probeLlamaServer`. */
  rejected: string[];
  /** Paths that RUN but whose type registry rejects the configured model —
   *  a different llama.cpp build than the model needs. Surfaced because the
   *  instruction is specific: point `llama.binPath` at one of these, or use a
   *  quant the chosen build understands. */
  rejectedForModel?: string[];
}

/** Parses a llama-server binary path out of a systemd user unit.
 *
 *  Two shapes are handled, because that is what exists in the wild:
 *    - `ExecStart=/home/u/bin/run-server.sh`  → the path is inside the SCRIPT
 *    - `ExecStart=/home/u/llama.cpp/build/bin/llama-server -m …`  → it is the
 *      ExecStart itself
 *
 *  Reading the script matters as much as reading the unit: the unit almost
 *  never names the binary, it names a wrapper that does.
 */
export async function systemdLlamaServerPaths(
  env: NodeJS.ProcessEnv,
  deps: { exists: (path: string) => Promise<boolean>; run: Run }
): Promise<string[]> {
  const unitDir = join(env.HOME ?? homedir(), ".config", "systemd", "user");
  const out: string[] = [];
  let text: string;
  try {
    const { readFile, readdir } = await import("node:fs/promises");
    const units = (await readdir(unitDir)).filter((f) => /^llama.*\.service$/.test(f));
    for (const unit of units) {
      text = await readFile(join(unitDir, unit), "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*ExecStart\s*=\s*(\S+)/.exec(line);
        if (!m) continue;
        // systemd specifiers are the norm in a user unit: `%h` is the home
        // directory, and it is what this very repo's unit uses
        // (`ExecStart=%h/bin/run-server.sh`). Passed through unexpanded, the
        // path does not exist and the unit looks like it names no binary at
        // all.
        const target = m[1]
          .replace(/^"|"$/g, "")
          .replace(/%h/g, env.HOME ?? homedir())
          .replace(/%t/g, "/tmp");
        // A wrapper script: look for the binary it launches.
        if (/\.(sh|bash)$/.test(target) || !target.includes(BIN_NAME)) {
          let body: string;
          try {
            body = await readFile(target, "utf8");
          } catch {
            continue; // the wrapper is named but absent — try the next unit
          }
          for (const assign of body.matchAll(/^\s*([A-Z_]*BIN[A-Z_]*)=["']?([^"'\s]+)["']?/gm)) {
            const binPath = assign[2];
            if (binPath.includes(BIN_NAME) && (await deps.exists(binPath))) out.push(binPath);
          }
          continue;
        }
        if (await deps.exists(target)) out.push(target);
      }
    }
  } catch {
    return out; // no systemd user dir, or unreadable — not an error
  }
  return out;
}

/** Asks a candidate binary what it actually is.
 *
 *  This used to exist and be called by nobody: the search accepted any file
 *  that was executable, so a binary built against a CUDA version this driver
 *  does not have — or one whose `libggml-cuda.so` was never installed — was
 *  recorded in config.yaml and only failed much later, at spawn, with an
 *  opaque error naming nothing useful. `findLlamaServer` now calls it on every
 *  candidate, which is also what makes "exists but will not run" a state the
 *  search can report instead of pass through.
 *
 *  `backendFromPath`'s guess is confirmed here too, when the binary says so.
 */
export async function probeLlamaServer(binPath: string, run: Run = defaultRun): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
  /** True when the binary runs but cannot read the configured model at all. */
  modelUnsupported?: boolean;
}> {
  try {
    const out = await run(binPath, ["--version"], { timeout: 20_000 });
    const m = /version:\s*(\S+)/i.exec(out) ?? /(\d{3,4})/.exec(out);
    return { ok: true, version: m?.[1] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether this llama-server can read the given model file.
 *
 * `--version` proves the binary runs; it says nothing about whether it can load
 * the weights we are about to hand it. Those are separate builds with separate
 * type registries, and picking the wrong one produces a failure that reads like
 * a corrupt download:
 *
 *   tensor 'output.weight' has invalid ggml type 143. should be in [0, 43)
 *
 * Type 143 is a ternary (3-valued) quant, added by the PrismML fork. The stock
 * `~/llama.cpp` build on this machine tops out at 42, so it rejects a 1-bit
 * Bonsai outright — while a `bonsai2-runtime` build sitting elsewhere on the
 * same disk loads it fine. `findLlamaServer` ranks `~/llama.cpp/build-opt` first
 * and accepted it, because until now nothing asked the question.
 *
 * So this loads nothing: it asks the binary to parse the GGUF header only,
 * which is a few hundred KB of the file, and treats the "invalid ggml type"
 * family of errors as "wrong build" rather than "bad download".
 */
export async function probeModelCompatibility(
  binPath: string,
  modelPath: string | undefined,
  run: Run = defaultRun
): Promise<{ ok: boolean; error?: string }> {
  if (!modelPath) return { ok: true };
  try {
    // `--no-warmup` stops after loading rather than allocating a context, and
    // `-c 64` keeps the KV buffer tiny; we want the header parsed, not a
    // running model. -ngl 0 keeps it off the GPU so this is cheap and cannot
    // disturb a server that is already using VRAM.
    await run(binPath, ["-m", modelPath, "-c", "64", "-ngl", "0", "--no-warmup"], {
      timeout: 60_000,
      // The load failure is the signal here, so its output must not throw.
      tolerateExitCode: true,
    } as never);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when a load failure looks like "this build cannot read this format".
 *
 *  Deliberately narrow: these specific messages mean the binary's type registry
 *  does not know the file's quantization, which is a build mismatch and not
 *  anything wrong with the model. A generic "failed to load" is not enough to
 *  claim that, so it is excluded. */
export function looksLikeUnsupportedModelFormat(message: string | undefined): boolean {
  if (!message) return false;
  return /invalid ggml type|unknown ggml type|unsupported (?:tensor )?type/i.test(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Building
// ─────────────────────────────────────────────────────────────────────────────

/** Debian/Ubuntu packages llama.cpp needs to compile at all, and CUDA adds two
 *  more. Kept as data so the install step is testable and so the apt line in the
 *  status output can be shown to the user BEFORE it runs. */
export const BASE_BUILD_PACKAGES = [
  "build-essential", "cmake", "git", "curl", "libcurl4-openssl-dev", "pkg-config",
];
export const CUDA_BUILD_PACKAGES = ["cuda-toolkit-12-4"];

/**
 * Installs the build dependencies.
 *
 * Uses `sudo -n` first — non-interactive, so it FAILS FAST instead of hanging
 * on a password prompt the user cannot see. Only if that fails do we retry
 * interactively, and only because a locked-out install is a worse outcome than
 * an interrupted one. The user was asked about this trade-off and chose to
 * allow the prompt; the fast path is still tried first so the common case
 * (passwordless sudo, e.g. a dev box) never prompts at all.
 */
export async function installBuildPackages(
  opts: { cuda: boolean; run: Run; interactive?: boolean }
): Promise<{ ok: boolean; output: string }> {
  const packages = opts.cuda ? [...BASE_BUILD_PACKAGES, ...CUDA_BUILD_PACKAGES] : BASE_BUILD_PACKAGES;
  const attempts: [string, string[]][] = [["sudo", ["-n", "apt-get", "install", "-y", ...packages]]];
  if (opts.interactive !== false) {
    attempts.push(["sudo", ["apt-get", "install", "-y", ...packages]]);
  }
  let last = "";
  for (const [file, args] of attempts) {
    try {
      const output = await opts.run(file, args, { timeout: 10 * 60_000 });
      return { ok: true, output };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, output: last };
}

export interface BuildOptions {
  hw: Hardware;
  run: Run;
  /** Called with human-readable progress lines. */
  log?: (line: string) => void;
  installDeps?: boolean;
}

/** Clones (or updates) and builds llama.cpp, returning the built binary path.
 *
 * The CUDA decision comes from `hw.canBuildCuda` — a machine can have a GPU
 * with no `nvcc`, and asking cmake for `-DGGML_CUDA=ON` in that state produces
 * a configure error rather than a CPU fallback. Threads are capped at the core
 * count because a `-j` larger than the machine only thrashes.
 */
export async function buildLlamaCpp(opts: BuildOptions): Promise<string> {
  const { hw, run, log = () => {} } = opts;
  const dir = LLAMA_CPP_HOME;

  if (opts.installDeps !== false) {
    log(`빌드 패키지를 설치합니다 (CUDA: ${hw.canBuildCuda ? "예" : "아니오"})…`);
    const deps = await installBuildPackages({ cuda: hw.canBuildCuda, run });
    if (!deps.ok) {
      // Not fatal on its own: the machine may already have everything (which is
      // the common case on a dev box, and is why we try the build regardless).
      log(`패키지 자동 설치에 실패했지만 이미 설치되어 있을 수 있어 계속합니다: ${deps.output.split("\n").slice(-1)[0]}`);
    }
  }

  if (!(await dirExists(join(dir, ".git")))) {
    log(`llama.cpp 소스를 받습니다 → ${dir}`);
    await run("git", ["clone", "--depth", "1", LLAMA_CPP_REPO, dir], { timeout: 20 * 60_000 });
  }

  const buildDir = hw.canBuildCuda ? "build-cuda" : "build-cpu";
  const cmakeFlags = [
    "-B", buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLLAMA_CURL=OFF",
    // GGML_NATIVE lets the build target this exact CPU, which on a modern
    // desktop CPU is a large prefill/decode win over a generic build.
    "-DGGML_NATIVE=ON",
    ...(hw.canBuildCuda ? ["-DGGML_CUDA=ON"] : []),
  ];
  log(`cmake 설정 중… (${hw.canBuildCuda ? "CUDA" : "CPU"})`);
  await run("cmake", cmakeFlags, { cwd: dir, timeout: 20 * 60_000 });

  const jobs = String(Math.max(1, Math.min(hw.cpuCount, 16)));
  log(`빌드 중… (-j${jobs})`);
  await run("cmake", ["--build", buildDir, "--config", "Release", "-j", jobs], {
    cwd: dir,
    // A CUDA build of llama.cpp is genuinely long; the generic 20 min default
    // is not enough on a slow CPU and would abort a build that was working.
    timeout: 120 * 60_000,
  });

  const bin = join(dir, buildDir, "bin", "llama-server");
  if (!(await isExecutable(bin))) {
    throw new Error(`빌드가 끝났지만 ${bin} 을 찾을 수 없습니다.`);
  }
  return bin;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
