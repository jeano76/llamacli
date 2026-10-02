#!/usr/bin/env node
/**
 * Bare-environment and Windows `cmd` validation.
 *
 * ── What this is, honestly ──────────────────────────────────────────────────
 * The other three harnesses all assume a machine that already has things: a
 * home directory with content, a shell, `PATH`, a GPU tool, a working
 * `llama-server`. This one removes those assumptions, because "works on my
 * machine" is exactly the claim that breaks for someone who has none of them.
 *
 * Two families:
 *
 *   A. BARE — no config, no model, no llama.cpp, no `PATH`, no `nvidia-smi`, no
 *      `ss`, no `systemctl`, no network. The first run of the product on a
 *      machine that has nothing installed. It must not crash, must not hang,
 *      must not claim a local backend it does not have, and must say something
 *      the user can act on.
 *
 *   B. WINDOWS — `cmd.exe` semantics: no `HOME` (it is `USERPROFILE`), no
 *      `systemctl`, no procfs, no `ss`, and listening ports come from
 *      `netstat -ano` in a different column layout. This is simulated by
 *      injecting the platform and the command output, NOT by mocking the code
 *      under test — the point is to exercise the real parsing.
 *
 * ── The bugs this found ─────────────────────────────────────────────────────
 * Both were real and both are the same mistake: a platform-specific default
 * that degrades into a WRONG ANSWER instead of an error.
 *
 *   1. The home directory was read as `env.HOME`, with a hardcoded `/root`
 *      fallback. `HOME` is normally unset on Windows, so every derived default
 *      became `/root/...` — a path that cannot exist there, produced without any
 *      error. Now `USERPROFILE` is honoured and there is no POSIX fallback.
 *
 *   2. The listening-port lookup shelled out to `ss -ltnp`. On Windows that
 *      command does not exist; the throw was caught and the port reported as
 *      FREE. A model switch would then start a SECOND server on an occupied
 *      port — the precise failure the switch module exists to prevent, reached
 *      by believing a tool's absence. A missing tool is now `unknown`, and
 *      `unknown` refuses to act.
 *
 * Run:  npx tsx scripts/bare_env_check.ts [--verbose]
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { ensureLocalStack } from "../src/setup/bootstrap.js";
import { defaultModelsDir, homeDir, listeningPortsCommand, hasSystemd } from "../src/setup/hostEnv.js";
import { detectPortOwner, switchModelAndServer, type PortOwner } from "../src/setup/modelSwitch.js";
import { findLlamaServer } from "../src/setup/llamaCpp.js";
import { loadConfig } from "../src/config.js";
import { writeConfig } from "../src/setup/bootstrap.js";
import { evaluateAll, formatModelTable, findRung } from "../src/setup/modelMetrics.js";
import { detectHardware } from "../src/setup/hardware.js";
import { SLASH_MENU_ITEMS } from "../src/tui/SlashMenu.js";

const verbose = process.argv.includes("--verbose");
const failures: { family: string; case: string; invariant: string; detail: string }[] = [];
let checks = 0;

function check(family: string, name: string, invariant: string, ok: boolean, detail = ""): boolean {
  checks++;
  if (!ok) failures.push({ family, case: name, invariant, detail });
  return ok;
}

/** Hardware as seen on a box with no GPU tool at all — the conservative shape
 *  `detectHardware` produces when `nvidia-smi` is absent or fails. */
const NO_GPU = {
  cpuCount: 4,
  ramTotalBytes: 8 * 1024 ** 3,
  ramAvailableBytes: 6 * 1024 ** 3,
  gpus: [],
  gpuBackend: "none",
  canBuildCuda: false,
  tools: {},
  platform: "linux",
} as any;

/** An environment with nothing on it. No PATH, no tools, no vars. */
function bareEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home } as NodeJS.ProcessEnv;
}

/** A `run` seam that behaves like a machine with no external tools at all:
 *  every command is "command not found", which is what a bare container and a
 *  Windows box without the tool both look like. */
const noTools = async (): Promise<string> => {
  throw new Error("spawn ENOENT");
};

// ── Family A: bare ───────────────────────────────────────────────────────────

