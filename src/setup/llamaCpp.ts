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
import { delimiter, dirname, join } from "node:path";
import { execFile, spawn as spawnProc } from "node:child_process";
import { promisify } from "node:util";
import type { Hardware } from "./hardware.js";
import { chooseBuildTarget, detectCudaArch, detectHipInfo, buildJobs, buildDiskBytes, type BuildBackend, type BuildTarget } from "./buildTarget.js";
import { planBuildEnv, applyBuildEnv } from "./buildEnv.js";
import { diskInfoFor, type Statfs } from "./disk.js";
import type { TransferProgress } from "./download.js";

const execFileAsync = promisify(execFile);

export const LLAMA_CPP_REPO = "https://github.com/ggml-org/llama.cpp";
/** Where llamacli keeps its OWN build, so it never touches a user's checkout. */
export const LLAMA_CPP_HOME = join(homedir(), ".llamacli", "llama.cpp");

export type Run = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    timeout?: number;
    /** Called with each output line as it is produced (stdout and stderr). Present only
     *  for long steps whose silence reads as a hang — a compile prints for 30 minutes
     *  and `execFile` hands none of it back until the end. */
    onLine?: (line: string) => void;
  }
) => Promise<string>;

export const defaultRun: Run = async (file, args, opts = {}) => {
  if (!opts.onLine) {
    return (await execFileAsync(file, args, { cwd: opts.cwd, timeout: opts.timeout ?? 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawnProc(file, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // Only the tail is kept: a full build log is tens of MB, and the tail is what
    // says why it failed.
    let tail: string[] = [];
    const feed = (stream: NodeJS.ReadableStream) => {
      let pending = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          tail.push(line);
          if (tail.length > 40) tail = tail.slice(-40);
          opts.onLine!(line);
        }
      });
    };
    feed(child.stdout!);
    feed(child.stderr!);
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : undefined;
    child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(tail.join("\n"));
      else reject(new Error(`${file} 가 ${signal ?? `종료 코드 ${code}`} 로 끝났습니다:\n${tail.slice(-12).join("\n")}`));
    });
  });
};

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
/**
 * The binary's filename on this platform.
 *
 * A FUNCTION, not a module-level const. As a const it was frozen from
 * `process.platform` at import time, which meant the Windows `.exe` name could
 * not be exercised by any test on a Linux box -- the platform-specific naming
 * was real code that nothing could reach. Same mistake as reading `HOME` once
 * at module load: a value decided before anything could ask the question.
 */
export function binNameFor(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

/** The name for the host platform.
 *
 *  Only the PATH lookup consults `binNameFor(opts.platform)`; the build
 *  directory layouts below use this, because llama.cpp's own layout
 *  (`build/bin`, `build/Release/bin`) is the same on every platform it ships
 *  for, and threading a platform parameter through every one of those helpers
 *  would be a large refactor to make an unchanged behaviour injectable. */
const BIN_NAME = binNameFor();

export interface LlamaLocation {
  binPath: string;
  /** Where it was found, for an honest status line ("PATH", "기존 빌드", …). */
  source: "env" | "path" | "existing-build" | "llamacli-build" | "model-adjacent" | "systemd" | "built" | "downloaded";
  /** Best guess at the accelerator it was compiled for, from the directory
   *  name / build flags. Verified separately by probeLlamaServer. */
  backend: "cuda" | "rocm" | "vulkan" | "metal" | "cpu" | "unknown";
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
const BUILD_DIR_PREFERENCE = ["build-opt", "build-cuda", "build-metal", "build-rocm", "build-vulkan", "build-cpu", "build", "build-release"];

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
  if (s.includes("rocm") || s.includes("hip")) return "rocm";
  if (s.includes("metal")) return "metal";
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
    // The UNPACKED shape, which is what every published release archive is: the
    // binary and its .so files sit directly in the directory, with no `bin/`. A
    // cmake build is never laid out this way, so this cannot shadow one — but
    // omitting it makes an installed runtime invisible to the very search meant
    // to find it, and the machine then re-downloads or re-builds on every launch.
    out.push(join(root, dir, BIN_NAME));
  }
  out.push(join(root, "bin", BIN_NAME));
  out.push(join(root, BIN_NAME));
  return out;
}

