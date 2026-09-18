import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { SlashMenu, SLASH_MENU_ITEMS, SlashMenuItem } from "./SlashMenu.js";
import { tailToWidth, wrapToWidth, wrapAnsiSafe, wrapPreservingTables } from "./textWidth.js";
import { stripToolCallTemplateLeak } from "../agent/textSanitize.js";
import { renderMarkdown } from "./markdown.js";

export interface AppProps {
  cwd: string;
  model: string;
  onSubmit: (text: string) => void;
  onSlashCommand: (key: string) => void;
}

interface LogLine {
  id: number;
  text: string;
  kind: "user" | "assistant" | "status" | "tool" | "diff";
}

let logIdCounter = 0;

/** `input` is the raw text box content, which starts with "/" while the
 *  menu is open — everything after that is the filter query. Matches
 *  against the command's key (e.g. "improve-apply"), not its "/"-prefixed
 *  label, so typing "imp" also finds "/improve-apply" via a plain
 *  substring check — simple and predictable over fuzzier matching. */
export function filterMenuItems(input: string): SlashMenuItem[] {
  const query = input.slice(1).toLowerCase();
  if (!query) return SLASH_MENU_ITEMS;
  return SLASH_MENU_ITEMS.filter((item) => item.key.toLowerCase().includes(query));
}

