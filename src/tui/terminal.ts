/**
 * Terminal capability detection — the layer that decides WHAT this process is
 * allowed to emit, per terminal, instead of one global "ANSI or not" flag.
 *
 * ── Why the single boolean wasn't enough ──────────────────────────────────────
 * `supportsAnsiTui()` (ansiSupport.ts) answered one question: "is this escape
 * sequence going to be interpreted, or will it show up as literal garbage?"
 * That is necessary but not sufficient, because terminals do not fail in
 * all-or-nothing ways. Each of these is a real, independently-observed
 * mismatch, not a hypothetical:
 *
 *   - Color depth. `banner.ts` and `tools/diff.ts` emit raw `\x1b[1;95m`
 *     (bright magenta) and `\x1b[2;90m` (bright black). On a 16-color
 *     terminal those map to the wrong color; on a true `vt100` the SGR 90-97
 *     range doesn't exist. Nothing checked color depth at all.
 *   - Unicode glyph coverage. The bouncing ball uses Braille (`⠁⠂⠄⡀`), the
 *     banner art and the context gauge use `█ ░`, StatusBar/SlashMenu use
 *     `✓ ✗ │ ❯`. Under a non-UTF-8 locale, or a font without Braille/block
 *     coverage, those become `?` or double-width boxes and every fixed-width
 *     calculation in this app (StatusBar's `statusBarFieldWidth`, App's
 *     cursor placement) is computed against widths the terminal disagrees
 *     with — so the layout desynchronizes, not just the glyphs. The Spinner
 *     component was already converted to ASCII for exactly this reason
 *     (see its doc comment); nothing else was.
 *   - Multiplexers. Under tmux/screen, mouse reporting needs the multiplexer
 *     to be configured for pass-through, `TERM` is `screen*`/`tmux*` rather
 *     than the real terminal, and absolute cursor addressing applies to the
 *     multiplexer pane, not the window.
 *   - Absolute cursor addressing has a hard PRECONDITION: it is only
 *     meaningful once the alternate screen buffer is active, because rows
 *     are counted from the top of the current buffer. `index.tsx` and
 *     `App.tsx` treated "ANSI works" as implying "alt screen works".
 *   - SGR mouse encoding (DECSET 1006) is not universal. `rxvt` and the Linux
 *     console predate it; sending 1006 there yields nothing, while sending
 *     1000 there yields events in the legacy X10 encoding this app's parser
 *     (`/\[<\d+;\d+;\d+[Mm]/`) cannot read — so the wheel silently dies.
 *   - `ConEmuANSI` / `WT_SESSION` / `TERM_PROGRAM` each identify a *family*
 *     of terminal with different behavior, and macOS's own Terminal.app
 *     (`Apple_Terminal`) is a known-quirky one.
 *
 * So this module reports a capability record, and the sequence builders below
 * return `""` (a safe no-op) for anything the current terminal can't take.
 * Callers can then write `process.stdout.write(seq.moveTo(r, c))`
 * unconditionally instead of repeating a guard at every call site — which is
 * how guards get forgotten in the first place.
 *
 * Every field is overridable from the environment, because heuristic
 * detection is by nature wrong sometimes and the user is the only authority
 * on what their own terminal does. See `ENV_OVERRIDES` below.
 */
import chalk from "chalk";

/** 0 = no color at all, 4 = the 16 ANSI colors, 8 = 256, 24 = truecolor. */
export type ColorDepth = 0 | 4 | 8 | 24;

export interface TerminalCapabilities {
  /** Basic CSI/SGR sequences are interpreted (not echoed as literal bytes). */
  ansi: boolean;
  /** How much color can be emitted. Downgrade map for raw SGR in this app. */
  colorDepth: ColorDepth;
  /** Non-ASCII glyphs (box drawing, block, Braille, arrows) render at their
   *  expected width. False => every glyph must come from an ASCII table. */
  unicode: boolean;
  /** DECSET 1049 alternate screen buffer. Required before absolute cursor
   *  addressing is meaningful — see the module comment. */
  altScreen: boolean;
  /** DECSET 2026 synchronized output (frame-at-a-time paint, kills tearing). */
  synchronizedOutput: boolean;
  /** OSC 8 clickable hyperlinks. */
  hyperlink: boolean;
  /** Mouse reporting may be turned on at all. */
  mouse: boolean;
  /** Mouse reports will arrive SGR-encoded (DECSET 1006) — the only encoding
   *  App.tsx's parser understands. False => don't enable mouse; the legacy
   *  X10 encoding is unreadable by the app and would be swallowed silently. */
  mouseSgr: boolean;
  /** Best-effort terminal identity, for `/diagnostics`-style output. */
  terminal: string;
  /** Running inside tmux/screen (or a nested one). */
  inMultiplexer: boolean;
  /** Why the answer came out the way it did — surfaced by the diagnostics
   *  line so a wrong guess is at least explainable. */
  reason: string;
}

