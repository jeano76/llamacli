// marked-terminal renders through chalk, which auto-detects color support
// at the moment chalk itself is first imported/initialized. Reported
// directly: assistant text had no color at all, unlike Claude Code's own
// output. Setting `process.env.FORCE_COLOR` *after* a static
// `import ... from "marked-terminal"` doesn't work — ES module imports are
// hoisted, so marked-terminal (and the chalk instance it creates
// internally) finish loading, with color support already locked in, before
// any of this module's own top-level code runs. Force it on and only THEN
// dynamically import marked-terminal, so chalk sees it during its own
// initialization — this is unconditional, matching how Ink already writes
// raw ANSI here regardless of what chalk's own TTY detection would guess.
process.env.FORCE_COLOR ??= "1";

const { marked } = await import("marked");
const { markedTerminal } = await import("marked-terminal");

marked.use(
  // @types/marked-terminal's MarkedExtension typing doesn't match what
  // markedTerminal() actually returns at runtime (verified working) —
  // this mismatch is in the community types, not a real incompatibility.
  markedTerminal({
    // Ink Boxes reserve the actual terminal width already (see App.tsx);
    // let wrapAnsiSafe() do the wrapping against real available columns
    // instead of marked-terminal guessing its own from process.stdout,
    // which is wrong here since Ink owns a fixed sub-region, not the full
    // terminal height, and marked-terminal has no notion of that.
    width: 100_000,
    reflowText: false,
  }) as any
);

/** Renders assistant markdown (headings, bold/italic, fenced code with
 *  syntax highlighting, lists, etc.) to an ANSI string ready for the
 *  terminal — mirrors how Claude Code's own CLI output looks, instead of
 *  the flat, unstyled text llamacli was showing before this existed. */
export function renderMarkdown(text: string): string {
  try {
    const out = marked.parse(text, { async: false }) as string;
    // marked always appends a trailing newline for block-level content;
    // trim it so callers control their own line spacing.
    return out.replace(/\n+$/, "");
  } catch {
    // Malformed/partial markdown (e.g. an unclosed code fence mid-stream,
    // since this runs on cumulative text while a response is still
    // streaming in) must never crash rendering — show the raw text for
    // that frame rather than losing the response.
    return text;
  }
}
