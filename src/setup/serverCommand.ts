/**
 * `/server restart [confirm]` as a function, so the interaction with the single-server
 * policy is testable without the TUI. The TUI only supplies the real dependencies and
 * prints the lines.
 */
import type { ServerReport } from "./serverReport.js";
import type { SwitchOptions, SwitchResult } from "./modelSwitch.js";
import { diffServer, gateServerReplacement } from "./serverPolicy.js";

export interface RestartDeps {
  switchServer: (opts: SwitchOptions) => Promise<SwitchResult>;
  /** Persist what is really running afterwards. */
  record: (state: { port: number; binPath: string; modelPath: string }) => Promise<unknown>;
  /** Bring the session's client in line with the new server. */
  sync: (modelPath: string, o: { contextSize?: number }) => Promise<string[]>;
  describePlan: (tuning: SwitchOptions["tuning"]) => Promise<string[]>;
}

export interface RestartInput {
  report: ServerReport;
  /** `config.llama.binPath`, used when discovery found no build. */
  configBin?: string;
  tuning: SwitchOptions["tuning"];
  confirmed: boolean;
}

export interface RestartOutcome {
  /** A server was (re)started. */
  restarted: boolean;
  lines: string[];
}

export async function runServerRestart(input: RestartInput, deps: RestartDeps): Promise<RestartOutcome> {
  const { report, tuning, confirmed } = input;

  // Plan problems the report already knows (no model, build cannot read it, …).
  if (/읽지 못|확인 불가|config 에 모델이 없습니다/.test(report.restartPlan) || !report.configuredModel) {
    return { restarted: false, lines: [`재시작하지 않습니다 — ${report.restartPlan}`] };
  }
  const binPath = report.build?.binPath ?? input.configBin;
  if (!binPath) {
    return { restarted: false, lines: ["llama-server 실행 파일을 찾지 못했습니다. /models 로 모델을 다시 선택하세요."] };
  }

  const changes = diffServer(
    report.serverArgs,
    report.configuredBin && report.build && report.configuredBin !== report.build.binPath ? report.configuredBin : undefined,
    { modelPath: report.configuredModel, binPath: report.build?.binPath, tuning: tuning as never }
  );
  const gate = gateServerReplacement({
    owner: report.owner, port: report.port, servers: report.servers, changes, confirmed,
    confirmCommand: "/server restart confirm",
  });
  if (!gate.proceed) return { restarted: false, lines: gate.lines };

  const sw = await deps.switchServer({
    modelPath: report.configuredModel,
    port: report.port,
    binPath,
    tuning,
    retune: async () => ({ lines: await deps.describePlan(tuning) }),
  });
  if (sw.ok && sw.launched) {
    await deps.record({ port: sw.port, binPath: sw.launched.binPath, modelPath: sw.launched.modelPath }).catch(() => false);
  }
  const synced = sw.ok ? await deps.sync(report.configuredModel, { contextSize: tuning.contextSize }) : [];
  return { restarted: sw.ok, lines: [...sw.lines, ...synced] };
}
