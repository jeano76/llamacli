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
import { join } from "node:path";
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

export interface LlamaLocation {
  binPath: string;
  /** Where it was found, for an honest status line ("PATH", "기존 빌드", …). */
  source: "env" | "path" | "existing-build" | "llamacli-build" | "built";
  /** Best guess at the accelerator it was compiled for, from the directory
   *  name / build flags. Verified separately by probeLlamaServer. */
  backend: "cuda" | "vulkan" | "cpu" | "unknown";
}

/** Build-directory names llama.cpp users actually end up with, in the order we
 *  prefer them. `build-opt` is the naming convention in wide use for an
 *  optimised CUDA build; a plain `build` is the cmake default and is whatever
 *  the last person configured. */
const BUILD_DIR_PREFERENCE = ["build-opt", "build-cuda", "build", "build-release", "bin", "Release"];

function backendFromPath(p: string): LlamaLocation["backend"] {
  const s = p.toLowerCase();
  if (s.includes("cuda") || s.includes("opt") || s.includes("gpu")) return "cuda";
  if (s.includes("vulkan")) return "vulkan";
  if (s.includes("release") || s.includes("cpu")) return "cpu";
  return "unknown";
}

/**
 * Locates a usable `llama-server` without building anything.
 *
 * Returns null when nothing usable is found, which is the caller's signal to
 * build. Exported with injectable `probe`/`env` so the search order itself is
 * testable — the order is the entire point of this function, and it is exactly
 * the kind of thing that silently rots when it can only be exercised by having
 * a real build on the machine.
 */
export async function findLlamaServer(opts: {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
  home?: string;
} = {}): Promise<LlamaLocation | null> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isExecutable;
  const home = opts.home ?? homedir();

  // 1. Explicit override. Cheapest and unambiguous, so it wins outright.
  if (env.LLAMACLI_LLAMA_SERVER && (await exists(env.LLAMACLI_LLAMA_SERVER))) {
    return { binPath: env.LLAMACLI_LLAMA_SERVER, source: "env", backend: "unknown" };
  }

  // 2. PATH. Note we check the name directly rather than running `command -v`,
  //    so the same injectable `exists` seam covers every candidate below and
  //    the whole search is testable.
  const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, "llama-server");
    if (await exists(candidate)) {
      return { binPath: candidate, source: "path", backend: "unknown" };
    }
  }

  // 3./4. Conventional build trees. Order within each tree is the preference
  //      list, and CUDA-ish names win over `build` because a CPU-only build
  //      found first would be silently preferred over a GPU one beside it.
  const roots = [join(home, "llama.cpp"), LLAMA_CPP_HOME];
  for (const root of roots) {
    for (const dir of BUILD_DIR_PREFERENCE) {
      const candidate = join(root, dir, "bin", "llama-server");
      if (await exists(candidate)) {
        return {
          binPath: candidate,
          source: root === LLAMA_CPP_HOME ? "llamacli-build" : "existing-build",
          backend: backendFromPath(candidate),
        };
      }
    }
  }
  return null;
}

/** Asks a candidate binary what it actually is. Used to confirm the "cuda"
 *  guess from a directory name, which is only a guess. */
export async function probeLlamaServer(binPath: string, run: Run = defaultRun): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const out = await run(binPath, ["--version"], { timeout: 20_000 });
    const m = /version:\s*(\S+)/i.exec(out) ?? /(\d{3,4})/.exec(out);
    return { ok: true, version: m?.[1] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
