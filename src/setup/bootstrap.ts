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
import { detectHardware, findOwnLlamaServerPids, ownLlamaServerVramGiB, type Hardware } from "./hardware.js";
import { getCapabilities } from "../tui/terminal.js";
import { tuneForHardware, type LlamaTuning } from "./tuning.js";
import { findLlamaServer, buildLlamaCpp, defaultRun, type LlamaLocation, type Run } from "./llamaCpp.js";
import { planPorts, tcpPortProbe, COMMON_PORTS, LLAMA_PORT, type PortProbe } from "./ports.js";
import { chooseModel, resolveModel, type ModelChoice } from "./modelCatalog.js";
import { downloadFile, formatProgress, type TransferProgress } from "./download.js";
import { selectModelPath, hasRoom, RESERVE_BYTES } from "./disk.js";
import { discoverRunningServer, modelLoadBudgetMs, type Discovery } from "../backend/detect.js";
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
  /** Replaces the download progress reporter, wrapping the default one so the
   *  caller does not have to reimplement it. Defaults to a single rewritten
   *  terminal line (renderProgressLine), which is right when the bootstrap owns
   *  a plain screen and WRONG when it does not: it writes `\r\x1b[2K` to
   *  process.stdout directly, which corrupts an Ink app rendering into the same
   *  terminal. The TUI passes a reporter that goes through its own log instead. */
  onProgress?: (defaultReporter: (p: TransferProgress) => void) => (p: TransferProgress) => void;
  /** Injected so a test can supply a fake machine. */
  hardware?: Hardware;
  /** Detects an already-running OpenAI-compatible server to adopt instead of
   *  spawning our own. Injected because the real probe talks to localhost, and
   *  a test that silently adopts whatever happens to be running on :8080 is
   *  testing the machine, not the code. Defaults to the real detector. */
  detectServer?: (host: string, ports: number[]) => Promise<Discovery>;
  /** Candidate .gguf files already present in the models dir. Injected in
   *  tests; read from disk otherwise. */
  listExistingModels?: (dir: string) => Promise<{ path: string; sizeBytes: number }[]>;
  /** PIDs of llama-server processes belonging to THIS install, whose VRAM is
   *  discounted when sizing the context (see budgetVramGiB). Injected because
   *  attributing a pid to our own server is a question about which binary we
   *  launched, not something the tuner can answer; tests pass an empty list,
   *  which is also correct for a genuine first run. */
  serverPids?: readonly number[];
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
  const { location: found, rejected } = await findLlamaServer({ env, home: env.HOME });
  let llama: LlamaLocation | undefined = found ?? undefined;
  if (!llama) {
    // A binary that exists but cannot run is a different problem from a binary
    // that is not installed, and reporting it as the latter sends the user
    // looking for an install that is sitting right there.
    const rejectedNote =
      rejected.length > 0
        ? ` (찾았지만 실행 불가: ${rejected.join(", ")})`
        : "";
    if (opts.offline || opts.allowBuild === false) {
      steps.push({
        name: "llama.cpp",
        ok: false,
        detail: `설치된 llama-server 를 찾지 못했습니다 (오프라인/빌드 금지 모드).${rejectedNote}`,
      });
    } else {
      if (rejected.length > 0) {
        // Rebuilding will not fix a binary that is present and broken, and the
        // 10-40 minutes it costs is better spent saying why.
        log(`찾은 llama-server 가 실행되지 않습니다: ${rejected.join(", ")}`);
        log("드라이버 또는 런타임 라이브러리 문제일 수 있습니다. 그래도 직접 빌드를 시도합니다.");
      }
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
  //
  // `existing` is the UNTOUCHED config, and that matters more than it looks.
  // An earlier version narrowed it to the user-owned keys on the theory that a
  // re-derivation should discard machine-derived state — but the machine-owned
  // keys are exactly the ones that identify the model this install is ALREADY
  // running, so narrowing them made the "keep the model in use" check below
  // fail every time and sent the bootstrap to the Hub for a model the machine
  // was serving. Read whole, or not at all.
  const existing = await readConfig(opts.projectRoot);

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
  //
  // `discoverRunningServer`, not `detectRunningServer`: a llama-server binds its
  // port before the model finishes loading and answers nothing until the
  // weights are resident. A single fast probe cannot tell that apart from
  // "nothing is running", and answering it wrongly is how this ended up
  // spawning a SECOND llama-server beside a healthy one — which on an 8 GB
  // card is an OOM, not a slowdown. A port that is loading is waited out
  // instead, for as long as a model of the recorded size could plausibly take
  // to load.
  const waitBudget = modelLoadBudgetMs(
    typeof existing?.model === "string" ? await fileSize(existing.model) : 0
  );
  const detect =
    opts.detectServer ??
    ((h: string, p: number[]) =>
      discoverRunningServer(h, p, {
        loadingWaitMs: waitBudget,
        onWait: (port, waited) =>
          log(`${port} 포트 서버가 모델을 불러오는 중입니다 (${Math.round(waited / 1000)}초 경과)…`),
      }));
  const discovery = await detect("127.0.0.1", COMMON_PORTS);

  // ── A port that is held but still loading is NOT ours to take ─────────────
  // The budget ran out while a server was mid-load. Binding a different port
  // here is the exact failure this whole step exists to prevent: the loading
  // server already holds most of the card, and a second one does not fit.
  //
  // So llamacli points at the loading server instead. Its requests will fail
  // until the load finishes, which the agent loop's existing transient-failure
  // retry already handles, and no VRAM is spent on a duplicate.
  if (discovery.kind === "loading") {
    const waitedSec = Math.round(discovery.waitedMs / 1000);
    steps.push({
      name: "기존 서버 연결",
      ok: false,
      detail:
        `${discovery.baseUrl} 에서 서버가 아직 모델을 불러오는 중입니다 (${waitedSec}초 대기). ` +
        `두 번째 서버를 띄우지 않고 이 서버를 사용합니다 — 곧 응답하기 시작합니다.`,
    });
    errors.push(`기존 서버 연결: ${discovery.port} 포트의 서버가 모델 로딩 중입니다 (${waitedSec}초 대기).`);
    log(
      `${discovery.baseUrl} 서버가 아직 모델을 불러오는 중이라 ${waitedSec}초 기다렸습니다. ` +
        `두 번째 서버를 띄우지 않고 이 서버를 사용합니다.`
    );
    steps.push({ name: "포트 결정", ok: true, detail: `llama ${discovery.port} (로딩 중인 기존 서버)` });
    const attached: Record<string, unknown> = {
      ...(existing ?? {}),
      backend: "openai-compatible",
      baseUrl: discovery.baseUrl,
      // The model id is unknown until the server answers, so the recorded one
      // is kept: config.ts re-reads it live on every load anyway.
      ...(typeof existing?.model === "string" ? {} : { model: "local-model" }),
    };
    if (opts.projectRoot) {
      await step("설정 저장", async () => {
        await writeConfig(opts.projectRoot!, attached);
        return ".llamacli/config.yaml (로딩 중인 기존 서버)";
      });
    }
    return {
      ok: false,
      steps,
      hardware,
      llama: llama ?? undefined,
      tuning: undefined,
      ports: { llamaPort: discovery.port },
      config: attached,
      errors,
    };
  }

  if (discovery.kind === "found") {
    const running = discovery.server;
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

  // ── 3. Model ──────────────────────────────────────────────────────────────
  //
  // llamacli searches HuggingFace for a GGUF, picks one that fits this
  // machine's VRAM/RAM, and downloads it — but only after two things that are
  // checked FIRST:
  //
  //   1. an already-running server (above), which ends the bootstrap outright;
  //   2. the model this install is ALREADY using, below.
  //
  const modelsDir = opts.modelsDir ?? env.LLAMACLI_MODELS_DIR ?? DEFAULT_MODELS_DIR;
  let equivalent: string | null = null;
  //
  // (2) exists because the Hub republishes filenames: this box's working model
  // is `Ornith-1.5-35B-A3B-Q4_K_M.gguf` (21,864,081,056 B) while the same
  // quant is published today as `Ornith-1.5-35B-Q4_K_M.gguf` (21,713,463,040)
  // -- different name, different size, same intended model. Resolving from the
  // catalogue first therefore produced a filename matching nothing on disk, and
  // a 20 GB download of weights the machine had been serving all along.
  // Observed twice, ~3h each at this link's speed.
  const configuredPaths = [
    typeof existing?.llama?.modelPath === "string" ? existing.llama.modelPath : undefined,
    typeof existing?.model === "string" ? existing.model : undefined,
  ];
  let alreadyInUse: string | undefined;
  for (const p of configuredPaths) {
    if (p && (await fileSize(p)) > 0) { alreadyInUse = p; break; }
  }
  let model: ModelChoice | undefined;
  let modelPath = "";
  if (alreadyInUse) {
    const size = await fileSize(alreadyInUse);
    modelPath = alreadyInUse;
    model = {
      candidate: { repo: "(기존 설정)", filename: alreadyInUse.split("/").pop()!, sizeBytes: size, url: "" },
      reason: `이미 사용 중인 모델을 유지합니다: ${alreadyInUse}`,
      alternatives: [],
    };
    steps.push({ name: "모델 결정", ok: true, detail: `기존 모델 유지 (다운로드 불필요): ${alreadyInUse}` });
    log(`이미 사용 중인 모델을 유지합니다 — 내려받지 않습니다: ${alreadyInUse}`);
  } else if (!opts.offline) {
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
  // then unrelated things on the machine start failing too. By the time a
  // progress bar is on screen the space is already gone, so this has to be a
  // precondition.
  if (model) {
    const needed = (model.candidate.sizeBytes || 0) + RESERVE_BYTES;
    const target = await selectModelPath({ requestedDir: modelsDir, neededBytes: needed, env });

    if (!hasRoom(target, needed)) {
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
        // The Hub's filename and the filename on disk routinely disagree, so an
        // existing correct model is reused instead of re-downloading 20 GB of
        // the same weights.
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
            onProgress: opts.onProgress ? opts.onProgress(() => renderProgressLine(log)) : renderProgressLine(log),
          });
          return `${result.bytes} 바이트 다운로드 완료 (${result.parallel ? "병렬 range" : "단일 스트림"})`;
        });
        modelPath = dest;
      }
    }
  }

  const plan = await planPorts({
    probe: opts.probe ?? tcpPortProbe,
    llamaPort: typeof existing?.llama?.port === "number" ? existing.llama.port : undefined,
    // The ports discovery already looked at. Passing them keeps the walk-forward
    // from landing on a port where a server was seen doing something — which is
    // how a second llama-server ends up sharing a GPU with the first.
    avoid: COMMON_PORTS,
  });
  steps.push({
    name: "포트 결정",
    ok: true,
    detail:
      `llama ${plan.llamaPort}` +
      (plan.moved.length > 0 ? ` (변경: ${plan.moved.map((m) => `${m.what} ${m.from}→${m.to}`).join(", ")})` : ""),
  });
  for (const n of plan.notes) log(n);

  // ── 5. Tuning + config ────────────────────────────────────────────────────
  // `--n-cpu-moe` is the one flag on this machine that was BENCHMARKED rather
  // than computed, so a value already in the config is passed through instead
  // of being replaced. Every other flag here is derived from hardware on every
  // launch; this one would otherwise be a guess overwriting a measurement, on
  // every single start.
  const configuredCpuMoe = existing?.llama?.cpuMoeLayers;
  const envCpuMoe = Number(env.LLAMACLI_CPU_MOE_LAYERS);
  const measuredCpuMoe =
    Number.isFinite(envCpuMoe) && envCpuMoe > 0
      ? envCpuMoe
      : typeof configuredCpuMoe === "number" && configuredCpuMoe > 0
      ? configuredCpuMoe
      : undefined;
  // Our own llama-server's VRAM is added back to the budget before the context
  // is sized. This matters because the tuner runs on the path that STARTS a
  // server, but the card is not guaranteed empty — a second llamacli, or any
  // other CUDA process, may already be resident, and nvidia-smi's free-VRAM
  // reading cannot tell those apart from our own weights. Without the
  // add-back, memory we ourselves are holding reads as unavailable headroom and
  // collapses the context. See budgetVramGiB's doc comment for the measured
  // case (an 8 GiB card dropping from 16384 to 4096).
  //
  // Best-effort and additive-only: if the pid can't be attributed (no
  // nvidia-smi, no permission, MIG), this is 0 and the plain free-VRAM reading
  // stands, which is the correct conservative default.
  //
  // When the caller doesn't supply pids, we discover our own rather than
  // leaving the credit permanently unused — attribution is restricted to a
  // binary inside THIS install's build dir (see findOwnLlamaServerPids), so
  // this cannot credit a system llama-server or another user's.
  const serverPids =
    opts.serverPids ?? (await findOwnLlamaServerPids(llama ? dirname(llama.binPath) : undefined, run));
  const ownServerVramGiB = await ownLlamaServerVramGiB(serverPids, run);
  const tuning = tuneForHardware(hardware, {
    modelBytes: model?.candidate.sizeBytes,
    cpuMoeLayers: measuredCpuMoe,
    ownServerVramGiB,
  });
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
    model,
    modelPath: modelPath || undefined,
    tuning,
    ports: { llamaPort: plan.llamaPort },
    config,
    errors,
  };
}