/**
 * llama-server builds installed NEXT TO the models they serve.
 *
 * This is a second real install shape, and the one that was invisible here.
 * llama.cpp publishes prebuilt release archives (`llama-bNNNN-bin-ubuntu-x64`)
 * that are unpacked, not compiled — which puts a complete runtime with its own
 * `llama-server` and its `.so` files wherever the user keeps their models. That
 * is not a llama.cpp *checkout*, so it appears in neither PATH nor any of the
 * `~/llama.cpp` roots searched above, and the binary that runs the model is
 * simply not among the candidates.
 *
 * Observed directly: the model lives at
 * `<drive>/models/bonsai2/Ternary-Bonsai-2-27B-PTQ1_0.gguf` and the only
 * build that can read it is `<drive>/bonsai2-runtime/llama-server`, which no
 * existing rule reached. The result was a dead end — the one working binary was
 * on the same disk, two directories away.
 *
 * Scanned from the model's own directory upward, because that is the one
 * location already known to be relevant. Depth is bounded: an unbounded walk
 * out of `/media/<user>/<volume>` would eventually reach the whole filesystem.
 *
 * What this does NOT decide is whether a candidate is any good — widening where
 * we look is safe precisely because `probeModelCompatibility` still arbitrates.
 * An unrelated sibling that happens to contain a `llama-server` is probed and
 * rejected, and appears in the rejection list, rather than being launched.
 */
export const MODEL_RUNTIME_SCAN_DEPTH = 3;

/** Directories that hold a llama-server beside the given model.
 *
 *  Returns absolute paths in scan order, nearest first. Empty when there is no
 *  model path — with no model there is nothing for a runtime to be adjacent to,
 *  and guessing at directories is what this function exists to avoid. */
