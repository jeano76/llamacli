/**
 * Refusing to start a download the disk cannot hold, and finding a path that can.
 *
 * Requested directly: "파일 다운로드 전에 해당 파일시스템의 용량이 부족하면 유휴
 * 경로로 바꿀 수도 있도록 하는 기능도 추가해줘" — before downloading, if the
 * target filesystem is short on space, switch to an idle/alternative path.
 *
 * ── Why this must happen BEFORE the transfer ────────────────────────────────
 * The failure this prevents is quiet and destructive. A 20 GB download to a disk
 * with 2 GB free does not fail at the start; it fills the disk, and then:
 *
 *   - the download itself starts failing with ENOSPC, mid-transfer, leaving a
 *     partial `.part` file;
 *   - worse, OTHER things on the machine start failing first. tmpfs-backed /tmp
 *     is where this repo's clipboard fallback lives, and a full root filesystem
 *     takes down the whole session, not just the download;
 *   - and on a root-owned filesystem the user may not even be able to clean up
 *     without sudo.
 *
 * So the check is a precondition, not a progress-time retry. By the time
 * progress is being reported, the space is already gone.
 *
 * ── What "유휴 경로" means here ─────────────────────────────────────────────
 * A shortlist of directories to try, in preference order: the configured models
 * directory first, then the conventional ones on other filesystems. The first
 * one that can hold the file WINS. Nothing is chosen by guessing a mount point
 * — each candidate is measured with statfs, so a path on a big disk and a path
 * on a small one are distinguished by facts, and a candidate on the same
 * filesystem as the original is not counted as "somewhere else" (checking
 * available space on it would be measuring the same disk twice and would happily
 * "choose" a fallback that has exactly as little room as the original).
 */

import { statfs, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Free space wanted beyond the file itself, in bytes.
 *
 *  512 MiB, not 0. A download that fills a filesystem to exactly 100% leaves
 *  the system unable to write its own logs, temp files, or swap, and on a
 *  systemd-journald machine the failure can take the session down with it. The
 *  headroom is cheap: the alternative is a 20 GB transfer that has to be thrown
 *  away. */
export const RESERVE_BYTES = 512 * 1024 * 1024;

export interface DiskInfo {
  path: string;
  /** Free bytes on the FILESYSTEM holding `path`. */
  freeBytes: number;
  totalBytes: number;
}

export type Statfs = (path: string) => Promise<{ bsize: number; bavail: number; blocks: number }>;

/** statfs, adapted to the injected `Statfs` seam so the whole module is
 *  testable with fabricated filesystems and no real disk involved. */
export const realStatfs: Statfs = async (path) => {
  const s = await statfs(path);
  return { bsize: Number(s.bsize), bavail: Number(s.bavail), blocks: Number(s.blocks) };
};

/**
 * Free space on the filesystem containing `path`.
 *
 *  `bavail` rather than `bfree`: the difference is the root reserve, which a
 *  non-root user cannot touch. Using `bfree` would report a disk as having room
 *  that only root can actually use, and the download would then fail with
 *  ENOSPC partway through — the exact outcome this exists to prevent.
 *
 *  Walks UP to the nearest existing ancestor when the path itself does not exist
 *  yet, because a models directory is usually created BY this download. Asking
 *  statfs about a path that isn't there yet throws, and treating that as "no
 *  space" would make a perfectly empty disk look full.
 */
export async function diskInfoFor(path: string, statfsImpl: Statfs = realStatfs): Promise<DiskInfo> {
  let probe = path;
  for (;;) {
    try {
      const s = await statfsImpl(probe);
      return {
        path,
        freeBytes: s.bsize * s.bavail,
        totalBytes: s.bsize * s.blocks,
      };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        // Reached the root without finding anything stat-able. Report "no space"
        // so the caller refuses rather than starting a doomed transfer.
        return { path, freeBytes: 0, totalBytes: 0 };
      }
      probe = parent;
    }
  }
}

/** Conventional places to put a multi-gigabyte model, in preference order.
 *
 *  `~/models` first because it is where the existing installs on this machine
 *  already keep their GGUFs; the rest cover the usual separate-mount layouts
 *  (`/mnt`, `/media`, `/data`) that people create precisely because the root
 *  disk is too small. Duplicates and non-existent paths are handled by the
 *  caller, not here. */
export function candidateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? homedir();
  const list = [
    env.LLAMACLI_MODELS_DIR,
    join(home, "models"),
    join(home, ".cache", "llamacli", "models"),
    "/mnt/models",
    "/media/models",
    "/data/models",
  ].filter(Boolean) as string[];
  return [...new Set(list)];
}

/**
 * Mount points that look like real, separate filesystems, in the layout
 * desktops actually use.
 *
 * This exists because a fixed candidate list was not enough, and the machine
 * that motivated the feature proved it: its models live on an external drive at
 * `/media/<user>/<label>/models`, which matches neither `/mnt/models` nor
 * `/media/models`, so the "switch to a path with room" logic correctly refused
 * to download while a 55 GiB drive sat right there unused. Hardcoding a guess
 * about someone's mount layout is exactly the kind of thing that rots, so the
 * directories are read instead.
 *
 * Linux automounts removable media under `/media/$USER/<label>` and `/media/<label>`;
 * `/mnt/<name>` is the manual convention. Both are shallow, so a single readdir
 * level is enough. Injected for testability.
 */
