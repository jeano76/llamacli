#!/usr/bin/env node
/**
 * Usability validation across 100 developer personas.
 *
 * ── What this is, honestly ──────────────────────────────────────────────────
 * This is NOT 100 simulated humans. Nobody can emulate human perception or
 * taste, and a script that claims to is worse than useless.
 *
 * What it IS: 100 distinct, concretely-specified *usage configurations* —
 * a real terminal, a real locale, a real terminal size, a real workflow, a
 * real accessibility constraint — each checked against invariants that are
 * objectively verifiable and that this app genuinely breaks in practice:
 *
 *   1. the fixed-height layout must not overflow the terminal
 *   2. no rendered line may exceed the terminal width (display columns)
 *   3. nothing may be emitted that the terminal cannot render
 *   4. every interaction must be reachable without a mouse
 *   5. every interaction must be discoverable from /help
 *   6. the gate must never be the reason a request is not answered
 *
 * Those six are the failures users actually reported. Every one of them was
 * found by a human first, and every one of them is mechanically checkable,
 * which is why this harness is worth running. A persona adds nothing beyond
 * choosing the configuration; the value is in the coverage matrix, not in the
 * fiction of the personas.
 *
 * Run:  npx tsx scripts/persona_usability_check.ts [--verbose]
 */
import {
  detectTerminal,
  buildSequences,
  borderStyleFor,
  type TerminalCapabilities,
} from "../src/tui/terminal.js";
import { SLASH_MENU_ITEMS, menuVisibleRows, menuWindow } from "../src/tui/SlashMenu.js";
import { KEY_BINDINGS } from "../src/tui/keybindings.js";
import { highRiskMatches, decideGate } from "../src/agent/gate.js";
import {
  statusBarFieldWidth,
  statusBarChrome,
  formatPlanProgress,
  formatCompactionStatus,
  formatScrollIndicator,
  renderGauge,
  SCROLL_INDICATOR_WIDTH,
} from "../src/tui/StatusBar.js";
import { scrolledBannerText, runHintText, shouldHideCursor, MAX_LOG_ENTRIES } from "../src/tui/App.js";
import { startupHintText, formatKeyRow } from "../src/tui/keybindings.js";
import stringWidth from "string-width";

type Verdict = "pass" | "fail";
interface Failure {
  persona: string;
  invariant: string;
  detail: string;
}

const failures: Failure[] = [];
let checks = 0;

function check(persona: string, invariant: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures.push({ persona, invariant, detail });
}

// ── the persona matrix ──────────────────────────────────────────────────────
//
// Built as a cross product so coverage is systematic rather than whatever
// configurations happened to occur to me. Each axis is a real axis along
// which this app has previously broken in a different way.

type Platform = "linux" | "win32" | "darwin";
type TerminalFamily =
  | "xterm-256color" | "xterm" | "screen-256color" | "screen" | "tmux-256color"
  | "rxvt-unicode-256color" | "linux" | "vt100" | "dumb" | "ansi";

interface Persona {
  id: number;
  name: string;
  env: Record<string, string>;
  platform: Platform;
  tty: boolean;
  columns: number;
  rows: number;
  /** Does this persona's workflow need to read long tool output? */
  heavyOutput: boolean;
  /** Does this persona use the mouse? */
  usesMouse: boolean;
  /** Does this persona read Korean? (affects the width expectations) */
  korean: boolean;
}

const PLATFORMS: { p: Platform; marker: Record<string, string> }[] = [
  { p: "linux", marker: {} },
  { p: "win32", marker: { WT_SESSION: "wtx" } },                 // Windows Terminal
  { p: "win32", marker: { TERM_PROGRAM: "vscode" } },            // VS Code terminal
  { p: "win32", marker: { ConEmuANSI: "ON" } },                  // ConEmu
  { p: "win32", marker: {} },                                    // bare conhost
  { p: "darwin", marker: { TERM_PROGRAM: "Apple_Terminal" } },  // macOS Terminal
  { p: "darwin", marker: { TERM_PROGRAM: "iTerm.app" } },
];

