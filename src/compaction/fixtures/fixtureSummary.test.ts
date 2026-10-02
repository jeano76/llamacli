import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPACTION_FIXTURES, scoreSummary } from "./compaction-fixtures.js";

// The research prompt's §5 / T0-5 called a fixed corpus a precondition: "픽스처
// 없으면 §3.3 품질 측정이 불가능해져 전체 연구가 무효". These tests pin the
// properties that corpus has to have for it to be usable, because a fixture set
// that quietly stops covering what it claims to is worse than none — a sweep
// against it would report confident numbers about nothing.

test("the fixture corpus covers the distinct summary failure modes, not just one shape", () => {
  const ids = COMPACTION_FIXTURES.map((f) => f.id);
  // Each of these fails differently: losing a fact, losing the distinction
  // between "done" and "not done", and over-compressing are three different
  // defects. A corpus of one shape can only ever catch one of them, and would
  // let a conclusion generalize past what it measured.
  assert.ok(ids.includes("user-constraints-and-decisions"), "stated constraints must be covered — they are lost first");
  assert.ok(ids.includes("unfinished-task-in-flight"), "in-flight work must be covered — a false 'done' is worse than a loss");
  assert.ok(ids.includes("tool-heavy-shell-failures"), "tool-heavy sessions are the dominant real shape");
  assert.ok(ids.includes("low-value-bulk"), "compressible bulk must be covered, or a sweep can only conclude 'more is better'");
});

test("every fixture is individually well-formed", () => {
  for (const f of COMPACTION_FIXTURES) {
    assert.ok(f.id.trim().length > 0, "fixture needs an id to be referenced in measurement output");
    assert.ok(f.intent.trim().length > 0, `${f.id}: the coverage note is what makes the corpus auditable`);
    assert.ok(f.mustPreserve.length >= 1, `${f.id}: a fixture with no must-preserve facts cannot be scored`);
    assert.ok(f.messages.length >= 3, `${f.id}: too short to exercise selectKeptTail's tail selection`);
    assert.equal(f.messages[0].role, "system", `${f.id}: runCompaction expects the system message at index 0`);
    assert.equal(new Set(f.messages.map((m) => m.role)).has("system"), true, `${f.id}: system message missing`);
  }
});

