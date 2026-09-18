import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { SlashMenu, SLASH_MENU_ITEMS } from "./SlashMenu.js";
import { tailToWidth, wrapToWidth } from "./textWidth.js";
import { stripToolCallTemplateLeak } from "../agent/textSanitize.js";

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

export function App({ cwd, model, onSubmit, onSlashCommand }: AppProps) {
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [contextUsedRatio, setContextUsedRatio] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // Messages typed while the agent is busy wait here instead of being sent
  // immediately; /queue inspects this list (PROMPT.md §6 message queue input).
  const [queue, setQueue] = useState<string[]>([]);
  const wasBusyRef = useRef(false);
  // Tracks which log line the currently-streaming assistant message is
  // appending to, so successive deltas mutate one line instead of spawning
  // a new one per chunk.
  const streamingIdRef = useRef<number | null>(null);

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
    if (menuOpen) {
      if (key.upArrow) setMenuIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMenuIndex((i) => Math.min(SLASH_MENU_ITEMS.length - 1, i + 1));
      else if (key.return) {
        const item = SLASH_MENU_ITEMS[menuIndex];
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
      }
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

  // The slash menu's row budget is now RESERVED PERMANENTLY, whether it's
  // open or not — rather than only occupying space while open. Two other
  // approaches were tried and both broke: (1) shrinking logHeight only
  // while the menu was open shifted everything below it (input box, status
  // bar) by up to ~10 rows in a single frame, and Ink's incremental diffing
  // didn't fully clear the old content at the shifted-from position,
  // leaving stale fragments visible right on the input box's border
  // (confirmed via a screen recording: a leftover "셀" on the border line
  // after closing the menu). (2) Rendering it as a `position="absolute"`
  // overlay to avoid that shift entirely turned out not to work either —
  // Ink 4.x's `position: absolute` only sets the Yoga position TYPE, not an
  // actual offset (no top/left/right/bottom style exists), and using
  // `marginTop` as a substitute pushed the menu's *output* below the
  // `overflow: hidden` boundary instead of clipping it, scrolling the real
  // terminal (confirmed by direct byte capture). Reserving fixed,
  // always-present space is less exciting but is the one approach that
  // makes "menu open/closed" purely a content change within a box whose
  // size never changes — nothing else can ever need to move because of it.
  const menuBoxHeight = SLASH_MENU_ITEMS.length + 2; // round border top+bottom
  // Fixed chrome below the log area: menu box + input box top border(1) +
  // content(1) + bottom border(1) + status bar(1).
  const logHeight = Math.max(3, rows - 4 - menuBoxHeight);

  // Absolute cursor positioning, reliable because index.tsx switches to the
  // terminal's alternate screen buffer before rendering (giving row 1 a
  // fixed, known meaning) and the app's total height is now provably
  // constant every frame regardless of menu state.
  useEffect(() => {
    const inputRow = logHeight + menuBoxHeight + 1 /* input box top border */ + 1; // 1-indexed content row
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
  const visualRows = recentEntries.flatMap((line) =>
    line.kind === "diff"
      ? // Diff text carries its own embedded ANSI color codes (added/removed
        // lines), so render it raw instead of through Ink's `color` prop,
        // which would wrap (and clash with) the codes already inside it.
        line.text.split("\n").map((rawLine, i) => <Text key={`${line.id}-${i}`}>{rawLine}</Text>)
      : // Any other line kind (tool-call JSON, assistant prose, status
        // messages) can be arbitrarily long — a tool call's full command
        // string routinely exceeds the terminal width. Wrap it ourselves so
        // every entry here really is one terminal row, matching what
        // `logHeight` assumes; otherwise Ink wraps it unaccounted-for,
        // silently using more real rows than budgeted (the same
        // overflow-then-ghosting class of bug already fixed for the input
        // line/status bar/slash menu — this is where it was still hiding).
        wrapToWidth(
          (line.kind === "user" ? "> " : "") + line.text,
          Math.max(10, columns)
        ).map((wrapped, i) => (
          <Text
            key={`${line.id}-${i}`}
            color={line.kind === "assistant" ? "white" : line.kind === "tool" ? "magenta" : "gray"}
          >
            {wrapped}
          </Text>
        ))
  );

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {/* justifyContent="flex-end": when there's less content than
       *  `logHeight` rows (a short/early conversation), Ink's default
       *  top-alignment left it stuck at the top of this box with a growing
       *  gap of blank space below, all the way down to the input box —
       *  reported directly as text never reaching the bottom area. Anchor
       *  it to the bottom instead, so any leftover blank space sits above
       *  the content (like a normal scrolling terminal/chat view), and new
       *  lines are always right next to the input box, not far above it. */}
      <Box flexDirection="column" height={logHeight} overflow="hidden" justifyContent="flex-end">
        {visualRows.slice(-logHeight)}
      </Box>

      {/* Always present at this fixed height, open or not — see the
       *  logHeight comment above for why. */}
      <Box flexDirection="column" height={menuBoxHeight} overflow="hidden">
        {menuOpen && <SlashMenu selectedIndex={menuIndex} />}
      </Box>

      {/* The prompt input lives INSIDE this bordered box, not below it —
       *  the border is the visible edge of the actual input area. */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} height={3} overflow="hidden">
        <Spinner active={busy} />
        <Text> {visibleInput}</Text>
      </Box>

      <StatusBar cwd={cwd} model={model} contextUsedRatio={contextUsedRatio} columns={columns} />
    </Box>
  );
}
