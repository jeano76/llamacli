/**
 * Fixed compaction fixtures (research prompt §5 / T0-5).
 *
 * Every compaction experiment in this project is judged on two axes — wall
 * clock and summary quality — and quality cannot be judged on a generated
 * conversation that changes every run. Without a fixed corpus, a "faster"
 * summary that quietly drops the user's constraints looks like a win, because
 * nothing ever checks what came out.
 *
 * These are HAND-WRITTEN slices shaped like a real `toSummarize` (system
 * prompt already excluded, tool calls and tool results already sanitized into
 * plain text by compactor.ts's sanitizeForSummary). Each carries facts that a
 * summary MUST preserve, so §3.3's four scoring questions have ground truth to
 * check against rather than a vibe.
 *
 * Not captured from a real session transcript: no session history is persisted
 * to disk (only checkpoints, which hold a summary rather than the messages
 * that produced it). These are therefore representative, not sampled — which
 * is a limitation, and the reason the scoring below checks for
 * PRESERVATION of stated facts rather than any property of real prose.
 */

export interface CompactionFixture {
  /** Stable id, referenced by measurement output. */
  id: string;
  /** What this fixture is for — a coverage note, not decoration: it is how you
   *  tell a summary-budget sweep covered distinct failure modes. */
  intent: string;
  /** Substrings that MUST survive into the summary. Scored verbatim. */
  /**
   * Facts a summary must preserve, each with the surface forms that count as
   * saying it. A bare string is shorthand for "this exact form and nothing
   * else"; the array form exists because a model preserves a fact without
   * reproducing its wording.
   *
   * Measured need: the summary pins the conversation's language now, so
   * cross-language paraphrase is gone — but Korean inflects, and the model wrote
   * "3번째 파일에서 중단" where the fixture says "3번 파일에서 중단". Scored as a
   * loss, for a fact that was plainly there. `forms` is how that is expressed
   * without pretending the scorer understands Korean.
   *
   * Deliberately explicit rather than a language model: variants have to be
   * declared and reviewed, so adding one is an auditable decision. A scorer that
   * guessed would silently widen until every budget scored 100%.
   */
  mustPreserve: (string | string[])[];
  /** The conversation, ready for runCompaction's `messages` parameter.
   *  Includes the system message at index 0, as runCompaction expects. */
  messages: { role: string; content: string }[];
}

