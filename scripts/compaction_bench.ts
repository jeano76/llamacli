/**
 * T3: sweep the summary budget and measure wall clock AND fact retention.
 *
 * The research prompt (§5 T0-5, §3.3) is explicit that a latency number alone
 * cannot decide anything about compaction: a smaller budget that quietly drops
 * the user's constraints is not a win. So this runs the real
 * runCompaction() against a live server, over the fixed fixture corpus, and
 * reports both axes per budget.
 *
 * Every measurement verifies the inference slot is idle first. With `-np 1`
 * there is one decode slot, and a concurrent session silently halves throughput
 * while also shortening every request (which inflates apparent tok/s) — see
 * §5.6. Contended samples are skipped, not reported.
 *
 * Usage: tsx scripts/compaction_bench.ts [budget1 budget2 ...]
 *   LLAMA_URL overrides the backend (default http://127.0.0.1:8084)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleClient } from "../src/backend/openaiClient.js";
import { runCompaction } from "../src/compaction/compactor.js";
import { COMPACTION_FIXTURES, scoreSummary, type CompactionFixture } from "../src/compaction/fixtures/compaction-fixtures.js";
import type { ChatMessage } from "../src/backend/types.js";

const BASE = process.env.LLAMA_URL ?? "http://127.0.0.1:8084";
const REPEATS = Number(process.env.REPEATS ?? 1);

interface SlotState {
  is_processing: boolean;
  id_task: number;
}

/** True only if the single inference slot is demonstrably free right now. */
async function slotIdle(): Promise<{ idle: boolean; state: SlotState | null; note: string }> {
  try {
    const slots: any[] = await fetch(`${BASE}/slots`).then((r) => r.json());
    const s = slots?.[0];
    if (!s) return { idle: false, state: null, note: "no /slots (non-llama.cpp backend — cannot verify idleness)" };
    return {
      idle: !s.is_processing,
      state: { is_processing: !!s.is_processing, id_task: s.id_task ?? 0 },
      note: s.is_processing ? "slot busy — another session is decoding" : "slot idle",
    };
  } catch (e: any) {
    return { idle: false, state: null, note: `slot check failed: ${e?.message ?? e}` };
  }
}

function estimateTokensOf(messages: { content: string }[]): number {
  // Same shape as compactor's own estimate, kept local so the script does not
  // perturb the memo the production code shares.
  let cjk = 0;
  let total = 0;
  for (const m of messages) {
    const t = m.content ?? "";
    total += t.length;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    }
  }
  return Math.ceil(cjk * 1.5 + (total - cjk) * 0.25);
}

