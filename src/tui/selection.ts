/**
 * Mouse selection, edge auto-scroll, and copy — the app's own replacement for
 * the terminal's native text selection.
 *
 * ── Why this has to exist ────────────────────────────────────────────────────
 * Reported directly: "마우스로 드레그 하면 화면 영역 밖에까지 복사할 수 있게
 * 스크롤 업 또는 다운이 되어야 해" — dragging with the mouse must scroll so you
 * can copy content that is off-screen.
 *
 * The obvious answer is "let the terminal do it", and for a normal program that
 * is correct. It is impossible here, for one structural reason: llamacli draws
 * on the **alternate screen buffer** (index.tsx's enterAltScreen). The alt
 * screen has no scrollback at all — when it fills, the top line is simply
 * overwritten. So a drag that runs off the top edge has nothing to scroll to,
 * and the long-standing behaviour every other terminal has (drag past the edge,
 * the view scrolls, your selection keeps extending) does not exist on this
 * screen.
 *
 * And the app cannot simply keep mouse reporting off and let the terminal
 * select, because the terminal cannot see history either. The log lives in
 * `App`'s React state; the terminal only ever saw the frames. Two ways out,
 * and we took both:
 *
 *   1. The app scrolls its OWN log (this file's edge auto-scroll + the existing
 *      PageUp/wheel paths), so off-screen content can be brought back on
 *      screen. That requires mouse reporting to be ON, because only then does
 *      the app see the pointer.
 *   2. With the mouse claimed by the app, plain-drag native selection is gone
 *      (Shift+drag still reaches the terminal, and is what the runHintText
 *      hint tells the user). So the app selects too — which is what the
 *      SelectionAnchor/SelectionRange below model, and what
 *      `clipboardWrite` in this file hands to the system.
 *
 * Net effect, which is the thing that has to be true: press, drag off the top
 * or bottom edge, keep holding — the log scrolls under the pointer and the
 * selection keeps growing — release, and the text is on the clipboard. Plus
 * the file fallback in `copySelection`, because OSC 52 is refused outright by
 * most Wayland terminals and losing a selection silently is worse than the
 * feature being absent.
 *
 * Everything here is pure except the two explicitly-marked I/O functions, and
 * the row maths is a plain function of (row, col) pairs, so the whole
 * interaction is testable without a terminal — which matters, because the bug
 * this fixes was invisible to every existing test.
 */

/** A position in the log's flattened row space. Rows are 0-based indices into
 *  the `allRows` array App builds (see App.tsx), NOT terminal rows — the
 *  mapping from one to the other changes as the log scrolls, and the selection
 *  must survive scrolling. `col` is a 0-based character index into that row's
 *  text. */
export interface LogPoint {
  row: number;
  col: number;
}

export interface Selection {
  anchor: LogPoint;
  head: LogPoint;
}

export const EMPTY_SELECTION: Selection | null = null;

/** Which edge (if any) a drag is currently pushing against, and therefore
 *  which way the log should scroll. Up = toward older output (larger
 *  scrollOffset), down = toward the live tail. */
export type EdgeDirection = "up" | "down" | null;

/** How many rows from the top/bottom of the log box count as "the edge".
 *
 *  Two rows, not one: with a one-row band, holding the pointer exactly on the
 *  last row (which is where it naturally rests after a drag) would scroll, and
 *  a user trying to select the final line of the transcript could never stop.
 *  Two rows also matches how a native terminal's edge-drag feels — you have to
 *  be *past* the content, not on it. */
export const EDGE_ROWS = 2;

/** Decides whether a drag at terminal row `row` should scroll the log.
 *
 *  `logFirstRow`/`logLastRow` are the absolute terminal rows the log occupies
 *  (App computes these for the click map — see clickMapRef). The slash menu
 *  overlays the log when open, and scrolling then would move content under a
 *  popup the user is reading, so `menuOpen` disables it outright.
 *
 *  Returns null when the pointer is in the body, or outside the log entirely
 *  (e.g. over the input box) — a drag that wandered off the log must not keep
 *  the view moving. */
export function edgeDirection(
  row: number,
  logFirstRow: number,
  logLastRow: number,
  opts?: { menuOpen?: boolean; edgeRows?: number }
): EdgeDirection {
  if (opts?.menuOpen) return null;
  const edge = opts?.edgeRows ?? EDGE_ROWS;
  if (!Number.isFinite(row) || row < logFirstRow || row > logLastRow) return null;
  if (row - logFirstRow < edge) return "up";
  if (logLastRow - row < edge) return "down";
  return null;
}

