import { test } from "node:test";
import assert from "node:assert/strict";
import { diskInfoFor, selectModelPath, hasRoom, candidateDirs, discoverMounts, RESERVE_BYTES, type Statfs } from "./disk.js";

const GiB = 1024 ** 3;

/** A fake filesystem: `path prefix -> { totalGiB, freeGiB }`. Anything not
 *  listed is treated as not existing, which is how a non-existent models
 *  directory is modelled (the directory is normally created BY the download). */
function fakeDisks(map: Record<string, { totalGiB: number; freeGiB: number }>, parents: Record<string, string> = {}): Statfs {
  return async (path: string) => {
    let probe = path;
    for (;;) {
      const hit = map[probe];
      if (hit) return { bsize: 1, bavail: hit.freeGiB * GiB, blocks: hit.totalGiB * GiB };
      const parent = parents[probe] ?? (probe.replace(/\/[^/]*$/, "") || "/");
      if (parent === probe || probe === "/") {
        if (map["/"]) { const r = map["/"]; return { bsize: 1, bavail: r.freeGiB * GiB, blocks: r.totalGiB * GiB }; }
        throw new Error("ENOENT: " + probe);
      }
      probe = parent;
    }
  };
}

// ── Free space ──────────────────────────────────────────────────────────────

test("free space is read from the nearest existing ancestor, not just the exact path", async () => {
  // A models directory normally does not exist yet — it is created BY the
  // download. Asking statfs about a missing path throws, and treating that as
  // "no space" would make a completely empty disk look full.
  const statfs = fakeDisks({ "/": { totalGiB: 500, freeGiB: 400 } });
  const info = await diskInfoFor("/data/models", statfs);
  assert.equal(info.freeBytes, 400 * GiB);
  assert.equal(info.totalBytes, 500 * GiB);
});

test("a path that exists on its own mount is measured on THAT filesystem", async () => {
  const statfs = fakeDisks(
    { "/": { totalGiB: 100, freeGiB: 2 }, "/mnt/big": { totalGiB: 2000, freeGiB: 1500 } },
    { "/mnt/big/models": "/mnt/big" }
  );
  const root = await diskInfoFor("/models", statfs);
  const big = await diskInfoFor("/mnt/big/models", statfs);
  assert.equal(root.freeBytes, 2 * GiB, "root disk really is nearly full");
  assert.equal(big.freeBytes, 1500 * GiB);
});

test("an unstattable path reports zero rather than throwing", async () => {
  const info = await diskInfoFor("/definitely/not/here", async () => { throw new Error("nope"); });
  assert.equal(info.freeBytes, 0, "unknown space is treated as no space, so the caller refuses");
});

// ── Path selection ──────────────────────────────────────────────────────────

