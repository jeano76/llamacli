/**
 * Switching the model AND the server, on the same port.
 *
 * ── The invariant this exists to hold ────────────────────────────────────────
 * Exactly ONE llama-server, on the SAME port, serving the model that was just
 * selected. Both halves matter and both have been violated in this project's
 * history:
 *
 *   - TWO servers: planPorts used to see 8080 busy and move llamacli to 8081,
 *     which meant spawning a SECOND llama-server. On an 8 GB card whose first
 *     server already holds 7.2 GB, that is an OOM at load, not a slowdown.
 *   - A MOVED port: an install that migrates its port on every launch is an
 *     install nobody can predict. The port is recorded once and kept.
 *
 * So the port is read from config and reused verbatim. There is no code path
 * here that chooses a different one.
 *
 * ── Who owns the port has to be established first ───────────────────────────
 * Something is usually already listening — the previous model, on the port we
 * are about to reuse. Whether llamacli may stop it depends entirely on what it
 * is:
 *
 *   - our own child (spawned by a previous llamacli): stop it. It holds VRAM we
 *     need and will never reload itself.
 *   - a systemd user unit we can name: the unit is what will keep the port, so
 *     a bare kill would race the unit's own restart and leave the port
 *     flapping. This is reported rather than fought over.
 *   - an unrelated process: NOT stopped. It is not ours, the port is not ours,
 *     and killing a stranger's process because a model changed is not a
 *     decision this code should make on its own.
 *
 * The last case is the honest limit: llamacli can guarantee "one server, the
 * port we were given" for servers it owns, and reports clearly when it does not.
 */

import { LlamaServerManager, type LlamaServerConfig } from "../backend/llamaServer.js";
import { summarizeGpuOffload, waitForGpuRelease } from "./gpuReport.js";
import { hasSystemd, listeningPortsCommand, PORT_FIELD_SEPARATOR, type HostPlatform } from "./hostEnv.js";

export type PortOwner =
  | { kind: "none" }
  /**
   * The lookup itself failed — the platform's tool is missing or its output
   * could not be parsed. NOT the same as "free".
   *
   * This state exists because the previous version shelled out to `ss`, caught
   * the "command not found" on Windows, and reported the port as free. A model
   * switch on an occupied port would then start a second server, which is the
   * exact failure the module exists to prevent — reached by believing a tool's
   * absence instead of by ignoring it.
   */
  | { kind: "unknown"; reason: string }
  /** A llama-server this install is allowed to stop. */
  | { kind: "ours"; pid: number; binPath?: string }
  /** A systemd user unit holding the port. Restarting it re-runs the unit's own
   *  command, which names its OWN model -- so it will not pick up a new one
   *  without the unit being changed. Reported rather than silently fought. */
  | { kind: "systemd"; unit: string }
  /** Something we cannot attribute. Never stopped. */
  | { kind: "foreign"; pid?: number };

export interface SwitchOptions {
  /** Where the model lives now. */
  modelPath: string;
  /** The port already in force. Reused verbatim -- never re-planned. */
  port: number;
  host?: string;
  /** The binary that can read this model. */
  binPath: string;
  /** Tuning flags, so the replacement server is configured like the old one. */
  tuning: Partial<Omit<LlamaServerConfig, "binPath" | "modelPath" | "host" | "port">>;
  /** Who holds the port. Injected for tests. */
  detectOwner?: () => Promise<PortOwner>;
  /** Injected for tests; defaults to a real manager. */
  makeServer?: (cfg: LlamaServerConfig) => { start(): Promise<void>; stop(): void; logTail(lines?: number): string; gpuLog?(): string };
  /** Called after the old server is gone and its VRAM released, BEFORE the new one is
   *  started: re-measure the hardware, re-derive the tuning for the new model against the
   *  memory that is really free now, and say whether the GPU will be used. Returns the
   *  tuning to launch with. The /models flow sizes the model while the old server still
   *  holds its VRAM, so without this the plan it printed was made on stale numbers. */
  retune?: () => Promise<{ tuning?: SwitchOptions["tuning"]; lines: string[] }>;
  /** Injected for tests; defaults to polling nvidia-smi. */
  waitGpuRelease?: (pid: number) => Promise<{ released: boolean; waitedMs: number }>;
  /** Injected for tests; defaults to signalling the real process.
   *
   *  A seam rather than a mock: "stopped before it started" is the load-bearing
   *  ordering in this module, and asserting it needs to observe the stop. A test
   *  that only watched the replacement server's own `start()` proved nothing --
   *  the stop goes through `process.kill`, not through that object. */
  stopProcess?: (pid: number, say: (line: string) => void) => Promise<void>;
  /** Injected for tests. */
  onProgress?: (line: string) => void;
  /** Injected for tests; defaults to the host platform. */
  platform?: HostPlatform;
  /** Injected for tests; defaults to a real child-process exec. */
  runCommand?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
}

