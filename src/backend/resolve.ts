import { stat } from "node:fs/promises";
import { formatBytes, type TransferProgress } from "../setup/download.js";
import { LlamaServerManager, type LlamaServerConfig } from "./llamaServer.js";
import { OpenAICompatibleClient } from "./openaiClient.js";
import { discoverRunningServer, type Discovery } from "./detect.js";
import { probeBackendHealth, describeUnhealthyBackend, type BackendHealth } from "./healthCheck.js";
import type { LlamacliConfig } from "../config.js";
import {
  ensureLocalStack,
  writeConfig,
  DEFAULT_MODELS_DIR,
  type BootstrapOptions,
  type BootstrapReport,
} from "../setup/bootstrap.js";

/**
 * Turns a project directory into a working model backend, in three cases, and
 * says which one it took.
 *
 * ── The three cases, and why they are ordered this way ──────────────────────
 *   1. llama.cpp is installed AND a server is already answering → use that
 *      server's own endpoint and port. Nothing is installed, nothing is
 *      spawned, nothing is downloaded.
 *   2. llama.cpp is installed but nothing is running → start a server on a port
 *      that is actually free, with the model already recorded in the config.
 *   3. llama.cpp is not installed → install it, derive a model that fits this
 *      machine, download it, write the config, then start it.
 *
 * The order is the whole design: case 1 is checked FIRST, before any network
 * access, because a machine already serving a model must never start resolving
 * one. Two llama-servers on one GPU is an out-of-memory at load, not a
 * slowdown — and this decision is the only thing standing between a healthy
 * session and that.
 *
 * Case 2 is checked before case 3 for the same reason in miniature: an existing
 * install with a recorded model has nothing to download, so it must not fall
 * through to the Hub. Measured once already: a 21.8 GB model deleted to reclaim
 * disk was silently re-downloaded in full on the next launch, because the Hub
 * now publishes the same quant under a different name and byte count, so the
 * "already on disk" match missed — while the server serving that very file was
 * up the whole time.
 */

export type Resolution =
  /** Case 1 — an already-running server was adopted. Nothing was spawned, so
   *  there is nothing to stop on exit. */
  | { kind: "adopted"; backend: OpenAICompatibleClient; baseUrl: string; model: string; port: number }
  /** Cases 2 and 3 — llamacli owns the process and must stop it on exit. */
  | { kind: "spawned"; backend: OpenAICompatibleClient; stop: () => void; port: number; modelPath: string }
  /** Resolution finished but the backend is degraded or unusable.
   *
   *  `usable` is what separates the two very different situations this one state
   *  used to conflate:
   *
   *   - true  — a real server answered; it just answers badly (the health probe
   *             judged its output garbage). The user has a working session they
   *             can inspect and act on, so the app comes up and says what is
   *             wrong. Killing it would strand a running server with no way to
   *             reach it.
   *   - false — there is nothing to talk to (nothing installed, start failed,
   *             install failed). Prompt mode would be a ready-looking front for
   *             a backend that cannot answer a single turn.
   *
   *  Never throws either way; `reason` is the sentence to show the user. */
  | { kind: "unresolved"; backend: OpenAICompatibleClient; reason: string; usable: boolean };

export interface ResolveOptions {
  projectRoot: string;
  config: LlamacliConfig;
  /** Status lines for the TUI log. Every line is a plain sentence naming what
   *  was found or done — this is the only feedback a multi-minute first run
   *  gives, and it renders inside the alt screen (see index.tsx). */
  log: (line: string) => void;
  /** Called with the process to release when the session ends, if any. */
  registerCleanup?: (fn: () => void) => void;
  /** Injected so tests do not depend on what is actually running on this
   *  machine's ports — nor on the network. */
  discover?: () => Promise<Discovery>;
  /** Injected for the same reason. Answers "does this backend actually produce
   *  text, or just well-formed noise?" — see healthCheck.ts. */
  probe?: (backend: OpenAICompatibleClient) => Promise<BackendHealth>;
  /** Injected for the same reason; runs the real first-run installer. */
  bootstrap?: (opts: BootstrapOptions) => Promise<BootstrapReport>;
  bootstrapOptions?: Partial<BootstrapOptions>;
}

const GiB = 1024 ** 3;

