/**
 * One place that decides which ports llamacli, llama-server and laya use, so
 * they cannot disagree.
 *
 * ── The problem this removes ────────────────────────────────────────────────
 * The three ports used to be independent facts:
 *   - `COMMON_PORTS` in detect.ts probed 8080/8081/11434 and picked the first
 *     that answered;
 *   - `DEFAULT_8GB_PROFILE.port` in llamaServer.ts was 8081;
 *   - laya's port came from `LAYA_ENDPOINT`, defaulting to 8099, in TWO
 *     independent scripts (the repo-root one and plugin/laya's copy) which had
 *     already drifted apart once — 8000 vs 8099 — and both then booted their own
 *     laya-serve, each holding ~5 GB of RAM for the same model.
 *
 * A fresh install that happened to find a server on 8080 wrote a config
 * pointing at 8080 while its own spawn default said 8081, so which port the
 * next run used depended on what else was running. The requirement is simply
 * that the port llamacli talks to, the port llama-server binds, and the port
 * laya binds are the same number by construction — decided once, written once,
 * and re-asserted on every launch.
 */

export const LLAMA_PORT = 8080;
export const LAYA_PORT = 8099;

/** Ports llamacli will probe for an already-running OpenAI-compatible server
 *  when a project has no config yet. The candidates are ORDERED and the first
 *  responder wins, so our own port leads: if llamacli is already serving, that
 *  is unambiguously the right answer. */
export const COMMON_PORTS = [LLAMA_PORT, LAYA_PORT, 11434];

export type PortState = "free" | "in-use" | "unknown";

/** Whether something is listening on `port`.
 *
 *  A pure TCP connect, deliberately: it answers "is this port taken", which is
 *  the only question here, without depending on an HTTP server existing there
 *  (llama-serve and laya-serve both answer HTTP, but a *foreign* process squatting
 *  on 8080 is exactly the case this must detect). Injected so the whole module
 *  is testable without binding real ports. */
export type PortProbe = (port: number) => Promise<PortState>;

export const tcpPortProbe: PortProbe = async (port) => {
  const net = await import("node:net");
  return new Promise<PortState>((resolve) => {
    const socket = new net.Socket();
    // A short timeout: probing several ports sequentially on a machine with a
    // firewall that DROPs rather than REJECTs would otherwise hang for the OS
    // default (~2 min) per port.
    const timer = setTimeout(() => { socket.destroy(); resolve("unknown"); }, 400);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("in-use"); });
    socket.once("error", () => { clearTimeout(timer); resolve("free"); });
    socket.connect(port, "127.0.0.1");
  });
};

export interface PortPlan {
  llamaPort: number;
  layaPort: number;
  /** Set when a port had to be moved, so the reason is reported rather than
   *  silently changing where the server lives between runs. */
  moved: { what: "llama" | "laya"; from: number; to: number; because: string }[];
  notes: string[];
}

/**
 * Resolves the port pair.
 *
 * `wanted` lets a caller pass a port that is already recorded in a config
 * (i.e. one this llamacli install set up before), so an established install
 * keeps its port instead of being migrated on every launch. A port that is
 * already occupied by something *else* is moved, because a port conflict is
 * precisely the failure this whole module exists to prevent — and it is
 * reported, never silently absorbed.
 */
export async function planPorts(opts: {
  probe: PortProbe;
  llamaPort?: number;
  layaPort?: number;
}): Promise<PortPlan> {
  const { probe } = opts;
  const moved: PortPlan["moved"] = [];
  const notes: string[] = [];

  let llamaPort = opts.llamaPort ?? LLAMA_PORT;
  const llamaState = await probe(llamaPort);
  if (llamaState === "free" || llamaState === "unknown") {
    if (llamaState === "unknown") {
      // Treated as usable: a firewall that DROPs the probe says nothing about
      // whether the port is bindable, and refusing to start on that evidence
      // would make llamacli fail on a locked-down network for no reason.
      notes.push(`llama 포트 ${llamaPort} 응답 없음(방화벽) — 그대로 사용을 시도합니다.`);
    }
  } else {
    // Occupied. Prefer 8080 itself if the caller merely inherited a stale value
    // and our canonical port is free; otherwise walk forward.
    if (llamaPort !== LLAMA_PORT && (await probe(LLAMA_PORT)) === "free") {
      moved.push({ what: "llama", from: llamaPort, to: LLAMA_PORT, because: "기록된 포트가 사용 중이고 기본 포트가 비어 있음" });
      llamaPort = LLAMA_PORT;
    } else {
      const next = await firstFree(probe, llamaPort + 1, llamaPort + 20);
      moved.push({ what: "llama", from: llamaPort, to: next, because: "이미 사용 중" });
      llamaPort = next;
    }
  }

  let layaPort = opts.layaPort ?? LAYA_PORT;
  // laya must never share llama's port: two servers cannot bind it, and the
  // health check would then probe the wrong process. Checked explicitly rather
  // than trusted, because the two defaults are independently configurable.
  if (layaPort === llamaPort) {
    const next = await firstFree(probe, layaPort + 1, layaPort + 20);
    moved.push({ what: "laya", from: layaPort, to: next, because: `llama 포트(${llamaPort})와 동일해서 충돌` });
    layaPort = next;
  }
  const layaState = await probe(layaPort);
  if (layaState === "in-use") {
    notes.push(`laya 포트 ${layaPort}가 이미 사용 중입니다 — 실행 중이라면 그대로 재사용합니다.`);
  }

  return { llamaPort, layaPort, moved, notes };
}

async function firstFree(probe: PortProbe, from: number, to: number): Promise<number> {
  for (let p = from; p <= to; p++) {
    if ((await probe(p)) === "free") return p;
  }
  return to;
}

/** The env the laya Python side must see for its bind port and its health
 *  probes to agree.
 *
 *  Reported in this repo's own history as the cause of "llamacli가 멈춘 것 같다":
 *  `laya-serve` reads its BIND port from `LAYA_PORT` (upstream default 8000) while
 *  every health probe in laya_integration.py read `LAYA_ENDPOINT` (default 8099).
 *  The spawned server bound 8000, the probe polled 8099, so bootstrap timed out
 *  on a perfectly healthy server and then killed it as "failed to boot". Setting
 *  BOTH to the one planned port is what makes them agree by construction. */
export function layaPortEnv(port: number): Record<string, string> {
  return { LAYA_PORT: String(port), LAYA_ENDPOINT: String(port) };
}