export async function runtimeCandidatesNearModel(
  modelPath: string | undefined,
  opts: { exists?: (p: string) => Promise<boolean>; listDirs?: (dir: string) => Promise<string[]> } = {}
): Promise<string[]> {
  if (!modelPath) return [];
  const exists = opts.exists ?? isExecutable;
  const listDirs = opts.listDirs ?? listBuildDirs;
  const found = new Set<string>();
  let dir = dirname(modelPath);
  for (let depth = 0; depth <= MODEL_RUNTIME_SCAN_DEPTH; depth++) {
    const parent = dirname(dir);
    // Stop at the filesystem root rather than spinning on `dirname("/") === "/"`.
    if (parent === dir) break;
    for (const entry of await listDirs(dir)) {
      const candidate = join(dir, entry, BIN_NAME);
      // A file, not a directory: `llama-server` itself must not be treated as
      // its own parent directory.
      if (entry === BIN_NAME) continue;
      if (await exists(candidate)) found.add(candidate);
    }
    dir = parent;
  }
  return [...found];
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
  probeModel?: typeof probeModelCompatibility;
  /** Injected for tests; defaults to a real spawn. */
  spawnProbe?: ProbeSpawn;
  /** Overrides the host platform. Injectable because the binary's NAME depends on
   *  it, and a name frozen at import time is untestable. */
  platform?: NodeJS.Platform;
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
  // Kept, but never confirmed to be able to read the model. Kept because
  // discarding a working install over a bad download would be worse.
  const unverified: string[] = [];
  // Memoised per path, because `candidatePaths` yields the same binary under
  // each of the three real build layouts and the loop below tries all three.
  // Without this, one binary is probed with `--version` up to three times and —
  // far worse — `probeModelCompatibility` is a PROCESS SPAWN that parses a GGUF
  // header, so a stock build rejected for a ternary model was launched and
  // re-read three times over, and reported to the user three times.
  const decided = new Map<string, Promise<LlamaLocation | null>>();
  const accept = (binPath: string, source: LlamaLocation["source"]): Promise<LlamaLocation | null> => {
    const cached = decided.get(binPath);
    if (cached) return cached;
    const verdict = decide(binPath, source);
    decided.set(binPath, verdict);
    return verdict;
  };
  const decide = async (
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
      const compat = await (opts.probeModel ?? probeModelCompatibility)(binPath, opts.modelPath, {
        run,
        spawn: opts.spawnProbe,
      });
      if (!compat.ok && looksLikeUnsupportedModelFormat(compat.error)) {
        rejectedForModel.push(binPath);
        return null;
      }
      // "Other" load failures (a genuinely corrupt file, a missing dependency)
      // say nothing about this binary, so it is kept rather than skipped —
      // discarding a working install over a bad download would be worse.
      //
      // "Inconclusive" is different in kind: nothing was learned at all, so the
      // binary is still kept — it is the best candidate available — but it is
      // ALSO recorded, because "kept" here means "not disproven", not "verified".
      // Presenting that as a positive result is how a stock build ends up
      // reported as able to read a ternary quant.
      if (compat.verdict === "inconclusive") unverified.push(binPath);
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
      if (hit) return { location: hit, rejected, rejectedForModel, unverified };
    }
  }

  // 2. PATH. Split on the platform's own separator — a hardcoded ":" made every
  //    entry on Windows a single nonsensical path, so PATH search could never
  //    succeed there. Checked by name rather than by running `command -v`, so
  //    the same injectable `exists` seam covers every candidate.
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, binNameFor(opts.platform));
    if (await exists(candidate)) {
      const hit = await accept(candidate, "path");
      if (hit) return { location: hit, rejected, rejectedForModel, unverified };
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
    // The two roots a TERNARY-capable runtime lands in (see ternaryRuntime.ts and
    // buildLlamaCpp's `repo` option). They were missing, and that is not a
    // cosmetic omission: llamacli downloaded its pinned PrismML prebuilt to
    // ~/.llamacli/prism-llama.cpp/<subdir>/, or built the fork into
    // ~/.llamacli/llama.cpp-fork/, and then never searched either — so the very
    // next launch could not see what it had just installed and would fetch or
    // compile the whole thing again. Every launch, forever.
    { dir: join(home, ".llamacli", "prism-llama.cpp"), source: "llamacli-build" as const },
    { dir: join(home, ".llamacli", "llama.cpp-fork"), source: "llamacli-build" as const },
    // Stock prebuilts installed by stockRuntime.ts, one subdirectory per backend.
    { dir: join(home, ".llamacli", "llama.cpp-prebuilt"), source: "llamacli-build" as const },
  ];
  for (const root of roots) {
    const buildDirs = await listDirs(root.dir);
    for (const candidate of candidatePaths(root.dir, buildDirs)) {
      if (await exists(candidate)) {
        const hit = await accept(candidate, root.source);
        if (hit) return { location: hit, rejected, rejectedForModel, unverified };
      }
    }
  }

  // 4. Runtimes installed beside the models. Ranked below every declared
  //    location on purpose: a build the user put in PATH or named in a unit
  //    file is a decision, whereas this is a guess about where an unpacked
  //    release archive ended up. It is tried because being unable to reach the
  //    one working binary is a dead end, not because it should ever win.
  if (opts.modelPath) {
    for (const binPath of await runtimeCandidatesNearModel(opts.modelPath, { exists, listDirs })) {
      const hit = await accept(binPath, "model-adjacent");
      if (hit) return { location: hit, rejected, rejectedForModel, unverified };
    }
  }

  // 5. A systemd user unit. On a machine where llama-server is managed as a
  //    service — a common way to run it on a workstation — the binary path is
  //    declared in the unit file or the script it ExecStart's, and is
  //    otherwise nowhere discoverable. This is what made a service-managed
  //    install look like "llama.cpp is not installed" to llamacli.
  for (const binPath of await systemdLlamaServerPaths(env, { exists, run: opts.run ?? defaultRun })) {
    const hit = await accept(binPath, "systemd");
    if (hit) return { location: hit, rejected, rejectedForModel, unverified };
  }

  return { location: null, rejected, rejectedForModel, unverified };
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
  /**
   * Paths that were KEPT because nothing proved them wrong, while also not
   * being confirmed able to read the configured model. Non-empty means the
   * answer to "will this build read your model" is unknown, and saying so is
   * more useful than a confident guess.
   */
  unverified?: string[];
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
export type CompatVerdict =
  /** The build read the model. Established, not assumed. */
  | "ok"
  /** The build's type registry rejected the file. */
  | "unsupported"
  /** The load failed for some other reason (corrupt file, missing dependency). */
  | "other"
  /** Nothing was learned -- the process neither reported a verdict nor finished. */
  | "inconclusive";

