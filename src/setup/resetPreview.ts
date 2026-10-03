/**
 * What `/reset confirm` WOULD change, computed without touching anything.
 *
 * `/reset` used to describe itself in prose and show the diff only after the config was
 * rewritten — and a reset drops hand-raised values (a 98,304-token context re-derives to
 * whatever the tuner's ceiling is), which is exactly the change worth seeing BEFORE
 * agreeing to it. This runs the same machine-derived step (`tuneForHardware` on the model
 * the reset would keep) and diffs it against the current config with the same
 * `describeReset` the post-reset report uses, so the preview and the result cannot disagree
 * about what counts as a change.
 */
import { describeReset } from "./resetDiff.js";
import { tuneForHardware } from "./tuning.js";
import type { Hardware } from "./hardware.js";
import { keepSelectedModelOnReset, keepUserOwnedKeys } from "./bootstrap.js";
import { isMoeModel, readGgufKvShape } from "./ggufMeta.js";
import { stat } from "node:fs/promises";

export interface ResetPreview {
  /** One line per change; empty when the machine-derived values already match. */
  changes: string[];
  /** The model the reset would keep, or undefined when it would re-pick one. */
  keepsModel?: string;
  /** True when the preview could not size a model (none on disk): the reset would pick one. */
  repicksModel: boolean;
}

export async function previewReset(opts: {
  config: Record<string, any> | undefined;
  hardware: Hardware;
  /** VRAM held by this install's own server, which the reset would be free to reuse. */
  ownServerVramGiB?: number;
}): Promise<ResetPreview> {
  const { config, hardware } = opts;
  const kept = await keepSelectedModelOnReset(config, keepUserOwnedKeys(config), hardware);
  const modelPath = typeof kept?.llama?.modelPath === "string" ? kept.llama.modelPath : undefined;
  if (!modelPath) return { changes: [], repicksModel: true };

  const size = (await stat(modelPath).catch(() => undefined))?.size ?? 0;
  const moe = await isMoeModel({ path: modelPath, filename: modelPath.split("/").pop() }).catch(() => undefined);
  const kv = await readGgufKvShape(modelPath).catch(() => undefined);
  const t = tuneForHardware(hardware, {
    modelBytes: size, moe, kvElementsPerToken: kv?.elementsPerToken, ownServerVramGiB: opts.ownServerVramGiB,
    reapplyContext: typeof config?.llama?.contextSize === "number" ? config.llama.contextSize : undefined,
  });
  const after = {
    model: modelPath,
    backend: config?.backend,
    llama: {
      modelPath, contextSize: t.contextSize, gpuLayers: t.gpuLayers, threads: t.threads,
      threadsBatch: t.threadsBatch, cpuMoeLayers: t.cpuMoeLayers, batchSize: t.batchSize, ubatchSize: t.ubatchSize,
      parallel: t.parallel, cacheTypeK: t.cacheTypeK, cacheTypeV: t.cacheTypeV, flashAttn: t.flashAttn,
      port: config?.llama?.port,
    },
  };
  return { changes: describeReset(config, after), keepsModel: modelPath, repicksModel: false };
}
