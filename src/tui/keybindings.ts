/**
 * The single source of truth for what every keystroke does.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `/help` used to print a list of slash commands and nothing else, while
 * every genuinely important interaction in this TUI is a KEYBOARD action
 * that appears nowhere: PageUp/PageDown to scroll the log, Ctrl/Alt+Left/
 * Right to jump a word, Esc vs `/quit` (force-abort vs clean exit), the
 * click-to-fold on reasoning and diff blocks. A developer cannot use a tool
 * they cannot discover, and there was no `?` / `/keys` to ask.
 *
 * It also existed in a form that couldn't survive a change: the descriptions
 * were inline string literals inside a `switch` in index.tsx, so adding a
 * binding meant editing prose in the middle of command dispatch and nothing
 * verified the two stayed in sync. Here they are data, grouped, rendered by
 * one function, and unit-tested — which is also what lets `/help` show them
 * in the same language as the rest of the TUI (the old one was English in a
 * Korean UI).
 */
import stringWidth from "string-width";

export interface KeyBinding {
  /** The literal key description, e.g. "Ctrl+←". Rendered verbatim. */
  keys: string;
  /** What it does, in Korean to match the rest of the UI. */
  description: string;
}

export interface KeyBindingGroup {
  title: string;
  bindings: KeyBinding[];
}

/**
 * Grouped for `/help` output. Order is the order things are needed, not
 * alphabetical: input editing first (what you do every second), then
 * navigation, then the session-lifecycle keys, then the slash commands.
 */
export const KEY_BINDINGS: KeyBindingGroup[] = [
  {
    title: "입력 편집",
    bindings: [
      { keys: "← →", description: "커서 좌우 이동" },
      { keys: "Ctrl+←/→ (Alt+←/→)", description: "단어 단위 이동" },
      { keys: "Home / End", description: "줄의 처음 / 끝으로" },
      { keys: "Ctrl+A / Ctrl+E", description: "줄의 처음 / 끝으로 (다른 터미널용 별칭)" },
      { keys: "Ctrl+U / Ctrl+K", description: "커서 앞 / 뒤 지우기" },
      { keys: "Ctrl+W", description: "직전 단어 지우기" },
      { keys: "Ctrl+L", description: "화면 지우기 (입력은 유지)" },
      { keys: "↑ / ↓", description: "입력 히스토리 (셸처럼 동작)" },
      { keys: "붙여넣기 (Ctrl+V / Shift+Insert)", description: "긴 텍스트는 자리표시자로 접고 클릭/키로 펼침" },
    ],
  },
  {
    title: "로그 탐색",
    bindings: [
      { keys: "PageUp / PageDown", description: "한 화면씩 스크롤" },
      { keys: "Ctrl+U / Ctrl+D", description: "반 화면씩 스크롤" },
      { keys: "Ctrl+O", description: "접힌 블록 전부 펼치기/접기 (추론·diff·붙여넣기)" },
      { keys: "Shift+T", description: "스크롤 중 새 출력 도착 표시로 이동" },
      { keys: "마우스 휠 / 클릭", description: "스크롤 · 접힌 블록 토글 (필요시 /mouse 로 켜기)" },
    ],
  },
  {
    title: "세션 제어",
    bindings: [
      { keys: "Enter", description: "전송" },
      { keys: "Esc", description: "강제종료 (체크포인트 저장 후 즉시 종료)" },
      { keys: "/quit", description: "정상종료 (현재 턴을 마치고 자기개선 검토 후 종료)" },
      { keys: "Ctrl+C", description: "강제종료 확인" },
      { keys: "/help, /keys", description: "이 도움말" },
      { keys: "/mouse", description: "마우스 스크롤/클릭 켜기·끄기" },
      { keys: "/term", description: "감지된 터미널과 지원 기능 상태" },
    ],
  },
  {
    title: "명령",
    bindings: [
      { keys: "/compact", description: "지금 컨텍스트 압축 실행" },
      { keys: "/queue", description: "큐에 메시지 추가" },
      { keys: "/skills, /rules", description: "불러온 스킬 / 룰 목록" },
      { keys: "/plan-clear", description: "멈춘 계획 표시 초기화" },
    ],
  },
];

/** Left column width for the rendered key table. Longest key spec is
 *  "Ctrl+←/→ (Alt+←/→)" — measured with string-width so a future entry with
 *  wide (CJK) characters can't silently break the column. */
export const KEY_COLUMN_WIDTH = 22;

/** Renders one `keys`/`description` row with the description aligned. Used by
 *  both `/help` and the in-TUI help panel, so the two can't drift. */
export function formatKeyRow(binding: KeyBinding, keyWidth: number = KEY_COLUMN_WIDTH): string {
  const pad = " ".repeat(Math.max(0, keyWidth - stringWidth(binding.keys)));
  return `${binding.keys}${pad}  ${binding.description}`;
}

/**
 * The startup hint line: names the three things a new user needs in the
 * first ten seconds (how to get help, how to scroll, how to quit) and
 * nothing else.
 *
 * Forms are ordered longest-first so a narrow terminal gets a shorter TRUE
 * statement rather than a truncated lie. The final clamp is a hard width
 * guarantee rather than a `?? lastForm` fallback: the shortest form is
 * itself 9 columns wide, so on an 8-column terminal the fallback overflowed
 * and pushed the log's fixed height budget out by a row. Truncating from the
 * left keeps "/help" (the one thing that must survive) and drops the
 * leading indent first.
 */
export function startupHintText(columns: number): string {
  const forms = [
    "  /help 키보드 단축키 · PageUp/Dn 로그 스크롤 · Esc 강제종료 · /quit 정상종료",
    "  /help 단축키 · PageUp/Dn 스크롤 · Esc 강제종료",
    "  /help 단축키 · Esc 종료",
    "  /help",
  ];
  const budget = Math.max(0, columns - 1);
  const chosen = forms.find((f) => stringWidth(f) <= budget);
  if (chosen !== undefined) return chosen;
  // Nothing fits — keep "/help" if it can, else nothing at all. Never return
  // something wider than the terminal.
  return stringWidth("/help") <= budget ? "/help" : "";
}
