/**
 * What does THIS machine need installed before llama.cpp can be compiled — and
 * how can that be installed without a human?
 *
 * ── Why this replaced the apt line ──────────────────────────────────────────
 * `installBuildPackages` ran `sudo apt-get install build-essential cmake git curl
 * libcurl4-openssl-dev pkg-config` unconditionally. That was wrong four ways:
 *
 *  - it assumed Debian: Fedora, Arch, Alpine, SUSE, macOS and Windows have no apt;
 *  - it reinstalled (and asked for sudo for) tools the machine already had, though
 *    `detectHardware` had just measured exactly which were missing;
 *  - it added `cuda-toolkit-12-4`, a package that does not exist until NVIDIA's apt
 *    repository is registered, and that is unrelated to the driver's CUDA version;
 *  - its interactive-sudo fallback waits for a password on a machine with no
 *    terminal, which looks exactly like a hang.
 *
 * ── What it does now ────────────────────────────────────────────────────────
 * `planBuildEnv` is PURE: facts in (the measured `Hardware`), a plan out. The plan
 * is shown before anything runs, and a plan with nothing missing runs nothing and
 * asks for no privilege. `applyBuildEnv` executes it and then RUNS each tool, because
 * "the package manager exited 0" has twice turned out not to mean "cmake works".
 *
 * A package manager this module does not know produces a plan with the missing tool
 * list and a manual instruction — never a guessed install command.
 *
 * The CUDA toolkit is deliberately NOT installed here. It is the largest and most
 * fragile step (repository registration, multi-GB download, driver coupling), and the
 * engine ladder reaches a working CUDA binary through a prebuilt that needs no
 * toolkit at all. A source build only targets CUDA when `nvcc` is already present.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Hardware, Run } from "./hardware.js";

export type PackageManager = "apt" | "dnf" | "pacman" | "apk" | "zypper" | "brew" | "winget";

/** What a source build needs, in terms independent of any package manager. */
export type BuildTool = "git" | "cmake" | "compiler" | "make" | "vulkan-sdk";

export interface BuildEnvNeeds {
  /** Build with Vulkan: needs headers and a shader compiler. */
  vulkan?: boolean;
}

export interface BuildEnvPlan {
  manager: PackageManager | null;
  /** Logical tools the build needs and the machine lacks. Empty = nothing to do. */
  missing: BuildTool[];
  /** Concrete package names for `missing` under `manager`. */
  packages: string[];
  /** The command(s) that would run, as argv — so the plan can be shown first. */
  commands: { file: string; args: string[]; privileged: boolean }[];
  /** True when running the plan needs root/sudo. */
  needsPrivilege: boolean;
  /** Set when the plan cannot be carried out automatically, with what to tell the user. */
  manual?: string;
  /** Absolute path of a cmake installed into the user's own directory (no root), for
   *  callers to invoke by path: a fresh `pip --user` install is not on this process's PATH. */
  cmakeBin?: string;
  /** Human-readable, for the log. */
  summary: string;
}

export interface PlanOptions {
  needs?: BuildEnvNeeds;
  /** Running as root (no sudo needed). Injected; defaults to the real uid. */
  isRoot?: boolean;
}

/** Package names per manager. Names are the distributions' own and were NOT run
 *  against each distribution's index from here — a wrong name fails the install,
 *  is reported, and the engine ladder has already offered a prebuilt, so the cost
 *  of an error is a clear message, not a broken machine. */
const PACKAGES: Record<PackageManager, Partial<Record<BuildTool, string[]>>> = {
  apt: { git: ["git"], cmake: ["cmake"], compiler: ["build-essential"], make: ["build-essential"], "vulkan-sdk": ["libvulkan-dev", "glslc"] },
  dnf: { git: ["git"], cmake: ["cmake"], compiler: ["gcc-c++"], make: ["make"], "vulkan-sdk": ["vulkan-headers", "vulkan-loader-devel", "glslc"] },
  pacman: { git: ["git"], cmake: ["cmake"], compiler: ["gcc"], make: ["make"], "vulkan-sdk": ["vulkan-headers", "shaderc"] },
  apk: { git: ["git"], cmake: ["cmake"], compiler: ["build-base"], make: ["build-base"], "vulkan-sdk": ["vulkan-headers", "shaderc"] },
  zypper: { git: ["git"], cmake: ["cmake"], compiler: ["gcc-c++"], make: ["make"], "vulkan-sdk": ["vulkan-devel", "shaderc"] },
  // macOS: the compiler comes from the Xcode Command Line Tools, which brew cannot
  // install; see the `manual` branch below.
  brew: { git: ["git"], cmake: ["cmake"] },
  // winget IDs are package IDs, not names. The Build Tools need the C++ workload
  // passed through --override or the install succeeds and contains no compiler.
  winget: { git: ["Git.Git"], cmake: ["Kitware.CMake"], compiler: ["Microsoft.VisualStudio.2022.BuildTools"] },
};