export async function discoverMounts(
  opts: { readdir?: (path: string) => Promise<import("node:fs").Dirent[]>; env?: NodeJS.ProcessEnv } = {}
): Promise<string[]> {
  const readdir = opts.readdir ?? (async (p: string) => (await import("node:fs/promises")).readdir(p, { withFileTypes: true }));
  const out: string[] = [];
  const isDir = (d: import("node:fs").Dirent) => d.isDirectory() || d.isSymbolicLink();

  for (const base of ["/media", "/mnt"]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(base);
    } catch {
      continue; // not present on this platform
    }
    for (const entry of entries) {
      if (!isDir(entry) || entry.name.startsWith(".")) continue;
      const first = join(base, entry.name);
      out.push(join(first, "models"));
      // One level deeper: /media/<user>/<label>/ is the automount shape.
      let nested: import("node:fs").Dirent[];
      try {
        nested = await readdir(first);
      } catch {
        continue;
      }
      for (const inner of nested) {
        if (!isDir(inner) || inner.name.startsWith(".")) continue;
        out.push(join(first, inner.name, "models"));
      }
    }
  }
  return out;
}

export interface PathChoice {
  dir: string;
  info: DiskInfo;
  /** The directory that was originally asked for. */
  requested: string;
  /** True when a different directory was chosen. */
  switched: boolean;
  reason: string;
}

export interface SelectPathOptions {
  /** Where the caller wanted the file. */
  requestedDir: string;
  /** Bytes the file needs, plus the transfer's own headroom. */
  neededBytes: number;
  candidates?: string[];
  statfsImpl?: Statfs;
  env?: NodeJS.ProcessEnv;
  /** Create the chosen directory if it is missing. Off in tests. */
  create?: boolean;
  /** Also consider mounted volumes found by scanning /media and /mnt. On by
   *  default: a fixed candidate list missed the external drive this feature
   *  was written for, which is what made it refuse a download while 55 GiB sat
   *  unused two directories away. */
  discoverMounts?: boolean;
}

/**
 * Picks the first candidate directory that can hold `neededBytes`.
 *
 *  Returns the ORIGINAL directory (and `switched: false`) when it already fits —
 *  a fallback must never fire just because another disk happens to be bigger.
 *  That would quietly relocate a 20 GB model away from where the user put it
 *  and leave a stale copy behind.
 *
 *  When nothing fits, the original is still returned, with a reason that says so
 *  explicitly. The caller is expected to REFUSE the download in that case; this
 *  function does not silently proceed, because proceeding is what fills the disk.
 */
export async function selectModelPath(opts: SelectPathOptions): Promise<PathChoice> {
  const { requestedDir, neededBytes } = opts;
  const statfsImpl = opts.statfsImpl ?? realStatfs;
  const base = opts.candidates ?? candidateDirs(opts.env);
  // Explicitly-passed candidates are taken as the complete list (tests rely on
  // that to stay hermetic); otherwise real mounts are discovered and appended.
  const candidates =
    opts.candidates || opts.discoverMounts === false
      ? base
      : [...new Set([...base, ...(await discoverMounts({ env: opts.env }).catch(() => []))])];
  const create = opts.create ?? true;

  const requested = await diskInfoFor(requestedDir, statfsImpl);
  if (requested.freeBytes >= neededBytes) {
    return {
      dir: requestedDir,
      info: requested,
      requested: requestedDir,
      switched: false,
      reason: `${formatGiB(requested.freeBytes)} 여유 (필요 ${formatGiB(neededBytes)}) — 요청한 경로 사용`,
    };
  }

  // Need a different path. Only consider candidates on a DIFFERENT filesystem:
  // measuring a sibling directory on the same disk would report the same free
  // space and could "select" a fallback with exactly as little room.
  for (const dir of candidates) {
    if (dir === requestedDir) continue;
    const info = await diskInfoFor(dir, statfsImpl);
    if (info.totalBytes === requested.totalBytes && info.freeBytes === requested.freeBytes) {
      continue; // same filesystem, nothing gained
    }
    if (info.freeBytes < neededBytes) continue;
    if (create) {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        continue; // unwritable candidate — try the next one rather than failing
      }
    }
    return {
      dir,
      info,
      requested: requestedDir,
      switched: true,
      reason:
        `${requestedDir} 은 여유 ${formatGiB(requested.freeBytes)} 로 부족합니다 ` +
        `(필요 ${formatGiB(neededBytes)}). ${dir} 로 전환했습니다 (여유 ${formatGiB(info.freeBytes)}).`,
    };
  }

  return {
    dir: requestedDir,
    info: requested,
    requested: requestedDir,
    switched: false,
    reason:
      `여유 공간이 부족합니다: ${requestedDir} 에 ${formatGiB(requested.freeBytes)} 남음, ` +
      `필요 ${formatGiB(neededBytes)} (여유 확보 포함 ${formatGiB(RESERVE_BYTES)}). ` +
      `대체 경로 후보 ${candidates.length}곳을 모두 확인했지만 충분한 곳이 없습니다.`,
  };
}

/** Whether a choice has enough room to proceed. */
export function hasRoom(choice: PathChoice, neededBytes: number): boolean {
  return choice.info.freeBytes >= neededBytes;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
