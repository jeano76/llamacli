/**
 * Ink 4 reads `CI` once, when it is imported: in a CI-flagged environment (`CI=true`, `GITHUB_ACTIONS`, …) it stops
 * redrawing and prints only the final frame — an interactive TUI then shows nothing but the startup text until it exits.
 * `CI` is set in more places than build servers (dev containers, some shells, `act`, test harnesses), and llamacli's
 * screen is always interactive when stdout is a terminal. Ink honours an explicit `CI=false`, so this module — which
 * must be the FIRST import of the entry file, so it runs before `ink` is evaluated — sets it for the import and
 * `restoreCi()` puts the real value back so the shell commands the agent runs still see the user's environment.
 * (Found by the TUI smoke test on a GitHub Actions runner.)
 */
/** Sets CI=false on a terminal and returns what it replaced (pure over `env` so it can be tested). */
export function applyCiOverride(env: NodeJS.ProcessEnv, isTTY: boolean): string | undefined {
  const before = env.CI;
  if (isTTY) env.CI = "false";
  return before;
}

export function restoreCiValue(env: NodeJS.ProcessEnv, original: string | undefined): void {
  if (original === undefined) delete env.CI;
  else env.CI = original;
}

export const originalCi: string | undefined = applyCiOverride(process.env, Boolean(process.stdout.isTTY));

export function restoreCi(): void {
  restoreCiValue(process.env, originalCi);
}
