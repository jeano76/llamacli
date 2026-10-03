/**
 * Path pieces that work for BOTH separators. A model path on Windows is `C:\models\x.gguf`; `p.split("/").pop()`
 * returned the whole string there, so model names in `/server`, `/models`, the diff shown before a restart, and
 * the sidecar written next to a download were full paths — and basename comparisons (is this the file the config
 * names?) never matched. (Found by running the unit tests on a real Windows runner.)
 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The last `n` path segments joined with "/", for compact display (`build-opt/bin/llama-server`). */
export function lastSegments(p: string, n: number): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-n).join("/");
}