export function App({ cwd, model, onSubmit, onSlashCommand }: AppProps) {
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [contextUsedRatio, setContextUsedRatio] = useState(0);
  const [planProgress, setPlanProgress] = useState<{ done: number; total: number } | null>(null);
  // Requested directly: the "[compaction complete] ..." log line got
  // pushed out of view by later scrolling activity before it was ever
  // actually noticed. A persistent status-bar indicator instead — same
  // reasoning as planProgress above.
  const [compactionStatus, setCompactionStatus] = useState<{ state: "running" | "complete" | "failed"; timestamp: string } | null>(
    null
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // Rows scrolled up from the live bottom (0 = following the newest output,
  // like a normal terminal). Requested directly: the alt-screen buffer
  // (needed for reliable absolute cursor positioning — see index.tsx) also
  // disables the terminal's own native scrollback as a side effect, so
  // there was no way at all to look back at anything that had scrolled off
  // the fixed-height log box. This restores that ability inside the app
  // itself instead.
  const [scrollOffset, setScrollOffset] = useState(0);
  // Messages typed while the agent is busy wait here instead of being sent
  // immediately; /queue inspects this list (PROMPT.md §6 message queue input).
  const [queue, setQueue] = useState<string[]>([]);
  const wasBusyRef = useRef(false);
  // Tracks which log line the currently-streaming assistant message is
  // appending to, so successive deltas mutate one line instead of spawning
  // a new one per chunk.
  const streamingIdRef = useRef<number | null>(null);
  // How far scrollOffset can go before there's nothing further back to see —
  // updated every render (see below) rather than recomputed inside the key
  // handler, which would mean redoing the markdown/wrap rendering work
  // twice per keystroke just to clamp a scroll position.
  const maxScrollRef = useRef(0);
  // Same reasoning as maxScrollRef — needed inside the key handler (for
  // sizing a Page Up/Down jump) before logHeight is computed later in this
  // render, so it's carried over from the previous one instead.
  const logHeightRef = useRef(3);

  function pushLine(text: string, kind: LogLine["kind"]) {
    setLog((prev) => [...prev, { id: logIdCounter++, text, kind }]);
  }

  function pushAssistantDelta(text: string) {
    setLog((prev) => {
      if (streamingIdRef.current !== null) {
        return prev.map((line) =>
          line.id === streamingIdRef.current
            ? // Re-sanitize the whole cumulative text each time, not just
              // the new chunk — a leaked tool-call template tag (see
              // src/agent/textSanitize.ts) can arrive split across several
              // small streaming chunks, so it's only ever complete (and
              // therefore matchable) once appended to what came before.
              { ...line, text: stripToolCallTemplateLeak(line.text + text) }
            : line
        );
      }
      const id = logIdCounter++;
      streamingIdRef.current = id;
      return [...prev, { id, text: stripToolCallTemplateLeak(text), kind: "assistant" }];
    });
  }

  function finalizeAssistant() {
    streamingIdRef.current = null;
  }

  // Once the current turn finishes, automatically send the next queued message.
  useEffect(() => {
    if (wasBusyRef.current && !busy && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      pushLine(`[sending from queue] ${next}`, "status");
      onSubmit(next);
    }
    wasBusyRef.current = busy;
  }, [busy]);

  useInput((char, key) => {
    // Ink's default Ctrl-C-exits-the-app behavior is disabled in index.tsx
    // (exitOnCtrlC: false) specifically so this reaches here instead —
    // reported directly: some terminals/users treat Ctrl-C as copy, not an
    // interrupt, and it shouldn't kill llamacli either way. Make it an
    // explicit no-op (not inserted into the input, doesn't touch the
    // menu) rather than falling through to the generic "append this
    // character" branch, which would otherwise insert the raw control
    // byte into whatever you were typing. /quit is still the only way out.
    if (key.ctrl && char.toLowerCase() === "c") {
      return;
    }

    if (menuOpen) {
      // Reported directly: the menu could only be driven with arrow keys —
      // typing the rest of a command's name (the obvious first thing to
      // try after "/") did nothing at all, since this branch previously
      // handled only up/down/return/escape and fell through to `return`
      // for everything else. Filter-as-you-type now works like a normal
      // command palette instead.
      const filtered = filterMenuItems(input);
      if (key.upArrow) setMenuIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMenuIndex((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
      else if (key.return) {
        const item = filtered[menuIndex];
        if (!item) return; // no match under the current filter — nothing to select
        setMenuOpen(false);
        setInput("");
        if (item.key === "queue") {
          pushLine(
            queue.length
              ? `Queue (${queue.length}):\n${queue.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
              : "The queue is empty.",
            "status"
          );
        } else {
          onSlashCommand(item.key);
        }
      } else if (key.escape) {
        setMenuOpen(false);
        setInput("");
      } else if (key.backspace || key.delete) {
        // Backspacing the "/" itself closes the menu — matches typing "/"
        // to open it being the exact inverse action, rather than leaving
        // an empty, command-less menu open.
        if (input.length <= 1) {
          setMenuOpen(false);
          setInput("");
        } else {
          setInput((s) => s.slice(0, -1));
          setMenuIndex(0); // narrower/wider filter — re-highlight the top match
        }
      } else if (char && !key.ctrl && !key.meta) {
        setInput((s) => s + char);
        setMenuIndex(0);
      }
      return;
    }

    // Arrow keys are otherwise unused while typing a normal message (Ink
    // gives an empty `char` for them, so the fallback append-to-input
    // below is already a harmless no-op for these) — repurposed for
    // scrollback instead of adding a new dedicated keybinding. PageUp/Down
    // jump a full screen at a time; plain Up/Down move one line.
    if (key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
      const amount = key.pageUp || key.pageDown ? Math.max(1, logHeightRef.current - 1) : 1;
      const direction = key.pageUp || key.upArrow ? 1 : -1;
      setScrollOffset((s) => Math.max(0, Math.min(maxScrollRef.current, s + amount * direction)));
      return;
    }

    if (key.return) {
      if (input.trim().length === 0) return;
      if (busy) {
        setQueue((q) => [...q, input]);
        pushLine(`[queued] ${input}`, "status");
      } else {
        pushLine(input, "user");
        onSubmit(input);
      }
      setInput("");
      // A message you just sent should be visible without having to
      // manually scroll back down for it — snap back to the live tail,
      // matching how a normal chat/terminal view behaves.
      setScrollOffset(0);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (char === "/" && input.length === 0) {
      setMenuOpen(true);
      setMenuIndex(0);
      setInput("/");
      return;
    }
    setInput((s) => s + char);
  });

  // TODO: replace with a proper imperative handle / event emitter once the
  // agent loop is wired to real streaming; global is a placeholder only.
  (globalThis as any).__llamacli_ui = {
    pushAssistantDelta,
    finalizeAssistant,
    pushStatus: (t: string) => pushLine(t, "status"),
    pushTool: (t: string) => pushLine(t, "tool"),
    pushDiff: (t: string) => pushLine(t, "diff"),
    setBusy,
    isBusy: () => busy,
    setContextUsedRatio,
    setPlanProgress: (done: number, total: number) => setPlanProgress(total > 0 ? { done, total } : null),
    setCompactionStatus: (state: "running" | "complete" | "failed", timestamp: string) => setCompactionStatus({ state, timestamp }),
  };

  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  // The input row must always be exactly one terminal row. Ink wraps a
  // <Text> that's wider than the terminal instead of clipping it, so a long
  // typed line silently grew this row to several — and since the total
  // layout height is fixed (see logHeight below), that overflow scrolled
  // the real terminal, leaving ghosting when it shrank back down. Truncate
  // to what actually fits instead of ever letting the input Text wrap.
  // Reserves 2 extra columns for the input box's own left+right border
  // characters (see the bordered Box below) on top of its padding/spinner/space.
  const maxInputWidth = Math.max(10, columns - 6);
  const visibleInput = tailToWidth(input, maxInputWidth);

  // logHeight is a CONSTANT, independent of menu state — this is the outer
  // log-area Box's actual `height`, and it must never change, because
  // changing it is what breaks things: (1) shrinking it only while the
  // menu was open shifted everything below (input box, status bar) by up
  // to ~10 rows in one frame, and Ink's incremental diffing didn't fully
  // clear the old content at the shifted-from position, leaving stale
  // fragments right on the input box's border (confirmed via a screen
  // recording: a leftover "셀" there after closing the menu). (2)
  // Permanently reserving the menu's height as a *separate* fixed box
  // avoided that, but left a permanent empty gap between the log and the
  // input box whenever the menu was closed (reported directly: text
  // "doesn't reach down to the prompt input"). (3) `position="absolute"`
  // to overlay it doesn't work in Ink 4.x — it only sets the Yoga position
  // TYPE, not an actual offset (no top/left/right/bottom style exists),
  // and a `marginTop` substitute pushed the menu's output past the
  // `overflow: hidden` boundary instead of being clipped, scrolling the
  // real terminal (confirmed by direct byte capture).
  //
  // The fix: keep this Box's height fixed at all times, and instead change
  // what's rendered *inside* it — when the menu is open, show fewer log
  // rows and the menu in the space freed up, all within the SAME
  // never-changing box. The outer box's contribution to the layout is
  // therefore always exactly `logHeight`, so nothing below it ever needs
  // to move, and nothing is permanently reserved when the menu is closed.
  const menuBoxHeight = SLASH_MENU_ITEMS.length + 2; // round border top+bottom
  // Fixed chrome below the log area: input box top border(1) + content(1) +
  // bottom border(1) + status bar(1).
  const logHeight = Math.max(3, rows - 4);
  logHeightRef.current = logHeight;

  // Absolute cursor positioning, reliable because index.tsx switches to the
  // terminal's alternate screen buffer before rendering (giving row 1 a
  // fixed, known meaning) and the app's total height is now provably
  // constant every frame regardless of menu state.
  useEffect(() => {
    const inputRow = logHeight + 1 /* input box top border */ + 1; // 1-indexed content row
    const promptColumn =
      1 /* input box left border */ + 1 /* paddingX */ + 1 /* spinner */ + 1 /* leading space */ + stringWidth(visibleInput) + 1;
    process.stdout.write(`\x1b[${inputRow};${promptColumn}H\x1b[?25h`);
  });

  // Slicing `log` itself by logHeight is wrong: a single multi-line diff
  // entry expands into several rendered rows, so a naive slice can hand the
  // fixed-height Box more rows than it can show — and since Box clips from
  // the bottom, that clips off the MOST recent lines (e.g. a status message
  // right after a diff) instead of showing them. Flatten to visual rows
  // first, then slice by rendered row count so the tail is always what's
  // visible. Pre-slice raw entries generously first so this stays cheap on
  // long sessions instead of flattening the whole history every render.
  const recentEntries = log.slice(-Math.max(logHeight * 5, 50));
  // Ink/Yoga gives an empty-string <Text> ZERO rendered height — not one
  // row like every other line — instead of a blank line taking up its own
  // row. Confirmed directly (a minimal Ink render collapsed blank entries
  // out of the layout entirely). That silently made the box's actual
  // rendered height fall short of `logHeight` whenever a wrapped entry
  // produced a blank line, and since the box is `justifyContent="flex-end"`,
  // the shortfall showed up as a gap at the TOP instead of the bottom —
  // reported directly as a blank area appearing even with a full screen of
  // text. This got much more visible once markdown rendering (below) started
  // inserting blank-line separators between blocks routinely, but it was
  // always a latent risk for any multi-line diff/status content too. A
  // single space renders as a real one-row-tall blank line instead.
  const asRow = (s: string) => s || " ";
  const visualRows = recentEntries.flatMap((line) => {
    const width = Math.max(10, columns);
    if (line.kind === "diff") {
      // Diff text carries its own embedded ANSI color codes (added/removed
      // lines) from formatDiff() — render it raw instead of through Ink's
      // `color` prop, which would clash with the codes already inside it.
      // Wrap with wrapAnsiSafe (not wrapToWidth): plain char-by-char
      // wrapping tears an escape sequence like `\x1b[32m` into individual
      // characters, corrupting it and miscounting its pieces as visible
      // glyphs — this was previously just left unwrapped entirely to dodge
      // that, which meant a long diff line could itself overflow the fixed
      // layout height (the same class of bug fixed everywhere else).
      return wrapAnsiSafe(line.text, width).map((wrapped, i) => (
        <Text key={`${line.id}-${i}`}>{asRow(wrapped)}</Text>
      ));
    }
    if (line.kind === "assistant") {
      // Reported directly: assistant text had no color/formatting at all,
      // unlike Claude Code's own terminal output — fenced code blocks,
      // bold, headings, lists all rendered as flat white text. Render
      // through marked-terminal for real markdown + syntax-highlighted
      // code, then wrap ANSI-safely for the same reason as the diff case
      // above (renderMarkdown's output is full of color codes).
      //
      // `width` is passed through to renderMarkdown itself now (used for
      // prose reflow — marked-terminal's own `width` option doesn't
      // actually apply to tables at all, see wrapPreservingTables below),
      // and the result goes through wrapPreservingTables rather than
      // plain wrapAnsiSafe — reported directly, with a screenshot: a
      // markdown table rendered with mangled, disjointed borders. See
      // wrapPreservingTables's own comment for the root cause; the short
      // version is that wrapping ANY table row, even ANSI-safely, still
      // destroys its visual structure, so a table row is clipped instead.
      return wrapPreservingTables(renderMarkdown(line.text, width), width).map((wrapped, i) => (
        <Text key={`${line.id}-${i}`}>{asRow(wrapped)}</Text>
      ));
    }
    // tool-call JSON, user echo, status messages: plain text, no ANSI of
    // their own, so the simpler char-width wrap is fine and cheaper.
    return wrapToWidth((line.kind === "user" ? "> " : "") + line.text, width).map((wrapped, i) => (
      <Text key={`${line.id}-${i}`} color={line.kind === "tool" ? "magenta" : "gray"}>
        {asRow(wrapped)}
      </Text>
    ));
  });

  // Content rows available to the log itself (as opposed to the menu, or
  // the one-row scroll indicator below) — reserving a row for the
  // indicator ahead of actually being scrolled (rather than only once
  // scrollOffset > 0) keeps maxScrollRef consistent regardless of current
  // scroll position, avoiding a circular "how much can I scroll depends on
  // whether I'm already scrolled" dependency.
  const scrollableContentRows = menuOpen ? Math.max(0, logHeight - menuBoxHeight) : Math.max(0, logHeight - 1);
  const maxScroll = Math.max(0, visualRows.length - scrollableContentRows);
  maxScrollRef.current = maxScroll;
  const clampedScroll = menuOpen ? 0 : Math.min(scrollOffset, maxScroll);
  const showScrollIndicator = !menuOpen && clampedScroll > 0;
  const contentRows = menuOpen ? scrollableContentRows : logHeight - (showScrollIndicator ? 1 : 0);
  const sliceEnd = visualRows.length - clampedScroll;
  const sliceStart = Math.max(0, sliceEnd - contentRows);

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {/* justifyContent="flex-end": when there's less content than
       *  `logHeight` rows (a short/early conversation), Ink's default
       *  top-alignment left it stuck at the top of this box with a growing
       *  gap of blank space below, all the way down to the input box —
       *  reported directly as text never reaching the bottom area. Anchor
       *  it to the bottom instead, so any leftover blank space sits above
       *  the content (like a normal scrolling terminal/chat view), and new
       *  lines are always right next to the input box, not far above it.
       *  This box's `height` is always exactly `logHeight`, whether the
       *  menu is open or not — only how much of that fixed space goes to
       *  log content vs. the menu vs. the scroll indicator changes. */}
      <Box flexDirection="column" height={logHeight} overflow="hidden" justifyContent="flex-end">
        {showScrollIndicator && (
          <Text dimColor>
            {`── ↑ scrolled up ${clampedScroll} line${clampedScroll === 1 ? "" : "s"} · ↓/PageDown to return to live ──`.slice(
              0,
              Math.max(10, columns)
            )}
          </Text>
        )}
        {visualRows.slice(sliceStart, sliceEnd)}
        {menuOpen && <SlashMenu items={filterMenuItems(input)} selectedIndex={menuIndex} />}
      </Box>

      {/* The prompt input lives INSIDE this bordered box, not below it —
       *  the border is the visible edge of the actual input area. */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} height={3} overflow="hidden">
        <Spinner active={busy} />
        <Text> {visibleInput}</Text>
      </Box>

      <StatusBar
        cwd={cwd}
        model={model}
        contextUsedRatio={contextUsedRatio}
        planProgress={planProgress}
        compactionStatus={compactionStatus}
        columns={columns}
      />
    </Box>
  );
}