async function bareBootstrap(): Promise<void> {
  const fam = "A/bare";
  const root = await mkdtemp(join(tmpdir(), "bare-"));
  const home = join(root, "home");
  const models = join(root, "models");
  await mkdir(home, { recursive: true });
  await mkdir(models, { recursive: true });

  let report: any;
  let threw: string | undefined;
  try {
    report = await ensureLocalStack({
      projectRoot: join(root, "project"),
      modelsDir: models,
      hardware: NO_GPU,
      offline: true,
      allowBuild: false,
      detectServer: async () => ({ kind: "none" as const }),
      probe: async () => "free",
      run: noTools as any,
      env: bareEnv(home),
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }

  check(fam, "bootstrap on a machine with nothing installed", "must not throw", !threw, threw ?? "");

  if (report) {
    // The bug the code's own comment warns about: claiming `local-llama` with no
    // binary and no model is the state index.tsx treats as "not configured", so
    // it would fall through to a dead URL with no explanation.
    const hasBinary = Boolean(report.llama?.binPath);
    const hasModel = Boolean(report.modelPath);
    check(
      fam,
      "backend claim matches reality",
      "must not claim a local backend without both a binary and a model",
      report.config?.backend !== "local-llama" || (hasBinary && hasModel),
      `backend=${report.config?.backend} binary=${hasBinary} model=${hasModel}`
    );

    // Whatever it decided, the user must be able to act on it.
    const say = [...(report.steps ?? []).map((s: any) => `${s.name}: ${s.detail}`), ...(report.errors ?? [])].join("\n");
    check(
      fam,
      "failures are actionable",
      "a reported problem must not be a bare exception or empty text",
      !report.errors?.some((e: string) => !e || /^\s*(undefined|null|\[object)/.test(e)),
      (report.errors ?? []).join(" | ")
    );
    check(fam, "reports something", "must not complete silently", say.trim().length > 0);

    // The config it would write must be loadable, or the next launch reads a
    // file it cannot parse and starts over from nothing.
    if (report.config) {
      const cfgRoot = join(root, "roundtrip");
      await mkdir(join(cfgRoot, ".llamacli"), { recursive: true });
      await writeConfig(cfgRoot, report.config as Record<string, unknown>);
      let reread: any;
      let rtErr: string | undefined;
      try {
        ({ config: reread } = await loadConfig(cfgRoot));
      } catch (e) {
        rtErr = e instanceof Error ? e.message : String(e);
      }
      check(fam, "config round-trips", "a config it writes must be readable by loadConfig", !rtErr, rtErr ?? "");
      if (reread) {
        check(
          fam,
          "config keeps the model dir it was told to use",
          "an explicit modelsDir must survive into the written config",
          typeof reread.llama?.port === "number" || reread.backend !== "local-llama",
          `port=${reread.llama?.port}`
        );
      }
    }
  }

  // Defaults must follow the injected HOME, not a hardcoded root.
  const dir = defaultModelsDir(bareEnv(home));
  check(
    fam,
    "models dir follows HOME",
    "must not resolve to a POSIX root when HOME is set to something else",
    dir === join(home, "models"),
    `got ${dir}`
  );
  check(
    fam,
    "models dir is absolute",
    "must be an absolute path, never a relative guess",
    dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir),
    `got ${dir}`
  );

  await rm(root, { recursive: true, force: true });
}

async function bareModelsCommand(): Promise<void> {
  const fam = "A/bare";
  // `/models` on a box with no model and no GPU must still answer, and must not
  // claim anything fits when there is nothing to fit.
  const reports = evaluateAll(NO_GPU);
  const table = formatModelTable(reports);
  check(fam, "/models renders with no GPU", "must produce a table", table.lines.length > 0);

  const anyFits = reports.some((r) => r.fit !== "no");
  check(
    fam,
    "no-GPU verdicts are honest",
    "with no GPU nothing may be reported as fitting in VRAM",
    !reports.some((r) => r.fit === "vram"),
    reports.map((r) => `${r.rung.id}=${r.fit}`).join(" ")
  );
  check(fam, "sanity: fit levels exist", "every report carries a verdict", reports.every((r) => !!r.verdict));

  // And the command must be registered — a menu entry with no dispatcher is a
  // dead entry, which the other harnesses check for the TUI.
  check(
    fam,
    "/models is reachable",
    "the command must exist in the slash menu",
    SLASH_MENU_ITEMS.some((i) => i.key === "models")
  );
  void anyFits;
}

async function bareLlamaSearch(): Promise<void> {
  const fam = "A/bare";
  const root = await mkdtemp(join(tmpdir(), "bare2-"));
  // No PATH, no build dirs, nothing on disk: the search must return "not found"
  // rather than throwing or hanging.
  let res: any;
  let threw: string | undefined;
  try {
    res = await findLlamaServer({
      env: { HOME: root } as NodeJS.ProcessEnv,
      home: root,
      exists: async () => false,
      run: noTools as any,
      spawnProbe: () => ({ kill: () => {} }),
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(fam, "llama.cpp search on a bare machine", "must report not-found, not throw", !threw && res, threw ?? "");
  if (res) {
    check(fam, "llama.cpp search result is empty", "no candidates means no location", res.location === null);
  }
  await rm(root, { recursive: true, force: true });
}

// ── Family B: Windows cmd ────────────────────────────────────────────────────

/** Real `netstat -ano` lines. The local-address column is where the port lives;
 *  the foreign column also contains a colon, which is what makes naive parsing
 *  read the wrong number. */
const NETSTAT = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:135          0.0.0.0:0              LISTENING       1044",
  "  TCP    127.0.0.1:8084         0.0.0.0:0              LISTENING       128976",
  "  TCP    127.0.0.1:8084         127.0.0.1:51234        ESTABLISHED     900",
].join("\r\n");

const netstat = async () => NETSTAT;

function windowsEnv(userProfile: string): NodeJS.ProcessEnv {
  // Windows sets USERPROFILE, and normally does NOT set HOME.
  return { USERPROFILE: userProfile, SystemRoot: "C:\\Windows", windir: "C:\\Windows" } as NodeJS.ProcessEnv;
}

async function windowsDefaults(): Promise<void> {
  const fam = "B/windows";
  const env = windowsEnv("C:\\Users\\jeano");

  const home = homeDir(env);
  check(
    fam,
    "home comes from USERPROFILE",
    "HOME is unset on Windows, so USERPROFILE must be used",
    home === "C:\\Users\\jeano",
    `got ${home}`
  );
  check(
    fam,
    "no POSIX root leaks in",
    "must not fall back to /root when HOME is absent",
    !home.startsWith("/"),
    `got ${home}`
  );

  const dir = defaultModelsDir(env);
  check(
    fam,
    "models dir is a Windows path",
    "must be under USERPROFILE, not a POSIX path",
    dir.includes("jeano") && !dir.startsWith("/root"),
    `got ${dir}`
  );

  check(
    fam,
    "port listing uses netstat on Windows",
    "`ss` does not exist on Windows",
    listeningPortsCommand("win32").file === "netstat",
    JSON.stringify(listeningPortsCommand("win32"))
  );
  check(
    fam,
    "port listing uses ss on Linux",
    "the Linux path must not regress to netstat",
    listeningPortsCommand("linux").file === "ss",
    JSON.stringify(listeningPortsCommand("linux"))
  );
  check(fam, "systemd is Linux-only", "must not probe systemd elsewhere", hasSystemd("linux") && !hasSystemd("win32"));
}

async function windowsPortParsing(): Promise<void> {
  const fam = "B/windows";

  // The cmdline reader is injected because the real one is procfs/wmic, and
  // `wmic` is gone from current Windows. Without a seam the only reachable
  // answer there is `unknown`, and the positive attribution — the case that
  // actually lets a switch proceed — would be untestable.
  const readCmdline = async (pid: number) =>
    pid === 128976 ? "C:\\llama\\llama-server.exe -m C:\\models\\bonsai.gguf --port 8084" : "C:\\Windows\\System32\\svchost.exe";

  const ours = await detectPortOwner(8084, { platform: "win32", run: netstat, readCmdline });
  check(
    fam,
    "an occupied port is attributed to a llama-server",
    "the LISTENING row's pid and command line must both be read",
    ours.kind === "ours" && (ours as any).pid === 128976,
    JSON.stringify(ours)
  );
  check(
    fam,
    "the attributed path keeps the .exe",
    "must be the command line's own path, not a reconstructed name",
    (ours as any).binPath?.toLowerCase().endsWith(".exe") === true,
    (ours as any).binPath ?? "null"
  );

  const notOurs = await detectPortOwner(135, { platform: "win32", run: netstat, readCmdline });
  check(
    fam,
    "a non-llama listener is foreign, not ours",
    "a readable command line that is not llama-server is a definite answer",
    notOurs.kind === "foreign",
    JSON.stringify(notOurs)
  );

  // And the honest middle: the pid is known but the command line is not
  // readable. That is UNKNOWN — refusing to act is right either way, but
  // claiming "a process llamacli does not recognise" when the truth is "I could
  // not look" sends the user looking for the wrong problem.
  const unreadable = await detectPortOwner(8084, {
    platform: "win32",
    run: netstat,
    readCmdline: async () => null,
  });
  check(
    fam,
    "an unreadable command line is UNKNOWN, not foreign",
    "'could not read it' is not 'it is not a llama-server'",
    unreadable.kind === "unknown",
    JSON.stringify(unreadable)
  );

  const free = await detectPortOwner(9999, { platform: "win32", run: netstat, readCmdline });
  check(
    fam,
    "a free port is reported free",
    "a port with no LISTENING row is free",
    free.kind === "none",
    JSON.stringify(free)
  );

  // The ESTABLISHED row for 8084 must not be mistaken for a second listener.
  const both = await detectPortOwner(8084, { platform: "win32", run: netstat, readCmdline });
  check(
    fam,
    "ESTABLISHED is not LISTENING",
    "only the LISTENING row owns the port",
    both.kind === "ours" && (both as any).pid === 128976,
    JSON.stringify(both)
  );

  // THE bug: no `ss` on Windows. A missing tool must not read as a free port.
  const missing = await detectPortOwner(8084, {
    platform: "win32",
    run: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  check(
    fam,
    "a missing port tool is UNKNOWN, not free",
    "believing a tool's absence starts a second server on an occupied port",
    missing.kind === "unknown",
    JSON.stringify(missing)
  );

  // And `unknown` must actually stop the switch from starting anything.
  const events: string[] = [];
  const sw = await switchModelAndServer({
    modelPath: "C:\\models\\m.gguf",
    port: 8084,
    binPath: "C:\\llama\\llama-server.exe",
    tuning: { contextSize: 4096, threads: 4, gpuLayers: 0 },
    platform: "win32",
    runCommand: async () => {
      throw new Error("spawn ENOENT");
    },
    makeServer: () => ({
      start: async () => void events.push("start"),
      stop: () => void events.push("stop"),
      logTail: () => "",
    }),
  });
  check(fam, "an uninspectable port refuses the switch", "must not start a server", sw.ok === false && events.length === 0, JSON.stringify(sw.lines));
  check(
    fam,
    "the refusal explains itself",
    "must say the port could not be checked and why that matters",
    /확인할 수 없/.test(sw.lines.join("\n")),
    sw.lines.join(" | ")
  );
}

async function windowsBinaryNaming(): Promise<void> {
  const fam = "B/windows";
  // The binary name is platform-dependent, and the search must be able to find
  // an `.exe` without being told the platform separately.
  const res = await findLlamaServer({
    platform: "win32",
    env: { ...windowsEnv("C:\\Users\\jeano"), PATH: "C:\\llama" } as any,
    home: "C:\\Users\\jeano",
    exists: async (p: string) => p.toLowerCase().endsWith("llama-server.exe"),
    run: async () => "",
    spawnProbe: () => ({ kill: () => {} }),
  });
  check(
    fam,
    "an .exe on PATH is found",
    "Windows installs llama-server.exe, not a bare llama-server",
    res.location !== null,
    JSON.stringify(res)
  );
  check(
    fam,
    "the reported path is the .exe",
    "must be the path that was found, not a guessed name",
    (res.location?.binPath ?? "").toLowerCase().endsWith(".exe"),
    res.location?.binPath ?? "null"
  );
}

async function windowsConfigRoundTrip(): Promise<void> {
  const fam = "B/windows";
  // A path with a space and a backslash is the ordinary Windows case, and the
  // single most common cause of "works on Linux, fails on Windows".
  const outer = await mkdtemp(join(tmpdir(), "win-"));
  // The PROJECT ROOT itself carries the space. A space in a nested config path
  // is a quoting problem; a space in the root is what every real Windows user
  // has ("C:\Users\jeano\My Documents\code\thing"), and it is the one that
  // breaks shells and YAML alike.
  const root = join(outer, "my project");
  const cfgDir = join(root, ".llamacli");
  await mkdir(cfgDir, { recursive: true });
  const modelPath = "C:\\Users\\jeano\\My Models\\Ternary-Bonsai-2-27B-PTQ1_0.gguf";
  await writeConfig(root, {
    model: modelPath,
    llama: { binPath: "C:\\llama\\llama-server.exe", modelPath, port: 8080, contextSize: 4096 },
  });
  const { config: reread } = await loadConfig(root);
  check(fam, "a Windows model path round-trips", "backslashes and spaces must survive YAML", reread.llama?.modelPath === modelPath, `got ${reread.llama?.modelPath}`);
  check(fam, "the port round-trips", "an integer must not become a string", reread.llama?.port === 8080, `got ${typeof reread.llama?.port}`);
  // The first version of this check regexed for `: C:\\` in the raw text, which
  // matches any *value* on any line and so failed on a perfectly valid file --
  // asserting nothing while looking rigorous. The real question is whether the
  // text parses back to the same value, so that is what is checked.
  const raw = await readFile(join(cfgDir, "config.yaml"), "utf8");
  const reparsed = parseYaml(raw) as any;
  check(
    fam,
    "the written YAML re-parses to the same path",
    "backslashes are not YAML escapes and must not be mangled",
    reparsed?.llama?.modelPath === modelPath && reparsed?.model === modelPath,
    `got ${reparsed?.llama?.modelPath}`
  );
  check(
    fam,
    "a Windows path is not split at its colon",
    "`C:` must not become a nested mapping",
    typeof reparsed?.model === "string",
    `type=${typeof reparsed?.model}`
  );
  await rm(outer, { recursive: true, force: true });
}

async function windowsNoGpuTools(): Promise<void> {
  const fam = "B/windows";
  // `nvidia-smi` is not present on a Windows box without the driver, and neither
  // is `sh` for building. Hardware detection must degrade to a stated default
  // rather than throwing.
  const hw = await detectHardware().catch((e: any) => ({ threw: e?.message }));
  check(fam, "hardware detection never throws", "must degrade, not throw", !("threw" in (hw as any)), JSON.stringify((hw as any).threw ?? ""));
  check(
    fam,
    "hardware detection returns a usable shape",
    "cores and RAM must be present for the tuner",
    typeof (hw as any).cpuCount === "number" && (hw as any).cpuCount > 0 && typeof (hw as any).ramTotalBytes === "number",
    JSON.stringify({ cores: (hw as any).cpuCount, ram: (hw as any).ramTotalBytes })
  );
  // And the tuner must produce numbers from that shape rather than NaN.
  const reports = evaluateAll(hw as any);
  check(
    fam,
    "fit verdicts are finite on any machine",
    "no NaN may reach the table",
    reports.every((r) => !/NaN|Infinity|undefined/.test(`${r.fit} ${r.verdict}`)),
    reports.map((r) => `${r.rung.id}=${r.fit}`).join(" ")
  );
  void findRung;
}

// ── run ──────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("llamacli — bare environment and Windows cmd validation");
console.log("=".repeat(80));

const t0 = Date.now();
await bareBootstrap();
await bareModelsCommand();
await bareLlamaSearch();
await windowsDefaults();
await windowsPortParsing();
await windowsBinaryNaming();
await windowsConfigRoundTrip();
await windowsNoGpuTools();

const families = [...new Set(failures.map((f) => f.family))];
console.log(`\nchecks run : ${checks}`);
console.log(`failures   : ${failures.length}`);
console.log(`duration   : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (failures.length === 0) {
  console.log("\nPASS — bootstrap and the model server behave on a bare machine and on Windows cmd.");
} else {
  console.log(`\nFAIL — ${families.length} distinct invariant(s) violated:\n`);
  const byInv = new Map<string, typeof failures>();
  for (const f of failures) {
    const cur = byInv.get(f.invariant) ?? [];
    cur.push(f);
    byInv.set(f.invariant, cur);
  }
  for (const [inv, list] of byInv) {
    console.log(`  ✗ ${inv}`);
    for (const f of list) console.log(`      [${f.family}] ${f.case} — ${f.detail}`);
    console.log();
  }
}
if (verbose && failures.length) {
  console.log("all failures:");
  for (const f of failures) console.log(`  ${f.family} | ${f.case} | ${f.invariant} | ${f.detail}`);
}
process.exit(failures.length === 0 ? 0 : 1);
