import React from "react";
import { Box, Text } from "ink";
import { tailToWidth } from "./textWidth.js";
import { Spinner } from "./Spinner.js";

export interface StatusBarProps {
  cwd: string;
  model: string;
  contextUsedRatio: number; // 0..1
  /** Requested directly: show plan/todo progress ("step N of M") somewhere
   *  persistent instead of only scrolling by once in the log — so it's
   *  still visible long after `update_plan` was last called. `null` means
   *  no active plan (nothing declared yet, or the last one finished). */
  planProgress: { done: number; total: number } | null;
  /** Requested directly: the "[compaction complete] ..." log line got
   *  pushed out of view by later scrolling activity (a long tool-call
   *  batch, a slow prompt-processing wait) before it was ever actually
   *  noticed. `null` means no compaction has happened yet this session. */
  compactionStatus: { state: "running" | "complete" | "failed"; timestamp: string } | null;
  /** Terminal width, used to keep this bar to exactly one row — an
   *  unconstrained cwd/model string wraps onto a second row otherwise,
   *  which is the same overflow-then-ghosting bug the input line and slash
   *  menu had (see App.tsx). */
  columns: number;
  /** Requested directly: the busy-spinner used to sit at the front of the
   *  prompt input box, but its own animation right next to typed text made
   *  the whole line look like it was trembling as the frame changed. Moved
   *  here instead — right in front of the model name, replacing the plain
   *  "│" divider with an animated frame while the model is actually
   *  working, back to "│" once it's idle. Not something read character by
   *  character while composing, so the same animation reads as normal
   *  motion here instead of visual noise. */
  busy: boolean;
  /** Whether the terminal can render the block/shade glyphs the gauge is
   *  drawn with. From terminal.ts's `unicode`; false switches to an ASCII
   *  gauge of the same width rather than letting `█` become `?`. */
  unicode: boolean;
  /** How far back the log is scrolled (rows) and the furthest it can go.
   *  `offset === 0` means pinned to the bottom (following new output).
   *
   *  Added because scrolling back with PageUp looked identical to being at
   *  the bottom: nothing indicated you were reading history, and nothing
   *  indicated that output kept arriving underneath you. Both are real
   *  traps in a long agent session — you scroll up to re-read a command, and
   *  a turn finishes while you're there, and there is no way to tell that
   *  without scrolling all the way back down. `null` keeps this bar's layout
   *  byte-identical to before on terminals too narrow to show it. */
  scroll: { offset: number; max: number } | null;
}

const GAUGE_WIDTH = 12;
// Fixed width for the plan-progress slot ("N/M"), reserved WHETHER OR NOT
// a plan is currently active — if this only took up space while a plan
// existed, cwd/model's available width would shift the moment one starts
// or finishes, which is exactly the "layout changing mid-session shifts
// everything else" class of bug already fixed elsewhere (see App.tsx's
// `logHeight` comment). Sized for up to 3 digits each side ("999/999").
const PLAN_PROGRESS_WIDTH = 7;
// On a narrow terminal, statusBarFieldWidth's own floor (8) already eats
// into cwd/model's budget — reserving 8 more fixed columns for the
// plan-progress slot on top of that pushed the row's real total width
// past the terminal width entirely (caught directly: 40 columns → 47
// used), risking the exact "this row wraps" bug the whole fixed-width
// layout here exists to prevent. Drop the slot below this width instead
// of letting cwd/model get squeezed to nothing to make room for it —
// resizing already reflows everything else in this app, so this
// disappearing on a narrow terminal is ordinary responsive behavior, not
// the "layout shifts based on unrelated state" class of bug that was
// fixed elsewhere.
const MIN_COLUMNS_FOR_PLAN_SLOT = 60;

export function hasRoomForPlanSlot(columns: number): boolean {
  return columns >= MIN_COLUMNS_FOR_PLAN_SLOT;
}

// "✓ HH:MM:SS" / "✗ HH:MM:SS" / "compacting" are all exactly 10 chars.
const COMPACTION_STATUS_WIDTH = 10;
// Same reasoning as MIN_COLUMNS_FOR_PLAN_SLOT, but this slot's own width
// added on top of it — narrow terminals drop this one first (it's the
// less critical of the two: plan progress reflects a real to-do list,
// this is a point-in-time event notice).
const MIN_COLUMNS_FOR_COMPACTION_SLOT = 80;