export interface SwitchResult {
  ok: boolean;
  /** The port, unchanged. Reported so the caller can assert it. */
  port: number;
  /** What was stopped, if anything. */
  stopped?: PortOwner;
  /** True when the new server answered a health probe. */
  ready: boolean;
  /** What the new server was actually launched with (after the post-stop re-tune), so the
   *  config can record the real thing rather than the pre-stop estimate. */
  launched?: { binPath: string; modelPath: string; tuning: SwitchOptions["tuning"] };
  /** User-facing lines. */
  lines: string[];
}

export async function switchModelAndServer(opts: SwitchOptions): Promise<SwitchResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    opts.onProgress?.(l);
  };

  const detectOwner =
    opts.detectOwner ??
    (async () => detectPortOwner(port, { platform: opts.platform, run: opts.runCommand }));
  const owner = await detectOwner();

  if (owner.kind === "unknown") {
    // Refusing is the whole point: acting on a port we could not inspect risks a
    // second server, and a second server on a small card is an OOM at load.
    return {
      ok: false,
      port,
      ready: false,
      lines: [
        `${port} 포트가 사용 중인지 확인할 수 없습니다 (${owner.reason}).`,
        "확인되지 않은 포트에 서버를 새로 띄우면 기존 서버와 충돌합니다.",
        "모델은 config 에 기록했습니다 — 서버 교체는 건너뜁니다.",
      ],
    };
  }

  if (owner.kind === "foreign") {
    // The one case we refuse to act on. Binding the port ourselves would fail,
    // and killing the holder is not this code's call.
    return {
      ok: false,
      port,
      ready: false,
      lines: [
        `${port} 포트를 llamacli 가 알 수 없는 프로세스가 사용 중입니다 (pid ${owner.pid ?? "?"}).`,
        "모델은 config 에 기록했습니다. 해당 포트를 비우면 새 모델로 서버가 올라갑니다.",
      ],
    };
  }

  let stopped: PortOwner | undefined;
  if (owner.kind === "systemd") {
    // The unit owns the port and will keep it. Say so, because "restart the
    // unit" does NOT load a new model -- the unit names its own -- and silently
    // proceeding would leave the new model unused while looking successful.
    return {
      ok: false,
      port,
      ready: false,
      stopped: owner,
      lines: [
        `${port} 포트를 systemd 유닛이 사용 중입니다 (${owner.unit}).`,
        `모델은 config 에 기록했습니다. 이 유닛은 자체적으로 모델을 지정하므로 ` +
          `단순 재시작으로는 새 모델이 적용되지 않습니다 — ${owner.unit} 의 시작 스크립트를 확인하세요.`,
      ],
    };
  }

  if (owner.kind === "ours") {
    stopped = owner;
    say(`${port} 포트의 기존 llama-server (pid ${owner.pid}) 를 종료합니다.`);
    await (opts.stopProcess ?? stopPid)(owner.pid, say);
    const rel = await (opts.waitGpuRelease ?? ((pid) => waitForGpuRelease(pid, opts.runCommand ?? defaultRunCommand)))(owner.pid);
    say(
      rel.released
        ? "기존 서버가 사용하던 GPU 메모리를 반환했습니다."
        : "기존 서버가 종료됐지만 GPU 메모리 반환이 아직 확인되지 않습니다 — 새 서버가 메모리 부족으로 실패할 수 있습니다."
    );
  } else {
    say(`${port} 포트가 비어 있습니다. 그대로 시작합니다.`);
  }

  // The plan, on numbers taken now that the old server's VRAM is free.
  let launchTuning = opts.tuning;
  if (opts.retune) {
    try {
      const r = await opts.retune();
      if (r.tuning) launchTuning = r.tuning;
      for (const l of r.lines) say(l);
    } catch (err) {
      say(`GPU 재측정에 실패해 이전 계산값으로 진행합니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cfg: LlamaServerConfig = {
    binPath: opts.binPath,
    modelPath: opts.modelPath,
    host,
    // Reused verbatim. There is deliberately no fallback to another port here:
    // a model switch that quietly relocates the server is the failure this
    // whole module exists to prevent.
    port,
    contextSize: launchTuning.contextSize ?? 8192,
    threads: launchTuning.threads ?? 4,
    gpuLayers: launchTuning.gpuLayers ?? 0,
    ...launchTuning,
  };

  const make = opts.makeServer ?? ((c: LlamaServerConfig) => new LlamaServerManager(c));
  const server = make(cfg);

  try {
    say(`${opts.binPath} 로 새 모델을 올립니다 (포트 ${port}, 그대로)…`);
    await server.start();
  } catch (err) {
    const tail = server.logTail?.(12) ?? "";
    return {
      ok: false,
      port,
      stopped,
      ready: false,
      lines: [
        `새 모델로 서버를 띄우지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
        ...(tail ? [tail] : []),
      ],
    };
  }

  say(`${port} 포트에서 새 모델이 응답합니다.`);
  const launched = { binPath: opts.binPath, modelPath: opts.modelPath, tuning: launchTuning };
  // The result, from the server's own load log — the plan above is what was asked for.
  say(summarizeGpuOffload(server.gpuLog?.() ?? server.logTail?.(200) ?? "", { gpuLayers: cfg.gpuLayers ?? 0 }));
  return { ok: true, port, stopped, ready: true, lines, launched };
}

