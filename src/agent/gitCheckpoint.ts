import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Aider-style git-first checkpointing: commit each successful file edit on
 *  its own, so a wrong change is `git diff HEAD~1` and a revert away. Opt-in
 *  (config.yaml `checkpoint: { git: true }`, default off) — auto-committing
 *  into a repo the user didn't ask for that in is a surprise, not a safety
 *  net, and llamacli already has its own non-git backup-before-overwrite for
 *  the case this is off. Best-effort throughout: a checkpoint failing must
 *  never fail or block the edit that triggered it. */
export interface GitCheckpointResult {
  committed: boolean;
  /** Short commit hash, when committed. */
  hash?: string;
  /** Why nothing was committed (not a git repo, file ignored, nothing
   *  changed, git itself failed) — for logging only, never shown to the
   *  model as an error. */
  reason?: string;
}

let repoRootCache: Map<string, string | null> | undefined;

async function findRepoRoot(cwd: string): Promise<string | null> {
  repoRootCache ??= new Map();
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd)!;
  let root: string | null = null;
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd, timeout: 5000 });
    root = stdout.trim() || null;
  } catch {
    root = null;
  }
  repoRootCache.set(cwd, root);
  return root;
}

/** Commits exactly `path` (relative to `projectRoot`, or absolute under it)
 *  with a short, machine-attributable message. No-ops outside a git repo,
 *  or when the path is gitignored, or when there is nothing to commit
 *  (content identical to HEAD). */
export async function gitCheckpoint(path: string, message: string, projectRoot: string): Promise<GitCheckpointResult> {
  const root = await findRepoRoot(projectRoot);
  if (!root) return { committed: false, reason: "not a git repository" };
  try {
    const ignored = await execAsync(`git check-ignore -q -- ${JSON.stringify(path)}`, { cwd: root }).then(
      () => true,
      () => false
    );
    if (ignored) return { committed: false, reason: "path is gitignored" };

    await execAsync(`git add -- ${JSON.stringify(path)}`, { cwd: root, timeout: 10_000 });
    const staged = await execAsync("git diff --cached --quiet -- " + JSON.stringify(path), { cwd: root }).then(
      () => false, // exit 0 = no staged diff = nothing to commit
      () => true // exit 1 = there IS a staged diff
    );
    if (!staged) return { committed: false, reason: "no change to commit" };

    await execAsync(
      `git commit --no-verify -m ${JSON.stringify(message)} -- ${JSON.stringify(path)}`,
      { cwd: root, timeout: 10_000, env: { ...process.env, GIT_AUTHOR_NAME: "llamacli", GIT_AUTHOR_EMAIL: "llamacli@local" } }
    );
    const { stdout } = await execAsync("git rev-parse --short HEAD", { cwd: root, timeout: 5000 });
    return { committed: true, hash: stdout.trim() };
  } catch (err: any) {
    return { committed: false, reason: String(err.message ?? err).slice(0, 200) };
  }
}

/** Test-only: clears the repo-root memo between runs against different dirs. */
export function resetGitCheckpointCacheForTests(): void {
  repoRootCache = undefined;
}
