/** The startup banner shown once, inside the app's own log (see App.tsx's
 *  mount effect and AppProps.startupBanner): "HARNESS" as block-letter
 *  ASCII art with a diagonal shine sweep (no shake — dropped per direct
 *  feedback: "지금처럼 좌우로 흔드는 애니메이션은 필요없고"), then a
 *  version line with a small bouncing-ball flourish, right-aligned to the
 *  art's own width. Pure ANSI + pure functions so the animation is
 *  unit-testable without a terminal. */
import stringWidth from "string-width";
import { paint, type TerminalCapabilities } from "./terminal.js";

/** `vYYYYMMDD` from a file's mtime — used with dist/index.js's own mtime as
 *  a build date, since there's no separate build-info step to read from. */
export function buildVersionString(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// SGR parameter strings, not full sequences, so `paint` can downgrade them
// for the terminal's actual color depth. The previous hardcoded `1;95m` /
// `2;90m` (bright magenta / bright black) reached 16-color terminals as the
// wrong color and true `vt100` not at all — nothing checked depth, and
// these are the exact codes that broke.
//
// Bright-color fallbacks for a 16-color terminal live in paintMap below,
// because the downgrade isn't a truncation: SGR 90-97 is a *separate* range
// from 30-37, so a 16-color terminal needs 95 -> 35 (bright magenta is
// approximated by plain magenta there).
const SETTLED_SGR = "1;36";
const PEAK_SGR = "1;95";
const DIM_SGR = "2;90";
export const BALL_SGR = "1;33";
export { SETTLED_SGR };

/** Bright (90-97) -> the matching standard color (30-37), for terminals with
 *  only 16 colors. Applied by `sgrFor` below. */
const BRIGHT_TO_STANDARD: Record<string, string> = {
  "90": "30", "91": "31", "92": "32", "93": "33",
  "94": "34", "95": "35", "96": "36", "97": "37",
};

/** Rewrites an SGR parameter string for the terminal's color depth. */
export function sgrFor(sgr: string, caps: TerminalCapabilities): string {
  if (caps.colorDepth !== 4) return sgr;
  return sgr
    .split(";")
    .map((p) => BRIGHT_TO_STANDARD[p] ?? p)
    .join(";");
}

/** Colors `text` with `sgr`, degrading to nothing on a colorless terminal
 *  and remapping bright colors on a 16-color one. */
export function colored(text: string, sgr: string, caps: TerminalCapabilities): string {
  return paint(text, sgrFor(sgr, caps), caps);
}

export const RESET = "\x1b[0m";
export const SETTLED = "\x1b[1;36m"; // bold cyan — matches the reasoning shimmer's settled color
const PEAK = "\x1b[1;95m"; // bold bright magenta — the word currently landing
const DIM = "\x1b[2;90m"; // dim gray — not yet reached (reasoning shimmer's own "unread" color)

/** One frame of the word-by-word reveal: words already shown stay settled
 *  (cyan), the word that just landed this tick is highlighted (peak
 *  magenta), and words not reached yet aren't emitted at all — a banner
 *  building up word by word, not sitting there half-dim like the
 *  character-reveal wave used elsewhere (shimmerBands). `tick` is words
 *  revealed so far; monotonic, so a settled word never reverts. */
export function bannerWordFrame(text: string, tick: number): string {
  if (!text) return "";
  const words = text.split(" ");
  const revealed = Math.max(0, Math.min(words.length, tick));
  const parts: string[] = [];
  for (let i = 0; i < revealed; i++) {
    const color = i === revealed - 1 ? PEAK : SETTLED;
    parts.push(`${color}${words[i]}${RESET}`);
  }
  return parts.join(" ");
}

/** Ticks needed to reveal every word — the reveal is done once
 *  bannerWordFrame(text, tick) === bannerWordFrame(text, wordCount). */
export function bannerWordCount(text: string): number {
  return text ? text.split(" ").length : 0;
}

// A braille cell's dot positions read top-to-bottom, standing in for a
// ball's height — 0 (top of its arc) through 3 (ground). Two bounces, each
// smaller than the last (gravity), settling on the ground.
const BOUNCE_HEIGHTS = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3];
// Braille dots, with ASCII stand-ins of the same *shape* (a rising little
// ball) for terminals that can't render them. The Spinner component was
// already converted to plain ASCII for exactly this reason (see its doc
// comment: glyph coverage and computed width vary by font, and a width
// mismatch shifts everything next to it) — but the banner kept its Braille,
// and the banner is the widest fixed-width element on screen, so a font
// without Braille coverage misaligned the whole startup block.
const BOUNCE_DOTS = ["⠁", "⠂", "⠄", "⡀"];
const BOUNCE_DOTS_ASCII = [".", "o", "O", "@"];
export const BALL_COLOR = "\x1b[1;33m"; // bold yellow — reads as a distinct little flourish, not more banner text