/** Top-level config blocks whose feature was removed from llamacli. Kept as
 *  data so the removal is a single list a re-introduction has to delete from,
 *  rather than a `delete` scattered through the merge path. */
export const REMOVED_CONFIG_BLOCKS = ["laya"] as const;

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

  // Config blocks belonging to features that no longer exist are DROPPED, not
  // merged forward. `laya` configured the deleted System-1 gate; carrying the
  // block forward would keep advertising a setting that nothing reads, and a
  // reader debugging a config would reasonably conclude it still did something.
  //
  // This is explicit rather than a general "strip unknown keys" rule: an
  // unknown key is far more likely to be a setting a NEWER llamacli wrote than
  // garbage, and deleting it on every launch would be its own data loss.
  for (const removed of REMOVED_CONFIG_BLOCKS) {
    if (removed in next) delete next[removed];
  }

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

/** The config keys a HUMAN owns, as opposed to the ones the machine derives.
 *
 *  `llama.*`, `model`, `backend` and `baseUrl` are all machine-derived: they
 *  describe what this box is currently running. Everything named here is a
 *  human decision — a key they typed, a verification command they wrote — and
 *  the bootstrap must never be the thing that discards it.
 *
 *  This used to exist to serve `/reset`, which is gone. It is kept because
 *  `buildConfig` merges rather than replaces, and this is the list of what
 *  "merges" is protecting; the persona harness asserts the separation is real
 *  by checking a removed feature's block does not survive a merge. */
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
    if (base === candidate.filename) continue;
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
      continue;
    }
  }
  return out;
}

