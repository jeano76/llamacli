import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel, ORNITH_35B_REPO, ORNITH_9B_REPO, listGgufFiles, chooseModel,
  type ModelCandidate,
} from "./modelCatalog.js";

// ── The pinned repo ids have to be the ones that actually exist ────────────

test("the default repos are namespaced, which is what makes them exist", () => {
  // The un-namespaced form (`Ornith-1.5-35B-A3B-GGUF`) is a repo that does not
  // exist: the Hub answers HTTP 401 for it. On a machine with no model
  // configured that made first-run bootstrap resolve nothing, write a config
  // with no `modelPath`, and leave the spawn condition in index.tsx
  // permanently unsatisfiable — the "finds the server binary and port but
  // never starts it" symptom.
  for (const repo of [ORNITH_35B_REPO, ORNITH_9B_REPO]) {
    assert.match(repo, /^[\w.-]+\/[\w.-]+$/, `${repo} must carry its publisher namespace`);
  }
  assert.equal(ORNITH_35B_REPO, "ornith-ai/Ornith-1.5-35B-A3B-GGUF");
  assert.equal(ORNITH_9B_REPO, "ornith-ai/Ornith-1.5-9B-GGUF");
});

test("the pinned repos actually list the quant the planner prefers", async (t) => {
  // A guard against the ids drifting again. Skipped when the network is
  // unavailable — an offline machine cannot disprove a repo id, and failing
  // here would make the suite depend on HuggingFace being up.
  const files = await listGgufFiles(ORNITH_35B_REPO).catch(() => null);
  if (files === null) {
    t.skip("HuggingFace unreachable");
    return;
  }
  const names = files.map((f) => f.filename);
  assert.ok(
    names.some((n) => n.includes("Q4_K_M")),
    `expected a Q4_K_M quant in ${ORNITH_35B_REPO}, saw: ${names.join(", ")}`
  );
  // Sizes are what the progress bar and the disk preflight use; a listing
  // without them would silently download blind.
  assert.ok(files.some((f) => f.sizeBytes > 0), "the Hub listing must carry byte sizes");
});

// ── A pinned repo that stops working must not end the first run ────────────

test("an unreachable default repo falls back to a search instead of failing", async () => {
  // Only the PINNED repo is gone. A repo found by the search lists normally —
  // which is the whole shape of the real failure: the default id went stale,
  // the family is still published under a different id.
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    if (u.includes("/api/models?")) {
      return {
        ok: true, status: 200,
        json: async () => [{ id: "someone/Ornith-1.5-9B-GGUF" }],
      } as any;
    }
    if (u.includes("/api/models/")) {
      const isPinned = u.includes("ornith-ai/");
      return isPinned
        ? { ok: false, status: 401, json: async () => ({}) } as any
        : { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "found-Q4_K_M.gguf", size: 1234 }] }) } as any;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;

  const logged: string[] = [];
  const { c9 } = await resolveModel({ fetchImpl, env: {}, log: (l) => logged.push(l) });
  assert.ok(c9.length > 0, "a renamed repo must degrade to a search, not to a dead first run");
  assert.equal(c9[0].repo, "someone/Ornith-1.5-9B-GGUF");
  assert.ok(
    logged.some((l) => /접근할 수 없습니다/.test(l)),
    "the fallback must be reported, not silent"
  );
});

test("an EXPLICIT MODEL_REPO that is unreachable fails loudly rather than substituting another repo", async () => {
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    if (u.includes("api/models/")) return { ok: false, status: 404, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "other.gguf", size: 1 }] }) } as any;
  }) as unknown as typeof fetch;

  const logged: string[] = [];
  const { c9 } = await resolveModel({
    fetchImpl,
    env: { MODEL_REPO_9B: "me/my-own-9B" },
    log: (l) => logged.push(l),
  });
  // If the user named a repo, quietly using a different one is worse than
  // telling them the one they named does not exist.
  assert.deepEqual(c9, []);
  assert.ok(logged.some((l) => /MODEL_REPO_9B=me\/my-own-9B/.test(l)), `expected the named repo to be reported: ${logged.join(" | ")}`);
});

