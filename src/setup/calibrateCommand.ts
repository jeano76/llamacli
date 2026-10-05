/**
 * `/server calibrate [confirm]` — 실측 재계산의 실행 부분.
 *
 * planCalibration() (calibrateTuning.ts, 순수)이 "무엇으로 바꿀지"를 정하면,
 * 여기가 "재서 → 보여주고 → 확인받으면 적용하고 → 실패하면 되돌린다"를 한다.
 * TUI는 줄만 받아서 찍는다 — 판정과 실행은 여기서 테스트된다.
 */

import { cpus, platform } from "node:os";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectHardware, findOwnLlamaServerPids, ownLlamaServerVramGiB } from "./hardware.js";
import { readGgufKvShape, isMoeModel } from "./ggufMeta.js";
import { planCalibration, type CalibrationReading } from "./calibrateTuning.js";
import type { ParsedServerArgs } from "./modelSwitch.js";
import type { ServerReport } from "./serverReport.js";
import type { RestartOutcome } from "./serverCommand.js";
import type { SwitchOptions } from "./modelSwitch.js";

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;

export interface CalibrateMeasureInject {
  readGpu?: () => Promise<{ freeMiB?: number; totalMiB?: number; name?: string } | undefined>;
  readOwnVramMiB?: () => Promise<number>;
  statModel?: (path: string) => Promise<number>;
}

async function defaultReadGpu(): Promise<{ freeMiB?: number; totalMiB?: number; name?: string } | undefined> {
  try {
    const hw = await detectHardware();
    const g = hw.gpus[0];
    if (!g) return undefined;
    return { freeMiB: g.vramFreeBytes / MiB, totalMiB: g.vramTotalBytes / MiB, name: g.name };
  } catch {
    return undefined;
  }
}

/**
 * 지금 떠 있는 서버 + 카드 + 모델 헤더를 읽어 planCalibration()의 입력으로
 * 만든다. 읽지 못한 것은 undefined로 둔다 — 0으로 메우면 튜너가 없는 것을
 * 있는 것처럼 계산한다 (planCalibration이 unmeasured로 보고한다).
 */
export async function measureCalibration(
  running: ParsedServerArgs,
  inject: CalibrateMeasureInject & { llamaDir?: string } = {}
): Promise<CalibrationReading> {
  const gpu = inject.readGpu ? await inject.readGpu().catch(() => undefined) : await defaultReadGpu();
  const ownVramMiB = inject.readOwnVramMiB
    ? await inject.readOwnVramMiB().catch(() => 0)
    : await (async () => {
        try {
          const pids = await findOwnLlamaServerPids(inject.llamaDir);
          return (await ownLlamaServerVramGiB(pids)) * 1024;
        } catch {
          return 0;
        }
      })();
  const modelPath = running.modelPath ?? "";
  const statModel = inject.statModel ?? (async (p: string) => (await stat(p)).size);
  const modelBytes = modelPath ? await statModel(modelPath).catch(() => 0) : 0;
  const kv = modelPath ? await readGgufKvShape(modelPath).catch(() => undefined) : undefined;
  const moe = modelPath ? await isMoeModel({ path: modelPath }).catch(() => undefined) : undefined;
  return {
    freeMiB: gpu?.freeMiB,
    totalMiB: gpu?.totalMiB,
    ownVramMiB,
    gpuName: gpu?.name,
    modelBytes,
    layers: kv?.layers,
    kvElementsPerToken: kv?.elementsPerToken,
    trainedContext: kv?.contextLength,
    moe,
    unifiedMemory: platform() === "darwin",
    cpuCount: cpus().length,
  };
}

export interface CalibrateDeps {
  rereport: () => Promise<ServerReport>;
  restart: (report: ServerReport, tuning: SwitchOptions["tuning"]) => Promise<RestartOutcome>;
}

export interface CalibrateResult {
  lines: string[];
  applied: boolean;
}

/**
 * 측정 → 계획 → (미리보기 | 확인 후 적용 + 실패 시 복구).
 * 복구는 "이전에 동작하던 값으로 다시 띄우기"다 — 새 값으로 뜨지 못한 서버를
 * 그대로 두는 것보다, 예전 설정으로 응답하는 서버가 낫다.
 */
export async function runCalibration(
  input: {
    report: ServerReport;
    running: ParsedServerArgs;
    measured: CalibrationReading;
    previousTuning: SwitchOptions["tuning"];
    confirmed: boolean;
  },
  deps: CalibrateDeps
): Promise<CalibrateResult> {
  const plan = planCalibration(input.running, input.measured);
  const head = (l: string) => `[calibrate] ${l}`;
  if (!plan.changed) {
    return {
      applied: false,
      lines: [
        head("바꿀 것이 없습니다."),
        ...plan.notes.map((n) => `  · ${n}`),
        ...plan.unmeasured.map((u) => `  · 측정 못 함: ${u}`),
      ],
    };
  }
  const lines = [
    head("다음을 다시 잡을 수 있습니다 (계산값이 아니라 실제 카드·모델에서 잰 값):"),
    ...plan.changes.map((c) => `  · ${c.label}: ${String(c.from)} → ${String(c.to)}`),
    ...plan.notes.map((n) => `  · ${n}`),
    ...plan.unmeasured.map((u) => `  · 측정 못 함(건드리지 않음): ${u}`),
  ];
  if (!input.confirmed) {
    lines.push("  · 적용하려면  /server calibrate confirm");
    return { applied: false, lines };
  }
  const out = await deps.restart(input.report, plan.tuning as SwitchOptions["tuning"]);
  lines.push(...out.lines.map((l) => `  · ${l}`));
  if (out.restarted) return { applied: true, lines };
  // 뜨지 않았다 — 이전에 동작하던 값으로 되돌린다. config 기록은 restart
  // 경로(recordServerState)가 성공한 뒤에만 바뀌므로, 되돌리기는 서버만 다시
  // 띄우면 된다.
  lines.push(head("새 설정으로 뜨지 않아 직전 설정으로 되돌립니다."));
  const fresh = await deps.rereport().catch(() => input.report);
  const back = await deps.restart(fresh, input.previousTuning);
  lines.push(...back.lines.map((l) => `  · ${l}`));
  lines.push(head(back.restarted ? "되돌렸습니다 — 서버는 예전 설정으로 응답합니다." : "되돌리기에도 실패했습니다 — /server 로 상태를 확인하십시오."));
  return { applied: false, lines };
}