/** Who is listening on `port`.
 *
 * Best-effort and conservative: anything it cannot confidently attribute as a
 * llama-server becomes "foreign", which the caller then declines to touch.
 * Failing closed matters here — mis-classifying a stranger's process as ours
 * would let a model switch kill it. */
export async function detectPortOwner(
  port: number,
  opts: {
    platform?: HostPlatform;
    run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
    /** Injected for tests. The real one reads procfs or shells out to wmic, and
     *  `wmic` is absent on current Windows -- so without a seam the ONLY
     *  reachable answer on a Windows box is `unknown`, and the positive
     *  attribution could not be exercised anywhere. */
    readCmdline?: (pid: number, platform: HostPlatform) => Promise<string | null>;
  } = {}
): Promise<PortOwner> {
  const run = opts.run ?? defaultRunCommand;
  const probeCmd = listeningPortsCommand(opts.platform);
  const { pid, known } = await pidOnPort(port, run, opts.platform);
  // `known: false` means the LISTENING-PORT LOOKUP ITSELF FAILED — the tool is
  // missing, or the output could not be parsed. That is NOT the same as "the
  // port is free", and treating it as free is how a model switch starts a SECOND
  // server on an occupied port: the command is absent on Windows, the throw was
  // caught, and the empty answer was believed.
  if (!known) return { kind: "unknown", reason: `listening-port 조회 실패 (${probeCmd.file})` };
  if (!pid) return { kind: "none" };

  // A systemd unit that names this port wins over everything: it is the thing
  // that will keep holding it, so it decides what happens. Skipped outright on
  // platforms that have no systemd, rather than run and caught.
  if (hasSystemd(opts.platform)) {
    const unit = await systemdUnitForPort(port, run);
    if (unit) return { kind: "systemd", unit };
  }

  const cmdline = await (opts.readCmdline ?? readCmdline)(pid, opts.platform ?? process.platform);
  if (cmdline && /llama-server/i.test(cmdline)) {
    return { kind: "ours", pid, binPath: cmdline.split(/\s+/)[0] };
  }
  // A cmdline we could NOT read is not the same as one that does not mention
  // llama-server. Collapsing the two calls a real server `foreign` — which
  // refuses the switch with a message about a process "llamacli does not
  // recognise", when the truth is that it simply could not look. `wmic` is
  // absent on current Windows, so this is the normal case there, not an edge
  // one. Both refuse to act, so the safety outcome is identical; the difference
  // is that only one of them tells the truth about why.
  if (!cmdline) {
    return { kind: "unknown", reason: `pid ${pid} 의 명령줄을 읽을 수 없음 (읽지 못함 ≠ llama-server 아님)` };
  }
  return { kind: "foreign", pid };
}