/** One frame of the bouncing-ball flourish, played once after the word
 *  reveal finishes. Clamps to the final (resting) frame past the end. */
export function bounceFrame(tick: number, caps?: TerminalCapabilities): string {
  const height = BOUNCE_HEIGHTS[Math.min(tick, BOUNCE_HEIGHTS.length - 1)];
  const dot = caps && !caps.unicode ? BOUNCE_DOTS_ASCII[height] : BOUNCE_DOTS[height];
  if (caps) return colored(dot, BALL_SGR, caps);
  return `${BALL_COLOR}${dot}${RESET}`;
}

export function bounceFrameCount(): number {
  return BOUNCE_HEIGHTS.length - 1;
}

/** One frame of a character-by-character reveal wave — the exact shining
 *  effect reasoning text streams in with (App.tsx's shimmerBands), as raw
 *  ANSI instead of React elements so it can be embedded directly into the
 *  plain-string banner lines here. Requested directly: "구동 로그에
 *  Thinking 시의 샤이닝 효과도 추가해줘" — used for the small "cli"
 *  caption under the HARNESS wordmark. Monotonic in tick (a settled
 *  character never reverts to dim). */
export function shineFrame(text: string, tick: number, speed = 2, bandWidth = 4): string {
  if (!text) return "";
  const revealed = Math.min(text.length, tick * speed);
  const peakStart = Math.max(0, revealed - bandWidth);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const color = i < peakStart ? SETTLED : i < revealed ? PEAK : DIM;
    out += `${color}${text[i]}`;
  }
  return out + RESET;
}

export function shineFrameCount(text: string, speed = 2): number {
  return Math.ceil(text.length / speed);
}

/** shineFrame over MULTIPLE lines, staggered diagonally by row — later rows
 *  start revealing a little later than the one above, so the bright band
 *  reads as one light sweeping across the block on a slant (top-left
 *  toward bottom-right) rather than a straight vertical or per-row-parallel
 *  wave. Requested directly, through several rounds of clarification:
 *  - "글씨를 구성하는 문자 하나하나가 빛나는 효과를 Harness CLI 전체
 *    생겨야 하는거야" (each character's shine as one motion across the
 *    whole thing, not per line)
 *  - "샤이닝 효과는 Think 할 때의 글씨의 반짝이는 효과처럼 같은 색상
 *    계열의 밝은색 블럭으로 좌측에서 우측으로 비스듬하게 이동이 되게
 *    되는거야" (a bright block of the same color family moving diagonally
 *    left-to-right, like reasoning's own sparkle)
 *  - finally: "모서리 약한 흐릿한 색상바꾸는 효과는 없애고 글씨의 메인
 *    색으로 모두 최종 통일되게 해줘" (drop the effect that changes some
 *    characters to a faint different color — everything should end up
 *    the SAME main color). Earlier passes tried a separate bright "peak"
 *    color restricted to specific characters, which kept reading as two
 *    (or more) different final colors instead of one; simplified to just
 *    two states — DIM (not yet revealed) and SETTLED (revealed, the one
 *    single final color) — so there's nothing left to look inconsistent.
 *  Monotonic per character (once revealed, never reverts to dim), same as
 *  every other shimmer in this app — only the shape of the sweep is new. */
export function shineMultilineFrame(lines: string[], tick: number, speed = 8, slantPerRow = 1): string {
  return lines
    .map((line, row) => {
      const effectiveTick = Math.max(0, tick - row * slantPerRow);
      const revealed = Math.min(line.length, effectiveTick * speed);
      let out = "";
      for (let i = 0; i < line.length; i++) {
        out += `${i < revealed ? SETTLED : DIM}${line[i]}`;
      }
      return out + RESET;
    })
    .join("\n");
}