const filler = (seed: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${seed} 항목 ${i}: 검토 후 반영 예정이었다.`).join("\n");

/** The tool-heavy shape that dominates real coding sessions: run_shell output,
 *  file reads, and edits. This is where a summary most easily loses the
 *  sequence of what was tried and what the results were. */
const toolHeavy: CompactionFixture = {
  id: "tool-heavy-shell-failures",
  intent: "실패한 테스트 출력과 그 원인이 된 파일 — 도구 호출이 많은 세션의 표준 형태",
  mustPreserve: [
    "npm test",
    "src/parse.ts:42",
    "total 12 중 11 passed",
  ],
  messages: [
    { role: "system", content: "You are a coding agent working in this repository." },
    { role: "user", content: "npm test가 실패하는데 원인을 찾아줘. 그리고 고쳐." },
    { role: "assistant", content: "[called tool run_shell with {\"command\":\"npm test\"}]\n테스트는 total 12 중 11 passed, 1 failed." },
    { role: "assistant", content: "[tool result] FAIL src/parse.test.ts\n\n  ✕ splits nested brackets\n\n    expect(received).toBe(expected)\n\n    Received: \"[a[b]]\"\n    Expected: \"[a[b]]\"\n      at Object.parse (src/parse.ts:42:11)\n" },
    { role: "assistant", content: "[tool result] at line 42 of src/parse.ts the closing bracket index is computed from the outer depth only, so a nested close is missed.\n" },
    { role: "assistant", content: "원인을 찾았다. src/parse.ts:42 의 닫는 괄호 인덱스 계산이 외부 깊이만 사용한다. 수정하겠다." },
    { role: "assistant", content: "[called tool write_file with {\"path\":\"src/parse.ts\"}]\n수정 완료.\n" },
    { role: "assistant", content: "수정 후 재실행 결과: 테스트는 total 12 중 12 passed. 모든 테스트 통과." },
    { role: "assistant", content: `작업 기록:\n${filler("이전", 40)}` },
  ],
};

/** A conversation whose value is almost entirely in stated constraints and
 *  decisions. This is the fixture that punishes an over-tight summary budget
 *  hardest, and the reason §3.3 exists. */
const constraints: CompactionFixture = {
  id: "user-constraints-and-decisions",
  intent: "사용자가 명시한 제약과 확정된 결정 — 요약 예산을 줄였을 때 가장 먼저 사라지는 것",
  mustPreserve: [
    "한국어로만 응답",
    "테스트를 추가하지 말 것",
    "PostgreSQL 15",
    "Redis 는 쓰지 않는다",
  ],
  messages: [
    { role: "system", content: "You are a coding agent. Follow the user's stated constraints exactly." },
    { role: "user", content: "제약이 몇 가지 있어. 하나씩 말할게.\n1. 한국어로만 응답해.\n2. 이 작업에서는 테스트를 추가하지 말 것.\n3. 데이터베이스는 PostgreSQL 15 로 간다." },
    { role: "assistant", content: "알겠습니다. 한국어로만 응답하고, 테스트는 추가하지 않으며, PostgreSQL 15 를 사용하겠습니다." },
    { role: "user", content: "그리고 캐시는 Redis 는 쓰지 않는다. 이미 있는 인메모리 캐시로 충분해." },
    { role: "assistant", content: "확인했습니다. Redis 는 쓰지 않고 인메모리 캐시만 사용하겠습니다." },
    { role: "user", content: "이제 스키마부터 만들어." },
    { role: "assistant", content: `스키마 설계 진행 중.\n${filler("설계", 30)}` },
    { role: "assistant", content: "테이블 3개(user, session, audit)로 구성했고 마이그레이션 파일을 만들었다." },
    { role: "assistant", content: `진행 기록:\n${filler("논의", 30)}` },
  ],
};

/** An unfinished task, mid-flight. The failure this catches is a summary that
 *  reads as if the work concluded — which costs more than losing the work,
 *  because the next turn will report completion of something that is not
 *  done. */
const inFlight: CompactionFixture = {
  id: "unfinished-task-in-flight",
  intent: "완료되지 않은 작업을 진행 중으로 — 요약이 완료처럼 읽히면 다음 턴이 거짓말을 보고한다",
  mustPreserve: [
    ["아직 수정 안 됨", "수정 안 됨", "아직 수정되지", "unmodified"],
    ["3번 파일에서 중단", "3번째 파일에서 중단", "3번 파일", "File 3"],
    ["다음 단계는 프로파일링", "프로파일링을 다시", "re-run profiling", "next step is to re-run profiling"],
  ],
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "렌더링 지연 문제를 전부 고쳐줘. 시간이 되면." },
    { role: "assistant", content: "분석을 시작했다. 렌더링 파이프라인의 병목 후보를 나열하겠다." },
    { role: "assistant", content: "[called tool read_file with {\"path\":\"src/render/pipeline.ts\"}]\n프로파일링 결과가 필요하다.\n" },
    { role: "assistant", content: "현재 상태: 1번 파일은 최적화 완료, 2번 파일은 부분 개선, 3번 파일은 아직 수정 안 됨. 여기서 중단되었다." },
    { role: "user", content: "계속 해." },
    { role: "assistant", content: "3번 파일부터 이어서 작업한다." },
    { role: "assistant", content: `중간 정리:\n${filler("관찰", 30)}` },
    { role: "assistant", content: "작업이 3번 파일에서 중단되어 있다. 다음 단계는 프로파일링을 다시 돌려 병목 지점을 특정하는 것이다. 아직 완료되지 않았다." },
  ],
};

/**
 * NOT a scored fixture — a helper that makes the scored ones big enough to be
 * summarized at all.
 *
 * `selectKeptTail` keeps a size-budgeted tail (DEFAULT_TAIL_BUDGET_FRACTION of
 * 75% of the window, minus the 25% reply reservation) and puts everything else
 * in `toSummarize`. An 8-message conversation is a few hundred tokens — far
 * under any of those budgets — so ALL of it lands in the kept tail,
 * `toSummarize` comes back EMPTY, and the summary request contains nothing but
 * the system message. The model then correctly answers "there is no prior
 * conversation to summarize", and every mustPreserve fact scores as lost.
 *
 * That is not a model failure and not a scoring failure; it is the fixture set
 * measuring nothing. Caught by running the corpus (every fixture scored 0%
 * retention, which is the shape of a harness bug, not of a summarizer losing
 * facts).
 *
 * So the fixtures are inflated with the same kind of padding a real session
 * accumulates — tool output, file listings, repeated build logs — until they
 * exceed the tail budget and the earlier, meaningful turns actually fall into
 * the summarized region. `assertFixturesAreSummarizable` enforces that, so a
 * future edit that shrinks a fixture fails loudly instead of silently
 * producing a corpus that measures nothing.
 */
export function withRealisticPadding(fixture: CompactionFixture): CompactionFixture {
  // Sized against the LARGEST window this is plausibly run against, not the
  // smallest. selectKeptTail's tail budget scales with the window (0.4 of 75%
  // of it), so padding sized for a 16k window is kept verbatim on a
  // 40960-token window and `toSummarize` comes back empty again.
//
// Bounded ABOVE as well, and that bound is not arbitrary. The conversation has
// to exceed the largest plausible tail budget (~12.3k tokens at window 40960) or
// nothing gets summarized — but it also has to leave room for the summary
// REQUEST itself, which runCompaction's input-trimming loop sizes against
// `contextWindowTokens - summaryMaxTokens - 512` using the char-based estimate.
// That estimate runs ~20% under the server's real tokenizer (measured: 65,946
// real tokens for a ~55k estimate), so a corpus sized to fill the window comes
// out ~20% over it and the backend hard-rejects the request with
// "exceeds the available context size" — a bench that cannot run, rather than
// one that reports bad numbers.
//
// The result below is ~30k estimated tokens: past any tail budget up to 40960,
// and well inside the summary request's own budget on the same window.
  const PAD_LINES = 480;
  const padMessage = {
    role: "assistant" as const,
    content: [
      `[tool result] build log line`,
      ...Array.from({ length: PAD_LINES }, (_, i) => `  [${String(i).padStart(4, "0")}] compiled target, 0 warnings, 2 cached`),
      `  (${"출력 줄 반복 ".repeat(20)})`,
    ].join("\n"),
  };
  // Interleave padding so it is spread through the conversation, which is what
  // a real session looks like — padding appended only at the end would let
  // selectKeptTail keep it in the tail and still leave the real turns
  // summarized, masking the very problem this is here to prevent.
  // Split the budget: padding on BOTH sides of the meaningful turns, so they end
  // up in the middle of the conversation — where a real session's decisions
  // live — rather than at the very end, which selectKeptTail keeps verbatim.
  const PAD_BEFORE = 2;
  const PAD_AFTER = 3;
  const padded: CompactionFixture["messages"] = [];
  // Keep the system message first; selectKeptTail excludes it from both halves.
  const [system, ...rest] = fixture.messages;
  padded.push(system);
  const splitAt = Math.max(1, Math.floor(rest.length / 2));
  for (let i = 0; i < splitAt; i++) padded.push(rest[i]);
  for (let i = 0; i < PAD_BEFORE; i++) padded.push({ ...padMessage });
  for (let i = splitAt; i < rest.length; i++) padded.push(rest[i]);
  for (let i = 0; i < PAD_AFTER; i++) {
    padded.push({ ...padMessage, content: padMessage.content + `\n[tool result] listing tail ${i}\n` });
  }
  return { ...fixture, messages: padded };
}

/** Long, low-value bulk: the case where a summary SHOULD compress hard, and
 *  where quality scoring has to be able to say "nothing important was here"
 *  rather than rewarding verbosity. Included so a sweep cannot conclude "more
 *  tokens is always better" from the other three alone. */
const bulk: CompactionFixture = {
  id: "low-value-bulk",
  intent: "압축해도 손해가 없는 대량 잡음 — 여기서 토큰을 아끼는 것이 정당",
  mustPreserve: ["설정 파일 이름은 app.config.ts"],
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "로그 파일 좀 정리해줘." },
    { role: "assistant", content: `로그 목록을 확인했다.\n${filler("로그", 200)}` },
    { role: "assistant", content: "정리 대상은 오래된 로그 파일들이다. 설정 파일 이름은 app.config.ts 이며 여기에는 손대지 않는다." },
    { role: "assistant", content: `목록 계속:\n${filler("로그", 200)}` },
  ],
};

/**
 * The scored corpus. Padded via withRealisticPadding so that `toSummarize` is
 * non-empty for every entry — without that, nothing is being summarized and
 * every score is a measurement of the harness rather than of the model.
 */
const paddedToolHeavy = withRealisticPadding(toolHeavy);
const paddedConstraints = withRealisticPadding(constraints);
const paddedInFlight = withRealisticPadding(inFlight);
const paddedBulk = withRealisticPadding(bulk);

export const COMPACTION_FIXTURES: CompactionFixture[] = [
  paddedToolHeavy,
  paddedConstraints,
  paddedInFlight,
  paddedBulk,
];

/**
 * §3.3's scoring. Deliberately mechanical and automatable so a sweep cannot
 * quietly change what "quality" means between budget settings — the failure
 * mode where a tighter budget looks worse simply because the grader changed.
 *
 * Returns a 0-1 retention score over the fixture's `mustPreserve` list, plus
 * the specific facts that were lost so a human can judge whether the lost ones
 * mattered.
 *
 * KNOWN LIMITATION — this measures VERBATIM retention, not semantic retention.
 * A summary that writes "3번째 파일은 아직 수정되지 않았다" does not match the
 * fixture's "아직 수정 안 됨" and scores as LOST, even though the fact
 * survived perfectly well in paraphrase.
 *
 * That limitation is why §5.9 could not interpret `unfinished-task-in-flight`
 * scoring 0/6: every budget, every repeat, perfectly consistent — which is the
 * signature of something structural, but "the model paraphrased" and "the model
 * dropped it" both produce exactly this. Reading the actual summary text is
 * the only way to tell them apart.
 *
 * Substring matching is kept anyway, deliberately: it is the only scoring that
 * is guaranteed to be identical across every budget and repeat, which is what
 * makes two rows comparable. A smarter scorer that understands paraphrase would
 * be better in isolation and useless for ranking, because its judgements would
 * not be stable enough to attribute a difference to the budget.
 *
 * What that limitation actually costs, measured in section 5.11: do not trust a low
 * Korean fixture without reading the summary. The `unfinished-task-in-flight`
 * scored 0/6 at every budget, consistently enough to look structural. It was
 * not. The model preserved all three facts, in English:
 *
 *   "아직 수정 안 됨"           -> "File 3 was unmodified"
 *   "3번 파일에서 중단"         -> "work was interrupted after File 3"
 *   "다음 단계는 프로파일링"     -> "the next step is to re-run profiling"
 *
 * So on a Korean corpus scored against verbatim Korean strings, this function
 * is largely a LANGUAGE DETECTOR: the model summarizes Korean prompts in
 * English, the match fails, and a perfectly good summary scores zero. Any
 * cross-budget comparison on these fixtures is measuring which runs happened
 * to quote Korean more, not which summarized better.
 *
 * Until the summary prompt pins the output language, treat retention on the
 * Korean fixtures as unreliable and read the text. That is also the reason a
 * language instruction in SUMMARY_INSTRUCTION is worth testing on its own
 * merits — a user who asked in Korean currently gets an English summary, and
 * the next turn inherits English.
 */
export function scoreSummary(fixture: CompactionFixture, summary: string): {
  retention: number;
  kept: string[];
  lost: string[];
} {
  const normalized = summary.replace(/\s+/g, " ").toLowerCase();
  const kept: string[] = [];
  const lost: string[] = [];
  for (const fact of fixture.mustPreserve) {
    // A declared variant set means "any of these says it". A bare string keeps
    // the strict original behaviour, so an existing fixture does not silently
    // become easier to score just by living in the same file as the ones that
    // use variants.
    const forms = typeof fact === "string" ? [fact] : fact;
    const label = forms[0];
    const hit = forms.some((f) => normalized.includes(f.replace(/\s+/g, " ").toLowerCase()));
    if (hit) kept.push(label);
    else lost.push(label);
  }
  return {
    retention: fixture.mustPreserve.length ? kept.length / fixture.mustPreserve.length : 1,
    kept,
    lost,
  };
}