export interface CompatResult {
  ok: boolean;
  error?: string;
  /**
   * Optional so existing injected probes that only return `{ ok, error }` still
   * typecheck. Absent means "did not say", which is treated as the pre-existing
   * `ok` semantics rather than as a new claim.
   */
  verdict?: CompatVerdict;
}

/** Streams a candidate binary's output so a verdict can be reached without
 *  waiting for the process to exit. Injected for tests. */
export type ProbeSpawn = (
  binPath: string,
  args: string[],
  handlers: {
    onOutput: (chunk: string) => void;
    onError: (err: Error) => void;
    /** The process ended on its own, with its exit code. */
    onExit: (code: number | null) => void;
  }
) => { kill(): void };

const realProbeSpawn: ProbeSpawn = (binPath, args, { onOutput, onError, onExit }) => {
  // A top-level import, not a lazy `require`: this module is ESM, where
  // `require` is undefined. A lazy require threw, every probe returned "other",
  // and since "other" is not a format complaint the candidate was KEPT -- which
  // silently reported the stock build as able to read a ternary quant. A probe
  // that cannot start must never look like a probe that passed.
  const proc = spawnProc(binPath, args);
  proc.stdout?.on("data", (d: Buffer) => onOutput(d.toString()));
  proc.stderr?.on("data", (d: Buffer) => onOutput(d.toString()));
  // Without this, a binary that cannot be executed emits an `error` event that
  // nothing handles, and Node turns it into an uncaught exception that takes the
  // caller down. A probe that cannot START must resolve to a verdict, not crash
  // the process that asked the question.
  proc.on("error", (err) => onError(err));
  proc.on("exit", (code) => onExit(code));
  return { kill: () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } } };
};

/** Output that can only appear once the model is loaded and the context is
 *  being created -- i.e. the header parsed AND the tensors were accepted.
 *
 *  Deliberately a "post-load" marker rather than a "parsed" one: the type
 *  registry is consulted while tensor infos are read, so anything that survives
 *  to this point has already proved it understands every type in the file. */
const MODEL_LOADED = /load_tensors:\s*done|load_model:\s*initializing|model\s+loaded/i;

/** A load that failed for a reason that is NOT about tensor types -- a corrupt
 *  file, a truncated download, a missing dependency.
 *
 *  Recognised separately so it is not confused with "we learned nothing". These
 *  say something definite about the FILE while saying nothing about the binary,
 *  which is exactly the case that must not be reported as a build mismatch and
 *  must not be left to time out. Ordering matters: the type check runs first, so
 *  an "invalid ggml type" line is never swallowed by this. */
const LOAD_FAILED =
  /llama_model_loader:[^\n]*failed|failed to load model|error loading model|unexpected end of file|file is corrupted/i;

/**
 * Can this build READ this model?
 *
 * ── Why this streams and kills instead of awaiting exit ─────────────────────
 * The previous version ran the binary with `--no-warmup` and awaited it, on the
 * belief that the flag "stops after loading". Measured on this machine, that is
 * false: `--no-warmup` suppresses the warmup REQUEST, and the process then goes
 * on to serve forever. A build that CAN read the model therefore never exits and
 * always burned the full 60 s timeout -- measured 180 s when the timeout was
 * raised, with the model itself fully loaded by ~3 s. A build that CANNOT read
 * it failed in 178 ms. So the expensive case was the successful one, on every
 * `/models` and every `/reset`.
 *
 * The verdict is therefore taken from the OUTPUT and the process killed the
 * moment it is known: ~3 s instead of 60 s, and the positive answer is now
 * actually established rather than merely never-disproven.
 *
 * ── Why "inconclusive" is its own answer ───────────────────────────────────
 * A timeout used to be caught, turned into a generic error, and then — because
 * a timeout is not a format complaint — the candidate was KEPT. So "this build
 * can read your model" was never verified for a working build; it was inferred
 * from a failure that carried no information. That is the same class of bug as
 * treating silence as consent, and it is reported as `inconclusive` instead so
 * the caller can say so out loud rather than presenting an assumption as a
 * measurement.
 */