export interface DetectOptions {
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  platform?: NodeJS.Platform;
  /** Injected so the mouse default can be flipped in tests without env. */
  mouseDefault?: boolean;
}

/**
 * Environment overrides, in precedence order. `LLAMACLI_*` is this app's own
 * escape hatch and beats every heuristic, including the platform defaults;
 * the rest are cross-tool conventions we should honor.
 *
 *   LLAMACLI_FORCE_ANSI=1   treat as fully capable (still downgraded by
 *                           LLAMACLI_COLOR_DEPTH if that is also set)
 *   LLAMACLI_NO_ANSI=1      treat as incapable of anything
 *   NO_COLOR=<anything>     no color at all (https://no-color.org)
 *   CLICOLOR_FORCE=1        force color even when TERM looks dumb
 *   LLAMACLI_COLOR_DEPTH=N  0 | 4 | 8 | 24
 *   LLAMACLI_ASCII=1        ASCII-only glyphs
 *   LLAMACLI_MOUSE=0|1      mouse reporting off / on
 *   LLAMACLI_NO_SMOOTH=1    never emit DECSET 2026
 *   TERM, COLORTERM, WT_SESSION, TERM_PROGRAM, TERMINAL_EMULATOR,
 *   ConEmuANSI, ANSICON, MSYSTEM, VTE_VERSION, LC_ALL, LC_CTYPE, LANG
 */
const ENV_OVERRIDES = [
  "LLAMACLI_FORCE_ANSI", "LLAMACLI_NO_ANSI", "LLAMACLI_COLOR_DEPTH", "LLAMACLI_ASCII",
  "LLAMACLI_MOUSE", "LLAMACLI_NO_SMOOTH", "NO_COLOR", "CLICOLOR_FORCE", "COLORTERM",
  "TERM", "WT_SESSION", "TERM_PROGRAM", "TERMINAL_EMULATOR", "ConEmuANSI", "ANSICON",
  "MSYSTEM", "VTE_VERSION", "LC_ALL", "LC_CTYPE", "LANG",
] as const;

const isSet = (v: string | undefined): boolean => v !== undefined;

/** Terminals known to handle synchronized output (DECSET 2026) and OSC 8.
 *  Both are "modern" features, so they share a list — anything here gets
 *  asked about both, and the answer is still overridable per-field. */
const MODERN_TERMINALS = [
  "WezTerm", "ghostty", "kitty", "Alacritty", "iTerm.app", "WezTerm",
  "vscode", "Windows_Terminal", "JetBrains-JediTerm", "rio", "foot",
];

/** Best-effort human-readable identity. Not load-bearing for any decision
 *  beyond the multiplexer/color heuristics below — just for diagnostics. */
function identifyTerminal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.TERMINAL_EMULATOR) return env.TERMINAL_EMULATOR;
  if (env.ConEmuANSI !== undefined) return "ConEmu";
  if (env.ANSICON !== undefined) return "ANSICON";
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  if (env.VTE_VERSION) return "GNOME VTE / gnome-terminal";
  if (env.MSYSTEM) return `MSYS/Git Bash (${env.MSYSTEM})`;
  const term = env.TERM ?? "";
  if (/^screen/.test(term)) return "GNU screen";
  if (/^tmux/.test(term)) return "tmux";
  if (/^rxvt/.test(term)) return "rxvt";
  if (/^linux/.test(term)) return "Linux console";
  if (/^vt/.test(term)) return "legacy VT";
  if (/^xterm|^st-|^eterm|^alacritty|^kitty|^wezterm|^foot|^ghostty/.test(term)) return term;
  if (platform === "win32") return "Windows conhost";
  return term || "unknown";
}