export async function resolveBackend(opts: ResolveOptions): Promise<Resolution> {
  const { projectRoot, config, log } = opts;

  // ── Case 1: is a server already answering? ─────────────────────────────────
  // Asked before anything else touches the disk or the network. A server that
  // is up is a complete answer: it knows its own endpoint, its own port and its
  // own model, all three of which are exactly what we would otherwise have to
  // decide ourselves.
  //
  // `discoverRunningServer`, not a single fast probe: llama-server binds its
  // port before the model is resident and answers nothing until the weights are
  // loaded. A fast probe cannot tell that apart from "nothing is running", and
  // answering it wrongly is how a second llama-server used to get spawned beside
  // a healthy one.
  const discover = opts.discover ?? (() => discoverRunningServer("127.0.0.1"));
  // A download that reported progress by rewriting one terminal line would
  // corrupt the TUI rendering into the same screen — Ink owns those bytes here,
  // and a bare `\r\x1b[2K` from the installer would cut its output in half. So
  // the reporter is routed through the TUI log like every other line, throttled
  // to whole percents: a 20 GB transfer updates several times a second, and an
  // unthrottled status line would push everything above it out of the log.
  let lastPercent = -1;
  let lastBytes = 0;
  const progress = (_default: (p: TransferProgress) => void) => (p: TransferProgress) => {
    // Whole percents only: a 20 GB transfer calls this several times a second,
    // and an unthrottled status line would push every earlier line out of the
    // TUI's log. `percent` is -1 until the total size is known, so that case
    // falls back to a fixed 1 GiB interval rather than emitting -1 forever.
    if (p.percent >= 0) {
      const percent = Math.floor(p.percent);
      if (percent === lastPercent) return;
      lastPercent = percent;
      lastBytes = 0;
      log(`모델 다운로드 중… ${percent}%`);
      return;
    }
    if (p.receivedBytes - lastBytes < GiB) return;
    lastBytes = p.receivedBytes;
    log(`모델 다운로드 중… ${formatBytes(p.receivedBytes)}`);
  };
  const discovery = await discover();

  if (discovery.kind === "found") {
    const server = discovery.server;
    const port = Number(new URL(server.baseUrl).port);
    const adopted = new OpenAICompatibleClient(server.baseUrl);
    // "It answered" is not "it works". A server serving unusable weights loads,
    // reports its model, accepts every request and returns HTTP 200 with a
    // perfectly well-formed completion full of nothing — so case 1 adopted one
    // for seven hours before anyone noticed, and nothing between the model file
    // and the screen ever asked whether the output was language.
    const health = await (opts.probe ?? probeBackendHealth)(adopted);
    if (health.verdict === "garbage") {
      const reason = describeUnhealthyBackend(`${server.baseUrl} (모델 ${server.model})`, health);
      log(reason);
      // Reported, not fatal to the app: `usable` is true because a real server
      // IS answering here — it just answers with garbage. The TUI comes up and
      // the reason is on screen where the user can act on it. Deliberately NOT
      // falling through to case 2 — the broken server is still holding the model
      // in VRAM, and spawning a second one beside it is the out-of-memory this
      // module's ordering exists to avoid. It also has to stay non-fatal: exiting
      // would strand a running server the user can no longer reach.
      return { kind: "unresolved", backend: adopted, reason, usable: true };
    }
    log(`이미 구동 중인 서버에 연결합니다: ${server.baseUrl} (모델 ${server.model})`);
    // Recorded so the next launch is a straight read of a known-good endpoint
    // instead of a fresh scan. Only when the config does not already say this,
    // so a user's hand-written baseUrl is never overwritten by a probe result.
    await persistAdoption(projectRoot, config, server.baseUrl, server.model).catch(() => {});
    return { kind: "adopted", backend: adopted, baseUrl: server.baseUrl, model: server.model, port };
  }

  if (discovery.kind === "loading") {
    // The port is HELD by a server mid-load. Binding a different one here is the
    // exact failure this module exists to prevent — the loading server already
    // holds most of the card. So we point at it and let the agent loop's
    // existing transient-failure retry cover the wait. It starts answering on
    // its own; no second process, no extra VRAM.
    const waitedSec = Math.round(discovery.waitedMs / 1000);
    log(
      `${discovery.baseUrl} 서버가 아직 모델을 불러오는 중입니다 (${waitedSec}초 대기). ` +
        `두 번째 서버를 띄우지 않고 이 서버를 사용합니다.`
    );
    await persistAdoption(projectRoot, config, discovery.baseUrl, undefined).catch(() => {});
    return {
      kind: "adopted",
      backend: new OpenAICompatibleClient(discovery.baseUrl),
      baseUrl: discovery.baseUrl,
      // Unknown until the server answers; config.ts re-reads it live on every
      // load, so the recorded value is only a placeholder.
      model: config.model,
      port: discovery.port,
    };
  }

  // ── Case 2: installed, recorded, but not running → start it ────────────────
  // Deliberately checked BEFORE the installer, so a machine that already has
  // both a binary and a model never reaches the Hub.
  const recorded = config.llama;
  if (config.backend === "local-llama" && recorded?.modelPath && recorded.binPath) {
    // Rebuilt as a full LlamaServerConfig rather than passed through: the config
    // type allows `host` to be absent, and the spawned process has to be told
    // explicitly. 127.0.0.1, not 0.0.0.0 — the server is for this session.
    const startCfg: LlamaServerConfig = { host: "127.0.0.1", ...recorded };
    if (await fileSize(recorded.modelPath) > 0) {
      const port = recorded.port;
      log(`설치된 llama-server 를 ${port} 포트에서 시작합니다: ${recorded.binPath}`);
      const started = await tryStart(startCfg, opts.registerCleanup);
      if (started) {
        const spawned = new OpenAICompatibleClient(started.baseUrl);
        // Same check as case 1, and for the same reason: a config that points
        // at a corrupt model file produces a server that loads and answers just
        // as convincingly as a good one. This one is nearly free — the spawn
        // path already waited out a multi-minute model load, so a single small
        // request adds nothing to what the user is waiting for.
        const health = await (opts.probe ?? probeBackendHealth)(spawned);
        if (health.verdict === "garbage") {
          const reason = describeUnhealthyBackend(`${started.baseUrl} (모델 ${recorded.modelPath})`, health);
          log(reason);
          // Same reasoning as case 1: the server is up and ours, so the session
          // comes up with the reason visible rather than exiting on the user.
          return { kind: "unresolved", backend: spawned, reason, usable: true };
        }
        return {
          kind: "spawned",
          backend: spawned,
          stop: started.stop,
          port,
          modelPath: recorded.modelPath,
        };
      }
      // A spawn failure is NOT fatal, and NOT a reason to fall through to the
      // installer: the binary and the model are both on disk and known, so a
      // rebuild would burn 10-40 minutes to fix a port that was busy or a card
      // that was full. Returning here rather than falling through is the point —
      // case 3 must be reached only when something is genuinely MISSING, never
      // when something is present and merely refused to start.
      return {
        kind: "unresolved",
        backend: fallbackClient(config),
        reason:
          `${recorded.binPath} 를 ${port} 포트에서 시작하지 못했습니다. ` +
          `llama.cpp 와 모델은 설치되어 있으므로 다시 설치하지 않았습니다 — 포트(${port})가 사용 중이거나 GPU 메모리가 부족할 수 있습니다. ` +
          `.llamacli/config.yaml 의 llama.port 를 비어 있는 포트로 바꾸거나, 서버를 직접 실행한 뒤 다시 시도하세요.`,
        // Nothing is listening on that endpoint — the process refused to start —
        // so there is no session to hand the user. This is one of the outcomes
        // that must NOT come up as a ready-looking prompt.
        usable: false,
      };
    } else {
      log(`설정된 모델 파일이 없습니다: ${recorded.modelPath}`);
    }
  }

  // ── Case 3: not installed (or no model recorded) → install + configure ─────
  // The one case that may touch the network, and the only one that can take
  // minutes. `ensureLocalStack` degrades instead of throwing, so a failure here
  // still yields a usable report and a running app.
  log("llama.cpp 가 설치되어 있지 않아 설치와 모델 준비를 시작합니다. 첫 실행이라 시간이 걸릴 수 있습니다.");
  const bootstrap = opts.bootstrap ?? ensureLocalStack;
  let report: BootstrapReport;
  try {
    report = await bootstrap({
      projectRoot,
      modelsDir: DEFAULT_MODELS_DIR,
      log,
      onProgress: progress,
      ...opts.bootstrapOptions,
    } as BootstrapOptions);
  } catch (err) {
    // Should not happen (ensureLocalStack returns a report), but a throw here
    // must not take down the session: the app starts on the recorded config.
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "unresolved", backend: fallbackClient(config), reason, usable: false };
  }

  for (const error of report.errors) log(`[설정 경고] ${error}`);

  // The bootstrap may have found a server of its own (case 1 all over again, in
  // the window between our probe and its own), or ended up attaching rather
  // than building. Both are reported through `config`, so the decision is read
  // back from there instead of being re-derived.
  const written = (report.config ?? {}) as Record<string, any>;
  if (written.backend === "openai-compatible" && typeof written.baseUrl === "string") {
    const baseUrl = written.baseUrl;
    log(`준비가 끝났습니다. ${baseUrl} 에 연결합니다.`);
    return {
      kind: "adopted",
      backend: new OpenAICompatibleClient(baseUrl),
      baseUrl,
      model: typeof written.model === "string" ? written.model : config.model,
      port: Number(new URL(baseUrl).port) || config.llama?.port || 8080,
    };
  }

  const llama = written.llama;
  if (typeof llama?.binPath === "string" && typeof llama?.modelPath === "string") {
    const cfg: LlamaServerConfig = {
      binPath: llama.binPath,
      modelPath: llama.modelPath,
      host: "127.0.0.1",
      port: typeof llama.port === "number" ? llama.port : 8080,
      // Respect the operator's config rather than always spawning at a
      // fixed 8192. The compaction thresholds (see index.tsx) are derived
      // from this, so an explicit contextSize in config.yaml must not be
      // silently dropped when we launch the server ourselves.
      contextSize: typeof llama.contextSize === "number" ? llama.contextSize : 8192,
      threads: typeof llama.threads === "number" ? llama.threads : 4,
      gpuLayers: typeof llama.gpuLayers === "number" ? llama.gpuLayers : 0,
      threadsBatch: llama.threadsBatch,
      batchSize: llama.batchSize,
      ubatchSize: llama.ubatchSize,
      cpuMoeLayers: llama.cpuMoeLayers,
      flashAttn: llama.flashAttn,
      cacheTypeK: llama.cacheTypeK,
      cacheTypeV: llama.cacheTypeV,
      parallel: llama.parallel,
    };
    const started = await tryStart(cfg, opts.registerCleanup);
    if (started) {
      log(`준비가 끝났습니다. ${started.baseUrl} 에서 llama-server 를 구동했습니다.`);
      return { kind: "spawned", backend: new OpenAICompatibleClient(started.baseUrl), stop: started.stop, port: cfg.port, modelPath: cfg.modelPath };
    }
  }

  return {
    kind: "unresolved",
    backend: fallbackClient(config),
    reason: report.errors[0] ?? "llama.cpp 와 모델을 준비하지 못했습니다. .llamacli/config.yaml 을 직접 설정하세요.",
    // The install itself did not complete, so there is no model and no server:
    // prompt mode here would be a shell around nothing.
    usable: false,
  };
}

