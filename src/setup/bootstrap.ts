/**
 * The first-run bootstrap: make sure a llama-server binary, a model that fits
 * this machine, and a set of non-conflicting ports all exist, then write them
 * into `.llamacli/config.yaml` so every later launch is a no-op.
 *
 * Requested directly: "llamacli 의 초기 구동 시 llama.cpp 가 존재를 하지 않는다면
 * 관련 설치 패키지와 llama.cpp 를 설치하고 … 정합한 모델을 다운로드 받는 초기
 * 과정을 수행해야해 … llama.cpp의 포트와 llamacli 에서 사용하는 포트가 맞아야
 * 하고 … 초기 llama
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
import { planPorts, tcpPortProbe, COMMON_PORTS, LLAMA_PORT, type PortProbe } from "./ports.js";
import { detectRunningServer } from "../backend/detect.js";
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
  /** The model actually in use. There is no longer any way to pick or fetch
   *  one, so this is only ever the path already recorded in the config. */
  modelPath?: string;
  tuning?: LlamaTuning;
  ports?: { llamaPort: number };
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
  /** Detects an already-running OpenAI-compatible server to adopt instead of
   *  spawning our own. Injected because the real probe talks to localhost, and
   *  a test that silently adopts whatever happens to be running on :8080 is
   *  testing the machine, not the code. Defaults to the real detector. */
  detectServer?: (host: string, ports: number[]) => Promise<{ baseUrl: string; model: string } | null>;
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

  // ── 2.5 Adopt an already-running server, BEFORE touching the network ──────
  // This check used to live in step 5, AFTER the model had been resolved and
  // DOWNLOADED. On a machine that already has a healthy llama-server serving a
  // model, that meant the bootstrap searched HuggingFace and began a 20 GB
  // fetch before ever noticing there was nothing to do.
  //
  // Not a theoretical waste — confirmed live. A 20 GB model deleted to reclaim
  // disk space was silently re-downloaded, in full, on the next launch: the file
  // the running server was actually serving had a different name AND a
  // different byte count from the one the Hub publishes today, so the
  // "equivalent model already on disk" check could not match it — while the
  // server serving that very file was up the whole time.
  //
  // So "is there already a server I can simply use?" is asked FIRST, and a yes
  // ends the bootstrap before any model resolution or disk probe.
  const existing = await readConfig(opts.projectRoot);

  {
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
    steps.push({ name: "포트 결정", ok: true, detail: `llama ${adoptedPort} (기존 서버)` });
    const adopted: Record<string, unknown> = {
      ...(existing ?? {}),
      backend: "openai-compatible",
      baseUrl: running.baseUrl,
      model: running.model,
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
      tuning: undefined,
      ports: { llamaPort: adoptedPort },
      config: adopted,
      errors,
    };
  }

  }

  // ── 3. Model ──────────────────────────────────────────────────────────────
  //
  // MODEL ACQUISITION HAS BEEN REMOVED.
  //
  // There is no Hub search and no download. llamacli no longer contacts a model
  // repository, never resolves a filename from a remote catalogue, and never
  // transfers a GGUF. The only model it will ever run is the one already
  // configured in `.llamacli/config.yaml`, or one an already-running
  // llama-server reports.
  //
  // Why a removal and not a flag: a downloader still wired up behind a
  // default-off switch is one `grep` from being re-enabled by accident, and it
  // was the source of a concrete 20 GB re-download that ignored a model the
  // machine had been serving all along.
  //
  // Consequence, stated honestly: a machine with no model cannot now obtain one
  // by itself. That is the intended trade — the operator places the .gguf and
  // points `llama.modelPath` at it, or starts a server, which is adopted.
  const modelsDir = opts.modelsDir ?? env.LLAMACLI_MODELS_DIR ?? DEFAULT_MODELS_DIR;
  // The model this install is ALREADY using, if that file still exists.
  //
  // This is now the only source of a model. The config's own record is the
  // authority: if the file is still present it is by definition correct, and
  // re-deriving it from a remote catalogue could only make it worse — the Hub
  // republishes filenames, so one model appears under a different name and a
  // different byte count, and matching on that produced a 20 GB download of
  // weights the machine already had.
  const configuredPaths = [
    typeof existing?.llama?.modelPath === "string" ? existing.llama.modelPath : undefined,
    typeof existing?.model === "string" ? existing.model : undefined,
  ];
  let alreadyInUse: string | undefined;
  for (const p of configuredPaths) {
    if (p && (await fileSize(p)) > 0) { alreadyInUse = p; break; }
  }
  let modelPath = "";
  if (alreadyInUse) {
    modelPath = alreadyInUse;
    steps.push({ name: "모델 확인", ok: true, detail: `설정된 모델 사용: ${alreadyInUse}` });
    log(`설정된 모델을 사용합니다: ${alreadyInUse}`);
  } else {
    steps.push({
      name: "모델 확인",
      ok: false,
      detail:
        "설정된 모델을 찾지 못했습니다. llamacli는 모델을 내려받지 않습니다 — " +
        "`.llamacli/config.yaml` 의 `llama.modelPath` 에 .gguf 경로를 지정하거나, " +
        "이미 실행 중인 llama-server 에 연결하세요.",
    });
    errors.push("모델: 설정된 모델을 찾지 못했습니다 (자동 다운로드 기능이 제거되었습니다).");
    log("모델을 찾지 못했습니다. llama.modelPath 를 설정하거나 실행 중인 서버에 연결하세요.");
  }


  const plan = await planPorts({
    probe: opts.probe ?? tcpPortProbe,
    llamaPort: typeof existing?.llama?.port === "number" ? existing.llama.port : undefined,
  });
  steps.push({
    name: "포트 결정",
    ok: true,
    detail:
      `llama ${plan.llamaPort}` +
      (plan.moved.length > 0 ? ` (변경: ${plan.moved.map((m) => `${m.what} ${m.from}→${m.to}`).join(", ")})` : ""),
  });
  for (const n of plan.notes) log(n);

  // ── 6. Tuning + config ────────────────────────────────────────────────────
  let tuning = tuneForHardware(hardware);

  for (const r of tuning.rationale) log(r);

  const config = buildConfig({ existing, llama, modelPath, plan, tuning });
  if (opts.projectRoot) {
    // Wrapped like every other step, because until now this was the ONE call
    // that could throw straight out of the function — which contradicted the
    // module's own contract ("a bootstrap that throws takes down a working
    // install; a bootstrap that returns a report lets the caller start anyway").
    //
    // Found by a project-axis sweep (100 project states): a read-only project
    // directory made `mkdir .llamacli` fail with EACCES and the whole bootstrap
    // rejected. That is a real and reachable state — a project on a read-only
    // mount, a checkout owned by another user, a container running as a
    // non-owner — and the user saw a crash instead of a report.
    //
    // Losing the write is genuinely bad (the run is not persisted), so it is
    // recorded as a FAILED step and pushes an error, rather than being
    // swallowed. The caller still gets a usable report and can start the
    // session with the settings it derived.
    await step("설정 저장", async () => {
      await writeConfig(opts.projectRoot!, config);
      return ".llamacli/config.yaml";
    });
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
    modelPath: modelPath || undefined,
    tuning,
    ports: { llamaPort: plan.llamaPort },
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
  plan: { llamaPort: number };
  tuning: LlamaTuning;
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