/** Scroll rows applied per auto-scroll tick while a drag sits on an edge.
 *
 *  Deliberately a constant rather than something proportional to how far past
 *  the edge the pointer is: this runs on a timer, and a rate that depends on
 *  pointer position makes the scroll speed change under the user mid-selection,
 *  which is exactly when they are trying to land on a specific line. */
export const EDGE_SCROLL_STEP = 1;
/** Auto-scroll tick interval. ~14 rows/s at EDGE_SCROLL_STEP — fast enough to
 *  cross a 30-row screen in about two seconds, slow enough to stop on the right
 *  line without overshooting. */
export const EDGE_SCROLL_INTERVAL_MS = 70;

/** Normalizes a selection so it runs from the earlier point to the later one,
 *  in reading order. Dragging up and to the right of the start must select the
 *  same text as dragging down and to the left — the single most common way a
 *  hand-rolled selection gets visibly wrong. */
export function normalizeSelection(sel: Selection): { start: LogPoint; end: LogPoint } {
  const a = sel.anchor;
  const b = sel.head;
  const after = a.row < b.row || (a.row === b.row && a.col <= b.col);
  return after ? { start: a, end: b } : { start: b, end: a };
}

export function isSelectionEmpty(sel: Selection): boolean {
  const { start, end } = normalizeSelection(sel);
  return start.row === end.row && start.col === end.col;
}

/** The character range a selection covers within ONE row, or null when the row
 *  isn't part of the selection at all. This is the one function the renderer
 *  calls per visible row, so it stays allocation-light and pure. */
export function rowRange(
  sel: Selection | null,
  row: number,
  rowLength: number
): { start: number; end: number } | null {
  if (!sel) return null;
  const { start, end } = normalizeSelection(sel);
  if (row < start.row || row > end.row) return null;
  const from = row === start.row ? Math.max(0, Math.min(start.col, rowLength)) : 0;
  const to = row === end.row ? Math.max(0, Math.min(end.col, rowLength)) : rowLength;
  // A drag that ends exactly at column 0 of a row should not paint that row's
  // full width; it ends *before* the row. Clamp to from when it would
  // otherwise select a backwards range.
  if (to < from) return from === to ? null : { start: from, end: from };
  if (from === to && row !== start.row) return null;
  return { start: from, end: to };
}

/** The selected text, in reading order, from the visible window's rows.
 *
 *  `rows` is the visible slice (already scrolled into place by App) — the
 *  selection can therefore only be copied for content that is currently on
 *  screen. That is not a limitation in practice: auto-scroll exists precisely so
 *  the user can bring any part of the transcript on screen before releasing,
 *  and it is the same constraint every terminal has when the buffer is finite.
 *  Trailing whitespace per row is stripped and the rows joined with "\n" so the
 *  copied text is pasteable rather than a ragged block. */