function detectColorDepth(env: NodeJS.ProcessEnv, ansi: boolean, terminal: string): ColorDepth {
  if (!ansi) return 0;
  if (isSet(env.NO_COLOR)) return 0;

  const override = env.LLAMACLI_COLOR_DEPTH;
  if (override !== undefined) {
    const n = Number(override);
    // Accept 0/4/8/24 and also 16/256/truecolor spellings, because a user
    // reaching for this knob will not remember which convention we picked.
    if (n === 0) return 0;
    if (n === 4 || n === 16) return 4;
    if (n === 8 || n === 256) return 8;
    if (n === 24 || n === 16_777_216) return 24;
  }

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;

  const term = env.TERM ?? "";
  // A multiplexer reports the *inner* terminal's TERM only when the user has
  // set terminal-overrides; the common `screen`/`screen-256color` and
  // `tmux-256color` spellings do carry the depth, so match on those too.
  if (/-256color\b/.test(term)) return 8;
  if (/\bdirect\b/.test(term)) return 24;
  if (/^xterm-(kitty|direct)/.test(term)) return 8;

  // Known 256/truecolor emulators that don't advertise it in TERM.
  if (/^(alacritty|kitty|wezterm|foot|ghostty|rio)$/i.test(term)) return 8;
  if (terminal === "Windows Terminal" || terminal === "WezTerm" || terminal === "vscode") return 24;

  // conhost with VT enabled: 16 colors plus the bright 90-97 range it has
  // supported since Windows 10, which is what the 4 bucket means here.
  if (terminal === "Windows conhost") return 4;

  // Unknown TERM: assume the 16 ANSI colors, which every terminal that
  // understands CSI at all also understands. Guessing *up* here is what
  // produces garbage like `95m` rendered as a stray character.
  return 4;
}

/**
 * Whether non-ASCII glyphs can be trusted. This app is Hangul-heavy, so a
 * false positive here is more damaging than a false negative: getting it
 * wrong doesn't just swap a symbol, it desynchronizes every fixed-width
 * calculation in the app. Hence the bias:
 *   - an explicitly non-UTF-8 locale (`LANG=C`, `LC_ALL=POSIX`) => false
 *   - an explicit UTF-8 locale => true
 *   - nothing set at all => follow the *terminal family*, not the OS. A
 *     recognized modern terminal (Windows Terminal, VS Code, ConEmu, any
 *     Unix one) renders UTF-8 whether or not LANG says so, and LANG is unset
 *     in plenty of working setups; a bare win32 conhost is the one case
 *     where the code page genuinely may not be UTF-8.
 */
function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, terminal: string): boolean {
  if (env.LLAMACLI_ASCII === "1") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale !== "") {
    if (/utf-?8/i.test(locale)) return true;
    // Some other encoding (e.g. LANG=ko_KR.euc-kr): the terminal may still
    // render UTF-8, but we can't tell, and the locale explicitly says the
    // user is not in a UTF-8 world.
    return false;
  }
  if (platform !== "win32") return true;
  return terminal !== "Windows conhost";
}

/**
 * DECSET 1006 (SGR) mouse encoding. Terminals that predate it don't have it,
 * and the only alternative this app could fall back to is the legacy X10
 * encoding — which `parseMouseClicks`/`parseMouseWheel` cannot read at all.
 * Enabling mouse there would mean the wheel looks broken forever with no
 * error, so the correct move is to leave it off and say so.
 */
function detectMouseSgr(env: NodeJS.ProcessEnv, term: string): boolean {
  if (/(^|-)rxvt/.test(term)) return false; // rxvt(-unicode) has no 1006
  if (/^linux/.test(term)) return false; // Linux console predates it too
  if (/^vt(100|102|220|320|400)/.test(term)) return false;
  if (term === "dumb" || term === "") return false;
  // tmux/screen: only trust SGR when the inner TERM actually says 256color,
  // which is what terminal-overrides "screen*:Tc" produces.
  if (/^(screen|tmux)/.test(term) && !/-256color\b/.test(term)) return false;
  return true;
}

