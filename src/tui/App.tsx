import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { SlashMenu, SLASH_MENU_ITEMS } from "./SlashMenu.js";
import { tailToWidth } from "./textWidth.js";

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
          line.id === streamingIdRef.current ? { ...line, text: line.text + text } : line
        );
      }
      const id = logIdCounter++;
      streamingIdRef.current = id;
      return [...prev, { id, text, kind: "assistant" }];
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
  // the real terminal, leaving ghosting when it shrank back down (the same
  // class of bug the slash menu had). Truncate to what actually fits
  // instead of ever letting the input Text wrap.
  const maxInputWidth = Math.max(10, columns - 4); // paddingX(2) + spinner(1) + leading space(1)
  const visibleInput = tailToWidth(input, maxInputWidth);

  // Ink finishes every render with the real terminal cursor sitting on a
  // blank line just below the last row it wrote (StatusBar) — it never
  // repositions the cursor back to where the user is actually typing. Since
  // desktop input methods (fcitx/ibus for Hangul, etc.) anchor their
  // composition popup to the REAL cursor position, not to anything Ink
  // renders, this left composed/typed characters appearing to land at the
  // bottom-left of the screen instead of in the prompt row. Move the cursor
  // back up onto the input row and to the exact column after the visible
  // text, and make sure it's shown, after every render.
  useEffect(() => {
    const promptColumn = 1 /* paddingX */ + 1 /* spinner */ + 1 /* leading space */ + stringWidth(visibleInput) + 1;
    // 2 rows up: 1 for StatusBar's own row, 1 for the blank trailer line
    // Ink's last write always ends on.
    process.stdout.write(`\x1b[2A\x1b[${promptColumn}G\x1b[?25h`);
  });
  // The slash menu (round border top+bottom + one line per item) adds rows
  // on top of the normal chrome (divider + input + status bar). Without
  // accounting for it, total rendered content exceeds the outer Box's fixed
  // `rows` height while the menu is open, which scrolls the real terminal —
  // and when the menu closes and the content shrinks back down, that scroll
  // doesn't cleanly undo, leaving stale content ("잔상") behind (PROMPT.md
  // §6 explicitly requires no ghosting/leftover artifacts on popup close).
  const menuHeight = menuOpen ? SLASH_MENU_ITEMS.length + 2 : 0;
  const logHeight = Math.max(3, rows - 6 - menuHeight);

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
      : [
          <Text
            key={line.id}
            color={line.kind === "assistant" ? "white" : line.kind === "tool" ? "magenta" : "gray"}
          >
            {line.kind === "user" ? "> " : ""}
            {line.text}
          </Text>,
        ]
  );

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Box flexDirection="column" height={logHeight} overflow="hidden">
        {visualRows.slice(-logHeight)}
      </Box>

      <Box borderStyle="single" borderColor="gray" />

      {menuOpen && <SlashMenu selectedIndex={menuIndex} />}

      <Box paddingX={1} height={1} overflow="hidden">
        <Spinner active={busy} />
        <Text> {visibleInput}</Text>
      </Box>

      <StatusBar cwd={cwd} model={model} contextUsedRatio={contextUsedRatio} columns={columns} />
    </Box>
  );
}
