/**
 * Is this model ALREADY on the machine? If so it is used where it is — no download, no copy.
 *
 * The previous reuse checks looked in one place each: the exact path in the config, the
 * exact filename in the models directory, and same-size-same-quant in that same directory.
 * Models are not kept in one place (this machine has them under `~/models` and on
 * `/media/<user>/<disk>/models/<family>/`), so a model that was a minute away on another
 * disk was downloaded again, 5 to 20 GB at a time.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { modelFamilyOf, pickPinnedCandidate, type ModelCandidate } from "./modelCatalog.js";
import { baseName } from "../util/path.js";

export interface LocalGguf {
  path: string;
  sizeBytes: number;
}

/** Walks `dirs` (depth-bounded, dot-directories skipped) and lists the .gguf files in them.
 *  Bounded on both axes because this runs inside a slash command on a real filesystem; a
 *  miss only means a download is proposed, a hang would be worse. `.part` files and the
 *  downloader's own staging folders are never candidates: they are unfinished by definition. */
export async function scanModels(
  dirs: string[],
  opts: { depth?: number; budget?: number; readdirImpl?: typeof readdir; statImpl?: typeof stat } = {}
): Promise<LocalGguf[]> {
  const rd = opts.readdirImpl ?? readdir;
  const st = opts.statImpl ?? stat;
  const budget = { left: opts.budget ?? 600 };
  const seen = new Set<string>();
  const out: LocalGguf[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (seen.has(dir) || budget.left-- <= 0) return;
    seen.add(dir);
    let entries;
    try {
      entries = await rd(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable
    }
    for (const e of entries) {
      if (e.isFile() && /\.gguf$/i.test(e.name)) {
        try {
          out.push({ path: join(dir, e.name), sizeBytes: (await st(join(dir, e.name))).size });
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) await walk(join(dir, e.name), depth - 1);
    }
  };

  for (const d of dirs) await walk(d, opts.depth ?? 2);
  return out;
}

/** The quant tag of a filename (`Q4_K_M`, `Q2_K`, …), or null. */
export function quantTag(filename: string): string | null {
  const base = filename.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/, "");
  const m = /-(Q\d_0(?:_g\d+)?|Q\d_K(?:_[SML]|_XL)?|IQ\d_\w+|BF16|F16|F32)$/i.exec(base);
  return m ? m[1].toUpperCase() : null;
}

/**
 * A local file that IS this candidate, or null.
 *
 *  1. The same filename at (at least) the published size. Smaller is an incomplete copy and
 *     is never reused; a larger one is accepted (the Hub republishes under the same name
 *     with a different byte count, and a working model must not be replaced for that).
 *  2. A different name with EXACTLY the published size and the same quant — the Hub and the
 *     disk disagree about names constantly (`Ornith-1.5-35B-…` vs `…-35B-A3B-…`).
 *
 * Not hashed: this is the file the user already runs. Hashing 20 GB at every launch to
 * "prove" it is the one they already trust costs minutes and can only ever delete a model
 * that works.
 */
export function pickReusable(candidate: { filename: string; sizeBytes: number }, local: LocalGguf[]): LocalGguf | null {
  const base = (p: string) => baseName(p);
  const exact = local
    .filter((f) => base(f.path).toLowerCase() === candidate.filename.toLowerCase())
    .filter((f) => !candidate.sizeBytes || f.sizeBytes >= candidate.sizeBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  if (exact) return exact;
  const want = quantTag(candidate.filename);
  if (!candidate.sizeBytes || !want) return null;
  return local.find((f) => f.sizeBytes === candidate.sizeBytes && quantTag(base(f.path)) === want) ?? null;
}

/**
 * For a model chosen by NAME with no Hub listing to hand (the `/models` table): any local
 * file of the same family, in the quant the downloader itself would have fetched. Reuses the
 * downloader's own preference order, so "what we would download" and "what we reuse" agree.
 */
export function pickFamilyMatch(filename: string, local: LocalGguf[]): LocalGguf | null {
  const family = modelFamilyOf(filename).toLowerCase();
  const asCandidates: ModelCandidate[] = local
    .filter((f) => modelFamilyOf(baseName(f.path) ?? "").toLowerCase() === family)
    .map((f) => ({ repo: "local", filename: baseName(f.path), sizeBytes: f.sizeBytes, url: f.path }));
  const pick = pickPinnedCandidate(asCandidates, filename);
  if (!pick) return null;
  return local.find((f) => baseName(f.path) === pick.filename && f.sizeBytes === pick.sizeBytes) ?? null; // by name, not by "/" suffix: Windows paths use "\\"
}