/** Spawns a llama-server and waits for it to answer. Returns null instead of
 *  throwing: "could not start" is a reportable state, not a crash, and each
 *  caller here has a sensible fallback that is better than a stack trace. */
async function tryStart(
  cfg: LlamaServerConfig,
  registerCleanup?: (fn: () => void) => void
): Promise<{ baseUrl: string; stop: () => void } | null> {
  const manager = new LlamaServerManager(cfg);
  try {
    await manager.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[llamacli] llama-server 시작 실패: ${detail}\n`);
    return null;
  }
  const stop = () => manager.stop();
  // Registered so the model is released from VRAM on every exit path — a
  // surviving server is the direct cause of the next session OOMing.
  registerCleanup?.(stop);
  return { baseUrl: manager.baseUrl, stop };
}

/** The endpoint to use when nothing could be prepared. Deliberately the
 *  recorded one rather than a guess, so the failure is "that server is not
 *  answering" — which is actionable — instead of ECONNREFUSED against an
 *  invented port. */
function fallbackClient(config: LlamacliConfig): OpenAICompatibleClient {
  if (config.backend === "openai-compatible" && config.baseUrl) {
    return new OpenAICompatibleClient(config.baseUrl, config.apiKey);
  }
  const port = config.llama?.port ?? 8080;
  return new OpenAICompatibleClient(`http://127.0.0.1:${port}`, config.apiKey);
}

/** Records an adopted endpoint, preserving every other key.
 *
 *  Only writes when it would actually change something: this runs on EVERY
 *  launch against case 1, and rewriting config.yaml each time would churn a
 *  user-reviewed file for no gain. A config already pointing at this endpoint is
 *  left completely alone. */
async function persistAdoption(
  projectRoot: string,
  config: LlamacliConfig,
  baseUrl: string,
  model: string | undefined
): Promise<void> {
  if (config.backend === "openai-compatible" && config.baseUrl === baseUrl) return;
  if (config.backend === "local-llama" && !config.llama) return;
  const next: Record<string, unknown> = {
    backend: "openai-compatible",
    baseUrl,
    // `model` is left out when unknown: the server is the source of truth and
    // config.ts re-reads it live, so recording a guess would only be stale.
    ...(model ? { model } : config.model ? { model: config.model } : {}),
  };
  await writeConfig(projectRoot, next);
}

/** Size of a file, or 0 when it cannot be read. Zero is the load-bearing value:
 *  a config pointing at a path that no longer exists (deleted to reclaim disk,
 *  moved to another machine) must read as "no model", not as "model of size 0"
 *  — which the installer would then try to use and fail to load. */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}