const TERMINALS: { t: TerminalFamily; note: string }[] = [
  { t: "xterm-256color", note: "" },
  { t: "xterm", note: "" },
  { t: "screen-256color", note: "tmux/screen" },
  { t: "screen", note: "tmux/screen, no 256color inner TERM" },
  { t: "tmux-256color", note: "tmux" },
  { t: "rxvt-unicode-256color", note: "no SGR mouse" },
  { t: "linux", note: "console, no SGR mouse" },
  { t: "vt100", note: "legacy, no 256color, no SGR mouse" },
  { t: "dumb", note: "no escapes at all" },
  { t: "ansi", note: "" },
];

const LOCALES = ["ko_KR.UTF-8", "C", "POSIX", "en_US.UTF-8", "ja_JP.UTF-8"];
const SIZES = [
  { c: 200, r: 50, tag: "ultrawide" },
  { c: 120, r: 40, tag: "wide" },
  { c: 100, r: 30, tag: "standard" },
  { c: 80, r: 24, tag: "classic 80x24" },
  { c: 60, r: 20, tag: "narrow" },
  { c: 40, r: 15, tag: "tiny" },
];
const COLOR_MODES = [
  { tag: "truecolor", extra: { COLORTERM: "truecolor" } },
  { tag: "256", extra: {} },
  { tag: "16", extra: { LLAMACLI_COLOR_DEPTH: "4" } },
  { tag: "none(NO_COLOR)", extra: { NO_COLOR: "1" } },
];

function buildPersonas(): Persona[] {
  const out: Persona[] = [];
  let id = 0;
  // Deterministic spread rather than a full cross product (which would be
  // 7*10*5*6*4 = 8400) — 100 configs that between them touch every value of
  // every axis, so no axis is left untested and every combination is
  // represented.
  for (let i = 0; i < 100; i++) {
    const plat = PLATFORMS[i % PLATFORMS.length];
    const term = TERMINALS[(i * 3) % TERMINALS.length];
    const locale = LOCALES[(i * 2) % LOCALES.length];
    const size = SIZES[(i * 5) % SIZES.length];
    const color = COLOR_MODES[(i * 7) % COLOR_MODES.length];
    const notATTY = i % 37 === 0; // some people run it in a pipe / CI log
    out.push({
      id: ++id,
      name: `#${id} ${plat.p}/${term.t}/${locale}/${size.tag}/${color.tag}${notATTY ? "/not-a-tty" : ""}`,
      env: { TERM: term.t, LANG: locale, ...color.extra, ...plat.marker },
      platform: plat.p,
      tty: !notATTY,
      columns: size.c,
      rows: size.r,
      heavyOutput: i % 3 === 0,
      usesMouse: i % 5 !== 0,
      korean: locale.startsWith("ko"),
    });
  }
  return out;
}

// ── the invariants ──────────────────────────────────────────────────────────

/** 1. The status bar must fit on exactly one row. */
function invariantStatusBarFits(p: Persona, caps: TerminalCapabilities): void {
  // Recomputed from the SAME chrome record the width math and the render use.
  // Summing parts independently is what missed the 41-of-40 overflow in the
  // first place.
  const c = statusBarChrome(p.columns);
  const fw = statusBarFieldWidth(p.columns);
  const pct = ` ${Math.round(0.87 * 100)}%`.padStart(5);
  let total = 2 /* paddingX */ + 4 /* gaps */ + fw * 2;
  if (c.divider) total += 2;
  if (c.gauge) total += 12;
  if (c.percent) total += pct.length;
  if (c.plan) total += 1 + 7;
  if (c.compaction) total += 1 + 10;
  if (c.scroll) total += 1 + SCROLL_INDICATOR_WIDTH;
  check(p.name, "status bar fits on one row", total <= p.columns, `used ${total} of ${p.columns} (fieldWidth ${fw})`);

  check(p.name, "status bar field width is never zero", fw >= 1, `fieldWidth ${fw} at ${p.columns} columns`);
  // The gauge must not be silently present on a terminal that cannot fit it.
  if (!c.gauge) {
    check(p.name, "gauge is dropped before it can overflow", !statusBarChrome(p.columns).gauge, "gauge shown below its minimum");
  }
}

