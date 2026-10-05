/**
 * 업데이트 슬롯 — 되돌릴 곳.
 *
 * selfUpdate.ts의 이중 해시 검증은 "받은 것이 맞는 것"까지만 본다. 받아서
 * 푼 새 빌드가 실행 중에 죽으면(로드 실패·즉시 크래시) 해시는 멀쩡히 통과한
 * 채로 사용자는 깨진 프로그램만 갖는다. 그래서 교체 전에 지금 dist/ 전체를
 * 슬롯에 복사해 둔다 — 되돌리기는 "슬롯을 dist/에 통째로 복사해 되붓는 것" 한 동작이다.
 *
 * 슬롯은 최대 3개(VERSION_SLOTS). 그 이상은 디스크만 먹고, 되돌릴 일은
 * 언제나 "직전" 이다. 경로는 dist/의 형제(update-slots/) — dist/ 안에 두면
 * 다음 업데이트의 해시 대조가 슬롯까지 세는 일이 생긴다.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 살려두는 슬롯 수. 그 이상은 가장 오래된 것부터 지운다. */
export const VERSION_SLOTS = 3;

export function slotsRootFor(distDir: string): string {
  return join(distDir, "..", "update-slots");
}

function slotName(version: string | null, sha256: string): string {
  const safe = (version ?? "unknown").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "unknown";
  return `v-${safe}-${sha256.slice(0, 12)}`;
}

/**
 * 지금 dist/ 전체를 슬롯으로 복사한다. tmp 아카이브(.self-update-tmp-*)는
 * 빼고 복사한다 — 복원 뒤 다음 업데이트가 tmp를 슬롯에서 되살리는 일을 막는다.
 * 같은 버전 슬롯이 이미 있으면 덮지 않고 그대로 둔다(멱등).
 */
export async function saveSlot(
  distDir: string,
  opts: { version?: string | null; sha256?: string; slotsRoot?: string } = {}
): Promise<{ slot: string; created: boolean }> {
  const root = opts.slotsRoot ?? slotsRootFor(distDir);
  let localSha = opts.sha256 ?? "";
  if (!localSha) {
    try {
      localSha = (await readFile(join(distDir, ".self-update-sha256"), "utf8")).trim();
    } catch {
      localSha = "unknown";
    }
  }
  const name = slotName(opts.version ?? null, localSha);
  const dest = join(root, name);
  try {
    const st = await stat(dest);
    if (st.isDirectory()) return { slot: dest, created: false };
  } catch {
    // 없으면 만든다.
  }
  await mkdir(root, { recursive: true });
  await cp(distDir, dest, {
    recursive: true,
    filter: (src) => !src.includes(".self-update-tmp-"),
  });
  await pruneSlots(root);
  return { slot: dest, created: true };
}

/** newest-mtime 3개만 남긴다. */
export async function pruneSlots(slotsRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(slotsRoot);
  } catch {
    return [];
  }
  const withTime = await Promise.all(
    entries.map(async (e) => {
      try {
        return { e, mtime: (await stat(join(slotsRoot, e))).mtimeMs };
      } catch {
        return { e, mtime: 0 };
      }
    })
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const { e } of withTime.slice(VERSION_SLOTS)) {
    await rm(join(slotsRoot, e), { recursive: true, force: true });
    removed.push(e);
  }
  return removed;
}

/** 슬롯 목록 (최신순). 없으면 []. */
export async function listSlots(slotsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(slotsRoot);
    const withTime = await Promise.all(
      entries.map(async (e) => {
        try {
          return { e, mtime: (await stat(join(slotsRoot, e))).mtimeMs };
        } catch {
          return { e, mtime: 0 };
        }
      })
    );
    return withTime.sort((a, b) => b.mtime - a.mtime).map((x) => x.e);
  } catch {
    return [];
  }
}

/**
 * 슬롯 하나를 dist/에 통째로 복사해 되붓는다. dist/는 통째로 교체한다(남은 옛 파일이 새
 * 트리와 섞이면 "절반만 갱신" 상태가 된다): dist/를 지우고 슬롯을 복사한다.
 * 해시 기록 파일(.self-update-sha256 등)도 슬롯 안에 같이 있으므로, 복원된
 * dist/가 주장하는 버전과 기록이 어긋나지 않는다.
 */
export async function restoreSlot(
  distDir: string,
  slotName_: string,
  opts: { slotsRoot?: string } = {}
): Promise<{ ok: boolean; detail: string }> {
  const root = opts.slotsRoot ?? slotsRootFor(distDir);
  const src = join(root, slotName_);
  try {
    const st = await stat(src);
    if (!st.isDirectory()) return { ok: false, detail: `슬롯이 디렉터리가 아닙니다: ${slotName_}` };
  } catch {
    return { ok: false, detail: `슬롯이 없습니다: ${slotName_}` };
  }
  const entry = join(src, "index.js");
  try {
    await stat(entry);
  } catch {
    return { ok: false, detail: `슬롯에 진입 파일이 없습니다(index.js): ${slotName_} — 깨진 슬롯이라 복원하지 않습니다` };
  }
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(src, distDir, { recursive: true });
  // 슬롯은 남긴다 — 복원이 또 실패하면 다시 되돌릴 곳이 있어야 한다.
  return { ok: true, detail: `${slotName_} → dist/ 복원됨. 재시작하면 이전 버전으로 뜹니다.` };
}

/** 복원 뒤 기록을 남긴다 — 다음 시작이 "왜 옛 버전인지" 알게. */
export async function recordRestore(distDir: string, slotName_: string): Promise<void> {
  try {
    await writeFile(join(distDir, ".restored-from-slot"), `${slotName_}\n${new Date().toISOString()}\n`, "utf8");
  } catch {
    // 기록 실패가 복원을 무효로 하지 않는다.
  }
}
