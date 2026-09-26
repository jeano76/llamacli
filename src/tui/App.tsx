import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { SlashMenu, SLASH_MENU_ITEMS, SlashMenuItem } from "./SlashMenu.js";
import { tailToWidth, wrapToWidth, wrapAnsiSafe, wrapPreservingTables } from "./textWidth.js";
import { stripToolCallTemplateLeak } from "../agent/textSanitize.js";
import { renderMarkdown } from "./markdown.js";
import { HARNESS_ART, ART_WIDTH, LETTER_WIDTH, SETTLED, BALL_COLOR, RESET, rightAlign, shineMultilineFrame, shineMultilineFrameCount, bounceFrame, bounceFrameCount } from "./banner.js";
import { supportsAnsiTui } from "./ansiSupport.js";
import { existsSync } from "node:fs";
import { isLikelyPaste, looksLikePastedFilePath, formatPasteLabel, findTrailingPlaceholder, substitutePlaceholders } from "./pasteChip.js";

export interface AppProps {
  cwd: string;
  model: string;
  onSubmit: (text: string) => void;
  /** Fires for a slash command selected from the menu. `argument` is the text
   *  after the command key (e.g. "/fastcheck foo" → argument "foo"), or "" for
   *  commands with no arguments; lets arg-taking commands read their input. */
  onSlashCommand: (key: string, argument?: string) => void;
  /** A message typed while the agent is busy — applied at the next
   *  opportunity mid-turn (AgentLoop.queueMessage), not held here. */
  onQueueMessage: (text: string) => void;
  /** Called when the user confirms Esc → Y ("force quit, saving progress to
   *  resume later"). Wired in index.tsx to: cancel the in-flight turn (if
   *  one is running) or save the current conversation (if idle) — either
   *  way writing a resumable checkpoint — and then actually exit the app
   *  (unmount + let the process end), skipping /quit's normal
   *  self-improvement-proposal gate entirely. That gate is a "review before
   *  you go" nicety; Esc is the emergency/quick exit and must never block
   *  on it. The checkpoint reuses the exact same mechanism a mid-batch
   *  compaction interruption already writes, so the next launch's startup
   *  resume-confirmation prompt (pendingResumeGoal below) picks it back up
   *  with no extra wiring. */
  onForceQuit: () => void;
  /** Esc or Ctrl-C while the quit-time save is still running: exit right
   *  away without waiting for it (see index.tsx exitAfterSaving). */
  onQuitWithoutSaving: () => void;
  /** Loaded once at startup (index.tsx) from .llamacli/state/prompt-history.json
   *  — kept as the initial value here rather than App loading it itself, so
   *  App stays pure UI/presentation and all filesystem I/O stays in
   *  index.tsx, matching how config/rules/skills are already loaded there. */
  initialHistory: string[];
  /** Fires with the full updated history (already capped/deduped) every
   *  time a new prompt is submitted, so index.tsx can persist it. */
  onHistoryChange: (history: string[]) => void;
  /** The previous session's checkpoint goal (its one-line restatement of
   *  what the user originally asked for), if a checkpoint was sitting on
   *  disk when this session started — read in index.tsx before render, so
   *  the resume/discard question can be asked (and answered) right at
   *  startup instead of silently auto-resuming. `null` when there's
   *  nothing to ask about. */
  pendingResumeGoal: string | null;
  /** Called once the resume confirmation is answered: `true` resumes (via
   *  AgentLoop.resumeIfCheckpointExists(), same as before this prompt
   *  existed), `false` discards the checkpoint and starts fresh. */
  onResumeDecision: (resume: boolean) => void;
  /** The "HARNESS" wordmark is App's own ASCII art (banner.ts's
   *  HARNESS_ART/shineMultilineFrame) — this just carries the build-date version and
   *  repo URL shown under it. Computed in index.tsx (needs dist/index.js's
   *  own mtime for the version) and passed in rather than read here, so App
   *  stays pure UI, same as everything else index.tsx already loads before
   *  render(). Previously printed straight to the raw terminal before
   *  enterAltScreen() switched buffers, which erased it a moment later —
   *  reported directly ("최초 구동 로그가 나오지 않았어 화면 상단에
   *  출력되어 있어야 하는데 없었어"). Now it's real log lines inside the
   *  alt-screen app itself, so they survive like anything else in scrollback. */
  startupBanner: { version: string; repoUrl: string };
}

/** Every prompt actually submitted counts, whether it was sent immediately
 *  or queued while busy (see the Return-key handler below) — both are "the
 *  user submitted a prompt" from history's point of view. Caps at
 *  MAX_PROMPT_HISTORY and drops an exact-duplicate of the immediately
 *  preceding entry (retyping/resubmitting the same thing shouldn't spam
 *  history with repeats), same as a normal shell's history behaves. */
export const MAX_PROMPT_HISTORY = 50;
export function appendHistory(history: string[], text: string): string[] {
  if (history[history.length - 1] === text) return history;
  const next = [...history, text];
  return next.length > MAX_PROMPT_HISTORY ? next.slice(next.length - MAX_PROMPT_HISTORY) : next;
}

interface LogLine {
  id: number;
  text: string;
  kind: "user" | "assistant" | "status" | "tool" | "diff" | "reasoning" | "compaction-detail" | "tool-result";
  /** Precomputed folded-state label for kinds whose fold summary can't be
   *  derived from `text` alone (e.g. "compaction-detail", whose text is the
   *  full expanded body). Unused for "reasoning", which derives its own via
   *  foldedReasoningSummary(text). */
  foldLabel?: string;
}

let logIdCounter = 0;

interface RenderedRow {
  key: string;
  text: string;
  kind: LogLine["kind"] | "reasoning-folded" | "compaction-detail-folded" | "diff-folded" | "tool-result-folded" | "tool-folded";
  lineId: number;
}

/** The single-line summary shown for a finished reasoning block once
 *  folded (the default — see App's expandedReasoningIds). Carries its own
 *  icon + a plain-language hint ("클릭해서 펼치기" — click to expand),
 *  requested directly so the fold affordance isn't just an unlabeled
 *  glyph. `foldToggleHint` is the matching label for the EXPANDED state,
 *  used in the render branch below. */
export function foldedReasoningSummary(text: string): string {
  const chars = text.trim().length;
  return `▸ 생각 과정 (${chars}자) — 클릭해서 펼치기`;
}
export const foldToggleHintExpanded = "  ▴ 클릭해서 접기";

/** Folded summary line for a compaction's before/after detail (see
 *  CompactionDetail in compactor.ts) — requested directly ("컴팩션하는
 *  과정을 그래픽컬하게 보여주고... 어떤 내용들이 잊혀지고 어떤 내용들이
 *  강조가 되었는지"): what got dropped vs what the summary kept/emphasized,
 *  folded by default like a reasoning block and expandable the same way. */
export function foldedCompactionSummary(droppedCount: number, droppedTokens: number, keptCount: number): string {
  return `▸ 압축 완료 — ${droppedCount}개 메시지 요약됨(~${droppedTokens}토큰), ${keptCount}개 메시지 유지 — 클릭해서 펼치기`;
}

/** The expanded body: dropped-content preview first (what was forgotten),
 *  then the summary text that replaced it (what was kept/emphasized). */
export function compactionDetailBody(detail: { droppedPreview: string[]; summary: string }): string {
  return (
    `🗑 잊혀진 내용:\n${detail.droppedPreview.map((l) => `  - ${l}`).join("\n")}\n\n` +
    `✨ 강조된 내용 (요약):\n${detail.summary}`
  );
}

/** Extracts the path and +added/-removed line counts from a formatDiff()
 *  string (src/tools/diff.ts) — its header is `\x1b[1m--- ${path}\x1b[0m`
 *  and each changed line is prefixed with the green/red ANSI codes it
 *  defines. Used for the folded summary label; a diff text that doesn't
 *  match the expected shape (defensive — formatDiff's own format could
 *  change) falls back to a generic label rather than throwing. */
