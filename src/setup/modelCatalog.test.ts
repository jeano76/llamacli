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

// ── the ladder ──────────────────────────────────────────────────────────────

const cand = (repo: string, filename: string, sizeBytes: number): ModelCandidate => ({
  repo,
  filename,
  sizeBytes,
  url: "",
});
const GiB = 1024 ** 3;

const ORNITH_35B = [cand("ornith-ai/Ornith-1.5-35B-A3B-GGUF", "Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21.86 * GiB)];
const ORNITH_9B = [cand("ornith-ai/Ornith-1.5-9B-GGUF", "Ornith-1.5-9B-Q4_K_M.gguf", 5.5 * GiB)];

test("an 8 GB card with enough RAM picks the Ornith 35B", () => {
  const r = chooseModel({
    vramTotalBytes: 8 * GiB,
    vramFreeBytes: 8 * GiB,
    ramTotalBytes: 32 * GiB,
    candidates35b: ORNITH_35B,
    candidates9b: ORNITH_9B,
  });
  assert.equal(r.candidate.filename, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
});

// ── A box too small for the 9B still gets it, with a warning ───────────────

test("chooseModel: with no GPU and 4 GB RAM, the 9B is still chosen rather than an error", () => {
  const c9 = [{ repo: "r", filename: "Ornith-1.5-9B-Q4_K_M.gguf", sizeBytes: 5.4 * GiB, url: "u" }];
  const c = chooseModel({ vramTotalBytes: 0, vramFreeBytes: 0, ramTotalBytes: 4 * GiB, candidates35b: [], candidates9b: c9 });
  assert.equal(c.candidate.filename, "Ornith-1.5-9B-Q4_K_M.gguf");
});

// ── the model the user SELECTED is the one that is downloaded ──────────────

import { pickPinnedCandidate, modelFamilyOf } from "./modelCatalog.js";

const cand2 = (filename: string, gib = 1): ModelCandidate => ({ repo: "r", filename, sizeBytes: gib * 1024 ** 3, url: "u" });

test("modelFamilyOf strips the quant and shard suffix", () => {
  assert.equal(modelFamilyOf("Ornith-1.5-9B-Q8_0.gguf"), "Ornith-1.5-9B");
  assert.equal(modelFamilyOf("Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "Ornith-1.5-35B-A3B");
  assert.equal(modelFamilyOf("Ornith-1.5-9B-Q2_0_g64.gguf"), "Ornith-1.5-9B");
  assert.equal(modelFamilyOf("Model-Q4_K_M-00001-of-00003.gguf"), "Model");
});

test("a selected 9B is never answered with the 35B — the field bug (picked the small one, downloaded the big one)", () => {
  const all = [
    cand2("Ornith-1.5-35B-A3B-Q4_K_M.gguf", 21.9),
    cand2("Ornith-1.5-9B-F16.gguf", 17.9),
    cand2("Ornith-1.5-9B-Q4_K_M.gguf", 5.1),
    cand2("Ornith-1.5-9B-Q2_K.gguf", 3.5),
  ];
  const pick = pickPinnedCandidate(all, "Ornith-1.5-9B-Q8_0.gguf")!;
  assert.match(pick.filename, /^Ornith-1\.5-9B-/);
  assert.ok(pick.sizeBytes < 6 * 1024 ** 3, "the small model, not the 21.9 GiB one");
  assert.ok(!pick.filename.includes("F16"), "and not the full-precision file when a quant exists");
});

test("an exact filename wins over a same-family substitute", () => {
  const all = [cand2("Ornith-1.5-9B-Q4_K_M.gguf"), cand2("Ornith-1.5-9B-Q8_0.gguf")];
  assert.equal(pickPinnedCandidate(all, "Ornith-1.5-9B-Q4_K_M.gguf")!.filename, "Ornith-1.5-9B-Q4_K_M.gguf");
});

test("nothing in the family means null — never a different model", () => {
  assert.equal(pickPinnedCandidate([cand2("Ornith-1.5-35B-A3B-Q4_K_M.gguf")], "Ornith-1.5-9B-Q4_K_M.gguf"), null);
  assert.equal(pickPinnedCandidate([], "x.gguf"), null);
});

test("mmproj files are ignored when matching a pinned family", () => {
  const all = [cand2("Ornith-1.5-9B-mmproj-Q8_0.gguf", 0.6), cand2("Ornith-1.5-9B-Q4_K_M.gguf", 5.1)];
  assert.equal(pickPinnedCandidate(all, "Ornith-1.5-9B-Q8_0.gguf")!.filename, "Ornith-1.5-9B-Q4_K_M.gguf");
});
