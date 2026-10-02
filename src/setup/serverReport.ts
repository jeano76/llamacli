/**
 * What the model-serving server currently IS, as a report the user can read.
 *
 * ── Why a report and not an action ──────────────────────────────────────────
 * `/models <n>` already switches the server as a side effect, and it does that
 * well. What it cannot do is answer the question a user has when something is
 * already wrong: "what is running right now, on which port, with which build,
 * and is that build the one that can read my model?"
 *
 * That question comes up on its own — after a crash, after an external process
 * took the port, after editing config.yaml by hand — and until now the only way
 * to answer it was to read the file. So `/server` reports, and `/server restart`
 * re-applies the recorded model on the recorded port.
 *
 * The distinction that matters: `/models <n>` CHANGES which model is served,
 * while `/server restart` re-serves the model that is already configured. They
 * are not two spellings of one action, and collapsing them would make "restart
 * my server" silently switch models.
 */

import { detectPortOwner, detectRunningServerPort, type PortOwner } from "./modelSwitch.js";
import { findLlamaServer } from "./llamaCpp.js";

export interface ServerReport {
  /** The port the config records. Absent when it records none. */
  configuredPort?: number;
  /** The port actually INSPECTED — the config's, else the running server's.
   *  Distinct from `configuredPort` because a report that said 8080 while
   *  inspecting 8084 would be confidently wrong, and a user who believed it
   *  would conclude their server had died. */
  port: number;
  /** True when `port` came from the running server rather than the config. */
  portDiscovered: boolean;
  /** The model the config names. */
  configuredModel?: string;
  /** The binary the config names. */
  configuredBin?: string;
  /** Who holds the port right now, if anyone. */
  owner: PortOwner;
  /** What discovery found for the configured model, and whether it can read it. */
  build?: {
    binPath: string;
    /** False when a build was found but cannot read this model's quantization. */
    canReadModel: boolean;
    /** Builds that exist and run but reject the model. */
    rejectedForModel: string[];
  };
  /** One-line summary for the status line. */
  summary: string;
  /** What a restart would do, stated before it is attempted. */
  restartPlan: string;
}

export interface ReportOptions {
  config: Record<string, any>;
  projectRoot: string;
  /** Injected for tests. */
  detectOwner?: (port: number) => Promise<PortOwner>;
  /** Injected for tests. Used ONLY when the config records no port. */
  detectRunningPort?: () => Promise<number | null>;
  /** Injected for tests. */
  findServer?: typeof findLlamaServer;
}

const DEFAULT_PORT = 8080;

export async function reportServer(opts: ReportOptions): Promise<ServerReport> {
  const llama = (opts.config?.llama ?? {}) as Record<string, any>;
  const configuredPort = typeof llama.port === "number" ? llama.port : undefined;
  const configuredModel = typeof llama.modelPath === "string" ? llama.modelPath : undefined;
  const configuredBin = typeof llama.binPath === "string" ? llama.binPath : undefined;

  // The port to inspect. NOT re-planned — the same rule the switch follows, so
  // the report and the action can never disagree about which port is "the" port.
  //
  // An unrecorded port is resolved by ASKING THE RUNNING SERVER, and that is not
  // a refinement. This config has no `llama` block at all, so the first version
  // reported "포트 8080 · 서버 없음" on a machine with a live server on 8084 —
  // confidently wrong, and worse than saying nothing, because a user who believed
  // it would conclude their server had died. `8080` is correct only when nothing
  // is listening, which is the one case where binding it cannot collide.
  const port = configuredPort ?? (await (opts.detectRunningPort ?? detectRunningServerPort)()) ?? DEFAULT_PORT;
  const owner = await (opts.detectOwner ?? ((p) => detectPortOwner(p)))(port);

  let build: ServerReport["build"];
  try {
    const found = await (opts.findServer ?? findLlamaServer)({ modelPath: configuredModel });
    const rejected = found.rejectedForModel ?? [];
    if (found.location) {
      build = {
        binPath: found.location.binPath,
        // A build is only "can read the model" if it was not rejected FOR the
        // model. `location` non-null already implies that, but the flag is
        // carried explicitly so a caller cannot read it the other way round.
        canReadModel: !rejected.includes(found.location.binPath),
        rejectedForModel: rejected,
      };
    } else if (rejected.length > 0) {
      // No usable build, but we know WHICH ones refuse this quantization. That
      // is the most actionable thing this report can say — it is the difference
      // between "the model will not load" and "the build is the wrong one" — and
      // an earlier version dropped it, because the section was only filled in
      // when a build was actually found.
      build = {
        binPath: rejected[0],
        canReadModel: false,
        rejectedForModel: rejected,
      };
    }
  } catch {
    // Discovery failing is not a reason to fail the report — the port and the
    // owner are the part the user cannot get any other way.
    build = undefined;
  }

  return {
    configuredPort,
    port,
    portDiscovered: configuredPort === undefined,
    configuredModel,
    configuredBin,
    owner,
    build,
    summary: summarize({ port, portDiscovered: configuredPort === undefined, configuredModel, owner, build }),
    restartPlan: restartPlan({ configuredModel, configuredBin, port, owner, build }),
  };
}

