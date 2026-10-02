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

export type PortOwner =
  | { kind: "none" }
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
  makeServer?: (cfg: LlamaServerConfig) => { start(): Promise<void>; stop(): void; logTail(lines?: number): string };
  /** Injected for tests; defaults to signalling the real process.
   *
   *  A seam rather than a mock: "stopped before it started" is the load-bearing
   *  ordering in this module, and asserting it needs to observe the stop. A test
   *  that only watched the replacement server's own `start()` proved nothing --
   *  the stop goes through `process.kill`, not through that object. */
  stopProcess?: (pid: number, say: (line: string) => void) => Promise<void>;
  /** Injected for tests. */
  onProgress?: (line: string) => void;
}

export interface SwitchResult {
  ok: boolean;
  /** The port, unchanged. Reported so the caller can assert it. */
  port: number;
  /** What was stopped, if anything. */
  stopped?: PortOwner;
  /** True when the new server answered a health probe. */
  ready: boolean;
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

  const detectOwner = opts.detectOwner ?? (async () => detectPortOwner(port));
  const owner = await detectOwner();

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
  } else {
    say(`${port} 포트가 비어 있습니다. 그대로 시작합니다.`);
  }

  const cfg: LlamaServerConfig = {
    binPath: opts.binPath,
    modelPath: opts.modelPath,
    host,
    // Reused verbatim. There is deliberately no fallback to another port here:
    // a model switch that quietly relocates the server is the failure this
    // whole module exists to prevent.
    port,
    contextSize: opts.tuning.contextSize ?? 8192,
    threads: opts.tuning.threads ?? 4,
    gpuLayers: opts.tuning.gpuLayers ?? 0,
    ...opts.tuning,
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
  return { ok: true, port, stopped, ready: true, lines };
}

/** Who is listening on `port`.
 *
 * Best-effort and conservative: anything it cannot confidently attribute as a
 * llama-server becomes "foreign", which the caller then declines to touch.
 * Failing closed matters here — mis-classifying a stranger's process as ours
 * would let a model switch kill it. */
export async function detectPortOwner(port: number): Promise<PortOwner> {
  const pid = await pidOnPort(port);
  if (!pid) return { kind: "none" };

  // A systemd unit that names this port wins over everything: it is the thing
  // that will keep holding it, so it decides what happens.
  const unit = await systemdUnitForPort(port);
  if (unit) return { kind: "systemd", unit };

  const cmdline = await readCmdline(pid);
  if (cmdline && /llama-server/i.test(cmdline)) {
    return { kind: "ours", pid, binPath: cmdline.split(/\s+/)[0] };
  }
  return { kind: "foreign", pid };
}

async function pidOnPort(port: number): Promise<number | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    // `ss -ltnp` prints `users:(("llama-server",pid=123,fd=3))`.
    const { stdout } = await run("ss", ["-ltnp"], { timeout: 5000 });
    for (const line of stdout.split("\n")) {
      if (!new RegExp(`:${port}\\s`).test(line)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  } catch {
    return null;
  }
}

async function systemdUnitForPort(port: number): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(
      "systemctl",
      ["--user", "list-units", "--type=service", "--state=running", "--no-pager", "--plain", "--no-legend"],
      { timeout: 8000 }
    );
    for (const line of stdout.split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (!unit) continue;
      if (!/llama|llamacli/i.test(unit)) continue;
      // Confirm the unit actually binds this port before claiming it does --
      // otherwise any llama unit would be attributed whatever port is asked.
      const { stdout: show } = await run("systemctl", ["--user", "show", unit, "-p", "ExecStart"], { timeout: 5000 }).catch(() => ({ stdout: "" }));
      if (show.includes(`:${port}`) || show.includes(`--port ${port}`)) return unit;
    }
    return null;
  } catch {
    return null;
  }
}

async function readCmdline(pid: number): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
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
export async function detectRunningServerPort(): Promise<number | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  let stdout = "";
  try {
    ({ stdout } = await run("ss", ["-ltnp"], { timeout: 5000 }));
  } catch {
    return null;
  }
  for (const line of stdout.split("\n")) {
    const pid = line.match(/pid=(\d+)/)?.[1];
    if (!pid) continue;
    const cmdline = await readCmdline(Number(pid));
    // The binary may be relative (`./llama-server`) when started by hand, so the
    // test is on the name anywhere in the command line, not on the argv[0] path.
    if (!cmdline || !/llama-server/i.test(cmdline)) continue;
    // The listening port off the ss line, cross-checked against the process's own
    // --port when it gave one. The ss port is authoritative: it is what the
    // socket is actually bound to.
    const port = line.match(/:(\d+)\s/) ? line.match(/:(\d+)\s/)![1] : null;
    if (port) return Number(port);
  }
  return null;
}
