import stringWidth from "string-width";

/** Keeps the END of `text` (matching where a cursor conceptually sits while
 *  typing/where the most relevant tail of a path is) that fits within
 *  `maxWidth` terminal columns, prefixed with "…" when truncated. Uses real
 *  display width (via string-width), not `.length`, since wide characters
 *  (Hangul, CJK generally) occupy 2 terminal columns each — a naive
 *  length-based cut would still overflow. */
export function tailToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  const chars = Array.from(text);
  let width = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = stringWidth(chars[i]);
    if (width + w > maxWidth - 1) break; // reserve 1 column for the leading "…"
    width += w;
    start = i;
  }
  return "…" + chars.slice(start).join("");
}

/**
 * Wraps `text` into lines that each fit within `maxWidth` terminal columns,
 * using real display width (wide/CJK characters count as 2). Unlike
 * `tailToWidth`, this preserves the full text — it's for scrollback log
 * lines, where truncating would silently drop content. Existing "\n"
 * breaks are preserved as their own wrap boundaries.
 *
 * This matters because the log area's height budget (App.tsx `logHeight`)
 * counts *entries* as one terminal row each; an unwrapped long line (a
 * tool-call's JSON arguments, a long assistant paragraph, a wide status
 * message) that Ink wraps on its own silently uses more real rows than
 * budgeted, which is the same "total content exceeds the fixed layout
 * height" class of bug already fixed for the input line/status bar/slash
 * menu — just showing up here as garbled/overlapping log text instead.
 */
export function wrapToWidth(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (stringWidth(paragraph) <= width) {
      out.push(paragraph);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of Array.from(paragraph)) {
      const w = stringWidth(ch);
      if (currentWidth + w > width && current.length > 0) {
        out.push(current);
        current = "";
        currentWidth = 0;
      }
      current += ch;
      currentWidth += w;
    }
    out.push(current);
  }
  return out;
}
