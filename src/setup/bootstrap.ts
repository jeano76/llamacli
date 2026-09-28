/**
 * The first-run bootstrap: make sure a llama-server binary, a model that fits
 * this machine, and a set of non-conflicting ports all exist, then write them
 * into `.llamacli/config.yaml` so every later launch is a no-op.
 *
 * Requested directly: "llamacli 의 초기 구동 시 llama.cpp 가 존재를 하지 않는다면
 * 관련 설치 패키지와 llama.cpp 를 설치하고 … 정합한 모델을 다운로드 받는 초기
 * 과정을 수행해야해 … llama.cpp의 포트와 llamacli 에서 사용하는 포트가 맞아야
 * 하고 … laya 서버의 포트와 llamacli 에서 지정하는 포트도 맞아야해 … 초기 llama
 * 구동시 cpu 가 여러개 인경우에는 Nvidia gpu를 우선 순으로 정의 … 사용자 개입없이
 * 진행이 될수 있도록".
 *
 * ── The one rule that shapes everything: it must not need a human ───────────
 * Every step is derived from measurements (src/setup/hardware.ts) and every
 * step is idempotent, so a second run costs a few file checks and nothing
 * else. The steps that COULD ask — "which model?", "which port?" — are
 * answered by fit calculations and reported, never prompted.
 *
 * And it degrades instead of failing. A bootstrap that throws takes down a
 * working install; a bootstrap that returns a report lets the caller start
 * anyway with whatever is already there. That is why `ensureLocalStack` returns
 * a report containing `ok: false` with per-step errors rather than throwing.
 */