async function pidOnPort(
  port: number,
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>,
  platform: HostPlatform = process.platform
): Promise<{ pid: number | null; known: boolean }> {
  const { file, args } = listeningPortsCommand(platform);
  let stdout: string;
  try {
    stdout = await run(file, args, 5000);
  } catch {
    return { pid: null, known: false };
  }
  for (const line of stdout.split("\n")) {
    if (platform === "win32") {
      // `continue` on a non-match, NOT an early return: the first line of
      // netstat output is a header, so returning on it reported every port as
      // free. An early return here is the same class of bug as treating a
      // failed lookup as an empty one — a wrong answer instead of no answer.
      const pid = parseNetstatLine(line, port);
      if (pid) return { pid, known: true };
      continue;
    }
    if (!new RegExp(`${PORT_FIELD_SEPARATOR}${port}\\s`).test(line)) continue;
    const m = line.match(/pid=(\d+)/);
    if (m) return { pid: Number(m[1]), known: true };
  }
  return { pid: null, known: true };
}

/** `netstat -ano` line → pid, or null when the line is not our port.
 *
 *  Windows prints `TCP  127.0.0.1:8084  0.0.0.0:0  LISTENING  1234`, with the
 *  port in the LOCAL address column. The foreign-address column also contains a
 *  colon, so the port is matched against the local column specifically —
 *  matching anywhere in the line would read `0.0.0.0:0` and every line as a
 *  candidate. */
function parseNetstatLine(line: string, port: number): number | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 5) return null;
  if (cols[0].toUpperCase() !== "TCP") return null;
  if (cols[3].toUpperCase() !== "LISTENING") return null;
  const local = cols[1];
  if (!local.endsWith(`${PORT_FIELD_SEPARATOR}${port}`)) return null;
  const pid = Number(cols[4]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function systemdUnitForPort(
  port: number,
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>
): Promise<string | null> {
  try {
    const stdout = await run(
      "systemctl",
      ["--user", "list-units", "--type=service", "--state=running", "--no-pager", "--plain", "--no-legend"],
      8000
    );
    for (const line of stdout.split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (!unit) continue;
      if (!/llama|llamacli/i.test(unit)) continue;
      // Confirm the unit actually binds this port before claiming it does --
      // otherwise any llama unit would be attributed whatever port is asked.
      const show = await run("systemctl", ["--user", "show", unit, "-p", "ExecStart"], 5000).catch(() => "");
      if (show.includes(`${PORT_FIELD_SEPARATOR}${port}`) || show.includes(`--port ${port}`)) return unit;
    }
    return null;
  } catch {
    return null;
  }
}

/** The command line of `pid`, or null when the platform cannot supply one.
 *
 *  null must be read as UNKNOWN, not as empty. An empty string would fail the
 *  `/llama-server/i` test below and classify a real server as `foreign`, which
 *  makes the switch refuse to act on the very server it was asked to replace. */
async function readCmdline(pid: number, platform: HostPlatform = process.platform): Promise<string | null> {
  if (platform === "win32") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const out = await promisify(execFile)("wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
        { timeout: 5000, windowsHide: true } as never);
      return (String(out.stdout) || "").split("=").slice(1).join("=").trim() || null;
    } catch {
      return null;
    }
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim() || null;
  } catch {
    return null;
  }
}

async function defaultRunCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(file, args, { timeout: timeoutMs });
  return String(stdout);
}

/** SIGTERM, then confirm it actually let go of the port.
 *
 * Confirming matters: starting the replacement while the old process is still
 * bound to the port produces a "address already in use" failure that reads like
 * a configuration problem, when it is really a race. */