/** A progress reporter for a long download.
 *
 *  Rewrites ONE terminal line rather than appending, because a 22 GB download
 *  at 4 updates/second would otherwise bury everything above it in thousands of
 *  lines. Falls back to periodic lines when the output is not a TTY, so a
 *  redirected log gets a readable record instead of one overwritten line.
 *
 *  Two things were wrong with the interactive branch, both visible in a real
 *  capture of a first run:
 *
 *  1. `\r[2K` was missing its ESC byte. The erase-line control sequence is
 *     `\x1b[2K`, so what actually reached the terminal was a carriage return
 *     followed by the literal characters `[2K` — visible garbage at the start
 *     of every update. Confirmed by driving this reporter directly: the bytes
 *     written were `"\r[2K[████..."`, and a whole download painted the line with
 *     `[2K` smeared across it.
 *  2. It wrote to `process.stdout` directly instead of going through `log`. That
 *     bypasses the caller's sink entirely, which is exactly why a TUI passing
 *     its own reporter had to wrap this one (see `onProgress`'s doc comment) —
 *     and why the bootstrap's own progress could never be routed anywhere else.
 *     Writing through `log` also means the line is suppressible on a terminal
 *     that cannot interpret escapes, instead of smearing control bytes over
 *     whatever is on screen.
 */