export async function probeModelCompatibility(
  binPath: string,
  modelPath: string | undefined,
  deps: { run?: Run; spawn?: ProbeSpawn; timeoutMs?: number } = {}
): Promise<CompatResult> {
  if (!modelPath) return { ok: true, verdict: "ok" };

  const spawnProbe = deps.spawn ?? realProbeSpawn;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const args = [
    "-m", modelPath,
    "-c", "64",
    // Off the GPU, so the probe is cheap and cannot disturb a server that is
    // already holding VRAM we are about to need.
    "-ngl", "0",
    "--no-warmup",
  ];

  return new Promise<CompatResult>((resolve) => {
    let text = "";
    let settled = false;
    let proc: { kill(): void } | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (verdict: CompatVerdict) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Kill unconditionally: in every non-timeout path the process is still
      // running and serving, and leaving it alive would put a second
      // llama-server on the machine holding the model's VRAM.
      //
      // The handle may not exist yet if a verdict arrived before the spawn
      // returned. That ordering is easy to lose track of — the kill is the one
      // side effect that must not be skipped, so the verdict is remembered and
      // applied below as soon as there is something to kill. A probe that
      // decides "ok" and then leaves a server running is worse than a slow one.
      try { proc?.kill(); } catch { /* not started yet, or already gone */ }
      resolve({ ok: verdict === "ok", verdict, error: verdict === "ok" ? undefined : tailOf(text) });
    };

    try {
      proc = spawnProbe(
        binPath,
        args,
        {
          onExit: (code) => {
            // A process that ENDS is a definite answer, and this case was
            // missing: the probe resolved only on a marker or the timeout, so
            // any binary that exited early -- a wrapper script, a build that
            // fails before it says anything -- waited the full 60 s for a
            // verdict that had already happened. The harness's stub server
            // exits instantly and still cost a minute per probe.
            //
            // Exit 0 with no complaint means it did what was asked. Non-zero
            // means the load did not complete -- "other", which says the file is
            // at fault rather than the build, and is not "inconclusive".
            finish(code === 0 ? "ok" : "other");
          },
          onOutput: (chunk) => {
            if (settled) return;
            text += chunk;
            if (looksLikeUnsupportedModelFormat(text)) return finish("unsupported");
            if (MODEL_LOADED.test(text)) return finish("ok");
            if (LOAD_FAILED.test(text)) return finish("other");
          },
          // The process could not be started, so nothing was learned about the
          // model -- "other", not "ok". Treating a failed launch as success is
          // how an unreadable model gets reported as loadable.
          onError: () => finish("other"),
        }
      );
    } catch (err) {
      return finish("other");
    }
    // A verdict that landed while the handle did not yet exist still has to kill.
    if (settled) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    timer = setTimeout(() => finish("inconclusive"), timeoutMs);
  });
}

/** The last few lines of a probe's output -- the diagnosis, when there is one. */
function tailOf(text: string, lines = 6): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
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
  /** Which repository to build. Defaults to stock llama.cpp.
   *
   *  Overridable because it is not always interchangeable: the ternary quants
   *  (PTQ1_0 / PQ2_0) that the Bonsai family ships in are a fork feature, and a
   *  stock build rejects them with "invalid ggml type 143". Compiling the default
   *  for such a model burns 10-40 minutes and produces a binary that cannot load
   *  it. Callers that know the model needs the fork pass its URL. */
  repo?: string;
  /** Where to keep the checkout. Separate per repo, so building the fork does not
   *  clobber a stock tree (or vice versa) and the two can coexist. */
  home?: string;
  /** Force a backend instead of choosing the best one the toolchain allows. The
   *  engine ladder uses this to retry as CPU when an accelerated build was unusable. */
  backend?: BuildBackend;
  /** Where build progress goes as a redrawn line. Absent: periodic `log` lines. */
  onProgress?: (p: TransferProgress) => void;
  /** Injected for tests. */
  statfs?: Statfs;
  /** Injected for tests; defaults to a TTY check. */
  interactive?: boolean;
}

