/**
 * What the laya gate is allowed to decide, and what it is never allowed to
 * decide.
 *
 * ── Measured ground truth (2026-09-28, this box, live) ───────────────────────
 * The gate shipped with one semantics: laya answers "can you handle this
 * without a full reasoning turn?", and a "yes" SKIPS the model entirely.
 * Measured against a labelled 10-prompt set:
 *
 *     short-circuit rate ..................... 80.0%  (8/10)
 *     ... on prompts that need the real model . 66.7%
 *     ... on destructive prompts .............. 66.7%
 *     gate latency ............................ 0.11s mean
 *     answer produced by a "short-circuit" ... 0 characters
 *
 * So the shipped behaviour was: +0.11s per turn, and on 80% of turns the
 * request was swallowed whole. It accepted "delete every node_modules
 * directory recursively" with confidence 0.854 and "permanently delete all
 * git history and remote branches" with 0.72.
 *
 * Four differently-worded meta-questions were then tried against the same
 * labelled set, scoring how well each separates "truly trivial" from
 * "needs the real model" (skip-class mean − full-class mean, >0.25 usable):
 *
 *     "can you answer without reasoning?" ..... 0.190   no separation
 *     "does it need to read files?" ............ 0.183   no separation
 *     "is it routine and safe?" ............... 0.093   no separation
 *     "is it answerable from general knowledge?" 0.223  no separation
 *
 * The reason is structural, not a prompt-tuning failure: the judge is the
 * SAME 35B MoE the gate is trying to avoid calling (every role in
 * `~/.laya/settings.json` — router, stager, chat, trace, omni — points at
 * this app's own llama-server), and it is being asked a meta-question about a
 * request it has no ground truth for. Its confidence is not calibrated
 * either: it reported 0.993 for a wrong answer and 0.72 for "delete all git
 * history".
 *
 * ── Consequence ─────────────────────────────────────────────────────────────
 * "Skip the model" is not implementable here, so it is not implemented. A
 * skip has to be answered by *something*, and laya's `/v1/systemone` is a
 * calibration endpoint that returns probabilities, never text — so a skip
 * could only ever mean "produce no answer at all", which is what the shipped
 * code did.
 *
 * What the gate can honestly do is choose a REASONING BUDGET:
 *
 *   mode "system1" — same model, chain-of-thought off, tight token cap.
 *                    Fast, and still produces a real answer.
 *   mode "full"    — the normal turn, reasoning on.
 *
 * A wrong verdict now costs answer *quality*, not the answer. That is the
 * whole point: the previous design turned a miscalibration into data loss
 * (a silently dropped request), which is the one failure mode a coding agent
 * must never have.
 */

export type GateMode = "system1" | "full";

export interface GateDecision {
  mode: GateMode;
  /** Why, in one line, for the status bar. Never blank when the gate ran. */
  reason: string;
  /** The judge's own probability/confidence, for the diagnostics line. */
  conf: number;
  /**
   * True when the rail below overrode the judge. Worth showing: it means the
   * model asked for a cheap turn on something the rail refuses to let be
   * cheap, and the user should know the rail is what decided.
   */
  forced: boolean;
  /** The rail patterns that matched, for the same reason. */
  matched: string[];
}

/**
 * Requests the gate must never treat as cheap, regardless of what the judge
 * says.
 *
 * This is deliberately NOT a security control and does not pretend to be: it
 * cannot tell a safe delete from a dangerous one, and a determined phrasing
 * will slip past any regex list. It exists because the *specific* failure it
 * prevents is a 35B model confidently routing "permanently delete all git
 * history" down a path that skips the reasoning step — a single
 * miscalibration with a blast radius of "user's repository". Cheap insurance
 * against a narrow, observed failure, with an honest name.
 *
 * Patterns are matched case-insensitively against the user's own text and
 * cover the irreversible operations the tool set can actually perform:
 * recursive/bulk deletion, history rewriting, force operations, and changes
 * to system or service configuration.
 */
