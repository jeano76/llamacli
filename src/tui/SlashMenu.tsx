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
];

export interface SlashMenuProps {
  selectedIndex: number;
}

/**
 * Ink re-renders the whole tree from state each frame, so this popup never
 * needs manual buffer save/restore (PROMPT.md §6) — it simply isn't in the
 * tree once `visible` is false, and the surrounding layout re-paints clean.
 * It's a self-contained Box, so it never reaches into or overwrites siblings.
 */
export function SlashMenu({ selectedIndex }: SlashMenuProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {SLASH_MENU_ITEMS.map((item, i) => (
        <Text key={item.key} inverse={i === selectedIndex}>
          {item.label.padEnd(10)} {item.description}
        </Text>
      ))}
    </Box>
  );
}