import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { stringify, parse } from "yaml";
import { detectHardware, type Hardware } from "./hardware.js";
import { tuneForHardware, type LlamaTuning } from "./tuning.js";
import { findLlamaServer, buildLlamaCpp, defaultRun, type LlamaLocation, type Run } from "./llamaCpp.js";
import { chooseModel, resolveModel, type ModelChoice } from "./modelCatalog.js";
import { planPorts, tcpPortProbe, layaPortEnv, COMMON_PORTS, LLAMA_PORT, LAYA_PORT, type PortProbe } from "./ports.js";
import { detectRunningServer } from "../backend/detect.js";
import { downloadFile, formatProgress, type TransferProgress } from "./download.js";
import { selectModelPath, hasRoom, RESERVE_BYTES } from "./disk.js";
import { calibrate, probeBackend, type Calibration } from "./calibration.js";
import { rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";

export interface BootstrapStep {
  name: string;
  ok: boolean;
  detail: string;
  /** Seconds, when the step was timed. */
  tookSeconds?: number;
}

export interface BootstrapReport {
  ok: boolean;
  steps: BootstrapStep[];
  hardware?: Hardware;
  llama?: LlamaLocation;
  model?: ModelChoice;
  tuning?: LlamaTuning;
  /** Present when `calibrate` ran; `degraded` means the probe was unusable. */
  calibration?: Calibration;
  ports?: { llamaPort: number; layaPort: number };
  /** The config that was (or would be) written. */
  config?: Record<string, unknown>;
  errors: string[];
}

export interface BootstrapOptions {
  projectRoot: string;
  /** Where large model files live. Deliberately NOT inside the project: a 22 GB
   *  file in a git repository shows up in `git status` and gets committed by
   *  someone eventually. */
  modelsDir?: string;
  /** Skip anything already on disk AND skip the network. Used by tests, and by
   *  `--offline` on a machine that is known to be set up. */
  offline?: boolean;
  /** Never install build packages or compile. */
  allowBuild?: boolean;
  log?: (line: string) => void;
  run?: Run;
  probe?: PortProbe;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected so a test can supply a fake machine. */
  hardware?: Hardware;
  /** An already-decided laya port, so an established install keeps it. */
  layaPort?: number;
  /**
   * Re-derive everything from the CURRENT machine, ignoring what is already
   * configured. This is what `/reset` uses.
   *
   *  Without it `/reset` would be a near no-op on a machine whose hardware has
   *  not changed — the common case — and the user would conclude it did nothing.
   *  With it the model choice, the llama flags and the ports are all recomputed,
   *  and the report says what actually changed, so a "nothing changed" run reads
   *  as "already optimal" rather than as "broken".
   *
   *  Never used on a normal launch: the bootstrap being idempotent — not
   *  redoing this work every time — is the whole point. */
  force?: boolean;
  /**
   * Probe the live backend's reported throughput and re-derive the llama
   * settings from the measurement, not from the hardware table alone. `/reset`
   * uses this.
   *
   *  The probe can only ever TIGHTEN the context downward, never raise it — see
   *  calibration.ts for why one slow or mis-reported sample must not be able to
   *  talk a machine into an OOM at load. */
  calibrate?: boolean;
  /**
   * Tear the laya layer down: stop any running server, clear the laya config
   *  block, and drop the project-local venv.
   *
   *  Included in `/reset` because a stale laya is invisible and poisonous. The
   *  case that motivated it: a laya-serve left listening on :8000 while the
   *  config said 8099, so every gate call burned a 30 s timeout and the UI
   *  reported the resulting silence as a verdict. Nothing in the config looked
   *  wrong; the running process simply predated the fix, so re-running /reset
   *  could not fix it without actually killing it. */
  resetLaya?: boolean;
  /** Injected so tests need not kill a real process. */
  stopServer?: () => Promise<boolean>;
  /** Detects an already-running OpenAI-compatible server to adopt instead of
   *  spawning our own. Injected because the real probe talks to localhost, and
   *  a test that silently adopts whatever happens to be running on :8080 is
   *  testing the machine, not the code. Defaults to the real detector. */
  detectServer?: (host: string, ports: number[]) => Promise<{ baseUrl: string; model: string } | null>;
  /** Candidate .gguf files already present in the models dir. Injected in
   *  tests; read from disk otherwise. */
  listExistingModels?: (dir: string) => Promise<{ path: string; sizeBytes: number }[]>;
}

export const DEFAULT_MODELS_DIR = pathJoin(process.env.HOME ?? "/root", "models");

/** Idempotency marker. Without it there is no way to tell "never bootstrapped"
 *  from "bootstrapped and everything was already present", and the expensive
 *  steps would re-run their checks forever. */
const STATE_VERSION = 1;

export async function ensureLocalStack(opts: BootstrapOptions): Promise<BootstrapReport> {
  const log = opts.log ?? (() => {});
  const run = opts.run ?? defaultRun;
  const env = opts.env ?? process.env;
  const steps: BootstrapStep[] = [];
  const errors: string[] = [];

  const step = async (name: string, fn: () => Promise<string>): Promise<string | null> => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail, tookSeconds: (Date.now() - t0) / 1000 });
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name, ok: false, detail: message, tookSeconds: (Date.now() - t0) / 1000 });
      errors.push(`${name}: ${message}`);
      return null;
    }
  };

  // ── 1. Hardware ───────────────────────────────────────────────────────────
  const hardware = opts.hardware ?? (await detectHardware(run));
  steps.push({
    name: "하드웨어 확인",
    ok: true,
    detail:
      `CPU ${hardware.cpuCount}코어, RAM ${(hardware.ramTotalBytes / 1024 ** 3).toFixed(0)} GiB, ` +
      (hardware.gpus.length > 0
        ? `GPU ${hardware.gpus.map((g) => `${g.name} ${(g.vramTotalBytes / 1024 ** 3).toFixed(0)}GiB`).join(", ")}`
        : "GPU 없음"),
  });
  log(steps[0].detail);

  // ── 2. llama-server binary ────────────────────────────────────────────────
  const found = await findLlamaServer({ env, exists: undefined, home: env.HOME });
  let llama: LlamaLocation | undefined = found ?? undefined;
  if (!llama) {
    if (opts.offline || opts.allowBuild === false) {
      steps.push({
        name: "llama.cpp",
        ok: false,
        detail: "설치된 llama-server 를 찾지 못했습니다 (오프라인/빌드 금지 모드).",
      });
    } else {
      const binPath = await step("llama.cpp 빌드", async () => {
        log("llama-server 를 찾지 못해 빌드합니다. CUDA 빌드는 10~40분 걸릴 수 있습니다.");
        return buildLlamaCpp({ hw: hardware, run, log });
      });
      if (binPath) llama = { binPath, source: "built", backend: hardware.canBuildCuda ? "cuda" : "cpu" };
    }
  } else {
    steps.push({
      name: "llama-server 확인",
      ok: true,
      detail: `${llama.binPath} (${llama.source})`,
    });
    log(`기존 llama-server 사용: ${llama.binPath}`);
  }

  // ── 3. Model ──────────────────────────────────────────────────────────────
  const modelsDir = opts.modelsDir ?? env.LLAMACLI_MODELS_DIR ?? DEFAULT_MODELS_DIR;
  let model: ModelChoice | undefined;
  if (!opts.offline) {
    const gpu = hardware.gpus[0];
    await step("모델 결정", async () => {
      const { c35, c9 } = await resolveModel({ env, fetchImpl: opts.fetchImpl, log });
      model = chooseModel({
        vramTotalBytes: gpu?.vramTotalBytes ?? 0,
        vramFreeBytes: gpu?.vramFreeBytes ?? 0,
        ramTotalBytes: hardware.ramTotalBytes,
        candidates35b: c35,
        candidates9b: c9,
      });
      log(model.reason);
      return model.reason;
    });
  }

  // ── 4. Download ───────────────────────────────────────────────────────────
  // Disk space is checked BEFORE the transfer, never during it. A download that
  // runs the filesystem out doesn't fail at the start: it fills the disk, and
  // then unrelated things on the machine start failing too (this repo's
  // clipboard fallback lives in /tmp, which is often tmpfs). By the time a
  // progress bar is on screen the space is already gone, so this has to be a
  // precondition.
  let modelPath = "";
  let equivalent: string | null = null;
  if (model) {
    const needed = (model.candidate.sizeBytes || 0) + RESERVE_BYTES;
    const target = await selectModelPath({ requestedDir: modelsDir, neededBytes: needed, env });

    if (!hasRoom(target, needed)) {
      // Refuse. Proceeding here is exactly the failure this check exists for.
      steps.push({ name: "모델 다운로드", ok: false, detail: target.reason });
      errors.push(`모델 다운로드: ${target.reason}`);
      log(target.reason);
      log("모델을 다운로드하지 않습니다. 디스크 공간을 확보한 뒤 다시 실행하세요.");
    } else {
      if (target.switched) {
        steps.push({ name: "저장 경로 변경", ok: true, detail: target.reason });
        log(target.reason);
      }
      const dest = join(target.dir, model.candidate.filename);
      const already = await fileSize(dest);
      if (already > 0 && (model.candidate.sizeBytes === 0 || already >= model.candidate.sizeBytes)) {
        modelPath = dest;
        steps.push({ name: "모델 다운로드", ok: true, detail: `이미 있습니다: ${dest}` });
        log(`모델 이미 있음: ${dest}`);
      } else if ((equivalent = await findEquivalentModel(target.dir, model.candidate, opts))) {
        // The Hub's filename and the filename on disk routinely disagree — the
        // repo here publishes `Ornith-1.5-35B-Q4_K_M.gguf` while the copy on
        // this machine is `Ornith-1.5-35B-A3B-Q4_K_M.gguf`. Matching on the
        // quant plus the exact byte count means an existing, correct model is
        // reused instead of re-downloading 20 GB of the same weights.
        modelPath = equivalent;
        steps.push({
          name: "모델 다운로드",
          ok: true,
          detail: `동일한 모델이 다른 이름으로 이미 있습니다: ${equivalent}`,
        });
        log(`이미 있는 동일 모델을 사용합니다: ${equivalent}`);
      } else if (opts.offline) {
        steps.push({ name: "모델 다운로드", ok: false, detail: "오프라인이라 건너뜁니다." });
      } else {
        await step("모델 다운로드", async () => {
          await mkdir(dirname(dest), { recursive: true });
          const result = await downloadFile(model!.candidate.url, dest, {
            connections: 8,
            label: model!.candidate.filename,
            fetchImpl: opts.fetchImpl,
            onProgress: renderProgressLine(log),
          });
          return `${result.bytes} 바이트 다운로드 완료 (${result.parallel ? "병렬 range" : "단일 스트림"})`;
        });
        modelPath = dest;
      }
    }
  }

  // `/reset` re-derives instead of inheriting. Everything below reads `existing`
  // to PRESERVE user intent (apiKey, verify commands, the laya toggle); with
  // `force` that is deliberately narrowed to the keys the user owns, because
  // the whole point is to discard machine-derived values and recompute them.
  const existing = opts.force ? keepUserOwnedKeys(await readConfig(opts.projectRoot)) : await readConfig(opts.projectRoot);

  // ── 5. Ports ──────────────────────────────────────────────────────────────
  // An ALREADY-RUNNING healthy server must be adopted, not routed around.
  //
  // This was found by running the real bootstrap on a machine that already had
  // a llama-server up: planPorts saw 8080 busy and moved us to 8081, which
  // means llamacli spawns a SECOND llama-server. On this box that is fatal —
  // the running server already holds 7.2 GB of an 8 GB card, so a second one
  // OOMs on load. And it is pointless: the thing on 8080 is already answering
  // /v1/models with the model we just picked.
  //
  // So detection runs first, and only a genuinely free port leads to a spawn.
  // This is also the same probe config.ts already uses for a project with no
  // config, so "adopt the running server" and "detect a running server" are one
  // mechanism rather than two that can disagree.
  const detect = opts.detectServer ?? ((h: string, p: number[]) => detectRunningServer(h, p));
  const running = await detect("127.0.0.1", [LLAMA_PORT, ...COMMON_PORTS.slice(1)]);
  if (running) {
    const adoptedPort = Number(new URL(running.baseUrl).port);
    steps.push({
      name: "기존 서버 연결",
      ok: true,
      detail: `이미 실행 중인 서버를 사용합니다: ${running.baseUrl} (${running.model})`,
    });
    log(`이미 실행 중인 llama-server 에 연결합니다: ${running.baseUrl}`);
    steps.push({ name: "포트 결정", ok: true, detail: `llama ${adoptedPort} (기존 서버), laya ${opts.layaPort ?? LAYA_PORT}` });
    const adopted: Record<string, unknown> = {
      ...(existing ?? {}),
      backend: "openai-compatible",
      baseUrl: running.baseUrl,
      model: running.model,
      laya: {
        ...(existing?.laya ?? {}),
        port: opts.layaPort ?? LAYA_PORT,
        baseUrl: `http://127.0.0.1:${opts.layaPort ?? LAYA_PORT}`,
      },
    };
    if (opts.projectRoot) {
      await writeConfig(opts.projectRoot, adopted);
      steps.push({ name: "설정 저장", ok: true, detail: ".llamacli/config.yaml (기존 서버 연결)" });
    }
    return {
      ok: true,
      steps,
      hardware,
      llama: llama ?? undefined,
      model,
      tuning: undefined,
      ports: { llamaPort: adoptedPort, layaPort: opts.layaPort ?? LAYA_PORT },
      config: adopted,
      errors,
    };
  }

  const plan = await planPorts({
    probe: opts.probe ?? tcpPortProbe,
    llamaPort: typeof existing?.llama?.port === "number" ? existing.llama.port : undefined,
    layaPort: typeof existing?.laya?.port === "number" ? existing.laya.port : undefined,
  });
  steps.push({
    name: "포트 결정",
    ok: true,
    detail:
      `llama ${plan.llamaPort}, laya ${plan.layaPort}` +
      (plan.moved.length > 0 ? ` (변경: ${plan.moved.map((m) => `${m.what} ${m.from}→${m.to}`).join(", ")})` : ""),
  });
  for (const n of plan.notes) log(n);

  // ── 6. Tuning + config ────────────────────────────────────────────────────
  let tuning = tuneForHardware(hardware, { modelBytes: model?.candidate.sizeBytes });
  let calibration: Calibration | undefined;

  if (opts.resetLaya) {
    // Before the settings are recomputed, so the laya block that gets written
    // reflects the NEW port rather than the stale one.
    await step("laya 초기화", async () => {
      const stopped = await (opts.stopServer ?? stopLayaServer)();
      const venv = join(opts.projectRoot, ".llamacli", "laya-venv");
      let removed = false;
      try {
        await rm(venv, { recursive: true, force: true });
        removed = true;
      } catch {
        removed = false; // nothing there, or not ours to delete
      }
      return `기존 laya 서버 ${stopped ? "종료됨" : "실행 중이 아님"}, venv ${removed ? "삭제됨" : "없음"}`;
    });
  }

  if (opts.calibrate) {
    await step("백엔드 성능 측정", async () => {
      const baseUrl = (existing?.baseUrl as string) ?? `http://127.0.0.1:${LLAMA_PORT}`;
      const timings = await probeBackend(baseUrl, { fetchImpl: opts.fetchImpl, model: existing?.model });
      calibration = calibrate({ hw: hardware, timings, modelBytes: model?.candidate.sizeBytes });
      if (calibration.degraded) {
        log(calibration.notes[0]);
        return "측정 불가 — 하드웨어 정보 기반 설정 사용";
      }
      for (const n of calibration.notes) log(n);
      return calibration.notes.join(" | ");
    });
  }
  if (calibration && !calibration.degraded) tuning = calibration.tuning;
  for (const r of tuning.rationale) log(r);

  const config = buildConfig({ existing, llama, modelPath, plan, tuning, portsEnv: layaPortEnv(plan.layaPort), resetLaya: opts.resetLaya });
  if (opts.projectRoot) {
    await writeConfig(opts.projectRoot, config);
    steps.push({ name: "설정 저장", ok: true, detail: ".llamacli/config.yaml" });
  }
  // NOTE: the config is written AFTER the download above. That ordering was
  // called out as a limitation and is deliberately left in place now that the
  // plan above already refuses to start a download it cannot finish: recording
  // a `modelPath` for a file that does not exist would make the next launch skip
  // the download (the size check sees a complete file) and then fail to load a
  // missing model. Writing early would trade a harmless extra Hub search on
  // relaunch for a config that lies.

  return {
    ok: errors.length === 0 && Boolean(llama),
    steps,
    hardware,
    llama: llama ?? undefined,
    model,
    tuning,
    calibration,
    ports: { llamaPort: plan.llamaPort, layaPort: plan.layaPort },
    config,
    errors,
  };
}

