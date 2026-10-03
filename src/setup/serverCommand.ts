/**
 * `/server restart [confirm]` as a function, so the interaction with the single-server
 * policy is testable without the TUI. The TUI only supplies the real dependencies and
 * prints the lines.
 */
import type { ServerReport } from "./serverReport.js";
import { parseLlamaServerArgs, type PortOwner, type ResolvedServerPort, type SwitchOptions, type SwitchResult } from "./modelSwitch.js";
import { diffServer, gateServerReplacement, type ServerGate } from "./serverPolicy.js";

export interface RestartDeps {
  switchServer: (opts: SwitchOptions) => Promise<SwitchResult>;
  /** Persist what is really running afterwards. */
  record: (state: { port: number; binPath: string; modelPath: string; tuning?: Record<string, unknown>; calibratedFor?: string }) => Promise<unknown>;
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
    calibrate: true,
    retune: async () => ({ lines: await deps.describePlan(tuning) }),
  });
  if (sw.ok && sw.launched) {
    await deps.record({
      port: sw.port, binPath: sw.launched.binPath, modelPath: sw.launched.modelPath,
      // The calibrated --n-cpu-moe (if the launch adjusted it) and the key that stops the trial repeating.
      ...(sw.calibration ? { tuning: sw.launched.tuning as Record<string, unknown>, calibratedFor: sw.calibration.calibratedFor } : {}),
    }).catch(() => false);
  }
  const synced = sw.ok ? await deps.sync(report.configuredModel, { contextSize: tuning.contextSize }) : [];
  return { restarted: sw.ok, lines: [...sw.lines, ...synced] };
}

/**
 * The `/models <n> [confirm]` side of the policy: may the switch to `modelPath` replace
 * whatever is serving on `port`? Same gate `/server restart` uses; the selection itself is
 * already recorded by the caller, so a refusal here loses nothing.
 */
export async function gateModelSwitch(
  input: { port: number; modelPath: string; tuning: SwitchOptions["tuning"]; arg: string; confirmed: boolean },
  deps: { resolvePort: (recorded: number) => Promise<ResolvedServerPort>; detectOwner: (port: number) => Promise<PortOwner> }
): Promise<ServerGate> {
  const resolved = await deps.resolvePort(input.port);
  const owner = await deps.detectOwner(resolved.port);
  const live = resolved.servers.find((x) => x.port === resolved.port);
  return gateServerReplacement({
    owner, port: resolved.port, servers: resolved.servers,
    changes: diffServer(live ? parseLlamaServerArgs(live.cmdline) : undefined, undefined, { modelPath: input.modelPath, tuning: input.tuning as never }),
    confirmed: input.confirmed,
    confirmCommand: `/models ${input.arg} confirm`,
  });
}
