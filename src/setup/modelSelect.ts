/**
 * Switching the model this install uses.
 *
 * ── Selection REPLACES, it does not add ─────────────────────────────────────
 * `.llamacli/config.yaml` names exactly one model, so picking a rung
 * overwrites it. That is the intent rather than an accident: a user choosing a
 * model is choosing to run THAT one, and keeping the previous one around as a
 * "fallback" would mean a silent mismatch between what `/models` says is
 * selected and what a stale `model` field says.
 *
 * Both fields are written together — the top-level `model` and
 * `llama.modelPath` — because loadConfig treats the top-level one as a live
 * cache refreshed from the server on every load, while `llama.modelPath` is
 * what the binary is launched with. Writing only one of them is how a config
 * ends up pointing at a model the server is not serving.
 *
 * ── The llama.cpp question, answered at selection time ──────────────────────
 * Some quantizations need a build that can read them: a llama.cpp whose type
 * table predates the model's quant rejects the file with an "invalid ggml type"
 * error that reads like a corrupt download.
 *
 * `findLlamaServer` already arbitrates this on the next launch: it executes
 * each candidate binary against the configured model and rejects one that
 * reports an unknown tensor type. That work is not duplicated here. What IS
 * done here is reporting it, at the moment the user decides — so a selection
 * that would need a different (or newly built) llama.cpp says so immediately,
 * rather than the failure surfacing on the next launch as a load error.
 */

import { join } from "node:path";
import { parse, stringify } from "yaml";
import { mkdir, writeFile } from "node:fs/promises";
import { findLlamaServer } from "./llamaCpp.js";
import { tuningToConfigKeys } from "./bootstrap.js";
import { candidateDirs, discoverMounts, selectModelPath } from "./disk.js";
import type { LlamaTuning } from "./tuning.js";
import type { ModelRung } from "./modelMetrics.js";

export interface SelectResult {
  /** The rung chosen. */
  rung: ModelRung;
  /** Where the model is expected to live once present. */
  modelPath: string;
  /** What changed in the config, for the status line. */
  previousModel?: string;
  /** Whether the model file already exists on disk. */
  presentOnDisk: boolean;
  /** llama-server story: can the build that would be used read this quant? */
  llama: {
    ok: boolean;
    /** Path of a binary that CAN read it, when one was found. */
    binPath?: string;
    /** Set when the current/candidate build cannot read this quant. */
    needsDifferentBuild?: boolean;
    /** User-facing explanation. */
    detail: string;
  };
  /** True when the switch takes effect only after a restart. */
  requiresRestart: boolean;
  /** The port already in force. Carried through so the server switch reuses it
   *  instead of re-planning one. */
  port: number;
  /** The tuning now recorded for the new model. */
  tuning?: LlamaTuning;
}

export interface SelectOptions {
  projectRoot: string;
  rung: ModelRung;
  /** Where models live for this install. Only a FALLBACK: if the chosen model
   *  is already on disk somewhere, that real path wins — see `findExistingModel`. */
  modelsDir?: string;
  /** Injected for tests. */
  readConfigFile?: (projectRoot: string) => Promise<Record<string, any> | undefined>;
  writeConfigFile?: (projectRoot: string, config: Record<string, unknown>) => Promise<void>;
  /** Tuning RE-DERIVED for the new model.
   *
   *  Not optional in practice: the flags in the config were sized for whatever
   *  model was loaded before, and `--n-cpu-moe` in particular is meaningless
   *  (or harmful) on a dense model. Carrying them across a switch is how a
   *  5 GiB dense model gets launched with a 35B MoE's CPU-expert count and
   *  dies at load. */
  tuning?: LlamaTuning;
  /** Injected for tests; defaults to the real discovery. */
  findServer?: typeof findLlamaServer;
  /** Injected for tests: the .gguf files on disk, instead of walking the real filesystem. */
  listLocalModels?: (dirs: string[]) => Promise<{ path: string; sizeBytes: number }[]>;
  /** Do not treat a same-family file in another quant as "already downloaded". */
  noFamilyReuse?: boolean;
  /** Injected for tests; defaults to asking the running server. */
  detectRunningPort?: () => Promise<number | null>;
}

async function defaultRead(projectRoot: string): Promise<Record<string, any> | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return (parse(await readFile(join(projectRoot, ".llamacli", "config.yaml"), "utf8")) as any) ?? undefined;
  } catch {
    return undefined;
  }
}