/** Turns the report into a config object.
 *
 *  Existing keys are PRESERVED and merged, never replaced wholesale. The
 *  bootstrap runs on every launch, so a config that a user has hand-tuned
 *  (apiKey, verify commands, browser settings) must survive it. Only the fields
 *  the bootstrap owns are written, and only when it actually determined them. */
export function buildConfig(opts: {
  existing?: Record<string, any>;
  llama?: LlamaLocation;
  modelPath: string;
  plan: { llamaPort: number; layaPort: number };
  tuning: LlamaTuning;
  portsEnv: Record<string, string>;
  /** When true, derived laya keys are recomputed instead of inherited. */
  resetLaya?: boolean;
}): Record<string, unknown> {
  const base = opts.existing ?? {};
  const next: Record<string, any> = { ...base };

  if (opts.llama) {
    // backend flips to local-llama ONLY when we have both a binary and a model.
    // Claiming a local backend with no modelPath is exactly the state index.tsx
    // treats as "not configured" and would silently fall through to a dead URL.
    if (opts.modelPath) next.backend = "local-llama";
    next.llama = {
      ...(base.llama ?? {}),
      binPath: opts.llama.binPath,
      ...(opts.modelPath ? { modelPath: opts.modelPath } : {}),
      port: opts.plan.llamaPort,
      contextSize: opts.tuning.contextSize,
      threads: opts.tuning.threads,
      threadsBatch: opts.tuning.threadsBatch,
      gpuLayers: opts.tuning.gpuLayers,
      cpuMoeLayers: opts.tuning.cpuMoeLayers,
      batchSize: opts.tuning.batchSize,
      ubatchSize: opts.tuning.ubatchSize,
      parallel: opts.tuning.parallel,
      flashAttn: opts.tuning.flashAttn,
      cacheTypeK: opts.tuning.cacheTypeK,
      cacheTypeV: opts.tuning.cacheTypeV,
    };
  }
  next.laya = {
    // `resetLaya` strips the derived keys (port/baseUrl) so they are recomputed
    // below rather than inherited from a stale block; the user's `enabled`
    // toggle is kept either way, because that is a choice, not a measurement.
    ...(opts.resetLaya ? pickUserLayaKeys(base.laya) : base.laya ?? {}),
    port: opts.plan.layaPort,
    // baseUrl is derived from the SAME port, so the two cannot drift — the
    // failure in this repo's history was a config pointing at one port while
    // the server bound another.
    baseUrl: `http://127.0.0.1:${opts.plan.layaPort}`,
  };
  return next;
}