async function stopPid(pid: number, say: (l: string) => void): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      say(`기존 서버가 종료되었습니다 (${(i + 1) * 0.25}초).`);
      return;
    }
  }
  say("기존 서버가 10초 안에 종료되지 않아 SIGKILL 로 마무리합니다.");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 500));
}
/** The port an already-running llama-server is listening on.
 *
 *  Needed because a config can legitimately have no `llama.port` at all — the
 *  file on this machine was exactly that — and the fallback for "no port
 *  recorded" must NOT be 8080. A server actually running on 8084 plus a default
 *  of 8080 means the switch starts a SECOND server on 8080, which is the exact
 *  two-server OOM this module exists to prevent. Asking the running process is
 *  the only source that cannot be wrong about where it is.
 *
 *  Returns null when nothing of ours is listening; the caller then falls back. */
export async function detectRunningServerPort(
  opts: { platform?: HostPlatform; run?: (file: string, args: string[], timeoutMs: number) => Promise<string> } = {}
): Promise<number | null> {
  return (await detectRunningServerPorts(opts))[0] ?? null;
}

/** EVERY port a llama-server process of this machine is listening on, in the order
 *  the OS lists them.
 *
 *  Plural because the first-found answer is not enough for discovery: with a manual
 *  server on 8084 and a stray one elsewhere, "the first" may be the wrong one, and
 *  discovery wants to probe them all. The list is the ground truth that the fixed
 *  `COMMON_PORTS` guess can never be — a server started by hand (`--port 8084`) is
 *  in no list anyone wrote down, which is how a healthy server holding 7.3 GB of an
 *  8 GB card went unseen and a second one was spawned beside it. */
export async function detectRunningServerPorts(
  opts: {
    platform?: HostPlatform;
    run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
    readCmdline?: (pid: number, platform: HostPlatform) => Promise<string | null>;
  } = {}
): Promise<number[]> {
  return (await listLlamaServers(opts)).map((s) => s.port);
}

export interface LiveLlamaServer {
  pid: number;
  port: number;
  cmdline: string;
  /** Absolute path of the executable (procfs `exe`), when readable. The command line's
   *  argv[0] is often relative (`./llama-server`), which names nothing on its own. */
  exe?: string;
}

/** What a running llama-server was started with, read back from its command line. Lets
 *  `/server restart` and `/models` act on a server that llamacli did not start and whose
 *  settings are in no config — the user started it by hand, and its own arguments are the
 *  only record of its model, build and tuning. */
export interface ParsedServerArgs {
  modelPath?: string;
  port?: number;
  /** PER-SLOT context: llama.cpp's `-c` is the total across slots, divided by `-np`. */
  contextSize?: number;
  gpuLayers?: number;
  threads?: number;
  threadsBatch?: number;
  batchSize?: number;
  ubatchSize?: number;
  parallel?: number;
  cpuMoeLayers?: number;
  flashAttn?: boolean;
  cacheTypeK?: string;
  cacheTypeV?: string;
}

export function parseLlamaServerArgs(cmdline: string): ParsedServerArgs {
  const t = cmdline.trim().split(/\s+/);
  const val = (...names: string[]): string | undefined => {
    for (let i = 0; i < t.length - 1; i++) if (names.includes(t[i])) return t[i + 1];
    return undefined;
  };
  const num = (...names: string[]): number | undefined => {
    const v = val(...names);
    return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined;
  };
  const parallel = num("-np", "--parallel");
  const totalCtx = num("-c", "--ctx-size");
  const fa = val("-fa", "--flash-attn");
  return {
    modelPath: val("-m", "--model"),
    port: num("--port"),
    parallel,
    contextSize: totalCtx !== undefined ? Math.floor(totalCtx / Math.max(1, parallel ?? 1)) : undefined,
    gpuLayers: num("-ngl", "--n-gpu-layers", "--gpu-layers"),
    threads: num("-t", "--threads"),
    threadsBatch: num("-tb", "--threads-batch"),
    batchSize: num("-b", "--batch-size"),
    ubatchSize: num("-ub", "--ubatch-size"),
    cpuMoeLayers: num("--n-cpu-moe"),
    flashAttn: fa === undefined ? (t.includes("-fa") ? true : undefined) : !/^(off|0|false)$/i.test(fa),
    cacheTypeK: val("-ctk", "--cache-type-k"),
    cacheTypeV: val("-ctv", "--cache-type-v"),
  };
}

