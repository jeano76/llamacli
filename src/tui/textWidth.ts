import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

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

/**
 * Same job as `wrapToWidth`, but safe for text carrying embedded ANSI
 * escape codes (markdown-rendered assistant text, colored diffs) — plain
 * `wrapToWidth` iterates `Array.from(text)` one *character* at a time,
 * which tears an escape sequence like `\x1b[32m` into its individual
 * characters, both corrupting the code itself and miscounting its pieces
 * as real, visible-width glyphs. `wrap-ansi` understands escape sequences
 * as zero-width and re-opens whatever style was active at each wrap
 * point, so color/bold carries across the break instead of leaking into
 * (or vanishing from) unrelated text after it.
 */
export function wrapAnsiSafe(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    out.push(...wrapAnsi(paragraph, width, { hard: true, trim: false }).split("\n"));
  }
  return out;
}

/** Any of the box-drawing characters marked-terminal (via cli-table3) uses
 *  to render a markdown table. A line containing one of these is a table
 *  border or content row. */
const TABLE_LINE_CHARS = /[┌┐└┘├┤┬┴┼─│]/;

/**
 * Like `wrapAnsiSafe`, but a table row is CLIPPED (kept from the left,
 * whatever doesn't fit is dropped) instead of wrapped onto a second line.
 *
 * Reported directly, with a screenshot: a markdown table rendered with
 * mangled, disjointed borders. Root cause: cli-table3 (which marked-
 * terminal delegates table rendering to) has no "fit to an overall
 * terminal width" option — only explicit per-column widths, which would
 * require knowing each table's actual column count ahead of render time.
 * A table row wider than the terminal was therefore reaching this wrap
 * step as one long ANSI-colored line, and wrapping ANY table row —
 * even correctly, without tearing escape codes — still destroys the
 * table's visual structure: half a cell's border ends up on one line,
 * the other half orphaned on the next with nothing lining up, which is
 * exactly the disjointed-border look in the report. Clipping instead
 * degrades far more gracefully (missing right-hand columns, but what IS
 * shown still looks like a real table) than wrapping ever could.
 */
export function wrapPreservingTables(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  return text.split("\n").flatMap((line) => {
    if (!TABLE_LINE_CHARS.test(line)) return wrapAnsiSafe(line, width);
    return [wrapAnsiSafe(line, width)[0] ?? ""];
  });
}