/** Clones (or updates) and builds llama.cpp, returning the built binary path.
 *
 * What is built comes from `chooseBuildTarget`, which only returns a backend whose
 * toolchain was measured present — a machine can have a GPU with no `nvcc`, and
 * asking cmake for `-DGGML_CUDA=ON` in that state is a configure error rather than a
 * CPU fallback. Build tools are installed by `planBuildEnv` (only what is missing,
 * for the package manager that is there), and the job count is capped by free RAM as
 * well as cores.
 */
export async function buildLlamaCpp(opts: BuildOptions): Promise<string> {
  const { hw, run, log = () => {} } = opts;
  const repo = opts.repo ?? LLAMA_CPP_REPO;
  // One checkout per repository. A fork and stock share nothing, and overwriting
  // one with the other would make `findLlamaServer` return whichever sorted first
  // for a model only one of them can read.
  const dir = opts.home ?? (repo === LLAMA_CPP_REPO ? LLAMA_CPP_HOME : join(LLAMA_CPP_HOME + "-fork"));

  const cudaArch = hw.canBuildCuda ? await detectCudaArch(run as never) : null;
  const hip = hw.canBuildRocm && opts.backend !== "cpu" ? await detectHipInfo(run as never) : undefined;
  const target: BuildTarget = chooseBuildTarget(hw, cudaArch, opts.backend, hip);

  // ── Preflight: refuse early, with the reason, instead of failing at minute 30 ──
  const need = buildDiskBytes(target.backend);
  const disk = await diskInfoFor(dir, opts.statfs);
  if (disk.freeBytes < need) {
    throw new Error(
      `빌드에 약 ${(need / 1024 ** 3).toFixed(0)} GiB 의 디스크가 필요하지만 ${dir} 이 있는 파일시스템의 여유는 ` +
        `${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB 입니다.`
    );
  }

  let cmake = "cmake";
  if (opts.installDeps !== false) {
    const plan = planBuildEnv(hw, { needs: { vulkan: target.backend === "vulkan" } });
    if (plan.cmakeBin) cmake = plan.cmakeBin;
    log(plan.summary);
    if (plan.commands.length > 0) {
      const res = await applyBuildEnv(plan, {
        run: run as never,
        log,
        interactive: opts.interactive ?? Boolean(process.stdin.isTTY),
      });
      if (!res.ok) {
        // Not fatal on its own: the tools may be usable anyway (a fresh shell is
        // sometimes all that is missing), and the configure step will say precisely
        // what is absent if they are not.
        log(`빌드 도구 설치가 확인되지 않았지만 계속합니다: ${res.output.split("\n").filter(Boolean).slice(-1)[0] ?? ""}`);
      }
    } else if (plan.manual) {
      throw new Error(plan.manual);
    }
  }

  if (!(await dirExists(join(dir, ".git")))) {
    // Reachability first, with git itself: it is the tool that will do the clone, so it
    // honours proxies and credentials exactly as the clone will, and a dead network
    // is reported now instead of as a clone error after the build tools were installed.
    await run("git", ["ls-remote", "--exit-code", repo, "HEAD"], { timeout: 30_000 }).catch((err) => {
      throw new Error(
        `${repo} 에 연결할 수 없어 소스를 받을 수 없습니다 (네트워크/프록시를 확인하세요): ` +
          `${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`
      );
    });
    log(`llama.cpp 소스를 받습니다 → ${dir}`);
    await run("git", ["clone", "--depth", "1", repo, dir], { timeout: 20 * 60_000 });
  } else {
    // An existing checkout is only usable if it is the repository asked for. A
    // stock tree left over from an earlier run would silently be rebuilt here and
    // then handed a model it cannot read, so the mismatch is stated instead.
    const origin = await run("git", ["config", "--get", "remote.origin.url"], { cwd: dir, timeout: 10_000 })
      .then((s) => s.trim())
      .catch(() => "");
    const sameRepo = origin.replace(/\.git$/, "") === repo.replace(/\.git$/, "");
    if (!sameRepo) {
      throw new Error(
        `${dir} 에는 다른 저장소(${origin || "알 수 없음"})가 있습니다. ` +
          `${repo} 빌드에는 다른 위치가 필요합니다.`
      );
    }
  }

  const buildDir = target.dir;
  const cmakeFlags = [
    "-B", buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLLAMA_CURL=OFF",
    // GGML_NATIVE lets the build target this exact CPU, which on a modern
    // desktop CPU is a large prefill/decode win over a generic build.
    "-DGGML_NATIVE=ON",
    ...target.flags,
  ];
  log(`cmake 설정 중… (${target.label})`);
  await run(cmake, cmakeFlags, { cwd: dir, timeout: 20 * 60_000 });

  const progress = makeBuildProgress(log, target.label, Date.now, 60_000, opts.onProgress);
  const buildCmd = (jobs: number) =>
    run(cmake, ["--build", buildDir, "--config", "Release", "-j", String(jobs)], {
      cwd: dir,
      onLine: progress,
      // A CUDA build of llama.cpp is genuinely long; the generic 20 min default
      // is not enough on a slow CPU and would abort a build that was working.
      timeout: 120 * 60_000,
    });
  const jobs = buildJobs(hw, target.backend);
  log(`빌드 중… (-j${jobs}${jobs < Math.min(hw.cpuCount, 16) ? ", 여유 메모리에 맞춰 코어 수보다 줄임" : ""})`);
  try {
    await buildCmd(jobs);
  } catch (err) {
    if (jobs === 1) throw err;
    // The usual cause of a mid-build failure on a small box is the kernel killing a
    // compiler for memory. One serial retry costs time and removes that cause.
    log("빌드가 실패해 -j1 로 한 번 더 시도합니다 (메모리 부족일 수 있습니다).");
    await buildCmd(1);
  }

  const bin = (await firstExecutable(candidatePaths(dir, [buildDir])));
  if (!bin) {
    throw new Error(`빌드가 끝났지만 ${dir}/${buildDir} 아래에서 ${binNameFor()} 를 찾을 수 없습니다.`);
  }
  return bin;
}