/** Every llama-server process that is listening, with its pid and command line. The
 *  pid is what lets a model switch stop the right process even when the config's
 *  recorded port is stale. */
export async function listLlamaServers(
  opts: {
    platform?: HostPlatform;
    run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
    readCmdline?: (pid: number, platform: HostPlatform) => Promise<string | null>;
    readExe?: (pid: number) => Promise<string | null>;
  } = {}
): Promise<LiveLlamaServer[]> {
  const run = opts.run ?? defaultRunCommand;
  const platform = opts.platform ?? process.platform;
  const { file, args } = listeningPortsCommand(platform);
  let stdout: string;
  try {
    stdout = await run(file, args, 5000);
  } catch {
    return [];
  }
  const out: LiveLlamaServer[] = [];
  for (const line of stdout.split("\n")) {
    const pid = platform === "win32" ? netstatPid(line) : line.match(/pid=(\d+)/)?.[1];
    if (!pid) continue;
    const cmdline = await (opts.readCmdline ?? readCmdline)(Number(pid), platform);
    // The binary may be relative (`./llama-server`) when started by hand, so the
    // test is on the name anywhere in the command line, not on the argv[0] path.
    if (!cmdline || !/llama-server/i.test(cmdline)) continue;
    // The port the socket is actually bound to is authoritative, not `--port` on the
    // command line: a server whose flag disagrees with its socket is rare, and trusting
    // the flag would hand the switch a port nothing is listening on.
    const port = platform === "win32" ? netstatLocalPort(line) : line.match(/:(\d+)\s/)?.[1];
    if (port && !out.some((o) => o.pid === Number(pid) && o.port === Number(port))) {
      const exe = await (opts.readExe ?? readExe)(Number(pid));
      out.push({ pid: Number(pid), port: Number(port), cmdline, ...(exe ? { exe } : {}) });
    }
  }
  return out;
}

async function readExe(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  const { readlink } = await import("node:fs/promises");
  return readlink(`/proc/${pid}/exe`).catch(() => null);
}

export interface ResolvedServerPort {
  port: number;
  /** "recorded": the config's port has a llama-server on it. "live": the config's port
   *  is stale or absent and a llama-server is listening elsewhere — that one wins.
   *  "recorded-idle": nothing is listening; the config's port is reused. "default":
   *  nothing is listening and nothing is recorded. */
  source: "recorded" | "live" | "recorded-idle" | "default";
  servers: LiveLlamaServer[];
}

/**
 * The port a model switch / restart must act on.
 *
 * The config's `llama.port` is a RECORD of where a server once was. When the user (or a
 * script) started the server by hand on another port it goes stale — here the config said
 * 8080 while the server held 7.3 GB of an 8 GB card on 8084 — and trusting it meant the
 * switch saw "8080 is free", stopped nothing, and started a SECOND server on a full card.
 * What is actually listening is a fact, so it outranks the record.
 */
export async function resolveLiveServerPort(
  recorded: number | undefined,
  opts: Parameters<typeof listLlamaServers>[0] & { servers?: LiveLlamaServer[] } = {}
): Promise<ResolvedServerPort> {
  const servers = opts.servers ?? (await listLlamaServers(opts));
  if (recorded !== undefined && servers.some((s) => s.port === recorded)) {
    return { port: recorded, source: "recorded", servers };
  }
  if (servers.length > 0) return { port: servers[0].port, source: "live", servers };
  if (recorded !== undefined) return { port: recorded, source: "recorded-idle", servers };
  return { port: 8080, source: "default", servers };
}

/** The pid column of a `netstat -ano` LISTENING line, or null. */
function netstatPid(line: string): string | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3].toUpperCase() !== "LISTENING") return null;
  return /^[0-9]+$/.test(cols[4]) ? cols[4] : null;
}

/** The local port of a `netstat -ano` LISTENING line, or null. */
function netstatLocalPort(line: string): string | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3].toUpperCase() !== "LISTENING") return null;
  const m = cols[1].match(/:(\d+)$/);
  return m ? m[1] : null;
}
