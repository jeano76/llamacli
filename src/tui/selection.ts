/**
 * Mouse selection and copy — the app's own replacement for the terminal's
 * native text selection.
 *
 * ── Why this has to exist ────────────────────────────────────────────────────
 * llamacli draws on the **alternate screen buffer** (index.tsx's enterAltScreen), which has no
 * scrollback, and the log lives in `App`'s React state — the terminal only ever saw frames. So
 * with mouse reporting ON (the app sees the pointer), plain-drag native selection is gone
 * (Shift+drag still reaches the terminal; the runHintText hint says so) and the app selects
 * itself, which is what the Selection/LogPoint model below is, and what `copySelection` hands to
 * the system: press, drag, release, and the text is on the clipboard — plus the file fallback,
 * because OSC 52 is refused outright by most Wayland terminals and losing a selection silently is
 * worse than the feature being absent.
 *
 * There is no edge auto-scroll (it was removed on request): the wheel and PageUp/PageDn scroll the
 * log, and a selection is made within what is on screen.
 *
 * Everything here is pure except the two explicitly-marked I/O functions, and
 * the row maths is a plain function of (row, col) pairs, so the whole
 * interaction is testable without a terminal — which matters, because the bug
 * this fixes was invisible to every existing test.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

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
 *  screen. To take in more than one screen, scroll with the wheel while the
 *  button is held (the anchor is kept in log-row space, so it survives that).
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
  /** What actually happened, for an honest status line. "system": the OS clipboard tool took it (confirmed by its exit). */
  via: "osc52" | "system" | "file";
  /** The tool that confirmed it, when via === "system". */
  tool?: string;
  /** Set when the text probably did NOT reach the clipboard and what would fix it. */
  advice?: string;
  /** Where a file fallback wrote it, when via === "file". */
  path?: string;
  /** True when the text had to be cut to fit the OSC 52 payload cap. */
  truncated: boolean;
}

/** Default place a failed clipboard write lands. /tmp rather than the project
 *  directory: this is a scratch artifact of a UI action, not project state, and
 *  writing it into the project would put a file the user didn't ask for into
 *  their git status. */
export const CLIPBOARD_FALLBACK_PATH =
  process.platform === "win32" ? join(tmpdir(), "llamacli-copy.txt") : "/tmp/llamacli-copy.txt"; // Windows has no /tmp

/** I/O seam so tests can assert the fallback without touching /tmp. */
export interface CopyDeps {
  write?: (seq: string) => void;
  writeFile?: (path: string, text: string) => Promise<void>;
  path?: string;
  maxOsc52?: number;
  /** Injected for tests: runs `cmd args` feeding `input` on stdin; true when it exited 0. */
  run?: (cmd: string, args: string[], input: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The OS clipboard tools to try, best first. OSC 52 cannot be confirmed and several terminals (GNOME's VTE, many
 *  Wayland setups) ignore it, so a drag-copy that only emitted OSC 52 silently copied nothing; these tools report
 *  success by their exit status. */
export function clipboardTools(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] }[] {
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (platform === "win32") {
    // `clip.exe` reads stdin in the console's OEM code page, so Korean/emoji text arrives garbled. PowerShell
    // reading UTF-8 from stdin is tried first; `clip` stays as the last resort (ASCII-safe).
    const ps = "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())";
    return [
      { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", ps] },
      { cmd: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", ps] },
      { cmd: "clip", args: [] },
    ];
  }
  const out: { cmd: string; args: string[] }[] = [];
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) out.push({ cmd: "clip.exe", args: [] });
  if (env.WAYLAND_DISPLAY) out.push({ cmd: "wl-copy", args: [] });
  if (env.DISPLAY) out.push({ cmd: "xclip", args: ["-selection", "clipboard"] }, { cmd: "xsel", args: ["--clipboard", "--input"] });
  return out;
}

async function defaultRun(cmd: string, args: string[], input: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => done(false));
      p.on("exit", (code) => done(code === 0));
      p.stdin.on("error", () => {});
      p.stdin.end(input);
      setTimeout(() => done(false), 2500).unref?.();
    } catch {
      done(false);
    }
  });
}

/** The status line for a finished copy — one place, so the drag handler and `/copy` cannot disagree. */
export function describeCopy(r: CopyResult, chars: number): string {
  if (r.via === "system") return `[복사] ${chars}자를 클립보드에 복사했습니다 (${r.tool}) — 파일에도 저장: ${r.path}`;
  const base =
    r.via === "osc52"
      ? `[복사] ${chars}자를 터미널 클립보드(OSC 52)로 보냈고 파일에도 저장했습니다 → ${r.path}`
      : `[복사] ${chars}자를 파일로 저장했습니다 → ${r.path}`;
  return r.advice ? `${base}\n  · ${r.advice}` : base;
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
  if (seq) write(seq);
  // Still write the file: we cannot observe whether the terminal honoured the sequence, and a path to the text is the
  // only thing that makes a refused OSC 52 recoverable.
  await writeFile(path, text);

  // The OS clipboard tool, whose success IS observable. This is what makes a plain drag (no Shift) land in the system
  // clipboard on terminals that ignore OSC 52 — GNOME's VTE does, which is why people fell back to Shift+drag.
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  for (const t of clipboardTools(env, deps.platform ?? process.platform)) {
    if (await run(t.cmd, t.args, text).catch(() => false)) return { via: "system", tool: t.cmd, path, truncated: false };
  }

  const vte = Boolean(env.VTE_VERSION);
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const advice = vte || !seq
    ? `이 터미널${vte ? "(GNOME VTE)" : ""}은 OSC 52 를 지원하지 않아 시스템 클립보드로는 가지 않았을 수 있습니다. ` +
      `${wayland ? "wl-clipboard" : "xclip"} 를 설치하면 Shift 없이 드래그만으로 복사됩니다 (예: sudo apt install ${wayland ? "wl-clipboard" : "xclip"}). ` +
      `지금은 ${path} 에서 가져올 수 있습니다.`
    : undefined;
  return { via: seq ? "osc52" : "file", path, truncated: false, ...(advice ? { advice } : {}) };
}