async function defaultWrite(projectRoot: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(join(projectRoot, ".llamacli"), { recursive: true });
  // Temp + rename, so a crash mid-write cannot leave a config that parses but
  // names a model that was never downloaded.
  const target = join(projectRoot, ".llamacli", "config.yaml");
  const tmp = `${target}.tmp`;
  await writeFile(tmp, stringify(config), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

/** Whether a llama-server that can read this model exists, and where.
 *
 *  `findLlamaServer` already arbitrates this — it EXECUTES each candidate
 *  against the configured model and collects the ones whose type registry
 *  rejects it into `rejectedForModel`, which is exactly the signal needed. So
 *  nothing is re-implemented here; this only turns that result into something
 *  the user can act on, at the moment they choose a model.
 */
async function checkLlama(
  modelPath: string,
  modelName: string,
  findServer: typeof findLlamaServer
): Promise<SelectResult["llama"]> {
  try {
    const found = await findServer({ modelPath });
    const loc = found.location;
    if (!loc) {
      const blocked = found.rejectedForModel ?? [];
      if (blocked.length > 0) {
        return {
          ok: false,
          needsDifferentBuild: true,
          detail:
            `설치된 llama-server 는 ${modelName} 의 양자화를 읽지 못합니다 ` +
            `(쓰기 불가로 거절된 빌드: ${blocked.join(", ")}). ` +
            `모델과 호환되는 빌드를 찾아야 하며, 없으면 새로 빌드해야 합니다.`,
        };
      }
      return {
        ok: false,
        needsDifferentBuild: true,
        detail:
          "설치된 llama-server 를 찾지 못했습니다. 다음 실행 시 자동으로 찾아 빌드합니다.",
      };
    }
    // `unverified` non-empty alongside a location means the chosen build was
    // kept because nothing DISPROVED it, not because it was shown to work.
    // Reporting that as "can read this model" would be presenting an assumption
    // as a measurement, so the hedge is stated rather than dropped.
    const unverified = found.unverified ?? [];
    const hedge =
      unverified.includes(loc.binPath)
        ? " (확인되지 않음 — 이 빌드가 이 양자화를 읽는다는 근거가 아직 없습니다)"
        : "";
    return {
      ok: true,
      binPath: loc.binPath,
      detail: `llama-server 가 이 모델을 읽을 수 있습니다 (${loc.binPath}, ${loc.backend} 빌드).${hedge}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `llama-server 확인 중 오류: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Points the config at `rung`, and reports whether the llama-server that will
 * serve it can read that quantization.
 *
 * Writes the config even when the build turns out to be incompatible. Refusing
 * to record the choice would leave the user with a selection that silently
 * does not happen; recording it and REPORTING the build problem is the honest
 * version, and the next launch's discovery already resolves it.
 */
export async function selectModel(opts: SelectOptions): Promise<SelectResult> {
  const readConfig = opts.readConfigFile ?? defaultRead;
  const writeConfig = opts.writeConfigFile ?? defaultWrite;
  const findServer = opts.findServer ?? findLlamaServer;

  const existing = await readConfig(opts.projectRoot);
  const filename =
    opts.rung.id === "ornith-35b" ? existingModelFilename(existing) : filenameFor(opts.rung);
  const modelPath =
    (await resolveModelPath(opts, filename, existing)) ?? join(opts.modelsDir ?? "", filename);

  const previousModel = typeof existing?.model === "string" ? existing.model : undefined;

  const port = await resolvePort(existing, opts.detectRunningPort);
  // The build that can read THIS model is recorded alongside it. Leaving the previous
  // `binPath` in place meant the config named a binary that rejects the new quant, and every
  // launch paid a failed probe (or a fallback search) before finding the right one.
  const llamaCheck = await checkLlama(modelPath, opts.rung.label, findServer);
  const next: Record<string, any> = {
    ...(existing ?? {}),
    model: modelPath,
    llama: {
      ...((existing?.llama ?? {}) as Record<string, any>),
      modelPath,
      // The port the server is REALLY on (see resolvePort), not a stale record.
      port,
      ...(llamaCheck.ok && llamaCheck.binPath ? { binPath: llamaCheck.binPath } : {}),
      // Re-derived per model. The port is deliberately NOT included here --
      // it is carried over untouched, and a model switch must never relocate
      // the server.
      ...(opts.tuning ? tuningToConfigKeys(opts.tuning) : {}),
    },
  };
  await writeConfig(opts.projectRoot, next);

  const { stat } = await import("node:fs/promises");
  const presentOnDisk = await stat(modelPath).then((s) => s.isFile(), () => false);
  const llama = llamaCheck;

  return {
    rung: opts.rung,
    modelPath,
    previousModel,
    presentOnDisk,
    llama,
    // The running server has the OLD model loaded; nothing can change that
    // without a restart, and saying so is the whole point of this field.
    requiresRestart: previousModel !== modelPath,
    port,
    tuning: opts.tuning,
  };
}


/**
 * Where the chosen model actually is, or should be.
 *
 * Order matters and the first entry is the one that was missing:
 *
 *  1. The file ALREADY on disk. A previous version of this guessed
 *     `$HOME/models` and wrote that, so selecting a model on a machine that
 *     already had it at `/media/<user>/<label>/models/<family>/` recorded a
 *     path that did not exist — which reports "not downloaded yet" and then
 *     re-downloads several GiB of a file the user is already sitting on. The
 *     search covers `discoverMounts` as well as the fixed candidates, because
 *     the real layout on this machine (`/media/jeano/nvme-usb/models`) matches
 *     neither `/mnt/models` nor `/media/models` and is found only by reading the
 *     mount table.
 *  2. A directory with room for it, so the next launch downloads rather than
 *     dying on a full root disk.
 *  3. The caller's `modelsDir`, as the last resort.
 */
async function resolveModelPath(
  opts: SelectOptions,
  filename: string,
  existing: Record<string, any> | undefined
): Promise<string | undefined> {
  const stat = (await import("node:fs/promises")).stat;
  const isFile = async (p: string) => stat(p).then((s) => s.isFile(), () => false);

  // 1. Already downloaded?
  const configured = configuredModelPath(existing, filename);
  if (configured && (await isFile(configured))) return configured;

  const dirs = await searchDirs(opts.modelsDir);
  for (const dir of dirs) {
    const hit = await findByName(dir, filename, isFile);
    if (hit) return hit;
  }

  // The table's quant is an estimate (a rung can name a quant the Hub does not publish; the
  // downloader fetches the best one it has), so the exact name can be absent while the same MODEL is on disk
  // in the quant the downloader would have chosen. That copy is reused rather than fetched.
  if (!opts.noFamilyReuse) {
    const { scanModels, pickFamilyMatch } = await import("./existingModel.js");
    const local = opts.listLocalModels ? await opts.listLocalModels(dirs) : await scanModels(dirs);
    const family = pickFamilyMatch(filename, local);
    if (family) return family.path;
  }

  // 2. Somewhere with room, for the download.
  if (opts.rung.sizeBytes > 0) {
    try {
      const base = opts.modelsDir ?? candidateDirs()[0];
      const choice = await selectModelPath({ requestedDir: base, neededBytes: opts.rung.sizeBytes });
      return join(choice.dir, filename);
    } catch {
      /* fall through to the caller's default */
    }
  }
  return undefined;
}

/** The port the server must keep using.
 *
 *  Preference order, and the middle entry is one an earlier version of this got
 *  wrong: it went straight from "the config records a port" to 8080. A config
 *  with no `llama.port` and a real server already on 8084 is a normal state —
 *  the file on this machine was exactly that — and defaulting to 8080 there
 *  starts a SECOND server, which is the two-server OOM this all exists to
 *  prevent. So an unrecorded port is resolved by asking the running server. */
async function resolvePort(
  existing: Record<string, any> | undefined,
  detect: (() => Promise<number | null>) | undefined
): Promise<number> {
  const recorded = typeof existing?.llama?.port === "number" ? existing.llama.port : undefined;
  if (detect) {
    // A test (or caller) that supplies its own probe answers "which port is a server on".
    const running = await detect();
    return recorded !== undefined && running === null ? recorded : running ?? recorded ?? 8080;
  }
  // What is actually listening outranks the record: a config that says 8080 while the
  // server was started by hand on 8084 sent the switch to a port with nothing on it, it
  // stopped nothing, and the replacement server was started beside a full card.
  const { resolveLiveServerPort } = await import("./modelSwitch.js");
  return (await resolveLiveServerPort(recorded)).port;
}

/** Records what the server is REALLY running, so the config stops describing the previous
 *  one: the port, the binary that read this model, the model file, and the tuning it was
 *  launched with. Only these keys are touched (and a local `baseUrl` that names another
 *  port); everything else in the file is preserved. */
export async function recordServerState(
  projectRoot: string,
  state: { port?: number; binPath?: string; modelPath?: string; tuning?: Record<string, unknown> },
  io: { read?: SelectOptions["readConfigFile"]; write?: SelectOptions["writeConfigFile"] } = {}
): Promise<boolean> {
  const read = io.read ?? defaultRead;
  const write = io.write ?? defaultWrite;
  const cfg = await read(projectRoot);
  if (!cfg) return false;
  const before = JSON.stringify(cfg);
  const next: Record<string, any> = { ...cfg, llama: { ...(cfg.llama ?? {}) } };
  if (state.port !== undefined) next.llama.port = state.port;
  if (state.binPath) next.llama.binPath = state.binPath;
  if (state.modelPath) {
    next.llama.modelPath = state.modelPath;
    next.model = state.modelPath;
  }
  if (state.tuning) {
    // An undefined tuning field means "not decided", not "clear it": assigning it would
    // delete the user's existing key (YAML drops undefined values on write).
    for (const [k, v] of Object.entries(tuningToConfigKeys(state.tuning as never))) {
      if (v !== undefined) next.llama[k] = v;
    }
  }
  if (state.port !== undefined && typeof next.baseUrl === "string") {
    try {
      const u = new URL(next.baseUrl);
      if (["127.0.0.1", "localhost"].includes(u.hostname) && Number(u.port) !== state.port) {
        u.port = String(state.port);
        next.baseUrl = u.toString().replace(/\/$/, "");
      }
    } catch { /* not a URL: leave it */ }
  }
  if (JSON.stringify(next) === before) return false;
  await write(projectRoot, next);
  return true;
}

/** Port-only form, kept for callers that have nothing else to record. */
export async function recordServerPort(
  projectRoot: string,
  port: number,
  io: Parameters<typeof recordServerState>[2] = {}
): Promise<boolean> {
  return recordServerState(projectRoot, { port }, io);
}

/** A path the config already uses for exactly this filename.
 *
 *  Matched on the BASENAME, not the whole path: `llama.modelPath` and `model`
 *  are the two fields that must agree, and a config that already names this
 *  model is the best evidence of where it lives. */
function configuredModelPath(existing: Record<string, any> | undefined, filename: string): string | undefined {
  const p = typeof existing?.llama?.modelPath === "string"
    ? existing.llama.modelPath
    : typeof existing?.model === "string"
      ? existing.model
      : undefined;
  if (!p) return undefined;
  return p.split("/").pop() === filename ? p : undefined;
}

/** Depth-first search for an already-downloaded file.
 *
 *  Recurses because the real layout puts models in per-family subdirectories
 *  (`.../models/<family>/<model>.gguf`) while others sit at
 *  the top of the same directory, so a flat check found neither reliably.
 *
 *  Bounded on both axes — depth and directories visited — because this runs
 *  inside a slash command on someone's real filesystem, and an unbounded walk
 *  of a mounted archive is how `/models` becomes a hang. The visit cap is
 *  deliberately generous; failing to find the file only means a re-download is
 *  proposed, which is recoverable, whereas hanging the UI is not. */
async function findByName(
  dir: string,
  filename: string,
  isFile: (p: string) => Promise<boolean>,
  depth = 2,
  budget = { left: 400 }
): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const direct = join(dir, filename);
  if (await isFile(direct)) return direct;
  if (depth <= 0) return undefined;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined; // unreadable or not a directory
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (budget.left-- <= 0) return undefined;
    // Skip mount points and caches: descending into another filesystem here
    // would both waste the budget and make the search unbounded in disk terms.
    if (entry.name.startsWith(".")) continue;
    const hit = await findByName(join(dir, entry.name), filename, isFile, depth - 1, budget);
    if (hit) return hit;
  }
  return undefined;
}

/** Candidate directories plus whatever real mount points look like model stores.
 *
 *  `discoverMounts` is not optional here and its result is not deduped away: a
 *  fixed list alone cannot see `/media/$USER/<label>/models`, which is where
 *  this machine's models actually are. */
async function searchDirs(requested?: string): Promise<string[]> {
  const mounts = await discoverMounts().catch(() => []);
  // The caller's hint goes first: it is the one directory somebody stated on
  // purpose, and a copy found there beats a copy merely guessed at.
  return [...new Set([...(requested ? [requested] : []), ...candidateDirs(), ...mounts])];
}

/** The filename to record. `ornith-35b` follows whatever the config already
 *  used, because the Hub publishes it under two names (see modelCatalog's
 *  note) and rewriting it to the catalogue's spelling is how a 20 GB
 *  re-download of a model already on disk starts. */
function existingModelFilename(existing: Record<string, any> | undefined): string {
  const p = typeof existing?.llama?.modelPath === "string" ? existing.llama.modelPath
    : typeof existing?.model === "string" ? existing.model : "";
  return p.split("/").pop() || "Ornith-1.5-35B-A3B-Q4_K_M.gguf";
}

function filenameFor(rung: ModelRung): string {
  return `${rung.label}-${rung.quant}.gguf`;
}