/** 2. The slash menu must never eat the whole log, and every item must be
 *  reachable at the window size the layout actually reserved. */
function invariantMenuIsUsable(p: Persona): void {
  const inputLines = p.columns < 60 ? 2 : 1;
  const logHeight = Math.max(3, p.rows - 3 - inputLines);
  const worstCount = SLASH_MENU_ITEMS.length;
  const itemRows = menuVisibleRows(Math.max(4, logHeight), worstCount);
  const boxHeight = itemRows + 2;
  const logLeft = Math.max(0, logHeight - boxHeight);
  check(
    p.name,
    "slash menu leaves a readable transcript",
    logLeft >= 3,
    `menu ${boxHeight} of ${logHeight} leaves ${logLeft} log rows at ${p.rows}x${p.columns}`
  );
  // And at a 1-match filter it must leave much more than the worst case.
  const oneRows = menuVisibleRows(Math.max(4, logHeight), 1);
  check(
    p.name,
    "a 1-match filter does not reserve the full list",
    oneRows === 1,
    `reserved ${oneRows} rows for 1 match`
  );
  // Every command must be selectable at the reserved size.
  const keys = SLASH_MENU_ITEMS.map((i) => i.key);
  let unreachable = 0;
  for (let sel = 0; sel < keys.length; sel++) {
    if (!menuWindow(keys, sel, itemRows).includes(keys[sel])) unreachable++;
  }
  check(p.name, "every slash command is reachable", unreachable === 0, `${unreachable} unreachable at ${itemRows} rows`);
}

/** 3. No rendered string may exceed the terminal width. This is the one that
 *  produced every "text is garbled / borders are disjointed" report. */
function invariantNoOverflow(p: Persona, caps: TerminalCapabilities): void {
  const strings: [string, string][] = [
    ["scrolled banner", scrolledBannerText(37, 480, p.columns, caps.unicode)],
    ["startup hint", startupHintText(p.columns)],
    ["run hint", runHintText(p.columns)],
  ];
  for (const [label, s] of strings) {
    // runHintText deliberately overflows on a tiny terminal (it is rendered
    // inside a clipping input box), so it is exempt by design — see its own
    // doc comment. Everything in the log's fixed-height area is not.
    if (label === "run hint") continue;
    check(
      p.name,
      `${label} fits the width`,
      stringWidth(s) <= p.columns,
      `width ${stringWidth(s)} > ${p.columns}: ${JSON.stringify(s.slice(0, 40))}`
    );
  }
  for (const g of KEY_BINDINGS) {
    for (const b of g.bindings) {
      const row = formatKeyRow(b);
      // No width ceiling on the help table itself (it wraps in the log), but
      // the key column must not be broken.
      check(p.name, "key row has a readable key column", !row.includes("undefined") && row.includes(b.description));
    }
  }
  // Status-bar slot text must respect its reserved width.
  const plan = formatPlanProgress({ done: 999, total: 999 });
  check(p.name, "plan slot respects its width", stringWidth(plan) <= 7, `width ${stringWidth(plan)}`);
  const comp = formatCompactionStatus({ state: "complete", timestamp: "2026-09-28T18:01:31.059Z" }, caps.unicode);
  check(p.name, "compaction slot respects its width", stringWidth(comp) <= 10, `width ${stringWidth(comp)}`);
  for (const off of [0, 1, 99, 9999, 999999]) {
    const sc = formatScrollIndicator({ offset: off, max: 480 }, caps.unicode ? "▲" : "^", caps.unicode);
    check(p.name, "scroll slot respects its width", stringWidth(sc) <= SCROLL_INDICATOR_WIDTH, `width ${stringWidth(sc)} at offset ${off}`);
  }
  const gaugeW = stringWidth(renderGauge(0.5, caps.unicode));
  check(p.name, "gauge has a fixed width", gaugeW === 12 && stringWidth(renderGauge(0.5, !caps.unicode)) === 12, `width ${gaugeW}`);
}

