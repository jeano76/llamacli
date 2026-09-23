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
  /** Called when the user confirms Esc → Y ("force quit, saving progress to
   *  resume later"). Wired in index.tsx to: cancel the in-flight turn (if
   *  one is running) or save the current conversation (if idle) — either
   *  way writing a resumable checkpoint — and then actually exit the app
   *  (unmount + let the process end), skipping /quit's normal
   *  self-improvement-proposal gate entirely. That gate is a "review before
   *  you go" nicety; Esc is the emergency/quick exit and must never block
   *  on it. The checkpoint reuses the exact same mechanism a mid-batch
   *  compaction interruption already writes, so the next launch's startup
   *  resume-confirmation prompt (pendingResumeGoal below) picks it back up
   *  with no extra wiring. */
  onForceQuit: () => void;
  /** Loaded once at startup (index.tsx) from .llamacli/state/prompt-history.json
   *  — kept as the initial value here rather than App loading it itself, so
   *  App stays pure UI/presentation and all filesystem I/O stays in
   *  index.tsx, matching how config/rules/skills are already loaded there. */
  initialHistory: string[];
  /** Fires with the full updated history (already capped/deduped) every
   *  time a new prompt is submitted, so index.tsx can persist it. */
  onHistoryChange: (history: string[]) => void;
  /** The previous session's checkpoint goal (its one-line restatement of
   *  what the user originally asked for), if a checkpoint was sitting on
   *  disk when this session started — read in index.tsx before render, so
   *  the resume/discard question can be asked (and answered) right at
   *  startup instead of silently auto-resuming. `null` when there's
   *  nothing to ask about. */
  pendingResumeGoal: string | null;
  /** Called once the resume confirmation is answered: `true` resumes (via
   *  AgentLoop.resumeIfCheckpointExists(), same as before this prompt
   *  existed), `false` discards the checkpoint and starts fresh. */
  onResumeDecision: (resume: boolean) => void;
}

/** Every prompt actually submitted counts, whether it was sent immediately
 *  or queued while busy (see the Return-key handler below) — both are "the
 *  user submitted a prompt" from history's point of view. Caps at
 *  MAX_PROMPT_HISTORY and drops an exact-duplicate of the immediately
 *  preceding entry (retyping/resubmitting the same thing shouldn't spam
 *  history with repeats), same as a normal shell's history behaves. */