function summarize(r: {
  port: number;
  portDiscovered: boolean;
  configuredModel?: string;
  owner: PortOwner;
  build?: ServerReport["build"];
}): string {
  // The RESOLVED port, and marked as discovered when the config did not record
  // it — so "8084 (실행 중인 서버에서 확인)" is visibly a different kind of
  // claim from a recorded "8084".
  const parts: string[] = [`포트 ${r.port}${r.portDiscovered ? " (실행 중인 서버에서 확인)" : ""}`];
  if (r.configuredModel) parts.push(`모델 ${r.configuredModel.split("/").pop()}`);
  switch (r.owner.kind) {
    case "none":
      parts.push("서버 없음 (포트 비어 있음)");
      break;
    case "ours":
      parts.push(`실행 중 (pid ${r.owner.pid}, 이 설치 소유)`);
      break;
    case "systemd":
      parts.push(`systemd 유닛 ${r.owner.unit} 이 사용 중`);
      break;
    case "foreign":
      parts.push(`알 수 없는 프로세스 pid ${r.owner.pid ?? "?"} 가 사용 중`);
      break;
    case "unknown":
      parts.push(`확인 불가 (${r.owner.reason})`);
      break;
  }
  if (r.build) {
    parts.push(r.build.canReadModel ? `빌드 ${r.build.binPath.split("/").slice(-2).join("/")}` : "빌드가 이 모델의 양자화를 읽지 못함");
  }
  return parts.join(" · ");
}

function restartPlan(r: {
  configuredModel?: string;
  configuredBin?: string;
  port: number;
  owner: PortOwner;
  build?: ServerReport["build"];
}): string {
  if (!r.configuredModel) {
    return "config 에 모델이 없습니다. /models 로 먼저 선택하세요.";
  }
  if (r.build && !r.build.canReadModel) {
    return (
      `설치된 빌드가 이 모델의 양자화를 읽지 못합니다 (거절된 빌드: ${r.build.rejectedForModel.join(", ") || "?"}). ` +
      "호환 빌드가 필요합니다."
    );
  }
  if (r.owner.kind === "systemd") {
    return (
      `포트 ${r.port} 를 systemd 유닛 ${r.owner.unit} 이 사용 중입니다. ` +
      "이 유닛은 자체적으로 모델을 지정하므로 재시작만으로 새 모델이 적용되지 않습니다."
    );
  }
  if (r.owner.kind === "unknown" || r.owner.kind === "foreign") {
    return `포트 ${r.port} 의 사용자를 확인할 수 없어 재시작하지 않습니다 (${r.owner.kind}).`;
  }
  return `기존 서버를 종료하고 같은 포트(${r.port})에서 ${r.configuredModel.split("/").pop()} 로 다시 올립니다.`;
}