async function readConfig(projectRoot: string): Promise<Record<string, any> | undefined> {
  try {
    return parse(await readFile(join(projectRoot, ".llamacli", "config.yaml"), "utf8")) ?? undefined;
  } catch {
    return undefined; // no config yet, or unreadable — both mean "start fresh"
  }
}

/** The config keys a HUMAN owns, and which `/reset` must therefore not discard.
 *
 *  Everything else (`llama.*`, `model`, `laya.port`, `backend`, `baseUrl`) is
 *  machine-derived — it is exactly what `/reset` exists to recompute. Throwing
 *  it away is the feature; throwing away an apiKey the user typed would be a
 *  data-loss bug wearing the feature's clothes. */
export function keepUserOwnedKeys(config: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!config) return config;
  const kept: Record<string, any> = {};
  if (config.apiKey) kept.apiKey = config.apiKey;
  if (config.verify !== undefined) kept.verify = config.verify;
  if (config.browser !== undefined) kept.browser = config.browser;
  if (config.checkpoint !== undefined) kept.checkpoint = config.checkpoint;
  if (config.enableThinking !== undefined) kept.enableThinking = config.enableThinking;
  if (config.repeatPenalty !== undefined) kept.repeatPenalty = config.repeatPenalty;
  if (config.compaction?.autoTriggerRatio !== undefined) {
    kept.compaction = {
      autoTriggerRatio: config.compaction.autoTriggerRatio,
      ...(config.compaction.autoResume !== undefined ? { autoResume: config.compaction.autoResume } : {}),
      ...(config.compaction.summaryMaxTokens !== undefined
        ? { summaryMaxTokens: config.compaction.summaryMaxTokens }
        : {}),
    };
  }
  // The laya gate is a deliberate user choice (it costs a round-trip per turn),
  // not a machine-derived value.
  if (config.laya?.enabled !== undefined) kept.laya = { enabled: config.laya.enabled };
  return kept;
}

