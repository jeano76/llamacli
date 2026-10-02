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
 * Some quantizations need a build that can read them. `PTQ1_0` and `PQ2_0`
 * are the two that a stock llama.cpp cannot (measured on this machine by
 * diffing `llama-quantize`'s supported list between two builds), and `PTQ1_0`
 * is precisely the quant the Bonsai family is chosen for — so picking a Bonsai
   model is the common case for hitting this, not an edge case.
 *
 * `findLlamaServer` already arbitrates this on the next launch: it executes
 * each candidate binary against the configured model and rejects one that
   reports an unknown tensor type. That work is not duplicated here. What IS
 * done here is reporting it, at the moment the user decides — so a selection
 * that would need a different (or newly built) llama.cpp says so immediately,
 * rather than the failure surfacing on the next launch as a load error.
 */

import { join } from "node:path";
import { parse, stringify } from "yaml";
import { mkdir, writeFile } from "node:fs/promises";
import { findLlamaServer } from "./llamaCpp.js";
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
}

export interface SelectOptions {
  projectRoot: string;
  rung: ModelRung;
  /** Where models live for this install. */
  modelsDir: string;
  /** Injected for tests. */
  readConfigFile?: (projectRoot: string) => Promise<Record<string, any> | undefined>;
  writeConfigFile?: (projectRoot: string, config: Record<string, unknown>) => Promise<void>;
  /** Injected for tests; defaults to the real discovery. */
  findServer?: typeof findLlamaServer;
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
    return {
      ok: true,
      binPath: loc.binPath,
      detail: `llama-server 가 이 모델을 읽을 수 있습니다 (${loc.binPath}, ${loc.backend} 빌드).`,
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
  const modelPath = join(opts.modelsDir, opts.rung.id === "ornith-35b" ? existingModelFilename(existing) : filenameFor(opts.rung));

  const previousModel = typeof existing?.model === "string" ? existing.model : undefined;

  const next: Record<string, any> = {
    ...(existing ?? {}),
    model: modelPath,
    llama: {
      ...((existing?.llama ?? {}) as Record<string, any>),
      modelPath,
    },
  };
  await writeConfig(opts.projectRoot, next);

  const { stat } = await import("node:fs/promises");
  const presentOnDisk = await stat(modelPath).then((s) => s.isFile(), () => false);
  const llama = await checkLlama(modelPath, opts.rung.label, findServer);

  return {
    rung: opts.rung,
    modelPath,
    previousModel,
    presentOnDisk,
    llama,
    // The running server has the OLD model loaded; nothing can change that
    // without a restart, and saying so is the whole point of this field.
    requiresRestart: previousModel !== modelPath,
  };
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