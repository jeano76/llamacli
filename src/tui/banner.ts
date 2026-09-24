/** The startup banner shown once, inside the app's own log (see App.tsx's
 *  mount effect and AppProps.startupBanner): "HARNESS" as block-letter
 *  ASCII art with a diagonal shine sweep (no shake — dropped per direct
 *  feedback: "지금처럼 좌우로 흔드는 애니메이션은 필요없고"), then a
 *  version line with a small bouncing-ball flourish, right-aligned to the
 *  art's own width. Pure ANSI + pure functions so the animation is
 *  unit-testable without a terminal. */
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

/** shineFrame over MULTIPLE lines, staggered diagonally by row — later rows
 *  start revealing a little later than the one above, so the bright band
 *  reads as one light sweeping across the block on a slant (top-left
 *  toward bottom-right) rather than a straight vertical or per-row-parallel
 *  wave. Requested directly, through two rounds of clarification:
 *  - "글씨를 구성하는 문자 하나하나가 빛나는 효과를 Harness CLI 전체
 *    생겨야 하는거야" (each character's shine as one motion across the
 *    whole thing, not per line)
 *  - "샤이닝 효과는 Think 할 때의 글씨의 반짝이는 효과처럼 같은 색상
 *    계열의 밝은색 블럭으로 좌측에서 우측으로 비스듬하게 이동이 되게
 *    되는거야" (a bright block of the same color family moving diagonally
 *    left-to-right, like reasoning's own sparkle)
 *  Monotonic per character (once revealed, never reverts to dim), same as
 *  every other shimmer in this app — only the shape of the sweep is new. */
export function shineMultilineFrame(lines: string[], tick: number, speed = 10, bandWidth = 3, slantPerRow = 1): string {
  return lines
    .map((line, row) => {
      const effectiveTick = Math.max(0, tick - row * slantPerRow);
      const revealed = Math.min(line.length, effectiveTick * speed);
      const peakStart = Math.max(0, revealed - bandWidth);
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const color = i < peakStart ? SETTLED : i < revealed ? PEAK : DIM;
        out += `${color}${line[i]}`;
      }
      return out + RESET;
    })
    .join("\n");
}

export function shineMultilineFrameCount(lines: string[], speed = 10, slantPerRow = 1): number {
  return Math.max(0, ...lines.map((line, row) => row * slantPerRow + Math.ceil(line.length / speed)));
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
 *  Pure so it — and the shine animation over it — is unit-testable without
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