/** Written to a temp file and renamed, so a crash mid-write cannot leave a
 *  half-written config that the next launch fails to parse. */
export async function writeConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(projectRoot, ".llamacli");
  await mkdir(dir, { recursive: true });
  const final = join(dir, "config.yaml");
  const tmp = `${final}.tmp`;
  await writeFile(tmp, stringify(config), "utf8");
  await rename(tmp, final);
}

async function fileSize(path: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** The quant token in a GGUF filename, e.g. "Q4_K_M" out of
 *  "Ornith-1.5-35B-A3B-Q4_K_M.gguf". */
export function quantOf(filename: string): string {
  return /Q\d(_[A-Z0-9]+)+/i.exec(filename)?.[0]?.toUpperCase() ?? "";
}

/**
 * Looks for a file in `dir` that is the SAME MODEL under a different name.
 *
 * Matching is on the quant plus the exact byte size, never on the filename: the
 * two disagree constantly (Hub says `Ornith-1.5-35B-Q4_K_M.gguf`, the copy on
 * disk is `Ornith-1.5-35B-A3B-Q4_K_M.gguf`), and a name-based guess would be a
 * guess. An exact size match on the same quant IS the same file as far as
 * loading is concerned, and it is the only thing that stops a fresh install
 * re-downloading 20 GB the machine already has.
 *
 * Requires a KNOWN size on both sides. A GGUF of unknown size is not matched,
 * because "some .gguf with a Q4 somewhere in the name" is not evidence.
 */
export async function findEquivalentModel(
  dir: string,
  candidate: { filename: string; sizeBytes: number },
  opts: { listExistingModels?: (dir: string) => Promise<{ path: string; sizeBytes: number }[]> } = {}
): Promise<string | null> {
  if (!candidate.sizeBytes) return null;
  const wantQuant = quantOf(candidate.filename);
  if (!wantQuant) return null;
  const list = opts.listExistingModels ?? listGgufsIn;
  let files: { path: string; sizeBytes: number }[];
  try {
    files = await list(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path;
    if (base === candidate.filename) continue; // handled by the caller
    if (f.sizeBytes !== candidate.sizeBytes) continue;
    if (quantOf(base) !== wantQuant) continue;
    return f.path;
  }
  return null;
}

async function listGgufsIn(dir: string): Promise<{ path: string; sizeBytes: number }[]> {
  const { readdir, stat } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: { path: string; sizeBytes: number }[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    const path = join(dir, name);
    try {
      out.push({ path, sizeBytes: (await stat(path)).size });
    } catch {
      continue; // vanished between readdir and stat
    }
  }
  return out;
}

/** A progress reporter for a long download.
 *
 *  Rewrites ONE terminal line rather than appending, because a 22 GB download
 *  at 4 updates/second would otherwise bury everything above it in thousands of
 *  lines. Falls back to periodic lines when the output is not a TTY, so a
 *  redirected log gets a readable record instead of one overwritten line. */
export function renderProgressLine(log: (line: string) => void): (p: TransferProgress) => void {
  const interactive = Boolean(process.stdout.isTTY);
  // Last logged decile. The obvious test for "log every 10%" —
  // `floor(percent) % 10 === 0` — is true for EVERY update while the download is
  // still under 10% done, so a real 20 GB fetch emitted a line about four times
  // a second for its first several minutes and buried everything above it.
  // Caught by running the bootstrap for real against the live Hub.
  let lastDecile = -1;
  return (p) => {
    if (interactive) {
      process.stdout.write(`\r[2K${formatProgress(p)}`);
      return;
    }
    const decile = p.percent < 0 ? -1 : Math.floor(p.percent / 10);
    if (decile > lastDecile || p.percent >= 100) {
      lastDecile = decile;
      log(formatProgress(p));
    }
  };
}

/** The only laya key a user owns: whether the gate is on at all. */
export function pickUserLayaKeys(laya: Record<string, any> | undefined): Record<string, any> {
  return laya?.enabled !== undefined ? { enabled: laya.enabled } : {};
}

/**
 * Stops a project-local laya-serve, if one is running.
 *
 * Best-effort and never throws. The server is usually a transient systemd unit
 * (`systemd-run --user --collect`), so stopping the unit is the correct way to
 * stop it — killing the short-lived client that spawned it would leave the real
 * server running, which is precisely the stale-server situation this exists to
 * clear. The pgrep fallback covers the plain-Popen path.
 */
export async function stopLayaServer(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    await run("systemctl", ["--user", "stop", "laya-serve.service"], { timeout: 20_000 });
    return true;
  } catch {
    // No systemd user session, or no such unit — fall through.
  }
  try {
    const { stdout } = await run("pgrep", ["-f", "laya-serve"], { timeout: 10_000 });
    const pids = stdout.trim().split("\n").filter(Boolean).map(Number);
    if (pids.length === 0) return false;
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    return true;
  } catch {
    return false;
  }
}