test("one unreachable family does not prevent the other from resolving", async () => {
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    if (u.includes("35B")) return { ok: false, status: 401, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ siblings: [{ rfilename: "ok-Q4_K_M.gguf", size: 99 }] }) } as any;
  }) as unknown as typeof fetch;
  const { c35, c9 } = await resolveModel({ fetchImpl, env: {}, log: () => {} });
  assert.deepEqual(c35, [], "the 401 family yields nothing rather than throwing");
  assert.ok(c9.length > 0, "the healthy family still resolves");
});

// ── the Bonsai ladder ───────────────────────────────────────────────────────
//
// Sizes below are the real ones from the Hub's file listings, not estimates,
// because the whole point is that a 27B DENSE model is 5.5 GB at 1-bit and
// therefore fits a card that cannot hold the Ornith 35B's active set. Invented
// numbers would make these tests pass without proving the property.

const BONSAI_27B_REPO_ID = "prism-ml/Ternary-Bonsai-2-27B-gguf";
const cand = (repo: string, filename: string, sizeBytes: number): ModelCandidate => ({
  repo,
  filename,
  sizeBytes,
  url: "",
});
const GiB = 1024 ** 3;

const bonsaiFixture: Record<string, ModelCandidate[]> = {
  "27B": [
    cand(BONSAI_27B_REPO_ID, "Ternary-Bonsai-2-27B-F16.gguf", 50.11 * GiB),
    cand(BONSAI_27B_REPO_ID, "Ternary-Bonsai-2-27B-PQ2_0.gguf", 6.71 * GiB),
    cand(BONSAI_27B_REPO_ID, "Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5.54 * GiB),
  ],
  "8B": [
    cand("prism-ml/Ternary-Bonsai-8B-gguf", "Ternary-Bonsai-8B-F16.gguf", 15.26 * GiB),
    cand("prism-ml/Ternary-Bonsai-8B-gguf", "Ternary-Bonsai-8B-PQ2_0.gguf", 2.03 * GiB),
  ],
  "4B": [
    cand("prism-ml/Ternary-Bonsai-4B-gguf", "Ternary-Bonsai-4B-F16.gguf", 7.5 * GiB),
    cand("prism-ml/Ternary-Bonsai-4B-gguf", "Ternary-Bonsai-4B-PQ2_0.gguf", 1.0 * GiB),
  ],
};
const ORNITH_35B = [cand("ornith-ai/Ornith-1.5-35B-A3B-GGUF", "Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21.86 * GiB)];
const ORNITH_9B = [cand("ornith-ai/Ornith-1.5-9B-GGUF", "Ornith-1.5-9B-Q4_K_M.gguf", 5.5 * GiB)];

const onCard = (vramGiB: number, ramGiB = 32) =>
  chooseModel({
    vramTotalBytes: vramGiB * GiB,
    vramFreeBytes: vramGiB * GiB,
    ramTotalBytes: ramGiB * GiB,
    candidates35b: ORNITH_35B,
    candidates9b: ORNITH_9B,
    bonsai: bonsaiFixture,
  });

test("an 8 GB card picks the 27B 1-bit Bonsai, not the smaller rung that also fits", () => {
  // The property that motivated adding this family: a dense 27B in 5.5 GB is
  // resident on a card whose VRAM the 35B MoE can only reach by paging
  // experts. Choosing by "smallest that fits" would hand a 4B to a machine
  // that can comfortably run a 27B.
  const r = onCard(8);
  assert.match(r.candidate.filename, /Bonsai-2-27B-PTQ1_0/, `got ${r.candidate.filename}`);
});

test("the Bonsai rung scales down with the card instead of always taking the largest", () => {
  assert.match(onCard(4).candidate.filename, /Bonsai-8B/, "4 GB cannot hold a 5.5 GB 27B");
  assert.match(onCard(6).candidate.filename, /Bonsai-8B/);
  assert.match(onCard(12).candidate.filename, /Bonsai-2-27B/);
});

test("the 1-bit quant is preferred over the same model's 2-bit and F16", () => {
  // PTQ1_0 is why this family exists; picking PQ2_0 or F16 by generic quant
  // order would quietly discard the entire benefit.
  assert.equal(onCard(8).candidate.filename.includes("PTQ1_0"), true);
});

test("Bonsai is tested as DENSE — a 50 GB F16 must not pass on a 12 GB card", () => {
  // If the fit test reused the MoE rule (6 GB for an active set), F16 would
  // look acceptable on any card over that and the download would be 50 GB.
  const r = chooseModel({
    vramTotalBytes: 12 * GiB,
    vramFreeBytes: 12 * GiB,
    ramTotalBytes: 64 * GiB,
    candidates35b: ORNITH_35B,
    candidates9b: ORNITH_9B,
    bonsai: { "27B": [cand("r", "Ternary-Bonsai-2-27B-F16.gguf", 50.11 * GiB)] },
  });
  assert.ok(
    !r.candidate.filename.includes("F16"),
    `a 50 GB model must not be chosen on a 12 GB card, got ${r.candidate.filename}`
  );
});

test("without Bonsai candidates the Ornith-only decision is unchanged", () => {
  // A caller that never resolves Bonsai must keep the behaviour it had.
  const r = chooseModel({
    vramTotalBytes: 8 * GiB,
    vramFreeBytes: 8 * GiB,
    ramTotalBytes: 32 * GiB,
    candidates35b: ORNITH_35B,
    candidates9b: ORNITH_9B,
  });
  assert.equal(r.candidate.filename, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
});

test("an empty Bonsai map does not change the Ornith outcome", () => {
  const r = chooseModel({
    vramTotalBytes: 8 * GiB,
    vramFreeBytes: 8 * GiB,
    ramTotalBytes: 32 * GiB,
    candidates35b: ORNITH_35B,
    candidates9b: ORNITH_9B,
    bonsai: { "27B": [], "8B": [], "4B": [] },
  });
  assert.equal(r.candidate.filename, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
});

// ── A box too small for the 9B must not be handed it ───────────────────────

test("chooseModel: a 4 GB CPU-only machine gets a 1-bit Bonsai, not the 5.4 GiB 9B", () => {
  const GiB = 1024 ** 3;
  const c9 = [{ repo: "r", filename: "Ornith-1.5-9B-Q4_K_M.gguf", sizeBytes: 5.4 * GiB, url: "u" }];
  const bonsai = {
    "27B": [{ repo: "r", filename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", sizeBytes: 5.5 * GiB, url: "u" }],
    "8B": [{ repo: "r", filename: "Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 2.0 * GiB, url: "u" }],
    "4B": [{ repo: "r", filename: "Ternary-Bonsai-4B-PQ2_0.gguf", sizeBytes: 1.0 * GiB, url: "u" }],
  };
  const pick = (ramGiB: number) => chooseModel({
    vramTotalBytes: 0, vramFreeBytes: 0, ramTotalBytes: ramGiB * GiB, candidates35b: [], candidates9b: c9, bonsai,
  }).candidate.filename;
  assert.equal(pick(4), "Ternary-Bonsai-8B-PQ2_0.gguf");
  assert.equal(pick(2), "Ternary-Bonsai-4B-PQ2_0.gguf");
  // Enough RAM for the 9B (5.4 * 1.4 = 7.6) keeps the existing choice.
  assert.equal(pick(8), "Ornith-1.5-9B-Q4_K_M.gguf");
  assert.equal(pick(16), "Ornith-1.5-9B-Q4_K_M.gguf");
});

test("chooseModel: with no Bonsai available, a small box still gets the 9B rather than an error", () => {
  const GiB = 1024 ** 3;
  const c9 = [{ repo: "r", filename: "Ornith-1.5-9B-Q4_K_M.gguf", sizeBytes: 5.4 * GiB, url: "u" }];
  const c = chooseModel({ vramTotalBytes: 0, vramFreeBytes: 0, ramTotalBytes: 4 * GiB, candidates35b: [], candidates9b: c9 });
  assert.equal(c.candidate.filename, "Ornith-1.5-9B-Q4_K_M.gguf");
});

// ── the model the user SELECTED is the one that is downloaded ──────────────

import { pickPinnedCandidate, modelFamilyOf } from "./modelCatalog.js";

const cand2 = (filename: string, gib = 1): ModelCandidate => ({ repo: "r", filename, sizeBytes: gib * 1024 ** 3, url: "u" });

test("modelFamilyOf strips the quant and shard suffix", () => {
  assert.equal(modelFamilyOf("Ternary-Bonsai-8B-PTQ1_0.gguf"), "Ternary-Bonsai-8B");
  assert.equal(modelFamilyOf("Ternary-Bonsai-2-27B-PQ2_0.gguf"), "Ternary-Bonsai-2-27B");
  assert.equal(modelFamilyOf("Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "Ornith-1.5-35B-A3B");
  assert.equal(modelFamilyOf("Ternary-Bonsai-4B-Q2_0_g64.gguf"), "Ternary-Bonsai-4B");
  assert.equal(modelFamilyOf("Model-Q4_K_M-00001-of-00003.gguf"), "Model");
});

test("a selected 8B is never answered with the 27B — the field bug (picked #4, downloaded 5.5 GiB)", () => {
  const all = [
    cand2("Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5.5),
    cand2("Ternary-Bonsai-8B-F16.gguf", 15.3),
    cand2("Ternary-Bonsai-8B-PQ2_0.gguf", 2.0),
    cand2("Ternary-Bonsai-8B-Q2_0.gguf", 2.0),
    cand2("Ornith-1.5-9B-Q4_K_M.gguf", 5.1),
  ];
  const pick = pickPinnedCandidate(all, "Ternary-Bonsai-8B-PTQ1_0.gguf")!;
  assert.match(pick.filename, /^Ternary-Bonsai-8B-/);
  assert.ok(pick.sizeBytes < 3 * 1024 ** 3, "the small model, not the 5.5 GiB one");
  assert.ok(!pick.filename.includes("F16"), "and not the 15 GiB full-precision file when a quant exists");
});

test("an exact filename wins over a same-family substitute", () => {
  const all = [cand2("Ternary-Bonsai-8B-PQ2_0.gguf"), cand2("Ternary-Bonsai-8B-PTQ1_0.gguf")];
  assert.equal(pickPinnedCandidate(all, "Ternary-Bonsai-8B-PQ2_0.gguf")!.filename, "Ternary-Bonsai-8B-PQ2_0.gguf");
});

test("nothing in the family means null — never a different model", () => {
  assert.equal(pickPinnedCandidate([cand2("Ternary-Bonsai-2-27B-PTQ1_0.gguf")], "Ternary-Bonsai-8B-PTQ1_0.gguf"), null);
  assert.equal(pickPinnedCandidate([], "x.gguf"), null);
});

test("a 4B request does not match the 4B-adjacent names of other families, and mmproj files are ignored", () => {
  const all = [cand2("Ternary-Bonsai-4B-mmproj-Q8_0.gguf", 0.6), cand2("Ternary-Bonsai-4B-Q2_0.gguf", 1.0)];
  assert.equal(pickPinnedCandidate(all, "Ternary-Bonsai-4B-PTQ1_0.gguf")!.filename, "Ternary-Bonsai-4B-Q2_0.gguf");
});
