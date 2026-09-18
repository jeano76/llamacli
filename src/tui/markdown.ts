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

const { Marked } = await import("marked");
const { markedTerminal } = await import("marked-terminal");

// One marked instance per terminal width, not a single shared one. A
// markdown *table* is rendered by marked-terminal (via cli-table3) as
// whole, already-bordered lines sized to whatever `width` the renderer was
// configured with — reported directly (with a screenshot): with a single
// large fixed width (the previous approach, to let wrapAnsiSafe() do
// wrapping afterward against the real terminal columns), a wide table's
// row was one long line far wider than the terminal, and wrapping that
// afterward sliced straight through the middle of box-drawing characters,
// scattering disjointed border fragments across multiple lines exactly
// like the screenshot. A table has to be sized to the real width at
// render time, not wrapped after the fact like plain text. Cached per
// width (not rebuilt every call) since the same 1-2 widths (whatever the
// terminal actually is, occasionally changing on resize) repeat for the
// life of the process.
const instances = new Map<number, InstanceType<typeof Marked>>();

function instanceForWidth(width: number): InstanceType<typeof Marked> {
  let instance = instances.get(width);
  if (instance) return instance;
  instance = new Marked();
  instance.use(
    // @types/marked-terminal's MarkedExtension typing doesn't match what
    // markedTerminal() actually returns at runtime (verified working) —
    // this mismatch is in the community types, not a real incompatibility.
    markedTerminal({ width, reflowText: true }) as any
  );
  instances.set(width, instance);
  return instance;
}

/** Renders assistant markdown (headings, bold/italic, fenced code with
 *  syntax highlighting, tables, lists, etc.) to an ANSI string ready for
 *  the terminal, sized to `width` columns — mirrors how Claude Code's own
 *  CLI output looks, instead of the flat, unstyled text llamacli was
 *  showing before this existed. Callers should still pass non-table
 *  content through wrapAnsiSafe() afterward as a backstop (prose can still
 *  run past `width` in edge cases marked-terminal doesn't wrap), but a
 *  table sized correctly here shouldn't need it. */
export function renderMarkdown(text: string, width: number): string {
  try {
    const out = instanceForWidth(Math.max(20, width)).parse(text, { async: false }) as string;
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