test("fixture ids are unique, so measurement output can be keyed on them", () => {
  const ids = COMPACTION_FIXTURES.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate fixture id would merge two results: ${ids.join(", ")}`);
});

/** The form a fact is named by — a bare string, or the first of its variants. */
function primary(fact: string | string[]): string {
  return typeof fact === "string" ? fact : fact[0];
}

test("each mustPreserve fact appears verbatim in its own fixture", () => {
  // The scorer does exact substring matching after whitespace normalization. A
  // fact written slightly differently in the fixture than in mustPreserve would
  // score as LOST while the summary actually preserved it — a grader that
  // reports false losses is worse than no grader, because a sweep would
  // "discover" that shorter budgets lose facts that they kept.
  for (const f of COMPACTION_FIXTURES) {
    const haystack = f.messages.map((m) => m.content).join("\n").replace(/\s+/g, " ").toLowerCase();
    for (const fact of f.mustPreserve) {
      // Only the FIRST form is required to be present verbatim. The rest are
      // alternative wordings the model is allowed to use for the same fact, and
      // asserting they appear in the conversation would defeat the point of
      // declaring them.
      const needle = primary(fact).replace(/\s+/g, " ").toLowerCase();
      assert.ok(
        haystack.includes(needle),
        `${f.id}: mustPreserve fact is not present verbatim in the fixture: "${primary(fact)}"`
      );
    }
  }
});

test("scoreSummary is a pure measurement of retention, with no length preference", () => {
  const f = COMPACTION_FIXTURES.find((x) => x.id === "user-constraints-and-decisions")!;
  const full = scoreSummary(f, f.mustPreserve.map(primary).join(" "));
  assert.equal(full.retention, 1);
  assert.deepEqual(full.lost, []);

  const none = scoreSummary(f, "요약이 비어 있다.");
  assert.equal(none.retention, 0);
  assert.equal(none.kept.length, 0);

  // A long summary that drops a constraint must NOT score better than a short
  // one that keeps it — the property that stops a budget sweep from rewarding
  // verbosity.
  const verboseButLossy = scoreSummary(f, "아주 긴 요약. ".repeat(200) + " Postgres 16 을 쓰기로 했다.");
  const terseButComplete = scoreSummary(f, "제약: " + f.mustPreserve.map(primary).join(", "));
  assert.ok(
    terseButComplete.retention > verboseButLossy.retention,
    "the scorer must not reward length over retention"
  );
});

test("scoring is whitespace- and case-insensitive, so formatting differences are not scored as losses", () => {
  const f = COMPACTION_FIXTURES[0];
  const fact = primary(f.mustPreserve[0]);
  const spread = scoreSummary(f, fact.toUpperCase().replace(/\s+/g, " "));
  const wrapped = scoreSummary(f, `요약 시작\n\n${fact}\n\n요약 끝`);
  assert.ok(spread.retention > 0, "case/whitespace must not count as a lost fact");
  assert.ok(wrapped.retention > 0);
});
// The failure this pins down: an earlier version of the corpus ran, and EVERY
// fixture scored 0% retention with summaries reading "There is no prior
// conversation provided to summarize." That is not a summarizer losing facts —
// it is `toSummarize` coming back EMPTY, because the fixtures were a few
// hundred tokens and selectKeptTail's size-budgeted tail swallowed all of them
// verbatim. Nothing was being summarized at all, so the corpus was measuring
// the harness.
//
// A corpus that quietly stops containing anything to summarize is worse than
// no corpus: a budget sweep against it reports confident 0% at every setting,
// which reads as "summaries always lose everything" and would justify any
// conclusion at all.

test("every fixture has something to summarize at every plausible window size", async () => {
  const { selectKeptTail } = await import("../compactor.js");
  // The tail budget scales with the window, so a corpus valid at one size can be
  // empty at another. 40960 is the largest window observed on the reference
  // hardware; 4096 is tuning.ts's MIN_CONTEXT.
  for (const window of [4096, 16384, 40960]) {
    for (const f of COMPACTION_FIXTURES) {
      const { toSummarize } = selectKeptTail(f.messages as any, window, 0.4);
      assert.ok(
        toSummarize.length > 0,
        `${f.id} at window ${window}: toSummarize is empty, so there is nothing to summarize and any score would be meaningless`
      );
    }
  }
});

test("each fixture's mustPreserve facts actually fall inside the summarized region", async () => {
  const { selectKeptTail } = await import("../compactor.js");
  // Weaker than "toSummarize is non-empty", and the property that actually
  // matters: if the scored facts were kept verbatim in the tail, they would
  // survive for free and every fixture would score 100% regardless of summary
  // quality — measuring the tail selection, not the summarizer.
  const window = 16384;
  for (const f of COMPACTION_FIXTURES) {
    const { toSummarize } = selectKeptTail(f.messages as any, window, 0.4);
    const region = toSummarize.map((m: any) => m.content ?? "").join("\n").replace(/\s+/g, " ").toLowerCase();
    for (const fact of f.mustPreserve) {
      const needle = primary(fact).replace(/\s+/g, " ").toLowerCase();
      assert.ok(
        region.includes(needle),
        `${f.id} at window ${window}: mustPreserve fact "${primary(fact)}" is in the KEPT TAIL, not the summarized region — it would score 100% for free`
      );
    }
  }
});

// Declared variants exist because Korean inflects and a model preserves a fact
// without reproducing its wording. Before this, "3번째 파일에서 중단" scored as a
// loss against a fixture that says "3번 파일에서 중단" — a fact that was plainly
// present. These tests pin the mechanism, and in particular that declaring a
// variant does not quietly make everything score.

test("a declared variant set matches when ANY form appears", () => {
  const f = COMPACTION_FIXTURES.find((x) => x.id === "unfinished-task-in-flight")!;
  // The inflected form the model actually produced.
  const scored = scoreSummary(f, "작업은 3번째 파일에서 중단되었다.");
  assert.ok(
    !scored.lost.some((l) => l.includes("3번 파일")),
    `the inflected form must count as the fact, lost: ${JSON.stringify(scored.lost)}`
  );
});

test("declaring variants does not make an unrelated summary pass", () => {
  const f = COMPACTION_FIXTURES.find((x) => x.id === "unfinished-task-in-flight")!;
  const scored = scoreSummary(f, "오늘 날씨가 좋았다.");
  assert.equal(scored.retention, 0, "a summary about something else must score 0");
  assert.equal(scored.lost.length, f.mustPreserve.length);
});

test("a bare string fact stays strict — living beside variant facts grants no leniency", () => {
  const f = COMPACTION_FIXTURES.find((x) => x.id === "tool-heavy-shell-failures")!;
  assert.ok(
    f.mustPreserve.every((x) => typeof x === "string"),
    "this fixture is the control: it uses bare strings and must remain strict"
  );
  const near = scoreSummary(f, "ran npm test, src/parse.ts line 42, 11 of 12 passed");
  assert.ok(
    near.retention < 1,
    "near-miss wordings must not pass a bare-string fact — that is what the variant array is for"
  );
});