export function parseDiffStats(diffText: string): { path: string; added: number; removed: number } {
  const pathMatch = diffText.match(/^\x1b\[1m--- (.+?)\x1b\[0m/);
  const added = (diffText.match(/\x1b\[32m\+/g) ?? []).length;
  const removed = (diffText.match(/\x1b\[31m-/g) ?? []).length;
  return { path: pathMatch?.[1] ?? "(unknown file)", added, removed };
}

/** Folded summary line for a run_shell result (e.g. `npm test` output) —
 *  requested directly ("유닛테스트 수행시 테스트 결과도 펼침과 닫힘기능으로
 *  제공한다"): a shell command's output was previously never shown in the
 *  TUI at all, only the "⚡ run_shell(...)" call label. Defaults folded
 *  like reasoning/compaction (raw shell output can be long and isn't the
 *  point of the screen most of the time), expandable the same way. */
export function foldedToolResultSummary(command: string, output: string): string {
  const lines = output.split("\n").length;
  return `▸ 결과: ${command} (${lines}줄) — 클릭해서 펼치기`;
}

/** Folded summary line for a diff block — requested directly ("기본적으로는
 *  화면에 펼짐으로 나타내고 다음 명령어 진입시 닫힘으로"): diffs start
 *  expanded (the opposite default from reasoning/compaction, which start
 *  folded) and only collapse once the next command is submitted, via
 *  collapsedDiffIds in App — still expandable again afterward by click. */
export function foldedDiffSummary(diffText: string): string {
  const { path, added, removed } = parseDiffStats(diffText);
  return `▸ diff: ${path} (+${added} -${removed}) — 클릭해서 펼치기`;
}

/** A single band's role in the "thinking" shimmer: `dim` hasn't been
 *  reached by the reveal wave yet, `peak` is the wave's leading edge (the
 *  brightest point right now), `settled` has already been passed by the
 *  wave and — the point of this design — STAYS that way; it never reverts
 *  to dim once revealed. */
export type ShimmerRole = "dim" | "peak" | "settled";

/** Splits `text` into runs for the reveal-wave shimmer: a one-directional
 *  wave (never wraps, never goes backward) advances `speed` characters per
 *  tick, so text already passed stays lit while text ahead of the wave is
 *  still dim. Monotonic in `tick` for a fixed `text`, so a settled band
 *  can never later render as dim again — the earlier design (a spotlight
 *  cycling over otherwise-static text) reverted already-"read" text back
 *  to dim every cycle, reported directly as looking wrong. Pure function:
 *  same (text, tick) always gives the same bands, so it has nothing to do
 *  with the row-wrap cache (keyed on text, not tick). */
export function shimmerBands(
  text: string,
  tick: number,
  bandWidth = SHIMMER_BAND_WIDTH,
  speed = SHIMMER_SPEED_CHARS_PER_TICK
): { text: string; role: ShimmerRole }[] {
  if (!text) return [];
  const revealed = Math.min(text.length, tick * speed);
  const peakStart = Math.max(0, revealed - bandWidth);
  const bands: { text: string; role: ShimmerRole }[] = [];
  if (peakStart > 0) bands.push({ text: text.slice(0, peakStart), role: "settled" });
  if (revealed > peakStart) bands.push({ text: text.slice(peakStart, revealed), role: "peak" });
  if (revealed < text.length) bands.push({ text: text.slice(revealed), role: "dim" });
  return bands;
}

const SHIMMER_BAND_WIDTH = 10;
const SHIMMER_SPEED_CHARS_PER_TICK = 2;
export const SHIMMER_TICK_MS = 80;

/** Wraps one log entry into terminal rows (unpadded). */
function wrapLogLine(line: LogLine, width: number): string[] {
  if (line.kind === "diff") {
    // Diff text carries its own ANSI color codes (formatDiff()): wrap
    // ANSI-safely so an escape sequence is never torn apart mid-code.
    return wrapAnsiSafe(line.text, width);
  }
  if (line.kind === "assistant") {
    // Markdown with syntax-highlighted code; tables are clipped rather than
    // wrapped, since wrapping a table row destroys its borders.
    return wrapPreservingTables(renderMarkdown(line.text, width), width);
  }
  if (line.kind === "user") return wrapToWidth(`❯ ${line.text}`, width);
  if (line.kind === "tool") return wrapToWidth(`⚡ ${line.text}`, width);
  // Chain-of-thought, shown only when enableThinking is on (loop.ts's
  // onReasoningDelta). Kept visually distinct (dim, prefixed) from the
  // real answer so it reads as "thinking out loud", not the final reply —
  // this is display-only and never re-enters the conversation.
  if (line.kind === "reasoning") return wrapToWidth(`  ${line.text}`, width);
  return wrapToWidth(line.text, width);
}

function renderRow(row: RenderedRow, shimmerTick?: number) {
  if (row.kind === "reasoning-folded") {
    // Same cyan the reasoning text itself settles at once fully revealed
    // (not dim) — reported directly that dim gray made the fold line hard
    // to read; it's also the click target, so it should read as "live UI",
    // not muted-away text.
    return (
      <Text key={row.key} color="cyan">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "reasoning" && shimmerTick !== undefined) {
    return (
      <Text key={row.key}>
        {shimmerBands(row.text, shimmerTick).map((b, i) => {
          if (b.role === "peak") {
            return (
              <Text key={i} color="cyan" bold italic>
                {b.text}
              </Text>
            );
          }
          if (b.role === "settled") {
            return (
              <Text key={i} color="cyan" italic>
                {b.text}
              </Text>
            );
          }
          return (
            <Text key={i} color="gray" dimColor italic>
              {b.text}
            </Text>
          );
        })}
      </Text>
    );
  }
  if (row.kind === "assistant" && shimmerTick !== undefined) {
    // Same shining reveal-wave as reasoning (see streamingAssistantId's
    // doc comment) — requested directly: "로그 문자를 생각의 글씨의
    // 빛나는 효과처럼 나타나게 해줘".
    return (
      <Text key={row.key}>
        {shimmerBands(row.text, shimmerTick).map((b, i) => {
          if (b.role === "peak") {
            return (
              <Text key={i} bold>
                {b.text}
              </Text>
            );
          }
          if (b.role === "settled") return <Text key={i}>{b.text}</Text>;
          return (
            <Text key={i} color="gray" dimColor>
              {b.text}
            </Text>
          );
        })}
      </Text>
    );
  }
  if (row.kind === "compaction-detail-folded") {
    return (
      <Text key={row.key} color="yellow">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "compaction-detail") {
    return (
      <Text key={row.key} color="yellow">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "user") {
    return (
      <Text key={row.key} color="cyan" bold>
        {row.text}
      </Text>
    );
  }
  if (row.kind === "tool" || row.kind === "tool-folded") {
    return (
      <Text key={row.key} color="magenta">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "status") {
    return (
      <Text key={row.key} color="gray">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "reasoning") {
    // A finished reasoning block the user has expanded (see
    // expandedReasoningIds) — kept at its settled shimmer color (cyan)
    // rather than dimming back down once done. Reported directly: fading
    // to dim on completion looked like the text itself had lost meaning,
    // when it is exactly the text that was just highlighted revealing it.
    return (
      <Text key={row.key} color="cyan" italic>
        {row.text}
      </Text>
    );
  }
  if (row.kind === "tool-result-folded") {
    return (
      <Text key={row.key} color="blue">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "tool-result") {
    return (
      <Text key={row.key} color="blue">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "diff-folded") {
    return (
      <Text key={row.key} color="green">
        {row.text}
      </Text>
    );
  }
  // diff / assistant carry their own ANSI styling
  return <Text key={row.key}>{row.text}</Text>;
}

/** `input` is the raw text box content, which starts with "/" while the
 *  menu is open — everything after that is the filter query. Matches
 *  against the command's key (e.g. "improve-apply"), not its "/"-prefixed
 *  label, so typing "imp" also finds "/improve-apply" via a plain
 *  substring check — simple and predictable over fuzzier matching. */
export function filterMenuItems(input: string): SlashMenuItem[] {
  const query = input.slice(1).toLowerCase();
  if (!query) return SLASH_MENU_ITEMS;
  return SLASH_MENU_ITEMS.filter((item) => item.key.toLowerCase().includes(query));
}

/** Parses SGR mouse reports ("[<64;10;5M" — Ink strips the leading ESC and
 *  can hand over several reports in one string) into a net scroll in rows:
 *  positive = wheel up (scroll back), negative = wheel down. Returns null
 *  when `input` isn't a mouse report at all, so it can fall through to
 *  normal key handling. Clicks and releases count as 0. */
export const WHEEL_SCROLL_ROWS = 3;
export function parseMouseWheel(input: string): number | null {
  const reports = [...input.matchAll(/\[<(\d+);\d+;\d+([Mm])/g)];
  if (reports.length === 0) return null;
  let rows = 0;
  for (const [, code, kind] of reports) {
    const button = Number(code);
    if (kind !== "M" || (button & 64) === 0) continue; // not a wheel event
    rows += (button & 1) === 0 ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS;
  }
  return rows;
}

/** Parses SGR mouse reports for a plain button PRESS (not the wheel, not a
 *  drag/motion report, not a release) into 1-based (row, col) terminal
 *  coordinates — absolute, since row 1 is the alt screen's top (see
 *  index.tsx). Used to toggle a folded reasoning block on click. Several
 *  reports can arrive in one input string, same as parseMouseWheel. */
/** Decides what to do with a raw stdin chunk that might be (part of) a SGR
 *  mouse report, given whatever was already buffered from a previous call —
 *  see mouseBufferRef's doc comment in App for why this exists at all (a
 *  chunk boundary landing mid-escape-sequence). Pure so the reassembly
 *  logic is testable without driving a real useInput handler. */
export type MouseBufferOutcome = { action: "process"; text: string } | { action: "wait" } | { action: "discard" };
export function bufferMouseChunk(buffered: string, chunk: string): MouseBufferOutcome {
  const combined = buffered + chunk;
  if (/\[<\d+;\d+;\d+[Mm]/.test(combined)) return { action: "process", text: combined };
  if (combined.length < 64) return { action: "wait" };
  return { action: "discard" };
}

/** Reported directly: garbled fragments like ";1;5m" and "[붙여넣기 #1: 1줄,
 *  8바이트]" placeholders showed up in the input box while just moving the
 *  mouse (SGR motion reports fire continuously while dragging/moving, far
 *  more often than the occasional click/wheel event) — the entry check
 *  below only started buffering once a chunk already contained the FULL
 *  "\x1b[<" lead-in together; a high-volume stream of reports is much more
 *  likely to have a read() boundary land INSIDE that 2-3 byte lead-in
 *  (bare "\x1b", or "\x1b["), and those fragments fell straight through as
 *  literal typed/pasted text instead of ever starting the reassembly.
 *
 *  Safe to broaden: Ink's own keypress parser (use-input.js) already
 *  decodes and clears `input` to '' for every key it recognizes as a named
 *  key (arrows, Escape, Home/End, ...) before this callback ever sees it,
 *  and strips a leading ESC byte from anything else single-key-shaped —
 *  so a bare "\x1b" or "\x1b[" reaching this callback as literal chunk
 *  content is never a real recognized keystroke to begin with; it can
 *  only be genuinely undecoded escape-sequence bytes (a mouse report,
 *  given we're the ones who turned mouse reporting on, or otherwise
 *  unrecognized garbage either way). Once buffered, mouseBufferRef being
 *  non-empty already pulls in every subsequent fragment regardless of
 *  its own shape (see the entry check's `mouseBufferRef.current ||` half)
 *  — so only the FIRST fragment of a split needs this widened check. */
export function looksLikePartialMouseSequenceStart(chunk: string): boolean {
  return chunk === "\x1b" || chunk === "\x1b[";
}

export function parseMouseClicks(input: string): { row: number; col: number }[] {
  const clicks: { row: number; col: number }[] = [];
  for (const [, code, colStr, rowStr, kind] of input.matchAll(/\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    if (kind !== "M") continue; // only presses — a release fires right after and would double-toggle
    const button = Number(code);
    if ((button & 64) !== 0 || (button & 32) !== 0) continue; // wheel, or drag/motion
    clicks.push({ row: Number(rowStr), col: Number(colStr) });
  }
  return clicks;
}

/** Log entries kept for scrollback. Rendering only ever builds React
 *  elements for the visible window (see visibleRows below), so this bounds
 *  memory, not render cost. */
export const MAX_LOG_ENTRIES = 5000;

/** Whether the terminal cursor should be hidden: it belongs only where the
 *  user can type. Reported directly: while the agent worked with an empty
 *  input box, the cursor sat blinking right next to the spinner. */
export function shouldHideCursor(state: { quitting: boolean; busy: boolean; input: string }): boolean {
  return state.quitting || (state.busy && state.input.length === 0);
}

/** The key-hint line shown under the log while the agent is running (never
 *  inside the input box: it used to sit next to the prompt and take width
 *  from it, which threw off the input's width/cursor math — reported
 *  directly). Picks the long form when it fits the terminal width. */
export function runHintText(columns: number): string {
  // With mouse reporting on (wheel scrollback), plain clicks go to the app;
  // holding Shift hands them back to the terminal, so Shift+drag selects and
  // Shift+right-click opens the terminal's own Copy/Paste menu.
  // Esc and /quit are NOT the same thing — Esc cancels the running turn and
  // exits right away (a checkpoint is written first so it resumes next
  // time), while /quit waits for the turn to finish and runs the normal
  // self-improvement-review gate first. Spelled out directly (강제종료 vs
  // 정상종료) rather than just "Esc: 종료" for both, which didn't say which
  // was which.
  const forms = [
    "  실행 중 · Esc: 강제종료 · /quit: 정상종료 · Shift+드래그: 선택 · Shift+우클릭: 복사/붙여넣기",
    "  Esc: 강제종료 · /quit: 정상종료 · Shift+우클릭: 복사/붙여넣기",
    "  Esc: 강제종료 · /quit: 정상종료",
  ];
  return forms.find((f) => stringWidth(f) <= columns - 1) ?? forms[forms.length - 1];
}

/** Input-box text while progress is being saved before exit. */
export function quittingStatusText(elapsedMs: number): string {
  return `진행 상황 저장 중… ${Math.floor(elapsedMs / 1000)}초 · Esc: 저장하지 않고 바로 종료`;
}

export function App({
  cwd,
  model,
  onSubmit,
  onSlashCommand,
  onQueueMessage,
  onForceQuit,
  onQuitWithoutSaving,
  initialHistory,
  onHistoryChange,
  pendingResumeGoal,
  onResumeDecision,
  startupBanner,
}: AppProps) {
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  // Requested directly: pasting shouldn't dump raw text straight into the
  // input box — a pasted block is appended as a short placeholder label
  // instead (see pasteChip.ts's doc comment for the full design), with the
  // real content kept here, mapped by that label, until the prompt is
  // actually submitted (or the label itself is backspaced away).
  const [pastedBlocks, setPastedBlocks] = useState<Map<string, string>>(new Map());
  const pasteCounterRef = useRef(1);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  // The startup banner: "HARNESS" as block-letter ASCII art that shines
  // itself in, then a version/bounce line and the repo URL underneath —
  // see AppProps.startupBanner's doc comment for why this lives inside the
  // log (a real, persistent line) rather than a raw stdout write before the
  // alt-screen switch, which was invisible in practice.
  useEffect(() => {
    const artLineId = logIdCounter++;
    // CLI, the version, and the bounce-ball flourish all share ONE line,
    // right-aligned together — requested directly: "Harness 아래 CLI 와
    // 버전정보 그리고 탁구공모양을 한줄에 우측 정렬로 해서 작성해줘".
    const cliLineId = logIdCounter++;
    setLog((prev) => [
      { id: artLineId, text: HARNESS_ART.join("\n"), kind: "status" as const },
      { id: cliLineId, text: "", kind: "status" as const },
      { id: logIdCounter++, text: rightAlign(`\x1b[2m${startupBanner.repoUrl}\x1b[0m`, ART_WIDTH), kind: "status" as const },
      ...prev,
    ]);
    const setLineText = (id: number, text: string) => setLog((prev) => prev.map((line) => (line.id === id ? { ...line, text } : line)));

    // Two phases, one after another (not simultaneous — several flourishes
    // going at once reads as chaotic): the WHOLE "HARNESS CLI" text shines
    // in with one diagonal sweep (no shake — dropped per direct feedback:
    // "지금처럼 좌우로 흔드는 애니메이션은 필요없고", replaced with "샤이닝
    // 효과는 Think 할 때의 글씨의 반짝이는 효과처럼 같은 색상 계열의
    // 밝은색 블럭으로 좌측에서 우측으로 비스듬하게 이동이 되게 되는거야" —
    // a bright block of the same color family moving diagonally
    // left-to-right, same as reasoning's own shimmer), then the version
    // line's ball bounces. "CLI" stays small plain text, not block art
    // (per "cli는 소문자로 좀 작게 해주고"), and uppercase (per "Harness
    // CLI 처럼 대소문자 반영해줘": the acronym stays uppercase, matching
    // how the app's own name is written everywhere else).
    const CLI_TEXT = "CLI";
    const shineLines = [...HARNESS_ART, CLI_TEXT];
    // Once the shine settles, the last letter of HARNESS and all of "CLI"
    // get recolored to match the bounce-ball's own color — requested
    // directly: "CLI 글자와 마지막 S 도형을 애니메이션 마지막엔 탁구공과
    // 같은 색으로 해줘". Built fresh from the plain (uncolored) source
    // text rather than patched into the shine's own frame, so there's no
    // risk of a leftover color from the sweep mixing in.
    const lastLetterStartsAt = ART_WIDTH - LETTER_WIDTH;
    const finalArtText = HARNESS_ART.map(
      (row) => `${SETTLED}${row.slice(0, lastLetterStartsAt)}${BALL_COLOR}${row.slice(lastLetterStartsAt)}${RESET}`
    ).join("\n");
    const finalCliText = `${BALL_COLOR}${CLI_TEXT}${RESET}`;
    let shineTick = 0;
    let bounceId: ReturnType<typeof setInterval> | null = null;
    const shineTicks = shineMultilineFrameCount(shineLines);
    const shineId = setInterval(() => {
      shineTick++;
      const frame = shineMultilineFrame(shineLines, shineTick).split("\n");
      setLineText(artLineId, frame.slice(0, HARNESS_ART.length).join("\n"));
      setLineText(cliLineId, rightAlign(frame[HARNESS_ART.length], ART_WIDTH));
      if (shineTick >= shineTicks) {
        clearInterval(shineId);
        setLineText(artLineId, finalArtText);
        let bounceTick = 0;
        bounceId = setInterval(() => {
          bounceTick++;
          setLineText(cliLineId, rightAlign(`${finalCliText}  ${startupBanner.version}  ${bounceFrame(bounceTick)}`, ART_WIDTH));
          if (bounceTick >= bounceFrameCount()) clearInterval(bounceId!);
        }, 60);
      }
    }, 48);
    return () => {
      clearInterval(shineId);
      if (bounceId !== null) clearInterval(bounceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Esc opens this Y/N confirmation instead of quitting immediately — a
  // single stray keystroke shouldn't be able to kill the app (mid-turn or
  // not). While this is true, useInput intercepts every key as part of the
  // confirmation (see below) rather than normal typing/menu/etc.
  const [quitConfirmPending, setQuitConfirmPending] = useState(false);
  // Set (to the start time) once a quit has been requested and progress is
  // being saved. Saving can take a minute (it's a full compaction when
  // idle), so this drives a dedicated animation with an elapsed-time count
  // instead of leaving the app looking frozen — and while it's set, Esc or
  // Ctrl-C quits immediately without waiting for the save.
  const [quittingSince, setQuittingSince] = useState<number | null>(null);
  const [, setQuitTick] = useState(0);
  useEffect(() => {
    if (quittingSince === null) return;
    const id = setInterval(() => setQuitTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [quittingSince]);
  // Shown once at startup (initialized from the prop, which index.tsx only
  // sets when a checkpoint was actually found on disk) — intercepts input
  // the same way quitConfirmPending does, and is resolved before either the
  // user can start typing a real message or the auto-resume machinery
  // (AgentLoop.resumeIfCheckpointExists()) runs on its own.
  const [resumeConfirmPending, setResumeConfirmPending] = useState(!!pendingResumeGoal);
  // Prompt history (Up/Down arrow), most recent last — see appendHistory.
  // Loaded once from disk (initialHistory) and kept in sync locally after
  // that; onHistoryChange pushes each update back out for index.tsx to
  // persist, rather than App doing its own file I/O (see AppProps doc).
  const [history, setHistory] = useState<string[]>(initialHistory);
  // -1 = not currently browsing history (typing fresh). 0 = the most
  // recent entry, counting UP from the end of `history` as Up is pressed
  // repeatedly — matches a normal shell's history navigation direction.
  const [historyIndex, setHistoryIndex] = useState(-1);
  // What was actually typed before Up was first pressed, restored once
  // Down navigates back past the most recent history entry — otherwise
  // browsing history and then returning to "fresh" would silently discard
  // whatever partial text the user had already typed.
  const [historyDraft, setHistoryDraft] = useState("");
  const [contextUsedRatio, setContextUsedRatio] = useState(0);
  const [planProgress, setPlanProgress] = useState<{ done: number; total: number } | null>(null);
  // Requested directly: the "[compaction complete] ..." log line got
  // pushed out of view by later scrolling activity before it was ever
  // actually noticed. A persistent status-bar indicator instead — same
  // reasoning as planProgress above.
  const [compactionStatus, setCompactionStatus] = useState<{ state: "running" | "complete" | "failed"; timestamp: string } | null>(
    null
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // Rows scrolled up from the live bottom (0 = following the newest output,
  // like a normal terminal). Requested directly: the alt-screen buffer
  // (needed for reliable absolute cursor positioning — see index.tsx) also
  // disables the terminal's own native scrollback as a side effect, so
  // there was no way at all to look back at anything that had scrolled off
  // the fixed-height log box. This restores that ability inside the app
  // itself instead.
  const [scrollOffset, setScrollOffset] = useState(0);
  // Messages typed while the agent is busy wait here instead of being sent
  // immediately; /queue inspects this list (PROMPT.md §6 message queue input).
  // Authoritative copy now lives in AgentLoop (queueMessage/onQueueChange —
  // see AppProps.onQueueMessage), so it's applied at the next turnLoop
  // iteration instead of only after the whole turn finishes; this is a
  // display-only mirror kept in sync via the __llamacli_ui.setQueue below.
  const [queue, setQueue] = useState<string[]>([]);
  // Tracks which log line the currently-streaming assistant message is
  // appending to, so successive deltas mutate one line instead of spawning
  // a new one per chunk.
  const streamingIdRef = useRef<number | null>(null);
  // Tracks the most recently pushed tool-call line, so finalizeToolCall()
  // (fired by loop.ts's onToolCallDone) knows which one just finished —
  // tool calls run sequentially within a turn, never concurrently, so
  // "most recent" is unambiguous.
  const activeToolLineIdRef = useRef<number | null>(null);
  // A tool-call line that has finished AND turned out to span more than
  // one wrapped row folds down to a summary (see the row-building loop) —
  // never while still running, only once finalizeToolCall() adds its id
  // here. Still expandable again by click (expandedReasoningIds, shared
  // with reasoning/compaction/tool-result's own fold state).
  const [completedToolIds, setCompletedToolIds] = useState<Set<number>>(new Set());
  // A ref alone (reasoningStreamingIdRef below) doesn't trigger a re-render
  // on change, so the shimmer needs actual state to know THIS render's
  // active line and to drive its own timer.
  const [thinkingLineId, setThinkingLineId] = useState<number | null>(null);
  // The streaming ASSISTANT line gets the same shining reveal-wave effect
  // reasoning text already has — requested directly: "로그 문자를 생각의
  // 글씨의 빛나는 효과처럼 나타나게 해줘". Shares shimmerTick with
  // reasoning below (reasoning and assistant content don't stream at the
  // same time in practice — reasoning always finishes first — so one
  // counter is enough; each line's OWN reveal wave still starts fresh, via
  // setShimmerTick(0) wherever a new line of either kind begins).
  const [streamingAssistantId, setStreamingAssistantId] = useState<number | null>(null);
  const [shimmerTick, setShimmerTick] = useState(0);
  useEffect(() => {
    if (thinkingLineId === null && streamingAssistantId === null) return;
    const id = setInterval(() => setShimmerTick((t) => t + 1), SHIMMER_TICK_MS);
    return () => clearInterval(id);
  }, [thinkingLineId, streamingAssistantId]);
  const reasoningStreamingIdRef = useRef<number | null>(null);
  // Finished reasoning blocks the user has clicked open — everything else
  // finished renders as one folded summary line (foldedReasoningSummary).
  // Requested directly: reasoning is useful to check but clutters the log
  // once it's no longer the point of what's on screen.
  const [expandedReasoningIds, setExpandedReasoningIds] = useState<Set<number>>(new Set());
  // Diffs are the opposite default: shown expanded (visible right away,
  // since that's the point — the user asked to actually see the change),
  // and only fold down once the next command is submitted (see the Return
  // handler below), rather than needing a click just to see what changed.
  // Still toggleable by click either way afterward.
  const [collapsedDiffIds, setCollapsedDiffIds] = useState<Set<number>>(new Set());
  // Rebuilt every render (see the allRows loop) so a click handler — which
  // only runs later, async, in response to a real terminal event — can map
  // the absolute terminal row it landed on back to a log line without
  // recomputing the whole layout itself.
  const clickMapRef = useRef<{ firstRow: number; entries: { lineId: number; foldable: boolean; isDiff: boolean }[] }>({
    firstRow: 1,
    entries: [],
  });
  // Holds a SGR mouse report that arrived split across two raw stdin
  // chunks — reported directly ("마우스 클릭 또는 휠을 내리면 프롬포트창에
  // 안시코드가 찍혀"): under fast scrolling/clicking, a chunk boundary can
  // land mid-escape-sequence, and the trailing half (e.g. a bare "6M") no
  // longer matches the mouse-report regex on its own, so it was falling
  // through to the plain "insert this character" branch and appearing as
  // literal text in the prompt. Buffered here and reassembled on the next
  // useInput call instead of being typed.
  const mouseBufferRef = useRef("");
  // How far scrollOffset can go before there's nothing further back to see —
  // updated every render (see below) rather than recomputed inside the key
  // handler, which would mean redoing the markdown/wrap rendering work
  // twice per keystroke just to clamp a scroll position.
  const maxScrollRef = useRef(0);
  // Same reasoning as maxScrollRef — needed inside the key handler (for
  // sizing a Page Up/Down jump) before logHeight is computed later in this
  // render, so it's carried over from the previous one instead.
  const logHeightRef = useRef(3);
  const rowCacheRef = useRef(new Map<number, { text: string; width: number; rows: string[] }>());
  // The terminal row of the input box's top border, from the PREVIOUS
  // render — see the cursor-positioning effect below for why this exists.
  const prevInputTopBorderRowRef = useRef<number | null>(null);

  function pushLine(text: string, kind: LogLine["kind"]) {
    setLog((prev) => [...prev, { id: logIdCounter++, text, kind }].slice(-MAX_LOG_ENTRIES));
  }

  function pushAssistantDelta(text: string) {
    setLog((prev) => {
      if (streamingIdRef.current !== null) {
        return prev.map((line) =>
          line.id === streamingIdRef.current
            ? // Re-sanitize the whole cumulative text each time, not just
              // the new chunk — a leaked tool-call template tag (see
              // src/agent/textSanitize.ts) can arrive split across several
              // small streaming chunks, so it's only ever complete (and
              // therefore matchable) once appended to what came before.
              { ...line, text: stripToolCallTemplateLeak(line.text + text) }
            : line
        );
      }
      const id = logIdCounter++;
      streamingIdRef.current = id;
      setStreamingAssistantId(id);
      // A fresh reveal wave for the new line — reusing the running tick
      // count would start it already partway (or fully) revealed.
      setShimmerTick(0);
      return [...prev, { id, text: stripToolCallTemplateLeak(text), kind: "assistant" as const }].slice(-MAX_LOG_ENTRIES);
    });
  }

  function finalizeAssistant() {
    // The row cache is keyed on (id, text, width) — text doesn't change
    // between the last delta and finalizing, so without this the NEXT
    // render would reuse the streaming render's plain-shimmer rows
    // instead of re-wrapping through markdown now that streaming (and the
    // shimmer) is over.
    if (streamingIdRef.current !== null) rowCacheRef.current.delete(streamingIdRef.current);
    streamingIdRef.current = null;
    setStreamingAssistantId(null);
  }

  function pushReasoningDelta(text: string) {
    setLog((prev) => {
      if (reasoningStreamingIdRef.current !== null) {
        return prev.map((line) => (line.id === reasoningStreamingIdRef.current ? { ...line, text: line.text + text } : line));
      }
      const id = logIdCounter++;
      reasoningStreamingIdRef.current = id;
      setThinkingLineId(id);
      // A fresh reveal wave for the new line — reusing the running tick
      // count would start it already partway (or fully) revealed.
      setShimmerTick(0);
      return [...prev, { id, text, kind: "reasoning" as const }].slice(-MAX_LOG_ENTRIES);
    });
  }

  function finalizeReasoning() {
    reasoningStreamingIdRef.current = null;
    setThinkingLineId(null);
  }

  function pushCompactionDetail(detail: { droppedCount: number; droppedTokens: number; droppedPreview: string[]; keptCount: number; keptTokens: number; summary: string }) {
    const foldLabel = foldedCompactionSummary(detail.droppedCount, detail.droppedTokens, detail.keptCount);
    setLog((prev) =>
      [...prev, { id: logIdCounter++, text: compactionDetailBody(detail), kind: "compaction-detail" as const, foldLabel }].slice(
        -MAX_LOG_ENTRIES
      )
    );
  }

  function pushToolResult(command: string, output: string) {
    const foldLabel = foldedToolResultSummary(command, output);
    setLog((prev) =>
      [...prev, { id: logIdCounter++, text: output, kind: "tool-result" as const, foldLabel }].slice(-MAX_LOG_ENTRIES)
    );
  }

  function pushTool(label: string) {
    const id = logIdCounter++;
    activeToolLineIdRef.current = id;
    setLog((prev) => [...prev, { id, text: label, kind: "tool" as const }].slice(-MAX_LOG_ENTRIES));
  }

  // Marks the most recently pushed tool-call line as finished — requested
  // directly: "툴 호출 명령어가 멀티 라인일결우에는 해당 명령어가 끝나면
  // 폴딩으로 접어줘야해 다시 클릭하면 폴더를 열고". Only actually folds it
  // if it turns out to span more than one wrapped line (checked in the
  // row-building loop, same as tool-result) — while a call is still
  // running it's never folded, only once onToolCallDone fires.
  function finalizeToolCall() {
    if (activeToolLineIdRef.current === null) return;
    const id = activeToolLineIdRef.current;
    activeToolLineIdRef.current = null;
    setCompletedToolIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  // Folds every currently-expanded diff to its one-line summary. Diffs
  // default to expanded (the point is to actually see the change), but
  // shouldn't sit taking up the whole log forever — requested directly to
  // fold them once the MODEL starts on the next command ("다음 명령어를
  // 모델이 처리 시작하면 닫힘으로"), not when the human merely presses
  // Enter (an earlier version of this folded on the keypress itself, which
  // was explicitly called out as wrong — a queued/auto-resumed command the
  // model picks up on its own never went through that keypress at all).
  // Wired to loop.ts's onTurnStart (index.tsx). Still re-expandable by click.
  function collapseDiffs() {
    setCollapsedDiffIds((prev) => {
      const next = new Set(prev);
      for (const line of log) if (line.kind === "diff") next.add(line.id);
      return next;
    });
  }


  // Echoes the startup resume question into the scrolling log as well as
  // showing it in the input box (see visibleInput below) — reported
  // directly: the input-box-only version wasn't visible on a real
  // terminal ("좌표 문제인듯" / "seems like a coordinate problem"). The
  // input box's text is positioned via delicate absolute-cursor math tied
  // to the terminal's reported size (see the cursor-positioning useEffect
  // further down); if that size is ever misdetected the single-line
  // question can end up genuinely off-screen or overwritten while the rest
  // of the app still looks fine. The log area uses a completely different,
  // independently-wrapped rendering path (wrapPreservingTables/wrapToWidth
  // below), so this guarantees the question is visible regardless of
  // whatever coordinate issue might affect the input box specifically.
  useEffect(() => {
    if (resumeConfirmPending) {
      pushLine(
        `이전 작업이 있습니다: "${pendingResumeGoal}"\n이어서 진행할까요? Y(예) / N(아니오) 를 입력해주세요.`,
        "status"
      );
    }
    // Runs once, at mount — resumeConfirmPending only ever starts true and
    // is answered exactly once per session (see useInput below), so there's
    // nothing to re-run this for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((rawChar, key) => {
    // Reassemble a mouse report split across chunk boundaries (see
    // mouseBufferRef's doc comment) before anything else looks at it.
    let char = rawChar;
    if (mouseBufferRef.current || /\x1b\[</.test(char) || looksLikePartialMouseSequenceStart(char)) {
      const outcome = bufferMouseChunk(mouseBufferRef.current, char);
      if (outcome.action === "process") {
        mouseBufferRef.current = "";
        char = outcome.text;
      } else {
        // "wait": still incomplete, buffered for the next call. "discard":
        // not actually a mouse report (or corrupted) — dropped. Either way,
        // don't type this fragment or treat it as a real key.
        if (outcome.action === "wait") mouseBufferRef.current = mouseBufferRef.current + char;
        else mouseBufferRef.current = "";
        return;
      }
    }
    // Mouse wheel (reporting enabled in index.tsx). Handled before
    // anything else so a report can never be typed into the input box or
    // answer a Y/N prompt.
    // Every SGR mouse report (wheel, click, release, drag) matches this and
    // must be fully consumed here regardless of which kind it is — parsing
    // it as a wheel event alone first and only checking for a click on a
    // separate early-return path meant a click's own "not a wheel" (0 rows)
    // result from parseMouseWheel already returned before the click parser
    // ever ran, so clicks did nothing. Verified against the real binary
    // (pty + a real terminal emulator) that this was the actual cause.
    if (/\[<\d+;\d+;\d+[Mm]/.test(char)) {
      const wheel = parseMouseWheel(char);
      if (wheel !== null && wheel !== 0 && !menuOpen && quittingSince === null) {
        setScrollOffset((s) => Math.max(0, Math.min(maxScrollRef.current, s + wheel)));
      }
      // A plain click: toggle a folded/expanded reasoning block if it
      // landed on one of its rows. Ignored while the menu is open or
      // saving (the map wasn't built for those layouts).
      if (!menuOpen && quittingSince === null) {
        const { firstRow, entries } = clickMapRef.current;
        for (const { row } of parseMouseClicks(char)) {
          const idx = row - firstRow;
          const entry = idx >= 0 && idx < entries.length ? entries[idx] : undefined;
          if (!entry?.foldable) continue;
          // Diffs track their FOLDED ids (default expanded); everything
          // else tracks its EXPANDED ids (default folded) — see
          // collapsedDiffIds/expandedReasoningIds's own doc comments.
          const setFn = entry.isDiff ? setCollapsedDiffIds : setExpandedReasoningIds;
          setFn((prev) => {
            const next = new Set(prev);
            if (next.has(entry.lineId)) next.delete(entry.lineId);
            else next.add(entry.lineId);
            return next;
          });
        }
      }
      return;
    }

    // Saving before exit: only "quit now without saving" does anything.
    if (quittingSince !== null) {
      if (key.escape || (key.ctrl && char.toLowerCase() === "c")) {
        pushLine("[quitting without waiting for the save]", "status");
        onQuitWithoutSaving();
      }
      return;
    }

    // Ink's default Ctrl-C-exits-the-app behavior is disabled in index.tsx
    // (exitOnCtrlC: false) specifically so this reaches here instead —
    // reported directly: some terminals/users treat Ctrl-C as copy, not an
    // interrupt, and it shouldn't kill llamacli either way. Make it an
    // explicit no-op (not inserted into the input, doesn't touch the
    // menu) rather than falling through to the generic "append this
    // character" branch, which would otherwise insert the raw control
    // byte into whatever you were typing. /quit is still the only way out.
    if (key.ctrl && char.toLowerCase() === "c") {
      return;
    }

    // Startup resume question, answered before anything else can happen —
    // set once from pendingResumeGoal (index.tsx found a checkpoint on
    // disk before this ever rendered) and never re-armed after being
    // answered once, so it can't reappear mid-session.
    if (resumeConfirmPending) {
      const lower = char.toLowerCase();
      if (lower === "y") {
        setResumeConfirmPending(false);
        pushLine("[resuming previous work...]", "status");
        onResumeDecision(true);
      } else if (lower === "n" || key.escape) {
        setResumeConfirmPending(false);
        pushLine("[starting fresh — previous checkpoint discarded]", "status");
        onResumeDecision(false);
      }
      // any other key: still waiting for a real y/n answer — ignored.
      return;
    }

    // Esc → Y/N confirmation dialog, entered below. While it's showing,
    // every keystroke is consumed here (y/n/esc) rather than falling
    // through to the menu or normal typing — a stray key must never
    // silently quit the app, and must never silently leak into the input
    // box either.
    if (quitConfirmPending) {
      const lower = char.toLowerCase();
      if (lower === "y") {
        setQuitConfirmPending(false);
        pushLine("[force quitting — saving progress to resume later]", "status");
        onForceQuit();
      } else if (lower === "n" || key.escape) {
        setQuitConfirmPending(false);
      }
      // any other key: still waiting for a real y/n answer — ignored.
      return;
    }

    if (menuOpen) {
      // Reported directly: the menu could only be driven with arrow keys —
      // typing the rest of a command's name (the obvious first thing to
      // try after "/") did nothing at all, since this branch previously
      // handled only up/down/return/escape and fell through to `return`
      // for everything else. Filter-as-you-type now works like a normal
      // command palette instead.
      const filtered = filterMenuItems(input);
      if (key.upArrow) setMenuIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMenuIndex((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
      else if (key.return) {
        const item = filtered[menuIndex];
        if (!item) return; // no match under the current filter — nothing to select
        setMenuOpen(false);
        setInput("");
        if (item.key === "queue") {
          pushLine(
            queue.length
              ? `Queue (${queue.length}):\n${queue.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
              : "The queue is empty.",
            "status"
          );
        } else {
          // Pass everything after the command key as its argument, so
          // commands that take text (e.g. "/fastcheck <question>") can read it.
          onSlashCommand(item.key, input.slice(item.key.length + 1));
        }
      } else if (key.escape) {
        setMenuOpen(false);
        setInput("");
      } else if (key.backspace || key.delete) {
        // Backspacing the "/" itself closes the menu — matches typing "/"
        // to open it being the exact inverse action, rather than leaving
        // an empty, command-less menu open.
        if (input.length <= 1) {
          setMenuOpen(false);
          setInput("");
        } else {
          setInput((s) => s.slice(0, -1));
          setMenuIndex(0); // narrower/wider filter — re-highlight the top match
        }
      } else if (char && !key.ctrl && !key.meta) {
        setInput((s) => s + stripAnsi(char));
        setMenuIndex(0);
      }
      return;
    }

    // Esc (menu not open, no confirmation already showing) opens the force-
    // quit confirmation above — works at any time, not just while a turn is
    // running, so it doubles as a quick "get me out of here" independent of
    // /quit's normal self-improvement-review gate. Also echoed into the log
    // (not just the input box) for the same visibility reason as the
    // startup resume question above.
    if (key.escape) {
      setQuitConfirmPending(true);
      pushLine("강제 종료하시겠습니까? 진행 중인 작업은 저장되어 다음 실행 시 이어집니다.\nY(예) / N(아니오) 를 입력해주세요.", "status");
      return;
    }

    // PageUp/PageDown scroll the log a full screen at a time — unaffected
    // by the history repurposing below (Ink gives an empty `char` for
    // these, so the fallback append-to-input further down was already a
    // harmless no-op for them).
    if (key.pageUp || key.pageDown) {
      const amount = Math.max(1, logHeightRef.current - 1);
      const direction = key.pageUp ? 1 : -1;
      setScrollOffset((s) => Math.max(0, Math.min(maxScrollRef.current, s + amount * direction)));
      return;
    }

    // Plain Up/Down: prompt history, matching a normal shell. (Previously
    // these did line-by-line log scrollback — moved to PageUp/PageDown-only
    // above, since history is the far more commonly reached-for behavior
    // for arrow keys specifically, and Page Up/Down already covers
    // scrollback on its own.)
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      if (key.upArrow) {
        if (historyIndex >= history.length - 1) return; // already at the oldest entry
        if (historyIndex === -1) setHistoryDraft(input); // stash what was being typed
        const next = historyIndex + 1;
        setHistoryIndex(next);
        setInput(history[history.length - 1 - next]);
      } else {
        if (historyIndex === -1) return; // not currently browsing — nothing to go back to
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setInput(next === -1 ? historyDraft : history[history.length - 1 - next]);
      }
      return;
    }

    if (key.return) {
      if (input.trim().length === 0) return;
      // The model (and history — recalling it later must give back the
      // real text, not a label whose backing content is about to be
      // dropped below) always gets the REAL pasted content; only the
      // on-screen log line keeps the compact placeholder, matching what
      // was actually visible while composing it instead of dumping a
      // potentially huge block into the transcript.
      const resolvedInput = substitutePlaceholders(input, pastedBlocks);
      if (busy) {
        onQueueMessage(resolvedInput);
        pushLine(`[queued] ${input}`, "status");
      } else {
        pushLine(input, "user");
        onSubmit(resolvedInput);
      }
      // Every actually-submitted prompt (sent now or queued) joins history —
      // see appendHistory's doc comment on why both count.
      setHistory((h) => {
        const next = appendHistory(h, resolvedInput);
        onHistoryChange(next);
        return next;
      });
      setHistoryIndex(-1);
      setHistoryDraft("");
      setInput("");
      setPastedBlocks(new Map());
      // A message you just sent should be visible without having to
      // manually scroll back down for it — snap back to the live tail,
      // matching how a normal chat/terminal view behaves.
      setScrollOffset(0);
      return;
    }
    if (key.backspace || key.delete) {
      // A pasted block is one atomic unit to delete, not one character at
      // a time — see pasteChip.ts's doc comment.
      const trailingPlaceholder = findTrailingPlaceholder(input, pastedBlocks);
      if (trailingPlaceholder) {
        setInput((s) => s.slice(0, s.length - trailingPlaceholder.length));
        setPastedBlocks((m) => {
          const next = new Map(m);
          next.delete(trailingPlaceholder);
          return next;
        });
      } else {
        setInput((s) => s.slice(0, -1));
      }
      return;
    }
    if (char === "/" && input.length === 0) {
      setMenuOpen(true);
      setMenuIndex(0);
      setInput("/");
      return;
    }
    // A pasted string can carry raw ANSI escape codes (color codes copied
    // along with colored terminal output, a diff, `ls --color`, etc.) —
    // reported directly as garbled characters and a misaligned input box.
    // The input box renders plain text with wrapToWidth (not the ANSI-
    // aware wrapAnsiSafe used for the log area, since a prompt has no
    // business containing color in the first place), which naively wraps
    // one raw character at a time and tears an escape sequence apart
    // mid-code — the broken remainder then renders as literal garbage.
    // Strip control codes at the point of entry instead of trying to wrap
    // them correctly: a prompt is plain text, so there's nothing worth
    // preserving.
    const sanitized = stripAnsi(char);
    // A real clipboard paste lands here as one single (often long)
    // string, rather than one useInput call per character the way actual
    // typing does — see pasteChip.ts's doc comment for the full design
    // and why a short burst of a few characters is deliberately left as
    // plain text instead.
    if (isLikelyPaste(sanitized)) {
      const isPath = looksLikePastedFilePath(sanitized) && existsSync(sanitized.trim());
      const label = formatPasteLabel(sanitized, pasteCounterRef.current++, isPath);
      setPastedBlocks((m) => new Map(m).set(label, sanitized));
      setInput((s) => s + label);
    } else {
      setInput((s) => s + sanitized);
    }
  });

  // TODO: replace with a proper imperative handle / event emitter once the
  // agent loop is wired to real streaming; global is a placeholder only.
  (globalThis as any).__llamacli_ui = {
    pushAssistantDelta,
    finalizeAssistant,
    pushReasoningDelta,
    finalizeReasoning,
    pushCompactionDetail,
    pushToolResult,
    collapseDiffs,
    setQueue,
    pushStatus: (t: string) => pushLine(t, "status"),
    pushTool,
    finalizeToolCall,
    pushDiff: (t: string) => pushLine(t, "diff"),
    setBusy,
    isBusy: () => busy,
    beginQuitting: () => setQuittingSince((t) => t ?? Date.now()),
    setContextUsedRatio,
    setPlanProgress: (done: number, total: number) => setPlanProgress(total > 0 ? { done, total } : null),
    setCompactionStatus: (state: "running" | "complete" | "failed", timestamp: string) => setCompactionStatus({ state, timestamp }),
  };

  // Reported directly: llamacli flickers, especially noticeable on Windows
  // consoles/WSL windows. Traced to Ink itself (node_modules/ink/build/ink.js
  // onRender): whenever the rendered tree's height is >= the terminal's row
  // count, Ink can't safely do its normal cheap redraw (move cursor up N
  // lines, erase, rewrite only what changed) — it falls back to a full
  // `clearTerminal` + redraw of the ENTIRE screen instead. The root Box below
  // is given height={rows} with overflow="hidden", so its rendered output is
  // exactly `rows` lines tall — which trips that `outputHeight >= stdout.rows`
  // check on literally every single render. Combined with the startup
  // banner's shimmer animation (an 80ms setInterval — see SHIMMER_TICK_MS),
  // that's a full-screen clear roughly 12 times a second during the intro,
  // visibly flickering (worse on Windows terminals, which paint escape
  // sequences slower than a typical Linux terminal emulator). Reserving one
  // row of headroom (`rows - 1`) keeps outputHeight strictly below
  // stdout.rows, so Ink takes its cheap incremental-diff path instead —
  // this one row was never guaranteed visible content anyway (any terminal
  // this app runs in reserves at least the bottom row for its own cursor/
  // scroll behavior).
  const rows = Math.max(1, (stdout?.rows ?? 24) - 1);
  const columns = stdout?.columns ?? 80;
  // Reserves 2 extra columns for the input box's own left+right border
  // characters (see the bordered Box below) on top of its padding/spinner/space.
  const maxInputWidth = Math.max(10, columns - 6);
  const quitting = quittingSince !== null;
  const QUIT_CONFIRM_TEXT = "강제 종료하시겠습니까? 진행 중인 작업은 저장되어 다음 실행 시 이어집니다. (Y/N)";
  const RESUME_CONFIRM_TEXT = pendingResumeGoal
    ? `이전 작업을 이어서 하시겠습니까? "${pendingResumeGoal}" (Y/N)`
    : "";
  const quittingText = quitting ? quittingStatusText(Date.now() - quittingSince!) : "";
  // The three confirmation/status prompts are always a single fixed message,
  // so they keep the old right-truncated single-line behavior (tailToWidth).
  // The real user-typed `input`, however, now grows the box instead of
  // silently truncating: reported directly — pasting or typing past one
  // line used to either get cut with no way to see the rest, or (before
  // that) broke the fixed layout outright when Ink auto-wrapped a <Text>
  // wider than the terminal (see the removed comment this replaced). A
  // literal "\n" already lands in `input` as-is (Ctrl+J, or embedded in a
  // pasted multi-line string — see useInput below), so wrapping it here is
  // what actually turns that into visible multi-line growth instead of a
  // broken row.
  const singleLineStatus = quitting
    ? tailToWidth(quittingText, maxInputWidth)
    : resumeConfirmPending
    ? tailToWidth(RESUME_CONFIRM_TEXT, maxInputWidth)
    : quitConfirmPending
      ? tailToWidth(QUIT_CONFIRM_TEXT, maxInputWidth)
      : null;
  // Caps how tall the input box can grow: bounded by both an absolute
  // sanity limit and however many rows are actually available above the
  // fixed chrome (top+bottom border + status bar = 3, plus at least 3 rows
  // kept for the log) — never allowed to push the total layout past `rows`.
  const maxInputVisibleLines = Math.max(1, Math.min(8, rows - 6));
  const inputLines =
    singleLineStatus !== null
      ? [singleLineStatus]
      : (() => {
          const wrapped = wrapToWidth(input, maxInputWidth);
          return wrapped.length <= maxInputVisibleLines
            ? wrapped
            : wrapped.slice(wrapped.length - maxInputVisibleLines);
        })();

  // logHeight is a CONSTANT, independent of menu state — this is the outer
  // log-area Box's actual `height`, and it must never change, because
  // changing it is what breaks things: (1) shrinking it only while the
  // menu was open shifted everything below (input box, status bar) by up
  // to ~10 rows in one frame, and Ink's incremental diffing didn't fully
  // clear the old content at the shifted-from position, leaving stale
  // fragments right on the input box's border (confirmed via a screen
  // recording: a leftover "셀" there after closing the menu). (2)
  // Permanently reserving the menu's height as a *separate* fixed box
  // avoided that, but left a permanent empty gap between the log and the
  // input box whenever the menu was closed (reported directly: text
  // "doesn't reach down to the prompt input"). (3) `position="absolute"`
  // to overlay it doesn't work in Ink 4.x — it only sets the Yoga position
  // TYPE, not an actual offset (no top/left/right/bottom style exists),
  // and a `marginTop` substitute pushed the menu's output past the
  // `overflow: hidden` boundary instead of being clipped, scrolling the
  // real terminal (confirmed by direct byte capture).
  //
  // The fix: keep this Box's height fixed at all times, and instead change
  // what's rendered *inside* it — when the menu is open, show fewer log
  // rows and the menu in the space freed up, all within the SAME
  // never-changing box. The outer box's contribution to the layout is
  // therefore always exactly `logHeight`, so nothing below it ever needs
  // to move, and nothing is permanently reserved when the menu is closed.
  const menuBoxHeight = SLASH_MENU_ITEMS.length + 2; // round border top+bottom
  // Chrome below the log area: input box top border(1) + content(inputLines.length)
  // + bottom border(1) + status bar(1). Unlike menuBoxHeight above, this is
  // NOT held fixed — an input box that grows to show a multi-line prompt
  // must borrow real rows from the log area (there's nowhere else for them
  // to come from), so logHeight intentionally shrinks/grows with
  // inputLines.length. maxInputVisibleLines already keeps at least 3 rows
  // for the log no matter how tall the input gets.
  const logHeight = Math.max(3, rows - 3 - inputLines.length);
  logHeightRef.current = logHeight;

  // Absolute cursor positioning, reliable because index.tsx switches to the
  // terminal's alternate screen buffer before rendering (giving row 1 a
  // fixed, known meaning) and the app's total height is now provably
  // constant every frame regardless of menu state. Editing is append/
  // backspace-only (no interior cursor movement), so the cursor always
  // sits at the end of the LAST visual line of the input box.
  useEffect(() => {
    const inputTopBorderRow = logHeight + 1;
    // The log↔input boundary moves whenever inputLines.length changes
    // (the input box grows/shrinks and logHeight shrinks/grows to match —
    // their sum is always exactly `rows`, so no gap opens at the bottom of
    // the terminal, but the ROW at which one ends and the other begins
    // shifts). This is the same class of bug already hit twice in this
    // file when a box's height changed frame-to-frame (da7d893, 11a5ee1):
    // Ink's own incremental diff doesn't always fully overwrite a row that
    // held one box's content in the previous frame and now belongs to the
    // other box, leaving a stale fragment of the old row visible — exactly
    // what was reported as the running line "floating" above a gap.
    // Ink has already committed its own frame by the time this effect
    // runs (effects fire after paint), so explicitly blanking every row
    // the boundary swept across is safe: it can only ever erase a stale
    // leftover, never something Ink still needs to show, since whichever
    // box now owns that row will redraw it on the very next state change
    // (the input box border itself needs no redraw from us because a
    // completely blank row includes no content Ink was relying on).
    // Reported directly: on a terminal that doesn't actually interpret ANSI
    // escapes, every one of these raw writes shows up as literal stray
    // characters in the prompt instead of moving the cursor/clearing a row
    // — see ansiSupport.ts's doc comment. Skip the whole block: Ink's own
    // (safer, if slightly less precise) redraw still applies either way.
    if (!supportsAnsiTui()) {
      prevInputTopBorderRowRef.current = inputTopBorderRow;
      return;
    }

    const prevInputTopBorderRow = prevInputTopBorderRowRef.current;
    if (prevInputTopBorderRow !== null && prevInputTopBorderRow !== inputTopBorderRow) {
      const lo = Math.min(prevInputTopBorderRow, inputTopBorderRow);
      const hi = Math.max(prevInputTopBorderRow, inputTopBorderRow);
      let clearSeq = "";
      for (let r = lo; r < hi; r++) clearSeq += `\x1b[${r};1H\x1b[2K`;
      process.stdout.write(clearSeq);
    }
    prevInputTopBorderRowRef.current = inputTopBorderRow;

    const lastLineIndex = inputLines.length - 1;
    const lastLine = inputLines[lastLineIndex] ?? "";
    const inputRow = inputTopBorderRow + 1 /* first content row */ + lastLineIndex;
    // Only the first content row is prefixed with the spinner + a leading
    // space (see the input Box's JSX below); every wrapped continuation
    // line starts flush after the border+padding instead.
    const promptColumn =
      lastLineIndex === 0
        ? 1 /* left border */ + 1 /* paddingX */ + 1 /* spinner */ + 1 /* leading space */ + stringWidth(lastLine) + 1
        : 1 /* left border */ + 1 /* paddingX */ + stringWidth(lastLine) + 1;
    const hideCursor = shouldHideCursor({ quitting, busy, input });
    process.stdout.write(`\x1b[${inputRow};${promptColumn}H${hideCursor ? "\x1b[?25l" : "\x1b[?25h"}`);
  });

  // Every log entry is wrapped into terminal rows once and cached by id
  // (recomputed only when its text or the width changes — e.g. the
  // streaming assistant line), and React elements are built only for the
  // visible window. Previously only the last max(logHeight*5, 50) entries
  // were flattened at all, to keep each render cheap — which also capped
  // how far PageUp could go: reported directly, older output of a long
  // session couldn't be scrolled back to.
  //
  // Ink/Yoga gives an empty-string <Text> ZERO rendered height — not one
  // row like every other line — which made the flex-end log box fall short
  // of `logHeight` and show a gap at the top. A single space renders as a
  // real one-row blank line instead.
  const asRow = (s: string) => s || " ";
  const width = Math.max(10, columns);
  const rowCache = rowCacheRef.current;
  const liveIds = new Set<number>();
  const allRows: RenderedRow[] = [];
  for (const line of log) {
    liveIds.add(line.id);
    // A finished (not actively streaming) reasoning block: fold to one
    // summary row unless the user has expanded it. Handled here, outside
    // the wrap cache below, since the cache is keyed on (text, width) —
    // fold state isn't either of those, and re-deriving the fold decision
    // fresh each render is cheap (no re-wrapping needed for the common,
    // folded case).
    if (line.kind === "reasoning" && line.id !== thinkingLineId) {
      if (!expandedReasoningIds.has(line.id)) {
        allRows.push({ key: `${line.id}-fold`, text: foldedReasoningSummary(line.text), kind: "reasoning-folded", lineId: line.id });
        continue;
      }
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      allRows.push({ key: `${line.id}-fold-hint`, text: foldToggleHintExpanded, kind: "reasoning-folded", lineId: line.id });
      continue;
    }
    // Compaction before/after detail: same fold-by-default, click-to-expand
    // pattern as reasoning, just always foldable (never "currently
    // streaming") and using its own precomputed label instead of deriving
    // one from the (here, already-expanded-body) text.
    if (line.kind === "compaction-detail") {
      if (!expandedReasoningIds.has(line.id)) {
        allRows.push({
          key: `${line.id}-fold`,
          text: line.foldLabel ?? "▸ 압축 완료 — 클릭해서 펼치기",
          kind: "compaction-detail-folded",
          lineId: line.id,
        });
        continue;
      }
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      allRows.push({ key: `${line.id}-fold-hint`, text: foldToggleHintExpanded, kind: "compaction-detail-folded", lineId: line.id });
      continue;
    }
    if (line.kind === "tool-result") {
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      // Only worth folding when it actually spans more than one line —
      // requested directly ("도구 사용도 출력도 한 줄이 넘으면 ... 자동으로
      // 닫힘"): a one-line result folding down to a one-line summary just
      // to be clicked back open is pure friction, not decluttering.
      if (cached.rows.length <= 1) {
        cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
        continue;
      }
      if (!expandedReasoningIds.has(line.id)) {
        allRows.push({
          key: `${line.id}-fold`,
          text: line.foldLabel ?? "▸ 결과 — 클릭해서 펼치기",
          kind: "tool-result-folded",
          lineId: line.id,
        });
        continue;
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      allRows.push({ key: `${line.id}-fold-hint`, text: foldToggleHintExpanded, kind: "tool-result-folded", lineId: line.id });
      continue;
    }
    // A multi-line tool-call label folds down once it's actually finished
    // (completedToolIds, set by finalizeToolCall — see its own doc
    // comment) — never while still running, and never at all if it only
    // ever took one line in the first place.
    if (line.kind === "tool") {
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      const foldable = completedToolIds.has(line.id) && cached.rows.length > 1;
      if (!foldable) {
        cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
        continue;
      }
      if (!expandedReasoningIds.has(line.id)) {
        allRows.push({ key: `${line.id}-fold`, text: `▸ ${cached.rows[0]}… — 클릭해서 펼치기`, kind: "tool-folded", lineId: line.id });
        continue;
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      allRows.push({ key: `${line.id}-fold-hint`, text: foldToggleHintExpanded, kind: "tool-folded", lineId: line.id });
      continue;
    }
    // Diffs: opposite default from the two folds above (see
    // collapsedDiffIds's doc comment) — shown in full unless collapsed,
    // either by clicking or because the next command was submitted.
    if (line.kind === "diff") {
      if (collapsedDiffIds.has(line.id)) {
        allRows.push({ key: `${line.id}-fold`, text: line.foldLabel ?? foldedDiffSummary(line.text), kind: "diff-folded", lineId: line.id });
        continue;
      }
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      allRows.push({ key: `${line.id}-fold-hint`, text: foldToggleHintExpanded, kind: "diff-folded", lineId: line.id });
      continue;
    }
    // The currently-streaming assistant line gets the same shining
    // reveal-wave effect reasoning already has (see streamingAssistantId's
    // doc comment) — plain wrapping, not markdown, while it's playing:
    // shimmerBands slices raw characters, which would tear markdown's own
    // embedded ANSI color codes apart. Reverts to real markdown rendering
    // once finalizeAssistant() clears streamingAssistantId (and this same
    // id's stale cache entry, so the next render re-wraps instead of
    // reusing these plain rows).
    if (line.kind === "assistant" && line.id === streamingAssistantId) {
      let cached = rowCache.get(line.id);
      if (!cached || cached.text !== line.text || cached.width !== width) {
        cached = { text: line.text, width, rows: wrapToWidth(line.text, width).map(asRow) };
        rowCache.set(line.id, cached);
      }
      cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
      continue;
    }
    let cached = rowCache.get(line.id);
    if (!cached || cached.text !== line.text || cached.width !== width) {
      cached = { text: line.text, width, rows: wrapLogLine(line, width).map(asRow) };
      rowCache.set(line.id, cached);
    }
    cached.rows.forEach((text, i) => allRows.push({ key: `${line.id}-${i}`, text, kind: line.kind, lineId: line.id }));
  }
  if (rowCache.size > liveIds.size) {
    for (const id of rowCache.keys()) if (!liveIds.has(id)) rowCache.delete(id);
  }

  // Content rows available to the log itself (as opposed to the menu, or
  // the one-row scroll indicator below) — reserving a row for the
  // indicator ahead of actually being scrolled (rather than only once
  // scrollOffset > 0) keeps maxScrollRef consistent regardless of current
  // scroll position, avoiding a circular "how much can I scroll depends on
  // whether I'm already scrolled" dependency.
  // One row at the bottom of the log area goes to the key hint, only while
  // the agent is running.
  const showRunHint = busy && !quitting && !quitConfirmPending && !resumeConfirmPending && !menuOpen;
  const hintRows = showRunHint ? 1 : 0;
  const scrollableContentRows = menuOpen
    ? Math.max(0, logHeight - menuBoxHeight)
    : Math.max(0, logHeight - 1 - hintRows);
  const maxScroll = Math.max(0, allRows.length - scrollableContentRows);
  maxScrollRef.current = maxScroll;
  const clampedScroll = menuOpen ? 0 : Math.min(scrollOffset, maxScroll);
  const showScrollIndicator = !menuOpen && clampedScroll > 0;
  const contentRows = menuOpen ? scrollableContentRows : logHeight - (showScrollIndicator ? 1 : 0) - hintRows;
  const sliceEnd = allRows.length - clampedScroll;
  const sliceStart = Math.max(0, sliceEnd - contentRows);

  // Absolute terminal row of the first visible content row, for mapping a
  // mouse click's (row, col) back to a log line. The log box is bottom-
  // anchored (flex-end) at fixed height `logHeight` starting at terminal
  // row 1 (the alt screen's origin — see index.tsx): any leftover space
  // when there's less content than the box's height sits ABOVE it, not
  // below, so the first content row isn't always row 1.
  {
    const visibleCount = sliceEnd - sliceStart;
    const childrenHeight = (showScrollIndicator ? 1 : 0) + visibleCount + (menuOpen ? menuBoxHeight : 0) + hintRows;
    const gap = Math.max(0, logHeight - childrenHeight);
    clickMapRef.current = {
      firstRow: 1 + gap + (showScrollIndicator ? 1 : 0),
      entries: allRows
        .slice(sliceStart, sliceEnd)
        .map((r) => ({
          lineId: r.lineId,
          foldable:
            r.kind === "reasoning" ||
            r.kind === "reasoning-folded" ||
            r.kind === "compaction-detail" ||
            r.kind === "compaction-detail-folded" ||
            r.kind === "tool-result" ||
            r.kind === "tool-result-folded" ||
            r.kind === "tool" ||
            r.kind === "tool-folded" ||
            r.kind === "diff" ||
            r.kind === "diff-folded",
          isDiff: r.kind === "diff" || r.kind === "diff-folded",
        })),
    };
  }

  const inputBorderColor = quitting || quitConfirmPending || resumeConfirmPending
    ? "yellow"
    : busy
      ? "magenta"
      : input.length > 0
        ? "cyan"
        : "gray";

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {/* justifyContent="flex-end": when there's less content than
       *  `logHeight` rows (a short/early conversation), Ink's default
       *  top-alignment left it stuck at the top of this box with a growing
       *  gap of blank space below, all the way down to the input box —
       *  reported directly as text never reaching the bottom area. Anchor
       *  it to the bottom instead, so any leftover blank space sits above
       *  the content (like a normal scrolling terminal/chat view), and new
       *  lines are always right next to the input box, not far above it.
       *  This box's `height` is always exactly `logHeight`, whether the
       *  menu is open or not — only how much of that fixed space goes to
       *  log content vs. the menu vs. the scroll indicator changes. */}
      <Box flexDirection="column" height={logHeight} overflow="hidden" justifyContent="flex-end">
        {showScrollIndicator && (
          <Text dimColor>
            {`── ↑ scrolled up ${clampedScroll} line${clampedScroll === 1 ? "" : "s"} · ↓/PageDown to return to live ──`.slice(
              0,
              Math.max(10, columns)
            )}
          </Text>
        )}
        {allRows
          .slice(sliceStart, sliceEnd)
          .map((row) =>
            renderRow(row, row.lineId === thinkingLineId || row.lineId === streamingAssistantId ? shimmerTick : undefined)
          )}
        {menuOpen && <SlashMenu items={filterMenuItems(input)} selectedIndex={menuIndex} />}
        {showRunHint && <Text dimColor>{runHintText(columns)}</Text>}
      </Box>

      {/* The prompt input lives INSIDE this bordered box, not below it —
       *  the border is the visible edge of the actual input area. Grows
       *  with inputLines.length (see logHeight above, which shrinks to
       *  make room) instead of staying pinned to one row — a multi-line
       *  prompt is now genuinely multi-line instead of being silently
       *  truncated to its tail. Only the first row carries the spinner +
       *  leading space; wrapped continuation rows are flush left (matches
       *  the cursor-column math in the positioning effect above). */}
      <Box
        borderStyle="round"
        borderColor={inputBorderColor}
        paddingX={1}
        height={2 + inputLines.length}
        overflow="hidden"
        flexDirection="column"
      >
        <Box>
          <Spinner active={busy || quitting} />
          <Text color={quitting || quitConfirmPending || resumeConfirmPending ? "yellow" : undefined}> {inputLines[0] ?? ""}</Text>
        </Box>
        {inputLines.slice(1).map((line, i) => (
          <Text key={i} color={quitting || quitConfirmPending || resumeConfirmPending ? "yellow" : undefined}>
            {line}
          </Text>
        ))}
      </Box>

      <StatusBar
        cwd={cwd}
        model={model}
        contextUsedRatio={contextUsedRatio}
        planProgress={planProgress}
        compactionStatus={compactionStatus}
        columns={columns}
      />
    </Box>
  );
}
