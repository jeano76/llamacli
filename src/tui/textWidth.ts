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
