import React from "react";
import { Box, Text } from "ink";

export interface SlashMenuItem {
  key: string;
  label: string;
  description: string;
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { key: "help", label: "/help", description: "도움말 표시" },
  { key: "quit", label: "/quit", description: "종료" },
  { key: "queue", label: "/queue", description: "메시지 큐에 입력 추가" },
  { key: "compact", label: "/compact", description: "지금 컨텍스트 컴팩션 실행" },
  { key: "skills", label: "/skills", description: "로드된 skill 목록 보기" },
  { key: "rules", label: "/rules", description: "로드된 rule 목록 보기" },
  { key: "improve", label: "/improve", description: "반복 실패 패턴 분석 → rule 개선 제안" },
  { key: "improve-apply", label: "/improve-apply", description: "직전 제안을 rule 파일로 저장" },
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