async function runOnce(
  client: OpenAICompatibleClient,
  fixture: CompactionFixture,
  budget: number,
  window: number
): Promise<{ ms: number; retention: number; lost: string[]; summary: string; inputTokens: number }> {
  const dir = await mkdtemp(join(tmpdir(), "bench-"));
  try {
    const messages = fixture.messages as unknown as ChatMessage[];
    const before = await slotIdle();
    const t0 = Date.now();
    const r = await runCompaction(
      dir,
      messages,
      client,
      "local",
      { reason: "manual", goal: "g", steps: [], files: [], pendingToolCall: null, mustPreserve: [] },
      window,
      undefined,
      budget
    );
    const ms = Date.now() - t0;
    void before;
    const scored = scoreSummary(fixture, r.detail.summary);
    return {
      ms,
      retention: scored.retention,
      lost: scored.lost,
      summary: r.detail.summary,
      inputTokens: estimateTokensOf(fixture.messages),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * §5.8: wall clock here measures PREFILL, not decode, unless the fixture is warm.
 *
 * runCompaction's summary request is a VERBATIM PREFIX of the turn that just
 * ran, which is exactly why production prefill is ~0.3 s (compactor.ts's
 * cache-prefix design). Calling runCompaction directly, with no preceding turn,
 * throws that property away: each fixture's ~19k-token prefill runs COLD once
 * and is served from llama-server's prompt cache on every later run.
 *
 * The first sweep measured exactly that and produced an impossible-looking
 * table — a 256-token budget appearing SLOWER (72-92 s) than a 1024-token one
 * (5 s), because the 256 rows were all cold and the 1024 rows all warm.
 *
 * So: warm the fixture first (discarded), then measure. The warmup cost is
 * recorded separately so it is never confused with the decode number.
 */
async function warmFixture(
  client: OpenAICompatibleClient,
  fixture: CompactionFixture,
  budget: number,
  window: number
): Promise<number> {
  const t0 = Date.now();
  await runOnce(client, fixture, budget, window);
  return Date.now() - t0;
}

async function main() {
  const budgets = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const budgetsToTest = budgets.length ? budgets : [256, 512, 1024];

  const client = new OpenAICompatibleClient(BASE);
  let window = 16384;
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    window = await client.getContextSize();
  } catch {
    console.error(`no llama.cpp server at ${BASE} (LLAMA_URL overrides)`);
    process.exit(1);
  }

  console.log(`backend ${BASE}, per-slot window ${window}, repeats ${REPEATS}\n`);

  const rows: {
    budget: number;
    fixture: string;
    ms: number;
    retention: number;
    lost: string[];
    skipped?: string;
  }[] = [];

  for (const budget of budgetsToTest) {
    for (const fixture of COMPACTION_FIXTURES) {
      // Warm up (discarded): pay the cold prefill once so every measured run
      // below is a decode measurement rather than a cache-fill measurement.
      const slot0 = await slotIdle();
      if (!slot0.idle) {
        console.log(`  [skip] ${fixture.id} @${budget}: ${slot0.note}`);
        rows.push({ budget, fixture: fixture.id, ms: NaN, retention: NaN, lost: [], skipped: slot0.note });
        continue;
      }
      const warmupMs = await warmFixture(client, fixture, budget, window);

      for (let rep = 0; rep < REPEATS; rep++) {
        const slot = await slotIdle();
        if (!slot.idle) {
          console.log(`  [skip] ${fixture.id} @${budget} rep${rep + 1}: ${slot.note}`);
          rows.push({ budget, fixture: fixture.id, ms: NaN, retention: NaN, lost: [], skipped: slot.note });
          continue;
        }
        const r = await runOnce(client, fixture, budget, window);
        rows.push({ budget, fixture: fixture.id, ms: r.ms, retention: r.retention, lost: r.lost });
        const pct = (r.retention * 100).toFixed(0);
        console.log(
          `  ${fixture.id.padEnd(30)} @${String(budget).padStart(5)} tok  ${String(r.ms).padStart(6)} ms  ` +
            `retention ${pct.padStart(3)}%   (warmup ${warmupMs} ms, discarded)` +
            (r.lost.length ? `  lost: ${r.lost.join(" / ")}` : "")
        );
      }
    }
  }

  // ---- summary table -----------------------------------------------------
  console.log("\n=== T3 summary: budget vs latency vs retention ===\n");
  console.log("budget   fixture                       median ms   retention   notes");
  for (const budget of budgetsToTest) {
    const forBudget = rows.filter((r) => r.budget === budget && !r.skipped);
    if (!forBudget.length) {
      console.log(`${String(budget).padStart(6)}   (no uncontended samples)`);
      continue;
    }
    for (const f of COMPACTION_FIXTURES) {
      const rs = forBudget.filter((r) => r.fixture === f.id);
      if (!rs.length) continue;
      const times = rs.map((r) => r.ms).sort((a, b) => a - b);
      const med = times[Math.floor(times.length / 2)];
      const ret = rs.reduce((n, r) => n + r.retention, 0) / rs.length;
      const lostAll = [...new Set(rs.flatMap((r) => r.lost))];
      console.log(
        `${String(budget).padStart(6)}   ${f.id.padEnd(28)} ${String(med).padStart(8)}   ` +
          `${(ret * 100).toFixed(0).padStart(8)}%   ${lostAll.join(", ") || "-"}`
      );
    }
  }

  const skipped = rows.filter((r) => r.skipped).length;
  if (skipped) {
    console.log(`\n${skipped} sample(s) skipped for slot contention. Contended samples are dropped,`);
    console.log("not averaged in — they inflate apparent throughput and shorten every request.");
  }
  console.log("\nRead retention alongside latency: a budget that halves wall clock while");
  console.log("dropping a stated constraint is a regression, not a win.");
  console.log("\nBefore trusting a trend here:");
  console.log("  - every measured run is WARM (cold prefill is discarded above); the ms column is");
  console.log("    decode time, which is what production pays thanks to compactor.ts's cache-prefix");
  console.log("    reuse of the previous turn.");
  console.log("  - retention still carries SAMPLING noise: runCompaction sends no temperature, so");
  console.log("    this server samples at its default (measured 1.0). A single repeat per fixture is");
  console.log("    not enough to rank budgets — use REPEATS=5 and treat small gaps as ties.");
  console.log("    Retention that is not monotonically non-decreasing in budget means noise, not signal.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});