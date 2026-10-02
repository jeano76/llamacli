/**
 * Did pinning the summary language actually change what the model writes?
 *
 * Everything about this change rests on one claim: a Korean conversation
 * summarized in English because SUMMARY_INSTRUCTION was English-only. That is
 * checkable directly — run the same fixture and look at the output language.
 *
 * Also measures the second thing this change might affect: summary LENGTH.
 * Generated token count is the only variable that has been shown to drive
 * compaction latency (the budget is only a ceiling and the model does not
 * reach it), so if pinning the language changes how much text is generated,
 * that is a latency effect worth knowing about.
 *
 * Requires an idle inference slot, like the rest of the measurement scripts.
 */
import { OpenAICompatibleClient } from "../src/backend/openaiClient.js";
import { runCompaction } from "../src/compaction/compactor.js";
import { COMPACTION_FIXTURES, scoreSummary } from "../src/compaction/fixtures/compaction-fixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.LLAMA_URL ?? "http://127.0.0.1:8084";

/** Crude but decisive: is this text mostly Hangul, or not? Counts letters only,
 *  so markdown punctuation and code identifiers cannot tip the balance. */
function hangulRatio(text: string): number {
  let hangul = 0;
  let letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7af) hangul++;
    if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a)) letters++;
  }
  return letters ? hangul / letters : 0;
}

async function slotBusy(): Promise<boolean> {
  try {
    const s: any[] = await fetch(`${LIVE}/slots`).then((r) => r.json());
    return Boolean(s?.[0]?.is_processing);
  } catch {
    return false;
  }
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

  console.log(`live ${LIVE}, window ${window}\n`);
  console.log("Each fixture's conversation is Korean. hangul% is the fraction of letters");
  console.log("in the SUMMARY that are Hangul — before this change it was near 0.\n");
  console.log(`  ${"fixture".padEnd(30)} ${"hangul%".padStart(8)} ${"chars".padStart(7)} ${"ms".padStart(7)}  notes`);

  for (const fixture of COMPACTION_FIXTURES) {
    if (await slotBusy()) {
      console.log(`  [skip] ${fixture.id}: slot busy`);
      continue;
    }
    const dir = await mkdtemp(join(tmpdir(), "lang-"));
    try {
      const t0 = Date.now();
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
      const ms = Date.now() - t0;
      const ratio = hangulRatio(r.detail.summary);
      const scored = scoreSummary(fixture, r.detail.summary);
      console.log(
        `  ${fixture.id.padEnd(30)} ${(ratio * 100).toFixed(0).padStart(7)}% ${String(r.detail.summary.length).padStart(7)} ${String(ms).padStart(7)}  ` +
          `verbatim retention ${(scored.retention * 100).toFixed(0)}%` +
          (scored.lost.length ? ` (lost: ${scored.lost.length})` : "")
      );
      if (process.env.DUMP) {
        console.log(`\n    ${r.detail.summary.slice(0, 420).replace(/\n/g, "\n    ")}\n`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("\nReading this:");
  console.log("  hangul% near 0  -> the model still summarizes in English; the instruction is not");
  console.log("                     working and should be reverted rather than kept on faith.");
  console.log("  hangul% high    -> summaries now follow the conversation's language.");
  console.log("\n  verbatim retention is expected to RISE now, and that is a measurement fix,");
  console.log("  not a quality win: the Korean facts were always preserved, they were just");
  console.log("  scored against Korean substrings in an English summary. Section 5.11.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});