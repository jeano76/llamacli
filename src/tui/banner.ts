/** The startup banner shown once, inside the app's own log (see App.tsx's
 *  mount effect and AppProps.startupBanner): "HARNESS" as block-letter
 *  ASCII art that shakes itself steady, then a version line with a small
 *  bouncing-ball flourish, right-aligned to the art's own width. Pure ANSI
 *  + pure functions so the animation is unit-testable without a terminal. */
import stringWidth from "string-width";

/** `vYYYYMMDD` from a file's mtime — used with dist/index.js's own mtime as
 *  a build date, since there's no separate build-info step to read from. */
export function buildVersionString(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const RESET = "\x1b[0m";
const SETTLED = "\x1b[1;36m"; // bold cyan — matches the reasoning shimmer's settled color
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
const BOUNCE_DOTS = ["⠁", "⠂", "⠄", "⡀"];
const BALL_COLOR = "\x1b[1;33m"; // bold yellow — reads as a distinct little flourish, not more banner text

/** One frame of the bouncing-ball flourish, played once after the word
 *  reveal finishes. Clamps to the final (resting) frame past the end. */
export function bounceFrame(tick: number): string {
  const height = BOUNCE_HEIGHTS[Math.min(tick, BOUNCE_HEIGHTS.length - 1)];
  return `${BALL_COLOR}${BOUNCE_DOTS[height]}${RESET}`;
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

/** Block-letter ASCII art, 5 rows tall — requested directly: "대문 로그를
 *  Ansi 의 아스키 코드를 이용해서 Harness 글자모양을 만들고 흔들리는 것은
 *  글씨 자체야" ("build the banner's 'Harness' shape out of ANSI/ASCII, and
 *  what shakes is the lettering itself") — replacing the earlier
 *  small-text word-reveal, which wasn't actual letter shapes. Only the
 *  letters this app's name needs; an unknown character renders as a blank
 *  5x5 cell rather than throwing. */
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

/** Builds the 5-row block-letter art for `text` (letters side by side, one
 *  space apart; a literal space becomes a narrower word gap), uppercased.
 *  Pure so it — and the shake animation over it — is unit-testable without
 *  a terminal. */
export function buildArt(text: string): string[] {
  const rows = new Array(ART_ROWS).fill("");
  for (const ch of text.toUpperCase()) {
    const glyph = ch === " " ? WORD_GAP_GLYPH : GLYPHS[ch] ?? BLANK_GLYPH;
    for (let r = 0; r < ART_ROWS; r++) {
      rows[r] += (rows[r] ? " " : "") + glyph[r];
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

const SHAKE_TICKS = 14;
const ART_COLOR = "\x1b[1;36m"; // bold cyan, same settled color the rest of the app's animations use

/** One frame of the shake: each row gets a small leading-space jitter that
 *  decays tick by tick (amplitude 3 → 0) and staggers by row so the whole
 *  word wobbles rather than moving as one rigid block, settling dead still
 *  (offset 0) by SHAKE_TICKS. Deterministic in (tick, row) — same inputs,
 *  same jitter, so it's testable without a terminal driving real timers. */
export function shakeFrame(art: string[], tick: number): string {
  const amplitude = Math.max(0, 3 - Math.floor(Math.min(tick, SHAKE_TICKS) / 4));
  return art
    .map((row, i) => {
      const offset = amplitude > 0 ? Math.abs(((tick + i * 2) % (amplitude * 2 + 1)) - amplitude) : 0;
      return `${ART_COLOR}${" ".repeat(offset)}${row}${RESET}`;
    })
    .join("\n");
}

export function shakeFrameCount(): number {
  return SHAKE_TICKS;
}
