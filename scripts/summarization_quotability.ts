/**
 * Minimal, obviously-correct probe: how much of a real compaction summary is
 * quotable from its own input?
 *
 * This is the question that decides T1. llama.cpp's ngram-mod speculator
 * (common/speculative.cpp:1925-1972) indexes every n-gram of the prompt and,
 * at each generated position, proposes whatever followed the same n-gram
 * earlier. If the summary were quoting its input, that lookup would fire often.
 * If the model is paraphrasing, it will not.
 *
 * Deliberately no simulation framework here: the earlier version of this probe
 * reported 0% and it took a separate control test to prove the 0% was real
 * rather than a harness bug. Simpler is worth more here than clever.
 */
import { OpenAICompatibleClient } from "/home/jeano/llamacli/src/backend/openaiClient.js";
import { runCompaction } from "../src/compaction/compactor.js";
import { COMPACTION_FIXTURES } from "../src/compaction/fixtures/compaction-fixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.LLAMA_URL ?? "http://127.0.0.1:8084";

/** Every n-gram window of `text` as a Set. */
function windows(text: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
  return out;
}

/** Fraction of the summary's n-gram windows that also occur in the prompt. */
function quotable(summary: string, prompt: string, n: number): number {
  if (summary.length < n) return 0;
  const table = windows(prompt, n);
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= summary.length; i++) {
    total++;
    if (table.has(summary.slice(i, i + n))) hit++;
  }
  return total ? hit / total : 0;
}

async function main() {
  const client = new OpenAICompatibleClient(LIVE);
  let window = 16384;
  try {
    await fetch(`${LIVE}/health`, { signal: AbortSignal.timeout(3000) });
    window = await client.getContextSize();
  } catch {
    console.log(`no server at ${LIVE}`);
    return;
  }

  // Control: the prompt quotes ITSELF (the padding is one repeated line), so a
  // working implementation must show a high number here. If this row is ~0%,
  // the probe is broken and every other row is meaningless.
  const controlFixture = COMPACTION_FIXTURES[0];
  const controlPrompt = controlFixture.messages.map((m) => m.content).join("\n");
  const controlSelf = quotable(controlPrompt.slice(-6000), controlPrompt, 16);
  console.log(`CONTROL (prompt vs itself, n=16 chars): ${(controlSelf * 100).toFixed(1)}%  <- must be high\n`);

  const sizes = [8, 12, 16, 24, 32];
  console.log(`quotable fraction of the summary, by n-gram window size`);
  console.log(`(llama.cpp counts TOKENS; these are CHARACTERS, so for English these`);
  console.log(` windows are ~4x shorter than the real thing -> optimistic, not pessimistic)\n`);
  console.log("  fixture                        summary   " + sizes.map((n) => `n=${n}`.padStart(7)).join(""));
  console.log("  " + "-".repeat(30) + "  " + "-".repeat(8) + "  " + sizes.map(() => "-------").join(""));

  for (const fixture of COMPACTION_FIXTURES) {
    const dir = await mkdtemp(join(tmpdir(), "probe-"));
    try {
      const r = await runCompaction(
        dir,
        fixture.messages as any,
        client,
        "local",
        { reason: "manual", goal: "g", steps: [], files: [], pendingToolCall: null, mustPreserve: [] },
        window,
        undefined,
        1024
      );
      const summary = r.detail.summary;
      const prompt = fixture.messages.map((m) => m.content).join("\n");
      const row = sizes.map((n) => `${(quotable(summary, prompt, n) * 100).toFixed(0)}%`.padStart(7)).join("");
      console.log(`  ${fixture.id.padEnd(30)} ${String(summary.length).padStart(6)}ch  ${row}`);

      if (process.env.DUMP) {
        console.log(`\n    --- summary ---\n    ${summary.replace(/\n/g, "\n    ")}\n    --- end ---`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("\nWhat this decides:");
  console.log("  ngram-mod proposes only when the exact window it is holding has been seen");
  console.log("  before. A near-0% row at every window size means the model is PARAPHRASING");
  console.log("  its input, not quoting it — so the speculator has nothing to propose and T1");
  console.log("  (n-gram/suffix speculative decoding for the compaction summary) has no basis");
  console.log("  here. A high row would justify a real A/B on a second server.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});