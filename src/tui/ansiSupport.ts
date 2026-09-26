/**
 * Reported directly: "llamacli 가 ansi 호환이 안되는 터미널 예를들면
 * 윈도우즈 cmd 나 wsl 창등에서는 깜빡이거나 특수문자가 프롬프트에 나타나는
 * 등의 문제가 있는거 같아" — index.tsx (alt-screen + mouse reporting) and
 * App.tsx (absolute cursor positioning + manual row clears) both wrote raw
 * ANSI escape sequences unconditionally, with no check that the terminal
 * on the other end actually interprets them. A terminal that doesn't
 * (legacy Windows cmd.exe without VT processing, output piped through
 * something that strips/mangles control sequences, a "dumb" TERM) shows
 * the escape bytes themselves as stray characters, and the alt-screen +
 * repeated cursor jumps read as flicker instead of a stable redraw.
 *
 * This is a best-effort heuristic, not a certainty (there is no portable
 * "does this terminal support ANSI" query) — so it's deliberately
 * conservative (assume NOT supported when unsure) and fully overridable
 * via environment variables for the cases it gets wrong either way.
 */
export function supportsAnsiTui(
  env: NodeJS.ProcessEnv = process.env,
  // Parameterized (rather than reading process.* directly) purely so this
  // is unit-testable without a real TTY/platform to run against.
  opts: { stdoutIsTTY?: boolean; stdinIsTTY?: boolean; platform?: NodeJS.Platform } = {}
): boolean {
  const stdoutIsTTY = opts.stdoutIsTTY ?? process.stdout.isTTY;
  const stdinIsTTY = opts.stdinIsTTY ?? process.stdin.isTTY;
  const platform = opts.platform ?? process.platform;

  if (env.LLAMACLI_FORCE_ANSI === "1") return true;
  if (env.LLAMACLI_NO_ANSI === "1" || env.NO_COLOR !== undefined) return false;

  // Not a real terminal at all (piped/redirected output, CI, etc.) — never
  // safe to emit escape sequences; there's nothing there to interpret them.
  if (!stdoutIsTTY || !stdinIsTTY) return false;

  if (env.TERM === "dumb") return false;

  // Node has auto-enabled ANSI VT processing on Windows' own conhost.exe
  // since ~v10, but that only covers the console conhost actually
  // negotiates with — plain cmd.exe windows launched in unusual ways, or a
  // WSL window whose parent console didn't get VT mode enabled, are a
  // known source of literal escape-code leakage in this environment
  // specifically (reported directly). Any of these env vars being present
  // is a reliable positive signal of a modern, ANSI-capable terminal
  // (Windows Terminal, VS Code, ConEmu/Cmder, most third-party emulators);
  // their absence on win32 is treated as "unknown, so don't risk it."
  if (platform === "win32") {
    const knownGoodTerminal =
      env.WT_SESSION !== undefined ||
      env.TERM_PROGRAM !== undefined ||
      env.ConEmuANSI === "ON" ||
      env.ANSICON !== undefined;
    if (!knownGoodTerminal) return false;
  }

  return true;
}
