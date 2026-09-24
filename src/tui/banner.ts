/** The startup banner shown once, inside the app's own log (see App.tsx's
 *  mount effect and AppProps.startupBanner) — a colored "Harness CLI" line
 *  with a build-date version, revealed one WORD at a time, finishing with a
 *  small bouncing-ball flourish. Requested directly: "대문로그는 한
 *  단어씩 나타나게 해줘 그리고 마지막에 위아래로 공이 튀는 것처럼 통통통
 *  하고 튀는 효과를 넣어주고" ("reveal the banner one word at a time, and
 *  add a bouncing-ball effect — like a ball bouncing up and down — at the
 *  end"). Pure ANSI + pure functions so the animation is unit-testable
 *  without a terminal. */

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