/** `[ 42%] Building CXX object …` → 42. Makefile and Ninja generators both print it
 *  (Ninja as `[12/340]`, which carries no percentage and is converted). */
export function parseBuildPercent(line: string): number | null {
  const pct = /^\s*\[\s*(\d{1,3})%\]/.exec(line);
  if (pct) return Math.min(100, Number(pct[1]));
  const frac = /^\s*\[(\d+)\/(\d+)\]/.exec(line);
  if (frac && Number(frac[2]) > 0) return Math.min(100, Math.floor((Number(frac[1]) / Number(frac[2])) * 100));
  return null;
}

/**
 * Turns a build's output into a few progress lines: one per ten percent, plus a
 * heartbeat when a long step (a single CUDA translation unit can take minutes) prints
 * nothing, so the user sees elapsed time instead of a frozen screen. Goes through
 * `log` — the TUI's own sink — rather than writing to stdout, which would corrupt an
 * Ink-rendered screen.
 */
export function makeBuildProgress(
  log: (line: string) => void,
  label: string,
  now: () => number = Date.now,
  heartbeatMs = 60_000,
  /** When given, progress goes here (the TUI's one-line redraw) instead of `log`. */
  report?: (p: TransferProgress) => void
): (line: string) => void {
  const t0 = now();
  let lastDecile = -1;
  let lastEmit = t0;
  let lastPct: number | null = null;
  const mins = () => Math.max(0, Math.floor((now() - t0) / 60_000));
  const emit = (percent: number, text: string) => {
    if (!report) return log(text);
    report({
      label, receivedBytes: 0, totalBytes: -1, bytesPerSecond: 0, etaSeconds: -1,
      percent, phase: "build", elapsedSeconds: Math.floor((now() - t0) / 1000),
    });
  };
  return (line) => {
    const pct = parseBuildPercent(line);
    if (pct !== null) lastPct = pct;
    const t = now();
    if (pct !== null && Math.floor(pct / 10) > lastDecile) {
      lastDecile = Math.floor(pct / 10);
      lastEmit = t;
      emit(pct, `${label} 빌드 ${pct}% (${mins()}분 경과)`);
    } else if (t - lastEmit >= heartbeatMs) {
      lastEmit = t;
      emit(lastPct ?? -1, `${label} 빌드 중… ${lastPct !== null ? `${lastPct}%, ` : ""}${mins()}분 경과`);
    }
  };
}

async function firstExecutable(paths: string[]): Promise<string | null> {
  for (const p of paths) if (await isExecutable(p)) return p;
  return null;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