export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
  opts: DetectOptions = {}
): TerminalCapabilities {
  const stdoutIsTTY = opts.stdoutIsTTY ?? process.stdout.isTTY;
  const stdinIsTTY = opts.stdinIsTTY ?? process.stdin.isTTY;
  const platform = opts.platform ?? process.platform;
  const term = env.TERM ?? "";
  const terminal = identifyTerminal(env, platform);
  const inMultiplexer = /^(screen|tmux)/.test(term) || isSet(env.TMUX);

  const noAnsi = env.LLAMACLI_NO_ANSI === "1";
  const forceAnsi = env.LLAMACLI_FORCE_ANSI === "1";
  const notATTY = !stdoutIsTTY || !stdinIsTTY;
  const dumbTerm = term === "dumb";

  // win32: Node has auto-enabled VT on conhost since ~v10, but only for the
  // console it negotiated with. A bare cmd.exe, or a WSL window whose parent
  // console never got VT mode, is the reported source of literal escape
  // bytes on the screen. Absence of every known-good marker => don't risk it.
  const win32KnownGood =
    isSet(env.WT_SESSION) ||
    isSet(env.TERM_PROGRAM) ||
    env.ConEmuANSI === "ON" ||
    isSet(env.ANSICON) ||
    isSet(env.MSYSTEM);

  let ansi: boolean;
  let reason: string;
  if (noAnsi) {
    ansi = false;
    reason = "LLAMACLI_NO_ANSI=1";
  } else if (forceAnsi) {
    ansi = true;
    reason = "LLAMACLI_FORCE_ANSI=1";
  } else if (notATTY) {
    ansi = false;
    reason = notATTY
      ? `not a TTY (stdout=${stdoutIsTTY}, stdin=${stdinIsTTY})`
      : "";
  } else if (dumbTerm) {
    ansi = false;
    reason = "TERM=dumb";
  } else if (platform === "win32" && !win32KnownGood) {
    ansi = false;
    reason = "win32 without a recognized terminal marker";
  } else {
    ansi = true;
    reason = "";
  }
  if (reason === "") reason = `ok (TERM=${term || "unset"}, ${terminal})`;

  const colorDepth = detectColorDepth(env, ansi, terminal);
  const unicode = ansi && detectUnicode(env, platform, terminal);
  const mouseSgr = ansi && detectMouseSgr(env, term);
  const modern = MODERN_TERMINALS.some((t) => terminal.includes(t)) || /^(alacritty|kitty|wezterm|foot|ghostty|rio)$/i.test(term);

  // Mouse default. ON by default, and this is a REVERSAL of an earlier
  // decision in this file — the change is documented here because the reason
  // it was flipped is the reason it was flipped back.
  //
  // It was turned off with the reasoning "enabling mouse reporting means the
  // user can no longer select text with the mouse, and the wheel/click
  // features are reachable from the keyboard anyway". Both halves turned out
  // to be wrong, and both were found by driving the real binary in a pty
  // (scripts/capture_screens.py), not by reasoning:
  //
  //   1. "Reachable from the keyboard" was only half true. PageUp/PageDown and
  //      Ctrl+O exist, but the WHEEL and click-to-toggle-fold do not have a
  //      keyboard equivalent at all, and with the mouse off they were not just
  //      harder to reach — they were completely dead, with nothing on screen to
  //      say so. Reported directly: click-to-expand/collapse "used to work but
  //      doesn't now", and the log could not be scrolled with the wheel.
  //
  //   2. The selection trade-off was self-defeating on an ALTERNATE SCREEN.
  //      With the mouse off the terminal does get to select text, but the alt
  //      screen has no scrollback (see selection.ts), so a drag that runs off
  //      the top edge has nothing to scroll to — the exact behaviour every
  //      other terminal has was impossible. So "let the terminal select" never
  //      actually delivered the thing it was protecting.
  //
  // The app now implements selection itself (selection.ts): press, drag off
  // the edge, the log auto-scrolls and the selection keeps growing, release
  // copies to the clipboard with a file fallback. Shift+drag still reaches the
  // terminal for native selection — runHintText tells the user so — and
  // `/mouse` (or LLAMACLI_MOUSE=0) turns this back off for anyone who prefers
  // to keep every mouse gesture for the terminal.
  let mouse: boolean;
  if (env.LLAMACLI_MOUSE === "1") mouse = mouseSgr;
  else if (env.LLAMACLI_MOUSE === "0") mouse = false;
  else mouse = opts.mouseDefault ?? true;

  return {
    ansi,
    colorDepth,
    unicode,
    altScreen: ansi,
    synchronizedOutput: ansi && modern && env.LLAMACLI_NO_SMOOTH !== "1",
    hyperlink: ansi && modern,
    mouse: mouse && mouseSgr,
    mouseSgr,
    terminal,
    inMultiplexer,
    reason,
  };
}

let cached: TerminalCapabilities | null = null;

/** Process-wide cached capabilities. Detection reads a handful of env vars and
 *  is idempotent, but it runs inside per-frame effects in App.tsx, so it
 *  shouldn't be recomputed 60x a second. */