export function hasRoomForCompactionSlot(columns: number): boolean {
  return columns >= MIN_COLUMNS_FOR_COMPACTION_SLOT;
}

// "^ 12/48" — one char of marker, one space, then rows-back / rows-available.
export const SCROLL_INDICATOR_WIDTH = 8;
const MIN_COLUMNS_FOR_SCROLL_SLOT = 72;

export function hasRoomForScrollSlot(columns: number): boolean {
  return columns >= MIN_COLUMNS_FOR_SCROLL_SLOT;
}

/**
 * The scroll indicator text, always exactly `SCROLL_INDICATOR_WIDTH` wide
 * while scrolled, and "" when pinned to the bottom.
 *
 * Blank-when-idle rather than "0/0": the slot itself is reserved in the
 * width budget unconditionally (see statusBarFieldWidth), so the bar's
 * layout is byte-identical whether you're scrolled or not and nothing
 * reflows the moment you press PageUp. Only the *content* appears.
 *
 * The width is bounded the same way the plan slot is — a session that
 * scrolled 10,000 rows back would otherwise produce a 4-digit number that
 * overflows the reserved slot and wraps the whole row.
 */
export function formatScrollIndicator(
  scroll: { offset: number; max: number } | null,
  up: string,
  wide: boolean
): string {
  if (!scroll || scroll.offset <= 0) return "";
  const text = wide
    ? `${scroll.offset}/${scroll.max}`
    : `${Math.min(scroll.offset, 99)}/${scroll.max}`;
  if (text.length + 2 > SCROLL_INDICATOR_WIDTH) return "";
  return (`${up} ${text}`).padStart(SCROLL_INDICATOR_WIDTH);
}

/** Formats the compaction indicator text, always exactly
 *  `COMPACTION_STATUS_WIDTH` characters (or "" for no compaction yet) so
 *  it never shifts anything next to it regardless of which state it's in.
 *
 *  `unicode` picks the mark only — the ASCII alternatives are also exactly
 *  one column, which is the constraint that matters here: a two-column
 *  fallback would silently push the gauge over the terminal width and wrap
 *  the row, which is the bug this fixed-width formatting exists to prevent. */
export function formatCompactionStatus(
  status: { state: "running" | "complete" | "failed"; timestamp: string } | null,
  unicode = true
): string {
  if (!status) return "";
  if (status.state === "running") return "compacting";
  const hhmmss = status.timestamp.slice(11, 19); // ISO 8601 "...THH:MM:SS.sssZ"
  const mark = status.state === "complete" ? (unicode ? "✓" : "+") : unicode ? "✗" : "x";
  return `${mark} ${hhmmss}`;
}

/** Renders a small bar-animation battery gauge for context usage (PROMPT.md §6).
 *
 *  `█`/`░` are U+2588/U+2591 block elements. On a terminal without block
 *  coverage — or under a non-UTF-8 locale — they come out as `?` or at a
 *  width the terminal disagrees with, and because this row is on the
 *  app's fixed one-row-height budget, a width mismatch shifts everything
 *  beside it. The ASCII pair below is the same visual at the same width.
 *  See terminal.ts's `detectUnicode` for how the locale is decided. */
export function renderGauge(ratio: number, unicode: boolean): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * GAUGE_WIDTH);
  if (unicode) return "█".repeat(filled) + "░".repeat(GAUGE_WIDTH - filled);
  // "#" for filled, "." for empty — distinct at a glance in a terminal
  // where the block shades would have collapsed into the same glyph.
  return "#".repeat(filled) + ".".repeat(GAUGE_WIDTH - filled);
}

function gaugeColor(ratio: number): string {
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.7) return "yellow";
  return "green";
}

/** Budgets the width available for cwd/model (after padding + the gauge +
 *  " 100%") evenly between the two, so each can be truncated to its tail
 *  and the row can never wrap onto a second line no matter how long a real
 *  path/model id gets. */
