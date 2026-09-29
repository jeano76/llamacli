/**
 * The one place that decides which port llamacli talks to, so the configured
 * port and the port llama-server binds cannot disagree.
 *
 * ── What this used to do, and why it is smaller now ─────────────────────────
 * There were once two ports: llama-server and a `laya` "System 1" helper that
 * was consulted before each turn (see the removed `/fastcheck`). Both the
 * helper and its port are gone, so exactly one port remains and the collision
 * logic that existed to stop the two servers fighting over 8099 is gone with
 * it. `layaPortEnv()` went the same way — its whole reason for existing was
 * making the Python side's bind port and its health probe agree, and there is
 * no Python side any more.
 *
 * ── The problem that remains ────────────────────────────────────────────────
 * The port was once an independent fact per component: `detect.ts` probed
 * 8080/8081/11434 and took the first responder, while a separate spawn default
 * said 8081. Which port the next run used therefore depended on what else
 * happened to be running. The requirement is simply that the port llamacli
 * talks to and the port llama-server binds are the same number by
 * construction — decided once, written once, and re-asserted on every launch.
 */

export const LLAMA_PORT = 8080;

/** Ports llamacli will probe for an already-running OpenAI-compatible server
 *  when a project has no config yet. The candidates are ORDERED and the first
 *  responder wins, so our own port leads: if llamacli is already serving, that
 *  is unambiguously the right answer. */
export const COMMON_PORTS = [LLAMA_PORT, 11434];

export type PortState = "free" | "in-use" | "unknown";

/** Whether something is listening on `port`.
 *
 *  A pure TCP connect, deliberately: it answers "is this port taken", which is
 *  the only question here, without depending on an HTTP server existing there
 *  (a *foreign* process squatting on 8080 is exactly the case this must
 *  detect). Injected so the whole module is testable without binding real
 *  ports. */
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
  /** Set when a port had to be moved, so the reason is reported rather than
   *  silently changing where the server lives between runs. */
  moved: { what: "llama"; from: number; to: number; because: string }[];
  notes: string[];
}

/**
 * Resolves the port.
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

  return { llamaPort, moved, notes };
}

async function firstFree(probe: PortProbe, from: number, to: number): Promise<number> {
  for (let p = from; p <= to; p++) {
    if ((await probe(p)) === "free") return p;
  }
  return to;
}