export function getCapabilities(): TerminalCapabilities {
  if (cached === null) cached = detectTerminal();
  return cached;
}

export function resetTerminalCache(): void {
  cached = null;
}

/** Replace the cached record — used by the `/mouse` toggle, which is the one
 *  capability a user changes at runtime. Everything that captured the old
 *  object keeps working (the record is treated as immutable and always
 *  re-read through getCapabilities), so a mid-session flip takes effect on
 *  the next render without any listener plumbing. */
export function setTerminalCapabilities(caps: TerminalCapabilities): void {
  cached = caps;
}

/** Re-derive with `mouse` forced, keeping every other detection intact. Used
 *  by the `/mouse` toggle so a runtime change doesn't require a re-exec. */
export function withMouse(caps: TerminalCapabilities, on: boolean): TerminalCapabilities {
  return { ...caps, mouse: on && caps.mouseSgr };
}

// ────────────────────────────────────────────────────────────────────────────
// Sequence builders. Each returns "" when the capability is absent, so a
// caller can write `write(seq.moveTo(3, 5))` with no guard and no risk.
// Building the string unconditionally (rather than branching) also keeps the
// hot per-frame path in App.tsx free of conditionals.
// ────────────────────────────────────────────────────────────────────────────

const csi = (body: string): string => `\x1b[${body}`;

export interface Sequences {
  altScreenOn: string;
  altScreenOff: string;
  /** Set the default background to black. Owned by the app rather than left to
   *  the terminal's own theme — see `backgroundOn` below. */
  backgroundOn: string;
  /** Undo `backgroundOn` (SGR 49 = default background). MUST be emitted on
   *  exit: a background left set outlives the app and recolours the user's
   *  shell for the rest of the session. */
  backgroundOff: string;
  mouseOn: string;
  mouseOff: string;
  hideCursor: string;
  showCursor: string;
  /** Synchronized-output bracket, for wrapping one frame's worth of writes. */
  syncBegin: string;
  syncEnd: string;
  /** Move to a 1-based (row, col) — only valid when `altScreen` is on. */
  moveTo: (row: number, col: number) => string;
  /** Erase the whole line at a 1-based row. */
  eraseLineAt: (row: number) => string;
  reset: string;
}