export const MAX_PROMPT_HISTORY = 50;
export function appendHistory(history: string[], text: string): string[] {
  if (history[history.length - 1] === text) return history;
  const next = [...history, text];
  return next.length > MAX_PROMPT_HISTORY ? next.slice(next.length - MAX_PROMPT_HISTORY) : next;
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

export function App({
  cwd,
  model,
  onSubmit,
  onSlashCommand,
  onForceQuit,
  initialHistory,
  onHistoryChange,
  pendingResumeGoal,
  onResumeDecision,
}: AppProps) {
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  // Esc opens this Y/N confirmation instead of quitting immediately — a
  // single stray keystroke shouldn't be able to kill the app (mid-turn or
  // not). While this is true, useInput intercepts every key as part of the
  // confirmation (see below) rather than normal typing/menu/etc.
  const [quitConfirmPending, setQuitConfirmPending] = useState(false);
  // Shown once at startup (initialized from the prop, which index.tsx only
  // sets when a checkpoint was actually found on disk) — intercepts input
  // the same way quitConfirmPending does, and is resolved before either the
  // user can start typing a real message or the auto-resume machinery
  // (AgentLoop.resumeIfCheckpointExists()) runs on its own.
  const [resumeConfirmPending, setResumeConfirmPending] = useState(!!pendingResumeGoal);
  // Prompt history (Up/Down arrow), most recent last — see appendHistory.
  // Loaded once from disk (initialHistory) and kept in sync locally after
  // that; onHistoryChange pushes each update back out for index.tsx to
  // persist, rather than App doing its own file I/O (see AppProps doc).
  const [history, setHistory] = useState<string[]>(initialHistory);
  // -1 = not currently browsing history (typing fresh). 0 = the most
  // recent entry, counting UP from the end of `history` as Up is pressed
  // repeatedly — matches a normal shell's history navigation direction.
  const [historyIndex, setHistoryIndex] = useState(-1);
  // What was actually typed before Up was first pressed, restored once
  // Down navigates back past the most recent history entry — otherwise
  // browsing history and then returning to "fresh" would silently discard
  // whatever partial text the user had already typed.
  const [historyDraft, setHistoryDraft] = useState("");
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

  // Echoes the startup resume question into the scrolling log as well as
  // showing it in the input box (see visibleInput below) — reported
  // directly: the input-box-only version wasn't visible on a real
  // terminal ("좌표 문제인듯" / "seems like a coordinate problem"). The
  // input box's text is positioned via delicate absolute-cursor math tied
  // to the terminal's reported size (see the cursor-positioning useEffect
  // further down); if that size is ever misdetected the single-line
  // question can end up genuinely off-screen or overwritten while the rest
  // of the app still looks fine. The log area uses a completely different,
  // independently-wrapped rendering path (wrapPreservingTables/wrapToWidth
  // below), so this guarantees the question is visible regardless of
  // whatever coordinate issue might affect the input box specifically.
  useEffect(() => {
    if (resumeConfirmPending) {
      pushLine(
        `이전 작업이 있습니다: "${pendingResumeGoal}"\n이어서 진행할까요? Y(예) / N(아니오) 를 입력해주세요.`,
        "status"
      );
    }
    // Runs once, at mount — resumeConfirmPending only ever starts true and
    // is answered exactly once per session (see useInput below), so there's
    // nothing to re-run this for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    // Startup resume question, answered before anything else can happen —
    // set once from pendingResumeGoal (index.tsx found a checkpoint on
    // disk before this ever rendered) and never re-armed after being
    // answered once, so it can't reappear mid-session.
    if (resumeConfirmPending) {
      const lower = char.toLowerCase();
      if (lower === "y") {
        setResumeConfirmPending(false);
        pushLine("[resuming previous work...]", "status");
        onResumeDecision(true);
      } else if (lower === "n" || key.escape) {
        setResumeConfirmPending(false);
        pushLine("[starting fresh — previous checkpoint discarded]", "status");
        onResumeDecision(false);
      }
      // any other key: still waiting for a real y/n answer — ignored.
      return;
    }

    // Esc → Y/N confirmation dialog, entered below. While it's showing,
    // every keystroke is consumed here (y/n/esc) rather than falling
    // through to the menu or normal typing — a stray key must never
    // silently quit the app, and must never silently leak into the input
    // box either.
    if (quitConfirmPending) {
      const lower = char.toLowerCase();
      if (lower === "y") {
        setQuitConfirmPending(false);
        pushLine("[force quitting — saving progress to resume later]", "status");
        onForceQuit();
      } else if (lower === "n" || key.escape) {
        setQuitConfirmPending(false);
      }
      // any other key: still waiting for a real y/n answer — ignored.
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

    // Esc (menu not open, no confirmation already showing) opens the force-
    // quit confirmation above — works at any time, not just while a turn is
    // running, so it doubles as a quick "get me out of here" independent of
    // /quit's normal self-improvement-review gate. Also echoed into the log
    // (not just the input box) for the same visibility reason as the
    // startup resume question above.
    if (key.escape) {
      setQuitConfirmPending(true);
      pushLine("강제 종료하시겠습니까? 진행 중인 작업은 저장되어 다음 실행 시 이어집니다.\nY(예) / N(아니오) 를 입력해주세요.", "status");
      return;
    }

    // PageUp/PageDown scroll the log a full screen at a time — unaffected
    // by the history repurposing below (Ink gives an empty `char` for
    // these, so the fallback append-to-input further down was already a
    // harmless no-op for them).
    if (key.pageUp || key.pageDown) {
      const amount = Math.max(1, logHeightRef.current - 1);
      const direction = key.pageUp ? 1 : -1;
      setScrollOffset((s) => Math.max(0, Math.min(maxScrollRef.current, s + amount * direction)));
      return;
    }

    // Plain Up/Down: prompt history, matching a normal shell. (Previously
    // these did line-by-line log scrollback — moved to PageUp/PageDown-only
    // above, since history is the far more commonly reached-for behavior
    // for arrow keys specifically, and Page Up/Down already covers
    // scrollback on its own.)
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      if (key.upArrow) {
        if (historyIndex >= history.length - 1) return; // already at the oldest entry
        if (historyIndex === -1) setHistoryDraft(input); // stash what was being typed
        const next = historyIndex + 1;
        setHistoryIndex(next);
        setInput(history[history.length - 1 - next]);
      } else {
        if (historyIndex === -1) return; // not currently browsing — nothing to go back to
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setInput(next === -1 ? historyDraft : history[history.length - 1 - next]);
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
      // Every actually-submitted prompt (sent now or queued) joins history —
      // see appendHistory's doc comment on why both count.
      setHistory((h) => {
        const next = appendHistory(h, input);
        onHistoryChange(next);
        return next;
      });
      setHistoryIndex(-1);
      setHistoryDraft("");
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
  // Shown next to the input any time it's not already showing one of the
  // confirmation dialogs below, so the quit path is discoverable without
  // having to already know the keybinding exists. Hidden below a
  // reasonable width rather than squeezing the input box to near-nothing
  // to make room for it on a narrow terminal.
  const ESC_HINT = " (Esc to quit)";
  const showEscHint = !quitConfirmPending && !resumeConfirmPending && columns >= 40;
  const QUIT_CONFIRM_TEXT = "강제 종료하시겠습니까? 진행 중인 작업은 저장되어 다음 실행 시 이어집니다. (Y/N)";
  const RESUME_CONFIRM_TEXT = pendingResumeGoal
    ? `이전 작업을 이어서 하시겠습니까? "${pendingResumeGoal}" (Y/N)`
    : "";
  const escHintWidth = showEscHint ? stringWidth(ESC_HINT) : 0;
  const visibleInput = resumeConfirmPending
    ? tailToWidth(RESUME_CONFIRM_TEXT, maxInputWidth)
    : quitConfirmPending
      ? tailToWidth(QUIT_CONFIRM_TEXT, maxInputWidth)
      : tailToWidth(input, Math.max(4, maxInputWidth - escHintWidth));

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
    if (line.kind === "user") {
      return wrapToWidth(`❯ ${line.text}`, width).map((wrapped, i) => (
        <Text key={`${line.id}-${i}`} color="cyan" bold>
          {asRow(wrapped)}
        </Text>
      ));
    }
    if (line.kind === "tool") {
      return wrapToWidth(`⚡ ${line.text}`, width).map((wrapped, i) => (
        <Text key={`${line.id}-${i}`} color="magenta">
          {asRow(wrapped)}
        </Text>
      ));
    }
    // status messages
    return wrapToWidth(line.text, width).map((wrapped, i) => (
      <Text key={`${line.id}-${i}`} color="gray">
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

  const inputBorderColor = quitConfirmPending || resumeConfirmPending
    ? "yellow"
    : busy
      ? "magenta"
      : input.length > 0
        ? "cyan"
        : "gray";

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
      <Box
        borderStyle="round"
        borderColor={inputBorderColor}
        paddingX={1}
        height={3}
        overflow="hidden"
      >
        <Spinner active={busy} />
        <Text color={quitConfirmPending || resumeConfirmPending ? "yellow" : undefined}> {visibleInput}</Text>
        {showEscHint && <Text dimColor>{ESC_HINT}</Text>}
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
