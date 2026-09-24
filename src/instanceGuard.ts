import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

/** Other llamacli processes running in the same project directory.
 *
 *  Reported live: the user "restarted" llamacli, but the old process (whose
 *  quit was still waiting on its running turn) kept going, and the session
 *  on screen was still the old build. Two sessions in one project also
 *  share the project's checkpoint and prompt-history files. Found by
 *  scanning /proc rather than a lock file, so it also catches processes
 *  started by builds that never wrote one. Linux only; elsewhere returns []. */
export function findOtherInstances(projectRoot: string, selfPid: number, selfScript: string): number[] {
  if (process.platform !== "linux") return [];
  const self = realpathOrNull(selfScript);
  if (!self) return [];
  const root = realpathOrNull(projectRoot) ?? projectRoot;
  const found: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== root) continue;
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.slice(1).some((arg) => arg && realpathOrNull(arg) === self)) found.push(pid);
    } catch {
      // exited meanwhile, or not ours to inspect
    }
  }
  return found;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // An exited process its parent hasn't reaped yet (a zombie) still
  // answers signal 0, but it's gone for our purposes.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** SIGTERM (the old process's handler restores its terminal and exits),
 *  then SIGKILL if it's still around after `graceMs`. Resolves true once
 *  the process is gone. */
export async function terminateInstance(pid: number, graceMs = 5000): Promise<boolean> {
  const waitGone = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !isAlive(pid);
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }
  if (await waitGone(graceMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  return waitGone(2000);
}
