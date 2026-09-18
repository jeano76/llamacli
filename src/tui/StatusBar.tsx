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
  const fixedWidth = 2 /* paddingX */ + GAUGE_WIDTH + 5 /* " 100%" */ + planSlotWidth + 4 /* inter-field gaps */;
  return Math.max(8, Math.floor((columns - fixedWidth) / 2));
}

/** Formats the "N/M" text for the fixed-width slot, or "" for no active
 *  plan. Guards against a pathological plan (hundreds+ of steps) producing
 *  text wider than the reserved slot — blank rather than let it overflow
 *  and break the "this row never wraps" guarantee the whole layout here
 *  depends on. */
export function formatPlanProgress(planProgress: { done: number; total: number } | null): string {
  if (!planProgress) return "";
  const text = `${planProgress.done}/${planProgress.total}`;
  return text.length <= PLAN_PROGRESS_WIDTH ? text : "";
}

export function StatusBar({ cwd, model, contextUsedRatio, planProgress, columns }: StatusBarProps) {
  const fieldWidth = statusBarFieldWidth(columns);
  const planText = formatPlanProgress(planProgress);

  return (
    <Box justifyContent="space-between" paddingX={1} height={1} overflow="hidden">
      <Text dimColor>{tailToWidth(cwd, fieldWidth)}</Text>
      <Text dimColor>{tailToWidth(model, fieldWidth)}</Text>
      <Box>
        {/* Fixed-width regardless of whether a plan is active — see
         *  PLAN_PROGRESS_WIDTH. A blank slot when there's no plan, not an
         *  absent one, so this never shifts the gauge next to it. Hidden
         *  below MIN_COLUMNS_FOR_PLAN_SLOT entirely (see hasRoomForPlanSlot)
         *  rather than reserved unconditionally, so a narrow terminal isn't
         *  forced to squeeze cwd/model to make room for it. */}
        {hasRoomForPlanSlot(columns) && (
          <>
            <Text dimColor>{planText.padStart(PLAN_PROGRESS_WIDTH)}</Text>
            <Text> </Text>
          </>
        )}
        <Text color={gaugeColor(contextUsedRatio)}>{renderGauge(contextUsedRatio)}</Text>
        <Text dimColor> {Math.round(contextUsedRatio * 100)}%</Text>
      </Box>
    </Box>
  );
}