export function statusBarFieldWidth(columns: number): number {
  const planSlotWidth = hasRoomForPlanSlot(columns) ? 1 /* space before it */ + PLAN_PROGRESS_WIDTH : 0;
  const compactionSlotWidth = hasRoomForCompactionSlot(columns) ? 1 /* space before it */ + COMPACTION_STATUS_WIDTH : 0;
  // The scroll slot is budgeted unconditionally (its content appears only
  // while scrolled) for the same reason the plan slot is: a bar whose total
  // width changes the moment you press PageUp is the exact "this row wraps"
  // failure the rest of this fixed-width layout exists to prevent.
  const scrollSlotWidth = hasRoomForScrollSlot(columns) ? 1 /* space before it */ + SCROLL_INDICATOR_WIDTH : 0;
  // 2 paddingX + 2 "│ " + gauge + " 100%" + slots + inter-field gaps (4)
  const fixedWidth = 2 /* paddingX */ + 2 /* "│ " */ + GAUGE_WIDTH + 5 /* " 100%" */ + planSlotWidth + compactionSlotWidth + scrollSlotWidth + 4 /* inter-field gaps */;
  return Math.max(8, Math.floor((columns - fixedWidth) / 2));
}

/** Formats the "N/M" text for the fixed-width slot, or "" for no active
 *  plan. Guards against a pathological plan (hundreds+ of steps) producing
 *  text wider than the reserved slot — blank rather than let it overflow
 *  and break the "this row never wraps" guarantee the whole layout here
 *  depends on. */
export function formatPlanProgress(planProgress: { done: number; total: number } | null): string {
  if (!planProgress || planProgress.total <= 0) return "";
  const text = `${planProgress.done}/${planProgress.total}`;
  return text.length <= PLAN_PROGRESS_WIDTH ? text : "";
}

export function StatusBar({ cwd, model, contextUsedRatio, planProgress, compactionStatus, columns, busy, unicode, scroll }: StatusBarProps) {
  const fieldWidth = statusBarFieldWidth(columns);
  const planText = formatPlanProgress(planProgress);
  const compactionText = formatCompactionStatus(compactionStatus, unicode);
  const compactionColor = compactionStatus?.state === "failed" ? "red" : compactionStatus?.state === "running" ? "yellow" : "green";
  // `│` and `▲` are both non-ASCII; fall back with the rest of the bar so a
  // non-UTF-8 locale doesn't get a stray `?` in the middle of the row.
  const divider = unicode ? "│" : "|";
  const scrollText = formatScrollIndicator(scroll, unicode ? "▲" : "^", unicode);
  // " 100%" is a 5-column budget, but the real number is 1-3 digits plus a
  // percent sign, and past 999% (possible: the ratio isn't clamped at 1) it
  // would grow. Pad the actual text to the budget rather than assuming, so
  // the gauge can't be pushed right and wrap the row.
  const percentText = ` ${Math.round(contextUsedRatio * 100)}%`.padStart(5);

  return (
    <Box justifyContent="space-between" paddingX={1} height={1} overflow="hidden">
      <Text>
        <Text dimColor>{tailToWidth(cwd, fieldWidth)}</Text>
      </Text>
      <Text>
        {busy ? <Spinner active /> : <Text dimColor>{divider}</Text>}
        <Text> </Text>
        <Text color="cyan">{tailToWidth(model, fieldWidth)}</Text>
      </Text>
      <Box>
        {hasRoomForPlanSlot(columns) && (
          <>
            <Text color={planText ? "cyan" : undefined} dimColor={!planText}>
              {planText ? planText.padStart(PLAN_PROGRESS_WIDTH) : "".padStart(PLAN_PROGRESS_WIDTH)}
            </Text>
            <Text> </Text>
          </>
        )}
        {hasRoomForCompactionSlot(columns) && (
          <>
            <Text color={compactionText ? compactionColor : undefined} dimColor={!compactionText}>
              {compactionText.padStart(COMPACTION_STATUS_WIDTH)}
            </Text>
            <Text> </Text>
          </>
        )}
        {hasRoomForScrollSlot(columns) && (
          <>
            <Text color={scrollText ? "yellow" : undefined} dimColor={!scrollText}>
              {scrollText.padStart(SCROLL_INDICATOR_WIDTH)}
            </Text>
            <Text> </Text>
          </>
        )}
        <Text color={gaugeColor(contextUsedRatio)}>{renderGauge(contextUsedRatio, unicode)}</Text>
        <Text dimColor>{percentText}</Text>
      </Box>
    </Box>
  );
}