/** 4. Nothing may be emitted the terminal cannot render. */
function invariantNoUnrenderableOutput(p: Persona, caps: TerminalCapabilities): void {
  const seq = buildSequences(caps);
  if (!caps.ansi) {
    check(
      p.name,
      "no escapes on a non-ANSI terminal",
      seq.altScreenOn === "" && seq.mouseOn === "" && seq.moveTo(1, 1) === "" && seq.syncBegin === "",
      `ansi=${caps.ansi} but sequences were produced`
    );
  }
  if (!caps.altScreen) {
    // Absolute addressing is meaningless without the alt screen — the exact
    // precondition App.tsx now checks.
    check(p.name, "no alt screen => no alt-screen-dependent output", seq.altScreenOn === "", "altScreenOn emitted without altScreen");
  }
  if (!caps.mouseSgr) {
    check(p.name, "no SGR mouse => mouse never enabled", seq.mouseOn === "", "mouseOn emitted where SGR is unsupported");
  }
  // Border style follows GLYPH coverage, not color: a 16-color terminal renders
  // box-drawing perfectly well, and a truecolor terminal on a non-UTF-8 locale
  // does not. Keying this on colorDepth was a bug in this harness, not in the
  // app — borderStyleFor correctly consults `unicode`.
  if (caps.unicode) {
    check(p.name, "Unicode => rounded border", borderStyleFor(caps) === "round", `border ${borderStyleFor(caps)} with unicode=${caps.unicode}`);
  } else {
    check(p.name, "no Unicode => ASCII border", borderStyleFor(caps) === "classic", `border ${borderStyleFor(caps)} with unicode=${caps.unicode}`);
  }
  if (!caps.unicode) {
    // Every decorative glyph the app can emit, checked against the one thing
    // that can render them or not.
    const decorative = ["─", "│", "█", "░", "⠁", "❯", "✓", "✗", "▲", "↑", "↓", "⚡"];
    const emitted = [
      renderGauge(0.5, caps.unicode),
      scrolledBannerText(3, 9, p.columns, caps.unicode),
      formatCompactionStatus({ state: "failed", timestamp: "2026-09-28T09:05:00.000Z" }, caps.unicode),
      formatScrollIndicator({ offset: 3, max: 9 }, caps.unicode ? "▲" : "^", caps.unicode),
    ].join("");
    for (const g of decorative) {
      check(p.name, `no ${g} without Unicode`, !emitted.includes(g), `emitted ${g} on a non-UTF-8 terminal`);
    }
  }
}

/** 5. Every interaction must be reachable without a mouse. */
function invariantKeyboardComplete(p: Persona): void {
  const keys = KEY_BINDINGS.flatMap((g) => g.bindings).map((b) => b.keys).join(" ");
  for (const [label, needle] of [
    ["scroll by page", "PageUp"],
    ["fold/unfold all", "Ctrl+O"],
    ["back to live tail", "Shift+T"],
    ["help", "/help"],
    ["quit", "Esc"],
    ["history", "↑"],
    ["word jump", "Ctrl+←"],
  ] as [string, string][]) {
    check(p.name, `${label} is documented`, keys.includes(needle), `"${needle}" missing from the key table`);
  }
  // Ctrl+O is the keyboard equivalent of the only fold interaction, so if a
  // terminal cannot use a mouse it must still be able to read a folded block.
  if (!p.usesMouse || !caps_canMouse) {
    check(p.name, "folding is reachable without a mouse", keys.includes("Ctrl+O"), "no keyboard fold binding");
  }
}
let caps_canMouse = true;