const INSTALL_ARGS: Record<PackageManager, (pkgs: string[]) => { file: string; args: string[] }> = {
  apt: (p) => ({ file: "apt-get", args: ["install", "-y", ...p] }),
  dnf: (p) => ({ file: "dnf", args: ["install", "-y", ...p] }),
  pacman: (p) => ({ file: "pacman", args: ["-S", "--noconfirm", "--needed", ...p] }),
  apk: (p) => ({ file: "apk", args: ["add", ...p] }),
  zypper: (p) => ({ file: "zypper", args: ["--non-interactive", "install", ...p] }),
  brew: (p) => ({ file: "brew", args: ["install", ...p] }),
  winget: (p) => ({ file: "winget", args: [] /* one command per package, see below */ }),
};

/** Which package manager this machine has, from what was measured. Order is by
 *  specificity: a Debian box with `brew` installed still wants apt for system packages. */
export function detectPackageManager(hw: Pick<Hardware, "tools" | "platform">): PackageManager | null {
  const t = hw.tools;
  if (hw.platform === "win32") return t.winget ? "winget" : null;
  if (hw.platform === "darwin") return t.brew ? "brew" : null;
  for (const [tool, pm] of [
    ["apt-get", "apt"], ["dnf", "dnf"], ["pacman", "pacman"], ["apk", "apk"], ["zypper", "zypper"],
  ] as const) {
    if (t[tool]) return pm;
  }
  return t.brew ? "brew" : null; // Linuxbrew as a last resort
}

/** The build tools this machine lacks, from the probe — nothing is assumed missing
 *  that was not measured missing. */
export function missingBuildTools(hw: Pick<Hardware, "tools" | "platform">, needs: BuildEnvNeeds = {}): BuildTool[] {
  const t = hw.tools;
  const out: BuildTool[] = [];
  if (!t.git) out.push("git");
  if (!t.cmake) out.push("cmake");
  // `cc` alone is a C compiler; llama.cpp is C++. On Windows `cl` only exists inside a
  // Developer prompt even when Visual Studio is installed, so it is not required to be
  // on PATH — cmake locates VS itself — and the planner leaves Windows compilers to
  // the post-install configure to confirm.
  const hasCxx = t["g++"] || t["c++"] || t["clang++"] || (hw.platform === "win32" && t.cl);
  if (!hasCxx) out.push("compiler");
  if (!t.make && !t.ninja && hw.platform !== "win32") out.push("make");
  if (needs.vulkan && !t.glslc) out.push("vulkan-sdk");
  return out;
}

export function planBuildEnv(
  hw: Pick<Hardware, "tools" | "platform">,
  opts: PlanOptions = {}
): BuildEnvPlan {
  const missing = missingBuildTools(hw, opts.needs);
  const manager = detectPackageManager(hw);

  if (missing.length === 0) {
    return {
      manager, missing, packages: [], commands: [], needsPrivilege: false,
      summary: "빌드 도구가 이미 모두 있습니다 — 설치할 것이 없습니다.",
    };
  }

  const manual = (why: string): BuildEnvPlan => ({
    manager, missing, packages: [], commands: [], needsPrivilege: false,
    manual: why,
    summary: `빌드에 필요한 도구가 없습니다: ${missing.join(", ")}. ${why}`,
  });

  if (!manager) {
    return manual("이 시스템의 패키지 관리자를 알 수 없어 자동 설치하지 않습니다. 위 도구를 직접 설치하세요.");
  }
  if (hw.platform === "darwin" && missing.includes("compiler")) {
    // `xcode-select --install` opens a GUI dialog and returns immediately; running it
    // headless "succeeds" and installs nothing.
    return manual("Xcode Command Line Tools 가 필요합니다: 터미널에서 `xcode-select --install` 을 실행하세요.");
  }

  const table = PACKAGES[manager];
  const unknown = missing.filter((m) => !table[m]);
  if (unknown.length > 0) {
    return manual(`${manager} 로는 ${unknown.join(", ")} 를 자동 설치할 수 없습니다. 직접 설치하세요.`);
  }
  const packages = [...new Set(missing.flatMap((m) => table[m]!))];

  const isRoot = opts.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  // brew refuses to run as root; winget elevates itself; the rest need root.
  const needsPrivilege = !isRoot && manager !== "brew" && manager !== "winget";
  const commands: BuildEnvPlan["commands"] = [];
  if (manager === "winget") {
    for (const id of packages) {
      const args = ["install", "--id", id, "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"];
      if (id === "Microsoft.VisualStudio.2022.BuildTools") {
        args.push("--override", "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended");
      }
      commands.push({ file: "winget", args, privileged: false });
    }
  } else {
    const c = INSTALL_ARGS[manager](packages);
    commands.push({ ...c, privileged: needsPrivilege });
  }

  if (needsPrivilege && !hw.tools.sudo) {
    // No root, but cmake alone is installable without it: PyPI ships a complete cmake.
    // Git and a compiler are not, so this only applies when cmake is all that is missing.
    if (missing.length === 1 && missing[0] === "cmake" && hw.tools.pip3) {
      return {
        manager, missing, packages: ["cmake"], needsPrivilege: false,
        commands: [{ file: "pip3", args: ["install", "--user", "cmake"], privileged: false }],
        cmakeBin: join(homedir(), ".local", "bin", "cmake"),
        summary: "root 권한이 없어 cmake 를 사용자 영역에 설치합니다 (pip3 install --user cmake).",
      };
    }
    return {
      manager, missing, packages, commands: [], needsPrivilege,
      manual: `root 권한이 필요한데 sudo 가 없습니다. 루트로 다음을 실행하세요: ${INSTALL_ARGS[manager](packages).file} ${INSTALL_ARGS[manager](packages).args.join(" ")}`,
      summary: `빌드 도구(${missing.join(", ")})를 설치하려면 root 권한이 필요합니다.`,
    };
  }

  return {
    manager, missing, packages, commands, needsPrivilege,
    summary:
      `빌드 도구 ${missing.join(", ")} 를 ${manager} 로 설치합니다: ${packages.join(" ")}` +
      (needsPrivilege ? " (sudo 필요)" : ""),
  };
}