const HIGH_RISK_PATTERNS: { name: string; all: RegExp[] }[] = [
  {
    // Word ORDER IS NOT ASSUMED, deliberately. The first version of this was
    // written as one regex, `delete-ish … bulk-qualifier`, which silently only
    // worked in English: "recursively delete everything" puts the qualifier
    // before the verb, while Korean puts it after ("전부 삭제" / "재귀적으로
    // … 삭제"), so every Korean phrasing sailed straight through. A unit test
    // caught it; the fix is to require each signal to be PRESENT rather than
    // to require a particular sequence.
    name: "bulk delete",
    all: [
      /(\brm\s+-[a-z]*[rf]|remove|delete|삭제|지우|없애|정리)/i,
      /(\brecursiv|\ball\b|\beverything\b|\bwhole\b|전체|전부|모든|모두|\*)/i,
    ],
  },
  {
    // A delete that names a PATH, a dotfile, or a config/service file is risky
    // even when nothing says "all" — deleting one systemd unit or one .env is
    // not a bulk operation but is just as irreversible. Kept as its own
    // pattern because it is the one that catches a single, specific,
    // named-file deletion, which the bulk pattern above is structurally
    // blind to.
    name: "delete of a named path/config",
    all: [
      /(\brm\b|\bdel\b|remove|delete|삭제|지우|없애)/i,
      /(\.{1,2}\/|\/[\w.-]+\/|\.service\b|\.conf\b|\.sh\b|\.py\b|\.json\b|\.yaml\b|\.yml\b|\.env\b|\.md\b)/i,
    ],
  },
  { name: "history rewrite", all: [/\b(git\s+(push\s+--force|reset\s+--hard|filter-branch|filter-repo|clean\s+-[a-z]*f|reflog\s+expire)|rebase\s+--onto|커밋\s*(기록|삭제|이력))/i] },
  { name: "bulk VCS / publish", all: [/\b(git\s+(push|push\s+--all|push\s+--mirror|remote\s+remove)|npm\s+publish|gh\s+(pr|release)\s+(create|merge))/i] },
  { name: "system/service config", all: [/(\bsystemctl\b|\bsudo\b|\bchmod\b|\bchown\b|\bapt(-get)?\b|\bpip\s+install\b|\bmkfs\b|\bfdisk\b|\bdd\s+if=|\bshutdown\b|\breboot\b|systemctl\s|서비스\s*(설정|수정|삭제))/i] },
  { name: "credential/secret handling", all: [/(\.ssh\/|\.aws\/|\.env\b|id_rsa|\.gnupg|\.git-credentials|api[_-]?key|\bsecret\b|\bcredential|비밀키|인증서|키파일)/i] },
  { name: "database/production data", all: [/\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM|\bpsql\b|\bmysql\s+-u|\bredis-cli\b|데이터베이스\s*삭제)/i] },
  { name: "process kill / infrastructure", all: [/\b(killall|pkill|kill\s+-9|docker\s+(rm|down|system\s+prune)|\bkubectl\s+delete\b|terraform\s+(destroy|apply))/i] },
];

/** Names of the high-risk patterns `text` matches. Empty = not high risk. */
export function highRiskMatches(text: string): string[] {
  return HIGH_RISK_PATTERNS.filter((p) => p.all.every((re) => re.test(text))).map((p) => p.name);
}

/**
 * Turns one raw gate result into a mode.
 *
 * `judgeSaysCheap` is the laya verdict (a "yes" with sufficient confidence).
 * `text` is the user's request, checked against the rail.
 *
 * The rail wins over the judge, always. That ordering is the entire point —
 * see the module comment for the measurement that made it necessary.
 */
export function decideGate(input: {
  judgeSaysCheap: boolean;
  conf: number;
  text: string;
  /** Disabled by config; then the rail still applies but the judge is ignored. */
  judgeEnabled: boolean;
}): GateDecision {
  const matched = highRiskMatches(input.text);

  if (matched.length > 0) {
    return {
      mode: "full",
      reason: `gate: 위험 작업으로 판단되어 전체 턴 유지 (${matched.join(", ")})`,
      conf: input.conf,
      forced: true,
      matched,
    };
  }
  if (!input.judgeEnabled) {
    return { mode: "full", reason: "gate: 꺼짐 — 전체 턴", conf: input.conf, forced: false, matched };
  }
  if (input.judgeSaysCheap) {
    return {
      mode: "system1",
      reason: `gate: 간단한 요청으로 판단 (conf=${input.conf.toFixed(3)}) — 추론 없이 짧게 응답`,
      conf: input.conf,
      forced: false,
      matched,
    };
  }
  return {
    mode: "full",
    reason: `gate: 전체 턴 필요로 판단 (conf=${input.conf.toFixed(3)})`,
    conf: input.conf,
    forced: false,
    matched,
  };
}

/**
 * Token budget for a system1 turn. Small on purpose: the mode exists to
 * answer a one-or-two-sentence question, and a generous cap would let a
 * "simple" request quietly become a long generation — reintroducing the cost
 * the gate was supposed to avoid.
 *
 * Also the reason the mode is safe to guess wrong about: exceeding this
 * truncates the answer rather than looping or calling tools.
 */
export const SYSTEM1_MAX_TOKENS = 200;

/** Confidence a judge "yes" must clear before it may downgrade a turn. */
export const SYSTEM1_MIN_CONFIDENCE = 0.65;
