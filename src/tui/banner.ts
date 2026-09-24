/** The startup banner printed once, before Ink takes over the screen —
 *  requested directly: a colored "Harness CLI" line with a build-date
 *  version and the repo URL, animated the same reveal-wave way reasoning
 *  text already is (see App.tsx's shimmerBands) so the two feel like one
 *  design language rather than two unrelated effects. */

/** `vYYYYMMDD` from a file's mtime — used with dist/index.js's own mtime as
 *  a build date, since there's no separate build-info step to read from. */
export function buildVersionString(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const RESET = "\x1b[0m";
const SETTLED = "\x1b[1;36m"; // bold cyan — matches the reasoning shimmer's settled color
const PEAK = "\x1b[1;95m"; // bold bright magenta — the wave's leading edge
const DIM = "\x1b[2;90m"; // dim gray — not yet reached

/** One animation frame: a left-to-right reveal wave over `text`, same
 *  monotonic-per-character shape as shimmerBands (never un-reveals a
 *  character once passed). Pure and ANSI-only so it can run before Ink/React
 *  mount and still be unit tested without a terminal. */
export function bannerFrame(text: string, tick: number, speed = 2, bandWidth = 4): string {
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

/** Ticks needed for the wave to fully cross `text` at the given speed —
 *  the animation is done once revealed === text.length. */
export function bannerFrameCount(text: string, speed = 2): number {
  return Math.ceil(text.length / speed);
}