export function buildSequences(caps: TerminalCapabilities): Sequences {
  return {
    altScreenOn: caps.altScreen ? `${csi("?1049h")}${csi("?25l")}` : "",
    altScreenOff: caps.altScreen ? `${csi("?25h")}${csi("?1049l")}` : "",
    // Requested directly: "llamacli 의 배경을 검은색으로 해줘 그게 가독성이
    // 더 있는거 같아" — a black background reads better than a light one.
    //
    // Two things make this more than a one-line SGR, and both were the failure
    // modes of doing it naively:
    //
    // 1. It is emitted on the alt screen, which is where the app lives, so it
    //    cannot leak into the user's shell — BUT the matching reset (SGR 49)
    //    still has to be emitted on exit. A background left set outlives the
    //    process and recolours the terminal for the rest of the session,
    //    including every command typed afterwards. `backgroundOff` exists for
    //    exactly that and index.tsx writes it in exitAltScreen.
    //
    // 2. 48;2;r;g;b is TRUECOLOR. On a terminal at colorDepth 4 (16 colours)
    //    or 8 (256) this either does nothing or is mangled, so it is gated on
    //    `colorDepth === 24`. A 16-colour terminal keeps its own background
    //    rather than getting a half-applied one. `backgroundBlack` (SGR 40) is
    //    the fallback for those, since black is in every colour palette.
    //
    //    NOTE the trailing `m`: this module's `csi()` helper does NOT append
    //    the final byte (every other call site passes it, e.g. `csi("?1049h")`).
    //    Omitting it here emitted a truncated `\x1b[49` immediately followed by
    //    the alt-screen sequence, which a terminal silently fails to parse —
    //    caught by capturing the raw bytes off a live pty, not by reading the
    //    code. The pairing of the two sequences (set black, then promote it to
    //    the DEFAULT) is what makes it survive Ink repainting.
    backgroundOn:
      caps.colorDepth === 24
        ? `${csi("48;2;0;0;0m")}${csi("49m")}` // set black, then make it the DEFAULT
        : caps.colorDepth >= 4
          ? `${csi("40m")}${csi("49m")}`
          : "",
    backgroundOff: caps.colorDepth >= 4 ? csi("49m") : "",
    mouseOn: caps.mouse ? `${csi("?1000h")}${csi("?1006h")}` : "",
    mouseOff: caps.mouseSgr ? `${csi("?1006l")}${csi("?1000l")}` : "",
    hideCursor: caps.ansi ? csi("?25l") : "",
    showCursor: caps.ansi ? csi("?25h") : "",
    syncBegin: caps.synchronizedOutput ? csi("?2026h") : "",
    syncEnd: caps.synchronizedOutput ? csi("?2026l") : "",
    moveTo: (row: number, col: number) => (caps.ansi ? csi(`${row};${col}H`) : ""),
    eraseLineAt: (row: number) => (caps.ansi ? `${csi(`${row};1H`)}${csi("2K")}` : ""),
    reset: caps.ansi ? csi("0m") : "",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Color: degrade instead of leak.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wraps `text` in an SGR sequence, downgrading for the terminal's actual
 * color depth so a bright-color code never reaches a 16-color (or colorless)
 * terminal — where it would either render as the wrong color or, on a true
 * `vt100`, not at all.
 *
 * `sgr` may be given either way round, because both spellings already exist
 * in this codebase and picking one would guarantee callers get it wrong:
 *   - the full sequence as `banner.ts` stores it: "1;36m"
 *   - the bare parameters: "1;36"
 * A trailing "m" is tolerated rather than blindly concatenated, which is what
 * would otherwise emit "1;36mm" and color the text magenta-plus-a-stray-m.
 *
 * The downgrade rules:
 *   - no color            -> plain text
 *   - 16 colors           -> keep attributes and the 30-37/90-97 "standard"
 *                           colors; a 38;5;N / 38;2;R;G;B sequence is dropped
 *                           entirely, since those index a palette this
 *                           terminal does not have
 *   - 256 / truecolor     -> emit as-is
 */
export function paint(text: string, sgr: string, caps: TerminalCapabilities): string {
  if (!caps.ansi || caps.colorDepth === 0) return text;
  const params = sgr.endsWith("m") ? sgr.slice(0, -1) : sgr;
  if (caps.colorDepth === 4 && /38;5;|38;2;/.test(params)) return text;
  return `\x1b[${params}m${text}\x1b[0m`;
}

/**
 * Glyph with a guaranteed fallback. `unicode` is the preferred glyph, `ascii`
 * the same symbol in plain ASCII. Centralizing this is the point: every
 * glyph in the app goes through here, so "this terminal has no Braille"
 * becomes one decision instead of a per-component guess.
 */
export function glyph(preferred: string, ascii: string, caps: TerminalCapabilities): string {
  return caps.unicode ? preferred : ascii;
}

/**
 * The cli-boxes border style to hand Ink.
 *
 * Ink draws borders from `cli-boxes`, and its `round`/`single` styles are
 * built entirely from box-drawing characters (`─ │ ┌ ┐`). Ink picks no
 * alternative for us, so on a non-UTF-8 terminal every box in this app
 * renders its frame as `?`/`?` — including the input box the user is typing
 * into. `classic` is the same layout in `+ - |`.
 */
export function borderStyleFor(caps: TerminalCapabilities): "round" | "classic" {
  return caps.unicode ? "round" : "classic";
}

/**
 * Applies the detected color depth to chalk, which is what Ink colors its own
 * output through.
 *
 * This is the piece that makes `NO_COLOR` (and a 16-color terminal) actually
 * work end to end. The rest of this module covers the escape sequences *we*
 * write, but the great majority of the colored text on screen is Ink's —
 * `<Text color="cyan">`, `dimColor`, the borders, the context gauge. Setting
 * chalk's level is the only way to degrade those, and chalk's levels line up
 * exactly with ColorDepth: 0 none, 1 = 16 colors, 2 = 256, 3 = truecolor.
 *
 * Must be called before `render()`. Safe to call more than once.
 */
export function applyColorDepth(caps: TerminalCapabilities): void {
  const level = caps.colorDepth === 0 ? 0 : caps.colorDepth === 4 ? 1 : caps.colorDepth === 8 ? 2 : 3;
  // chalk is Ink's own coloring dependency (a transitive dep, so it is always
  // present and always the SAME instance Ink renders through — which is what
  // makes setting the level here affect Ink's output at all).
  chalk.level = level;
}

/** Strips CSI/OSC sequences. Used before measuring width and before handing
 *  text to anything that can't be trusted with control bytes. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
