import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  cwd: string;
  model: string;
  contextUsedRatio: number; // 0..1
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

export function StatusBar({ cwd, model, contextUsedRatio }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>{cwd}</Text>
      <Text dimColor>{model}</Text>
      <Box>
        <Text color={gaugeColor(contextUsedRatio)}>{renderGauge(contextUsedRatio)}</Text>
        <Text dimColor> {Math.round(contextUsedRatio * 100)}%</Text>
      </Box>
    </Box>
  );
}
