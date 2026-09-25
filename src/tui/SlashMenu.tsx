import React from "react";
import { Box, Text } from "ink";

export interface SlashMenuItem {
  key: string;
  label: string;
  description: string;
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { key: "help", label: "/help", description: "Show help" },
  { key: "quit", label: "/quit", description: "Quit" },
  { key: "queue", label: "/queue", description: "Add a message to the queue" },
  { key: "compact", label: "/compact", description: "Run context compaction now" },
  { key: "skills", label: "/skills", description: "List loaded skills" },
  { key: "rules", label: "/rules", description: "List loaded rules" },
  { key: "improve", label: "/improve", description: "Analyze repeated failures → propose a rule" },
  { key: "improve-apply", label: "/improve-apply", description: "Save the last proposal as a rule file" },
  { key: "plan-clear", label: "/plan clear", description: "Clear a stuck plan-progress indicator" },
  { key: "fastcheck", label: "/fastcheck", description: "Ask laya to short-circuit this turn (see docs)" },
];

export interface SlashMenuProps {
  /** The items left after typing-to-filter (a subset of SLASH_MENU_ITEMS,
   *  in the same relative order) — not necessarily all of them. */
  items: SlashMenuItem[];
  /** Index into `items` (the filtered list), not into SLASH_MENU_ITEMS. */
  selectedIndex: number;
}

/**
 * Ink re-renders the whole tree from state each frame, so this popup never
 * needs manual buffer save/restore (PROMPT.md §6) — it simply isn't in the
 * tree once `visible` is false, and the surrounding layout re-paints clean.
 * It's a self-contained Box, so it never reaches into or overwrites siblings.
 *
 * Always renders exactly `SLASH_MENU_ITEMS.length` rows — regardless of how
 * many `items` actually matched the typed filter — padding with blank rows
 * when fewer. App.tsx's `menuBoxHeight` (the fixed space reserved for this
 * box) is sized against the *full* list length; letting this box's real
 * height shrink with the filter would reintroduce the exact "menu height
 * changing shifts everything below it" ghosting bug that was fixed before
 * typing-to-filter existed (see App.tsx's `logHeight` comment) — filtering
 * down to 1 match must look identical, layout-wise, to showing all 8.
 */
export function SlashMenu({ items, selectedIndex }: SlashMenuProps) {
  const blankRows = Math.max(0, SLASH_MENU_ITEMS.length - Math.max(items.length, 1));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {items.length === 0 ? (
        <Text dimColor>No matching commands</Text>
      ) : (
        items.map((item, i) => (
          <Text key={item.key} color={i === selectedIndex ? "cyan" : undefined} inverse={i === selectedIndex}>
            {i === selectedIndex ? "❯ " : "  "}{item.label.padEnd(15)} <Text dimColor={i !== selectedIndex}>{item.description}</Text>
          </Text>
        ))
      )}
      {Array.from({ length: blankRows }, (_, i) => (
        <Text key={`blank-${i}`}> </Text>
      ))}
    </Box>
  );
}
