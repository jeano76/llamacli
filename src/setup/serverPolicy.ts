/**
 * The ONE place that decides whether a command may replace a running llama-server.
 *
 * `/server restart`, `/models <n>` and `/reset` all end in "the server the user is
 * running should now be a different one". Each used to decide for itself — and
 * `/server restart` and `/models` stopped a live server with no question asked. The
 * policy, once, so the commands cannot drift:
 *
 *  - There is one llama-server on one port. Several live servers are never resolved
 *    automatically: the user is shown them and chooses.
 *  - A port held by something we cannot attribute (foreign / systemd / unknown) is never
 *    touched.
 *  - Nothing on the port: start, no question (nothing is being replaced).
 *  - Our own server on the port: replacing it needs an explicit `confirm`. Without it the
 *    caller gets the change laid out and the exact command to run — never a stop.
 *    (A `confirm` word rather than a Y/N dialog: the same reason `/reset confirm` exists —
 *    a stray Enter cannot trigger it and it needs no new UI surface.)
 */
import type { LiveLlamaServer, ParsedServerArgs, PortOwner } from "./modelSwitch.js";

export interface DesiredServer {
  modelPath?: string;
  binPath?: string;
  tuning?: Partial<Omit<ParsedServerArgs, "modelPath" | "port">>;
}

const base = (p: string) => p.split("/").pop() ?? p;

/** What would change between the running server and the one that would replace it. */
export function diffServer(serving: ParsedServerArgs | undefined, servingBin: string | undefined, desired: DesiredServer): string[] {
  const out: string[] = [];
  if (desired.modelPath && serving?.modelPath && base(serving.modelPath) !== base(desired.modelPath)) {
    out.push(`모델: ${base(serving.modelPath)} → ${base(desired.modelPath)}`);
  }
  if (desired.binPath && servingBin && servingBin !== desired.binPath) {
    out.push(`빌드: ${servingBin} → ${desired.binPath}`);
  }
  const t = desired.tuning ?? {};
  const s = serving ?? {};
  const keys: [keyof ParsedServerArgs, string][] = [
    ["contextSize", "컨텍스트"], ["gpuLayers", "-ngl"], ["cpuMoeLayers", "--n-cpu-moe"],
    ["threads", "스레드"], ["flashAttn", "flash-attn"], ["cacheTypeK", "KV(k)"], ["cacheTypeV", "KV(v)"],
  ];
  for (const [k, label] of keys) {
    const want = (t as Record<string, unknown>)[k];
    const have = (s as Record<string, unknown>)[k];
    if (want !== undefined && have !== undefined && want !== have) out.push(`${label}: ${String(have)} → ${String(want)}`);
  }
  return out;
}

export type ServerGate =
  | { proceed: true; stopFirst: boolean; lines: string[] }
  | { proceed: false; reason: "multiple" | "foreign" | "systemd" | "unknown" | "needs-confirm"; lines: string[] };

export function gateServerReplacement(opts: {
  owner: PortOwner;
  port: number;
  servers?: LiveLlamaServer[];
  /** Output of `diffServer`. */
  changes: string[];
  confirmed: boolean;
  /** The command that proceeds, shown when confirmation is missing, e.g. `/server restart confirm`. */
  confirmCommand: string;
}): ServerGate {
  const { owner, port, servers, changes, confirmed, confirmCommand } = opts;

  if (servers && servers.length > 1) {
    return {
      proceed: false, reason: "multiple",
      lines: [
        `llama-server 가 ${servers.length}개 떠 있습니다. 자동으로 정리하지 않습니다 — 하나만 남기세요:`,
        ...servers.map((s) => `  · pid ${s.pid} · 포트 ${s.port} · ${base(parseModel(s.cmdline) ?? "?")}`),
        "한 서버만 직접 종료한 뒤 다시 실행하세요.",
      ],
    };
  }
  if (owner.kind === "foreign") {
    return { proceed: false, reason: "foreign", lines: [`포트 ${port} 는 llamacli 가 아닌 프로세스(pid ${owner.pid ?? "?"})가 사용 중이라 종료하지 않습니다.`] };
  }
  if (owner.kind === "systemd") {
    return { proceed: false, reason: "systemd", lines: [`포트 ${port} 는 systemd 유닛 ${owner.unit} 이 사용 중입니다. 유닛을 직접 바꾸세요.`] };
  }
  if (owner.kind === "unknown") {
    return { proceed: false, reason: "unknown", lines: [`포트 ${port} 사용 여부를 확인할 수 없어 서버를 건드리지 않습니다 (${owner.reason}).`] };
  }
  if (owner.kind === "none") return { proceed: true, stopFirst: false, lines: [] };

  // ours
  if (confirmed) return { proceed: true, stopFirst: true, lines: [] };
  return {
    proceed: false, reason: "needs-confirm",
    lines: [
      `포트 ${port} 에서 실행 중인 llama-server (pid ${owner.pid}) 를 종료하고 다시 올립니다.`,
      ...(changes.length ? changes.map((c) => `  · ${c}`) : ["  · 모델·빌드·설정 변경 없음 (같은 설정으로 재시작)"]),
      `진행하려면  ${confirmCommand}  를 입력하세요. 취소하려면 아무것도 하지 마세요 — 서버는 그대로 유지됩니다.`,
    ],
  };
}

function parseModel(cmdline: string): string | undefined {
  const t = cmdline.trim().split(/\s+/);
  const i = t.findIndex((x) => x === "-m" || x === "--model");
  return i >= 0 ? t[i + 1] : undefined;
}
