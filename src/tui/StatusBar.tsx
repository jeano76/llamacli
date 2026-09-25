import React from "react";
import { Box, Text } from "ink";
import { tailToWidth } from "./textWidth.js";

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

/** Formats the compaction indicator text, always exactly
 *  `COMPACTION_STATUS_WIDTH` characters (or "" for no compaction yet) so
 *  it never shifts anything next to it regardless of which state it's in. */
export function formatCompactionStatus(status: { state: "running" | "complete" | "failed"; timestamp: string } | null): string {
  if (!status) return "";
  if (status.state === "running") return "compacting";
  const hhmmss = status.timestamp.slice(11, 19); // ISO 8601 "...THH:MM:SS.sssZ"
  const glyph = status.state === "complete" ? "✓" : "✗";
  return `${glyph} ${hhmmss}`;
}

/** Renders a small bar-animation battery gauge for context usage (PROMPT.md §6). */
function renderGauge(ratio: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * GAUGE_WIDTH);
  return "█".repeat(filled) + "░".repeat(GAUGE_WIDTH - filled);
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
  // 2 paddingX + 2 "│ " + gauge + " 100%" + slots + inter-field gaps (4)
  const fixedWidth = 2 /* paddingX */ + 2 /* "│ " */ + GAUGE_WIDTH + 5 /* " 100%" */ + planSlotWidth + compactionSlotWidth + 4 /* inter-field gaps */;
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

export function StatusBar({ cwd, model, contextUsedRatio, planProgress, compactionStatus, columns }: StatusBarProps) {
  const fieldWidth = statusBarFieldWidth(columns);
  const planText = formatPlanProgress(planProgress);
  const compactionText = formatCompactionStatus(compactionStatus);
  const compactionColor = compactionStatus?.state === "failed" ? "red" : compactionStatus?.state === "running" ? "yellow" : "green";

  return (
    <Box justifyContent="space-between" paddingX={1} height={1} overflow="hidden">
      <Text>
        <Text dimColor>{tailToWidth(cwd, fieldWidth)}</Text>
      </Text>
      <Text>
        <Text dimColor>│ </Text>
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
        <Text color={gaugeColor(contextUsedRatio)}>{renderGauge(contextUsedRatio)}</Text>
        <Text dimColor> {Math.round(contextUsedRatio * 100)}%</Text>
      </Box>
    </Box>
  );
}