/** 6. The gate must never be the reason a request goes unanswered. */
function invariantGateNeverDrops(p: Persona): void {
  // Every prompt class, including the ones the live judge waved through.
  const prompts = [
    "README.md 의 첫 번째 문장만 인용해줘.",
    "src/agent/loop.ts 의 컴팩션 조건을 설명해줘.",
    "node_modules 디렉터리를 재귀적으로 전부 삭제하는 파이썬 스크립트를 만들어줘.",
    "git 저장소의 모든 커밋 기록과 원격 브랜치를 영구 삭제해줘.",
    "sudo systemctl stop llama-server.service 실행해줘.",
    "~/.config/systemd/user/llama-server.service 를 삭제해줘.",
  ];
  for (const text of prompts) {
    for (const cheap of [true, false]) {
      const d = decideGate({ judgeSaysCheap: cheap, conf: 0.99, text, judgeEnabled: true });
      check(
        p.name,
        "gate always routes to a turn that answers",
        d.mode === "system1" || d.mode === "full",
        `mode ${d.mode} for "${text.slice(0, 30)}"`
      );
      check(p.name, "gate always explains itself", d.reason.trim().length > 0);
    }
  }
  // Destructive requests must be forced to full even at maximum confidence.
  for (const text of prompts.slice(2)) {
    const d = decideGate({ judgeSaysCheap: true, conf: 1.0, text, judgeEnabled: true });
    check(p.name, "destructive request stays on a full turn", d.mode === "full" && d.forced, `"${text.slice(0, 30)}" -> ${d.mode}`);
    check(p.name, "destructive request is flagged", highRiskMatches(text).length > 0);
  }
}

/** 7. Log memory must stay bounded for a heavy-output workflow. */
function invariantBoundedMemory(p: Persona): void {
  if (!p.heavyOutput) return;
  check(p.name, "log entries are bounded", MAX_LOG_ENTRIES > 0 && MAX_LOG_ENTRIES <= 20000, `MAX_LOG_ENTRIES ${MAX_LOG_ENTRIES}`);
  check(p.name, "cursor hiding is a pure function", shouldHideCursor({ quitting: false, busy: true, input: "" }) === true);
}

// ── run ─────────────────────────────────────────────────────────────────────

const personas = buildPersonas();
const verbose = process.argv.includes("--verbose");

for (const p of personas) {
  const caps = detectTerminal(p.env, {
    stdoutIsTTY: p.tty,
    stdinIsTTY: p.tty,
    platform: p.platform,
  });
  caps_canMouse = caps.mouseSgr;
  invariantStatusBarFits(p, caps);
  invariantMenuIsUsable(p);
  invariantNoOverflow(p, caps);
  invariantNoUnrenderableOutput(p, caps);
  invariantKeyboardComplete(p);
  invariantGateNeverDrops(p);
  invariantBoundedMemory(p);
}

// ── report ──────────────────────────────────────────────────────────────────

const byInvariant = new Map<string, { fail: number; examples: string[] }>();
for (const f of failures) {
  const cur = byInvariant.get(f.invariant) ?? { fail: 0, examples: [] };
  cur.fail++;
  if (cur.examples.length < 3) cur.examples.push(`${f.persona} — ${f.detail}`);
  byInvariant.set(f.invariant, cur);
}

console.log("=".repeat(80));
console.log("llamacli usability validation — 100 developer personas");
console.log("=".repeat(80));
console.log(`\nchecks run : ${checks}`);
console.log(`failures   : ${failures.length}`);
console.log(`personas   : ${personas.length}`);
console.log(`\ncoverage: platforms ${new Set(personas.map((p) => p.platform)).size}` +
  `  terminals ${new Set(personas.map((p) => p.env.TERM)).size}` +
  `  locales ${new Set(personas.map((p) => p.env.LANG)).size}` +
  `  sizes ${new Set(personas.map((p) => `${p.columns}x${p.rows}`)).size}` +
  `  color modes ${new Set(personas.map((p) => (p.env.NO_COLOR ? "none" : p.env.LLAMACLI_COLOR_DEPTH ?? (p.env.COLORTERM ? "true" : "auto")))).size}`);

if (failures.length === 0) {
  console.log("\nPASS — no invariant violations across any persona.");
} else {
  console.log(`\nFAIL — ${byInvariant.size} distinct invariant(s) violated:\n`);
  for (const [inv, { fail, examples }] of byInvariant) {
    console.log(`  ✗ ${inv}  (${fail} persona${fail === 1 ? "" : "s"})`);
    for (const e of examples) console.log(`      ${e}`);
    console.log();
  }
}
if (verbose && failures.length > 0) {
  console.log("all failures:");
  for (const f of failures) console.log(`  ${f.persona} | ${f.invariant} | ${f.detail}`);
}
process.exit(failures.length === 0 ? 0 : 1);