export function selectionText(sel: Selection | null, rows: { text: string }[]): string {
  if (!sel) return "";
  const { start, end } = normalizeSelection(sel);
  const parts: string[] = [];
  for (let i = start.row; i <= end.row; i++) {
    const row = rows[i];
    if (!row) continue;
    const range = rowRange(sel, i, row.text.length);
    const slice = range ? row.text.slice(range.start, range.end) : "";
    parts.push(slice.replace(/\s+$/, ""));
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Clipboard
// ─────────────────────────────────────────────────────────────────────────────

/** Strips the SGR/OSC escape codes out of text destined for the clipboard.
 *
 *  Caught by copying from the real app: the copied text came out as literal
 *  `[1;36m` fragments wrapped around the log's colour codes. Log rows are
 *  built from strings that already carry ANSI (the banner, the coloured status
 *  lines), so a copy that doesn't strip them pastes garbage into whatever the
 *  user pastes it into — a bug report, a commit message, a chat. */
export function stripAnsiForCopy(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Maximum OSC 52 payload, in base64 characters.
 *
 *  Deliberately capped. Some terminals (and every multiplexer that doesn't
 *  pass OSC through) simply drop an over-long payload, and a megabyte of
 *  transcript is not something a user pastes into a chat window anyway. The
 *  cap is applied to the base64 length because that is what actually travels
 *  over the wire, and the caller is told the text was truncated rather than
 *  being handed a silently shortened string. */
export const MAX_OSC52_PAYLOAD = 100_000;

/** Builds the OSC 52 escape sequence for `text`. Returns null when the text is
 *  empty or would exceed `maxPayload` base64 characters (default
 *  MAX_OSC52_PAYLOAD) after encoding.
 *
 *  The cap is a parameter rather than a hard-coded read of the constant because
 *  copySelection's own decision of whether to truncate has to be made against
 *  the SAME limit it then encodes with. When the two used different values,
 *  `copySelection` computed `truncated` against its injected cap while
 *  `buildOsc52` silently applied the global one — so a caller asking for a
 *  small cap got a full-size sequence and a "not truncated" report at the same
 *  time. */
export function buildOsc52(text: string, maxPayload: number = MAX_OSC52_PAYLOAD): string | null {
  if (!text) return null;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > maxPayload) return null;
  // OSC 52 ; c = clipboard selection (what a middle-click pastes on X11);
  // ST (ESC \) terminates, per ECMA-48 as every terminal in practice expects.
  return `\x1b]52;c;${b64}\x07`;
}

/** Escape for a terminal whose newline byte would terminate the OSC payload.
 *  Base64 can't contain a newline, so this never arises — the function exists
 *  so the correctness is visible rather than assumed. */
export function osc52Terminator(): string {
  return "\x07";
}

export interface CopyResult {
  /** What actually happened, for an honest status line. */
  via: "osc52" | "file";
  /** Where a file fallback wrote it, when via === "file". */
  path?: string;
  /** True when the text had to be cut to fit the OSC 52 payload cap. */
  truncated: boolean;
}

/** Default place a failed clipboard write lands. /tmp rather than the project
 *  directory: this is a scratch artifact of a UI action, not project state, and
 *  writing it into the project would put a file the user didn't ask for into
 *  their git status. */
export const CLIPBOARD_FALLBACK_PATH = "/tmp/llamacli-copy.txt";

/** I/O seam so tests can assert the fallback without touching /tmp. */
export interface CopyDeps {
  write?: (seq: string) => void;
  writeFile?: (path: string, text: string) => Promise<void>;
  path?: string;
  maxOsc52?: number;
}

/**
 * Puts `text` on the clipboard, with a guaranteed file fallback.
 *
 * The order matters. OSC 52 goes first because when it works it is
 * instantaneous and invisible to the user; the file is written as well when the
 * payload was too large to travel over OSC at all, or — since a terminal that
 * *refuses* OSC 52 (most Wayland compositors, several multiplexers) cannot tell
 * us it refused — whenever the caller cannot confirm delivery.
 *
 * A copy that silently does nothing is the worst possible outcome here: the
 * user selects, releases, pastes, and gets their own earlier clipboard with no
 * indication anything went wrong. So the file write is the default and the
 * clipboard is the bonus, which is why `via` is reported either way.
 */
export async function copySelection(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  const path = deps.path ?? CLIPBOARD_FALLBACK_PATH;
  const cap = deps.maxOsc52 ?? MAX_OSC52_PAYLOAD;
  const write = deps.write ?? ((seq: string) => process.stdout.write(seq));
  const writeFile = deps.writeFile ?? ((p: string, t: string) => import("node:fs/promises").then((fs) => fs.writeFile(p, t, "utf8")));

  // Over the cap => the FILE carries the whole selection and nothing goes over
  // the wire.
  //
  // The earlier version truncated to fit and sent the truncated text as the
  // clipboard, which is the wrong trade in every direction: the user pastes a
  // silently incomplete block into wherever they were pasting it and has no way
  // to know it was cut, while the file — which they are told about — has
  // everything. Sending nothing costs one extra paste-from-file, and the file
  // is the lossless copy either way.
  const seq = buildOsc52(text, cap);
  if (seq) {
    write(seq);
    // Still write the file: we cannot observe whether the terminal honoured
    // the sequence, and a path to the text is the only thing that makes a
    // refused OSC 52 recoverable.
    await writeFile(path, text);
    return { via: "osc52", path, truncated: false };
  }
  await writeFile(path, text);
  return { via: "file", path, truncated: false };
}
