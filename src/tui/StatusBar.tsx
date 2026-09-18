import React from "react";
import { Box, Text } from "ink";
import { tailToWidth } from "./textWidth.js";

export interface StatusBarProps {
  cwd: string;
  model: string;
  contextUsedRatio: number; // 0..1
  /** Terminal width, used to keep this bar to exactly one row — an
   *  unconstrained cwd/model string wraps onto a second row otherwise,
   *  which is the same overflow-then-ghosting bug the input line and slash
   *  menu had (see App.tsx). */
  columns: number;
}

const GAUGE_WIDTH = 12;

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
  const fixedWidth = 2 /* paddingX */ + GAUGE_WIDTH + 5 /* " 100%" */ + 4 /* inter-field gaps */;
  return Math.max(8, Math.floor((columns - fixedWidth) / 2));
}

export function StatusBar({ cwd, model, contextUsedRatio, columns }: StatusBarProps) {
  const fieldWidth = statusBarFieldWidth(columns);

  return (
    <Box justifyContent="space-between" paddingX={1} height={1} overflow="hidden">
      <Text dimColor>{tailToWidth(cwd, fieldWidth)}</Text>
      <Text dimColor>{tailToWidth(model, fieldWidth)}</Text>
      <Box>
        <Text color={gaugeColor(contextUsedRatio)}>{renderGauge(contextUsedRatio)}</Text>
        <Text dimColor> {Math.round(contextUsedRatio * 100)}%</Text>
      </Box>
    </Box>
  );
}
