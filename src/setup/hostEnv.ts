/**
 * Host-environment questions that have more than one right answer depending on
 * the platform, gathered in one place so the answer is not re-derived — and
 * re-derived wrongly — at each call site.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Two of these were genuine bugs, both found by writing the bare-environment and
 * Windows harness rather than by reading the code:
 *
 *  - The home directory was read as `env.HOME`. On Windows `HOME` is normally
 *    **unset** — it is `USERPROFILE` — so every default derived from it became
 *    `/root/...` on a Windows box, a path that cannot exist there. And the
 *    fallback was a hardcoded POSIX root, so it did not fail loudly either; it
 *    produced a plausible-looking path that was simply wrong.
 *
 *  - The listening-port lookup shelled out to `ss -ltnp`. That is Linux-only.
 *    On Windows the command does not exist, the failure was caught, and the
 *    result was reported as "nothing is listening" — so a model switch would
 *    start a **second** server on an occupied port. A missing tool must never
 *    read as an empty port.
 *
 * Both are the same mistake: a platform-specific default that quietly degrades
 * into a wrong answer instead of an error.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The user's home directory.
 *
 *  `HOME` first because that is what the harness and the rest of the project
 *  inject, then `USERPROFILE` because that is what Windows sets, then
 *  `homedir()` as the last resort. Deliberately NOT a hardcoded `/root`: that
 *  turned a missing variable into a confidently wrong path. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Where models go when nothing says otherwise. Derived from `homeDir`, so it
 *  follows the platform instead of assuming a POSIX layout. */
export function defaultModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "models");
}

export type HostPlatform = NodeJS.Platform | "win32" | "linux" | "darwin";

/** The command that lists listening TCP sockets with their owning PIDs.
 *
 *  `ss` on Linux, `netstat -ano` on Windows. Returned as argv rather than a
 *  shell string so nothing is word-split or quoted by a shell that is not the
 *  one the syntax belongs to — `netstat`'s output is parsed, not interpreted. */
export function listeningPortsCommand(platform: HostPlatform = process.platform): {
  file: string;
  args: string[];
} {
  return platform === "win32"
    ? { file: "netstat", args: ["-ano"] }
    : { file: "ss", args: ["-ltnp"] };
}

/** How to read another process's command line.
 *
 *  procfs on Linux, `wmic` on Windows. `null` means "this platform has no way",
 *  and callers must treat that as *unknown* rather than as an empty string —
 *  an empty cmdline reads as "not a llama-server", which would classify a real
 *  server as foreign and make the switch refuse to act. */
export function readCmdlineCommand(
  platform: HostPlatform = process.platform
): { file: string; args: (pid: number) => string[] } | null {
  if (platform === "win32") {
    return { file: "wmic", args: (pid) => ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"] };
  }
  return null; // procfs — the caller reads /proc/<pid>/cmdline directly
}

/** True when this platform has a systemd user session.
 *
 *  Used to skip the systemd branch entirely rather than run `systemctl` and
 *  handle the "command not found" — on Windows there is no systemctl to find,
 *  and a probe that must be caught is a probe that will eventually not be. */
export function hasSystemd(platform: HostPlatform = process.platform): boolean {
  return platform === "linux";
}

/** The separator to use when PARSING `ss` output, which is colon-delimited on
 *  every platform. Kept as a named constant because a Windows path uses `\\`
 *  and mixing the two silently produces a wrong port. */
export const PORT_FIELD_SEPARATOR = ":";