export function renderProgressLine(log: (line: string) => void): (p: TransferProgress) => void {
  const interactive = Boolean(process.stdout.isTTY);
  // Last logged decile. `floor(percent) % 10 === 0` is true for EVERY update
  // while the download is still under 10% done, so a real 20 GB fetch emitted a
  // line about four times a second for its first several minutes and buried
  // everything above it.
  let lastDecile = -1;
  // Carriage return + erase-line + cursor-to-column-1, or nothing at all when
  // the sink cannot take escapes (a non-ANSI terminal would print these
  // literally). Written through `log` so it honours that decision instead of
  // assuming stdout is a capable terminal.
  const canRewrite = interactive && supportsAnsiOutput();
  let first = true;
  return (p) => {
    if (canRewrite) {
      // The leading `\r` on the first update would blank a line of scrollback
      // the user has not read yet; later updates genuinely need it to rewrite
      // in place.
      log(`${first ? "" : "\r\x1b[2K"}${formatProgress(p)}`);
      first = false;
      return;
    }
    const decile = p.percent < 0 ? -1 : Math.floor(p.percent / 10);
    if (decile > lastDecile || p.percent >= 100) {
      lastDecile = decile;
      log(formatProgress(p));
    }
  };
}

/** Whether escape sequences can be written to the process's own stdout.
 *
 *  Deliberately narrower than the full TUI capability report: a redirected
 *  stdout is not a terminal, and a terminal that cannot interpret escapes would
 *  print `\x1b[2K` as text. Reuses the TUI's own verdict so this and the
 *  renderer can never disagree — terminal.ts pulls in chalk and nothing from
 *  React, so importing it here costs no dependency the setup path was avoiding. */
function supportsAnsiOutput(): boolean {
  if (!process.stdout.isTTY) return false;
  return getCapabilities().ansi;
}