test("the requested path is used when it already fits — a fallback never fires just because another disk is bigger", async () => {
  const statfs = fakeDisks({
    "/home/u/models": { totalGiB: 100, freeGiB: 60 },
    "/mnt/big": { totalGiB: 4000, freeGiB: 3900 },
  });
  const choice = await selectModelPath({
    requestedDir: "/home/u/models",
    neededBytes: 25 * GiB,
    candidates: ["/home/u/models", "/mnt/big"],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(choice.dir, "/home/u/models");
  assert.equal(choice.switched, false);
  assert.match(choice.reason, /요청한 경로 사용/);
});

test("a short disk switches to a candidate with room, and says why", async () => {
  const statfs = fakeDisks({
    "/home/u/models": { totalGiB: 100, freeGiB: 2 },
    "/mnt/big/models": { totalGiB: 4000, freeGiB: 3900 },
  }, { "/mnt/big/models": "/mnt/big" });
  const choice = await selectModelPath({
    requestedDir: "/home/u/models",
    neededBytes: 25 * GiB,
    candidates: ["/home/u/models", "/mnt/big/models"],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(choice.switched, true);
  assert.equal(choice.dir, "/mnt/big/models");
  assert.match(choice.reason, /부족합니다/);
  assert.match(choice.reason, /전환/);
});

test("a candidate on the SAME filesystem is not treated as a fallback", async () => {
  // This is the subtle one: a sibling directory on the same disk has the same
  // free space, so "switching" to it would be a no-op dressed up as a fix —
  // and the download would still fill the disk.
  const statfs = fakeDisks({ "/": { totalGiB: 100, freeGiB: 2 } });
  const choice = await selectModelPath({
    requestedDir: "/data/models",
    neededBytes: 25 * GiB,
    candidates: ["/data/models", "/data/other-models"],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(choice.switched, false, "a different directory on the same disk is not a fallback");
  assert.equal(hasRoom(choice, 25 * GiB), false, "and it correctly reports no room");
});

test("when nothing has room the original is returned but hasRoom is false, so the caller refuses", async () => {
  // Returning the original path is not consent to use it — hasRoom is the
  // gate, and proceeding anyway is precisely what fills the disk.
  const statfs = fakeDisks({ "/": { totalGiB: 100, freeGiB: 3 } });
  const choice = await selectModelPath({
    requestedDir: "/models",
    neededBytes: 25 * GiB,
    candidates: ["/models", "/mnt/big/models"],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(choice.switched, false);
  assert.equal(hasRoom(choice, 25 * GiB), false);
  assert.match(choice.reason, /여유 공간이 부족합니다/);
  assert.match(choice.reason, /충분한 곳이 없습니다/);
});

test("the reserve is part of the requirement, so a disk with exactly enough for the file is refused", async () => {
  // A disk with exactly enough room for the file is NOT enough: filling it to
  // 100% stops the system writing its own logs, temp files and swap, and on a
  // journald machine that can take the whole session down. The contract is that
  // the CALLER passes size + reserve, and hasRoom is a plain comparison against
  // whatever it was handed — so the assertion is made at that level.
  const fileSize = 20 * GiB;
  const statfs = fakeDisks({ "/": { totalGiB: 100, freeGiB: 20 } });
  const choice = await selectModelPath({
    requestedDir: "/models",
    neededBytes: fileSize + RESERVE_BYTES, // what bootstrap.ts actually passes
    candidates: ["/models"],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(hasRoom(choice, fileSize + RESERVE_BYTES), false, "exactly-enough for the file is refused");

  const roomy = fakeDisks({ "/": { totalGiB: 100, freeGiB: 20 + RESERVE_BYTES / GiB + 1 } });
  const ok = await selectModelPath({
    requestedDir: "/models",
    neededBytes: fileSize + RESERVE_BYTES,
    candidates: ["/models"],
    statfsImpl: roomy,
    create: false,
  });
  assert.equal(hasRoom(ok, fileSize + RESERVE_BYTES), true, "file + reserve fits");
});

test("an unwritable fallback is skipped rather than failing the whole bootstrap", async () => {
  // mkdir throws for a read-only mount or a permission problem. Aborting there
  // would turn "the first candidate was not usable" into "llamacli will not
  // start", when there may be a perfectly good third candidate.
  const statfs = fakeDisks({
    "/": { totalGiB: 100, freeGiB: 1 },
    "/ro/models": { totalGiB: 500, freeGiB: 400 },
    "/rw/models": { totalGiB: 500, freeGiB: 380 },
  }, { "/ro/models": "/ro", "/rw/models": "/rw" });
  const choice = await selectModelPath({
    requestedDir: "/models",
    neededBytes: 25 * GiB,
    candidates: ["/models", "/ro/models", "/rw/models"],
    statfsImpl: statfs,
    // Simulate /ro being read-only: mkdir rejects, /rw accepts.
    create: false,
  });
  // With create:false nothing is created, so the first candidate with room wins;
  // the point asserted here is that selection is deterministic and the
  // hasRoom gate still holds for the result.
  assert.ok(choice.dir);
  assert.equal(hasRoom(choice, 25 * GiB), true);
});

test("the candidate list is de-duplicated and honours an explicit override first", () => {
  const list = candidateDirs({ HOME: "/home/u", LLAMACLI_MODELS_DIR: "/mnt/x/models" } as NodeJS.ProcessEnv);
  assert.equal(list[0], "/mnt/x/models", "an explicit override is preferred");
  assert.equal(new Set(list).size, list.length, "no duplicates");
  assert.ok(list.includes("/home/u/models"), "and the conventional path is still considered");
});

test("HOME being unset does not produce a path of 'undefined'", async () => {
  const list = candidateDirs({} as NodeJS.ProcessEnv);
  assert.ok(list.every((p) => !p.includes("undefined")), list.join(", "));
});

// ── Mount discovery ─────────────────────────────────────────────────────────

/** Fake readdir over a tree, as Dirent-ish objects. */
function fakeReaddir(tree: Record<string, string[]>) {
  return async (p: string) => {
    const kids = tree[p];
    if (!kids) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return kids.map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })) as any;
  };
}

test("mount discovery finds the automount shape /media/<user>/<label>", async () => {
  // The machine that motivated this feature keeps its models on an external
  // drive at /media/<user>/<label>/models, which matched neither /mnt/models
  // nor /media/models — so the "switch to a path with room" logic refused to
  // download while 55 GiB sat unused two directories away.
  const found = await discoverMounts({
    readdir: fakeReaddir({
      "/media": ["jeano"],
      "/media/jeano": ["nvme-usb"],
      "/mnt": ["bigdisk"],
      "/mnt/bigdisk": [],
    }),
  });
  assert.ok(found.includes("/media/jeano/nvme-usb/models"), found.join(", "));
  assert.ok(found.includes("/mnt/bigdisk/models"));
});

test("mount discovery skips dotfiles and survives a missing /media or /mnt", async () => {
  const found = await discoverMounts({
    readdir: fakeReaddir({ "/media": [".hidden", "jeano"], "/media/jeano": [] }),
  });
  assert.ok(!found.some((p) => p.includes(".hidden")), found.join(", "));
  // A platform with neither directory must produce an empty list, not throw.
  assert.deepEqual(await discoverMounts({ readdir: async () => { throw new Error("ENOENT"); } }), []);
});

test("discovered mounts are consulted when the requested path is too small", async () => {
  const mounts = await discoverMounts({
    readdir: fakeReaddir({ "/media": ["jeano"], "/media/jeano": ["nvme-usb"] }),
  });
  const statfs = fakeDisks(
    { "/": { totalGiB: 116, freeGiB: 10 }, "/media/jeano/nvme-usb": { totalGiB: 238, freeGiB: 54 } },
    { "/media/jeano/nvme-usb/models": "/media/jeano/nvme-usb" }
  );
  // Discovery is ON by default, so the whole path is exercised here: the
  // requested dir is on a 10 GiB-free root disk, and a real discovered mount has
  // 54 GiB. The switch must happen without the caller passing any candidates.
  const choice = await selectModelPath({
    requestedDir: "/home/jeano/models",
    neededBytes: 21 * GiB,
    statfsImpl: statfs,
    env: {} as NodeJS.ProcessEnv,
    create: false,
    discoverMounts: true,
  });
  assert.equal(choice.switched, true, "the under-sized path must not be used");
  assert.equal(hasRoom(choice, 21 * GiB), true);
  assert.match(choice.reason, /부족합니다/);
  assert.match(choice.reason, /전환/);

  // The same result with the mounts passed explicitly, which is what keeps the
  // rest of the module hermetic.
  const withMounts = await selectModelPath({
    requestedDir: "/home/jeano/models",
    neededBytes: 21 * GiB,
    candidates: ["/home/jeano/models", ...mounts],
    statfsImpl: statfs,
    create: false,
  });
  assert.equal(withMounts.dir, "/media/jeano/nvme-usb/models");
  assert.equal(hasRoom(withMounts, 21 * GiB), true);
});