export interface ApplyResult {
  ok: boolean;
  /** Each tool that was RUN after the install, and whether it answered. */
  verified: Record<string, boolean>;
  output: string;
}

export interface ApplyOptions {
  run: Run;
  log?: (line: string) => void;
  /** May sudo prompt for a password? Only true when a person is at a terminal. */
  interactive?: boolean;
}

/** Tools whose `--version` proves the install actually worked. The compiler is the
 *  first of these that answers: a box needs one C++ compiler, not all three. */
const VERIFY: { tool: string; candidates: string[]; args: string[] }[] = [
  { tool: "git", candidates: ["git"], args: ["--version"] },
  { tool: "cmake", candidates: ["cmake"], args: ["--version"] },
  { tool: "compiler", candidates: ["g++", "c++", "clang++"], args: ["--version"] },
];

export async function applyBuildEnv(plan: BuildEnvPlan, opts: ApplyOptions): Promise<ApplyResult> {
  const log = opts.log ?? (() => {});
  if (plan.commands.length === 0) {
    return { ok: plan.missing.length === 0, verified: {}, output: plan.manual ?? "" };
  }
  log(plan.summary);

  let output = "";
  let installed = true;
  for (const cmd of plan.commands) {
    // Non-interactive sudo first so a machine with passwordless sudo never prompts;
    // the prompting form is tried only when someone can see and answer it.
    const attempts: [string, string[]][] = cmd.privileged
      ? [["sudo", ["-n", cmd.file, ...cmd.args]], ...(opts.interactive ? [["sudo", [cmd.file, ...cmd.args]] as [string, string[]]] : [])]
      : [[cmd.file, cmd.args]];
    let ok = false;
    for (const [file, args] of attempts) {
      try {
        output += await opts.run(file, args, { timeout: 30 * 60_000 });
        ok = true;
        break;
      } catch (err) {
        output = err instanceof Error ? err.message : String(err);
      }
    }
    if (!ok) installed = false;
  }

  // Trust nothing the installer said: run the tools.
  const verified: Record<string, boolean> = {};
  const needsVerify = new Set<string>(plan.missing.filter((m) => m !== "make" && m !== "vulkan-sdk"));
  for (const v of VERIFY) {
    if (!needsVerify.has(v.tool)) continue;
    let ok = false;
    const candidates = v.tool === "cmake" && plan.cmakeBin ? [plan.cmakeBin, ...v.candidates] : v.candidates;
    for (const c of candidates) {
      try { await opts.run(c, v.args, { timeout: 10_000 }); ok = true; break; } catch { /* next */ }
    }
    verified[v.tool] = ok;
  }
  const allVerified = Object.values(verified).every(Boolean);
  if (installed && !allVerified) {
    log(`설치 명령은 끝났지만 실행되지 않는 도구가 있습니다: ${Object.entries(verified).filter(([, v]) => !v).map(([k]) => k).join(", ")} (새 셸이 필요할 수 있습니다).`);
  }
  return { ok: installed && allVerified, verified, output };
}