export function shineMultilineFrameCount(lines: string[], speed = 8, slantPerRow = 1): number {
  return Math.max(0, ...lines.map((line, row) => row * slantPerRow + Math.ceil(line.length / speed)));
}

/** Block-letter ASCII art, 5 rows tall — requested directly: "대문 로그를
 *  Ansi 의 아스키 코드를 이용해서 Harness 글자모양을 만들고 흔들리는 것은
 *  글씨 자체야" ("build the banner's 'Harness' shape out of ANSI/ASCII, and
 *  what shakes is the lettering itself") — replacing the earlier
 *  small-text word-reveal, which wasn't actual letter shapes. Only the
 *  letters this app's name needs; an unknown character renders as a blank
 *  5x5 cell rather than throwing. */
// Plain solid block letters — the corner-softening (a lighter ░ shade at
// the four outer corners of each glyph, tried as a "chubbier" look) was
// removed per direct feedback: "아스키 문자구성의 HARNESS 의 모서리
// 색상바꾸는 효과는 없애죠" (drop the effect that changes the color of
// HARNESS's corners).
const GLYPHS: Record<string, string[]> = {
  H: ["█   █", "█   █", "█████", "█   █", "█   █"],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
};
const BLANK_GLYPH = ["     ", "     ", "     ", "     ", "     "];
// Narrower than a letter's own blank — a full 5-wide gap between WORDS (as
// opposed to the 1-column gap buildArt already puts between letters) reads
// as a big empty hole rather than a word break.
const WORD_GAP_GLYPH = ["   ", "   ", "   ", "   ", "   "];
const ART_ROWS = 5;
/** Every glyph above is 5 columns wide — used by callers (App.tsx) that
 *  need to know where the LAST letter's columns start, to restrict the
 *  shine's peak color to it (see shineMultilineFrame's peakAllowed). */
export const LETTER_WIDTH = 5;

/**
 * Same wordmark in `#`, for a terminal that can't render `█` (U+2588).
 * Every cell is deliberately still exactly 5 columns wide: `ART_WIDTH` and
 * `rightAlign` are computed from the glyph table, so an ASCII table of a
 * different width would silently shift the right-aligned version/caption
 * line instead of just looking plainer. That's the whole class of bug the
 * Spinner comment describes, and the reason a naive "strip the non-ASCII
 * characters" fallback is wrong — stripping `█` leaves an empty banner
 * AND a zero ART_WIDTH, which then breaks every caller that indexes into it.
 */
const GLYPHS_ASCII: Record<string, string[]> = {
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  S: [" ####", "#    ", " ### ", "    #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
};

/** Builds the 5-row block-letter art for `text` (letters side by side, one
 *  space apart; a literal space becomes a narrower word gap), uppercased.
 *  Pure so it — and the shine animation over it — is unit-testable without
 *  a terminal. `caps` selects the block or ASCII glyph table; omitting it
 *  keeps the original (Unicode) output so existing callers and tests are
 *  unaffected. */
export function buildArt(text: string, caps?: TerminalCapabilities): string[] {
  const table = caps && !caps.unicode ? GLYPHS_ASCII : GLYPHS;
  const rows = new Array(ART_ROWS).fill("");
  for (const ch of text.toUpperCase()) {
    const g = ch === " " ? WORD_GAP_GLYPH : table[ch] ?? BLANK_GLYPH;
    for (let r = 0; r < ART_ROWS; r++) {
      rows[r] += (rows[r] ? " " : "") + g[r];
    }
  }
  return rows;
}

export const HARNESS_ART = buildArt("HARNESS");
/** Every row of HARNESS_ART is the same width (buildArt pads letters to a
 *  fixed 5-column glyph) — used to right-align the caption line under it. */
export const ART_WIDTH = HARNESS_ART[0].length;

/** Right-pads `text` with leading spaces so its VISIBLE width (ANSI codes
 *  don't count, via string-width) ends flush with `width` — requested
 *  directly: "버전과 탁구공같은 튀김은 HARNESS 마지막 길이를 맞춰서 우측
 *  정렬을 해줘" (right-align the version + bounce-ball line to HARNESS's
 *  own width). Never truncates: text wider than `width` is returned as-is. */
export function rightAlign(text: string, width: number): string {
  const pad = Math.max(0, width - stringWidth(text));
  return " ".repeat(pad) + text;
}

