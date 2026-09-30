import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, ORNITH_35B_REPO, ORNITH_9B_REPO, listGgufFiles } from "./modelCatalog.js";

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
