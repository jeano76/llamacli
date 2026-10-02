import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAndApplyUpdate, UPDATE_STAGE_LABEL, type UpdateStage } from "./selfUpdate.js";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The self-update printed one banner and then went silent for the whole
 * download-and-install, so a slow step looked like a hang — and the window
 * BEFORE the manifest resolved printed nothing at all, which is exactly what a
 * frozen startup looks like. These pin the stage sequence, because "reports
 * something" is only useful if what it reports is true.
 */

function fixture(): { dir: string; tgz: Buffer; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "su-test-"));
  writeFileSync(join(dir, "hello.js"), "console.log('hi');");
  execFileSync("tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "hello.js"]);
  const tgz = readFileSync(join(dir, "a.tgz"));
  execFileSync("rm", [join(dir, "a.tgz"), join(dir, "hello.js")]);
  return { dir, tgz, sha: createHash("sha256").update(tgz).digest("hex") };
}

const manifestFetch = (sha: string) => (u: any) =>
  Promise.resolve(
    String(u).includes("manifest")
      ? new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 })
      : new Response("not the manifest", { status: 404 })
  );

test("every stage is announced, in order, and the update still installs", async () => {
  const { dir, tgz, sha } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), "0".repeat(64)); // an older build
  const seen: UpdateStage[] = [];
  const r = await checkAndApplyUpdate(dir, {
    fetchImpl: (async (u: any) =>
      String(u).includes("manifest")
        ? new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 })
        : new Response(new Uint8Array(tgz), { status: 200 })) as any,
    onStage: (n) => seen.push(n),
  });
  assert.equal(r.updated, true);
  // Order matters: a stage reported out of order would be a lie about what the
  // updater is doing.
  assert.deepEqual(seen, ["manifest", "download", "verify", "extract"]);
  assert.equal(readFileSync(join(dir, "hello.js"), "utf8"), "console.log('hi');");
});

test("the manifest stage fires BEFORE the fetch — that is the silent window", async () => {
  // The regression: nothing was printed until the manifest had resolved, so a
  // slow or unreachable GitHub produced total silence and read as a frozen
  // startup. Asserted by checking the stage landed before the request was ever
  // made, which is the only ordering that closes the window.
  const { dir, tgz, sha } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), "0".repeat(64));
  const seen: UpdateStage[] = [];
  let manifestBeforeFetch = false;
  await checkAndApplyUpdate(dir, {
    fetchImpl: (async (u: any) => {
      if (String(u).includes("manifest")) {
        // Sampled at the moment the request is made — if the stage had not fired
        // yet, this is false and the window is still open.
        manifestBeforeFetch = seen.includes("manifest");
        return new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 });
      }
      return new Response(new Uint8Array(tgz), { status: 200 });
    }) as any,
    onStage: (n) => seen.push(n),
  });
  assert.equal(manifestBeforeFetch, true, "the manifest stage must precede the manifest fetch");
  assert.equal(seen[0], "manifest", "and it must be the first thing reported");
});

test("elapsed time is reported and is non-decreasing", async () => {
  // A stage with no number reads as stalled whether or not it is. Monotonic
  // because a clock that goes backwards is worse than no clock.
  const { dir, tgz, sha } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), "0".repeat(64));
  const times: number[] = [];
  await checkAndApplyUpdate(dir, {
    fetchImpl: (async (u: any) => {
      if (String(u).includes("manifest")) return new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 });
      await new Promise((r) => setTimeout(r, 60));
      return new Response(new Uint8Array(tgz), { status: 200 });
    }) as any,
    onStage: (_n, ms) => times.push(ms),
  });
  assert.ok(times.length >= 4, `expected every stage timed, got ${times.length}`);
  assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), `times went backwards: ${times.join(",")}`);
  assert.ok(times[times.length - 1] >= 60, `the slow download must show in the clock, got ${times[times.length - 1]}ms`);
});

test("already-up-to-date reports only the manifest stage and installs nothing", async () => {
  // The overwhelmingly common case. The manifest stage has to be announced
  // before the fetch to close the silent window, which means it fires on every
  // startup — so it must be the ONLY one, and the caller erases it. A full
  // stage list here would mean downloading an update that does not exist.
  const { dir, tgz, sha } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), sha);
  const seen: UpdateStage[] = [];
  const r = await checkAndApplyUpdate(dir, {
    fetchImpl: (async (u: any) =>
      String(u).includes("manifest")
        ? new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 })
        : new Response(new Uint8Array(tgz), { status: 200 })) as any,
    onStage: (n) => seen.push(n),
  });
  assert.equal(r.updated, false);
  assert.match(r.reason, /already up to date/);
  assert.deepEqual(seen, ["manifest"], "no download/verify/extract when there is nothing to install");
});

test("a failed manifest fetch still announced the stage first", async () => {
  // Otherwise the failure mode is a hang with no output until the timeout, and
  // then an error the user never saw coming.
  const { dir } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), "0".repeat(64));
  const seen: UpdateStage[] = [];
  const r = await checkAndApplyUpdate(dir, {
    fetchImpl: (async () => {
      throw new Error("ENOTFOUND raw.githubusercontent.com");
    }) as any,
    onStage: (n) => seen.push(n),
  });
  assert.equal(r.updated, false);
  assert.deepEqual(seen, ["manifest"], "the stage must precede the request, so a failure is never silent");
});

test("every stage has a human label", async () => {
  // A stage name that renders as an enum value is the same "looks broken"
  // failure in a different font.
  for (const s of ["manifest", "download", "verify", "extract"] as UpdateStage[]) {
    const label = UPDATE_STAGE_LABEL[s];
    assert.ok(label && label.length > 2, `no label for ${s}`);
    assert.doesNotMatch(label, /^[a-z_]+$/, `label for ${s} looks like the raw key`);
  }
});

test("a corrupt archive fails the hash check without touching dist/", async () => {
  // The stage reporting must not have weakened the guard that matters: the
  // progress display is cosmetic, the refusal is not.
  const { dir, sha } = fixture();
  writeFileSync(join(dir, ".self-update-sha256"), "0".repeat(64));
  writeFileSync(join(dir, "keepme.js"), "original");
  const r = await checkAndApplyUpdate(dir, {
    fetchImpl: (async (u: any) =>
      String(u).includes("manifest")
        ? new Response(JSON.stringify({ version: "vX", sha256: sha }), { status: 200 })
        : new Response(new TextEncoder().encode("not the real archive"))) as any,
    onStage: () => {},
  });
  assert.equal(r.updated, false);
  assert.match(r.reason, /hash/i);
  assert.equal(readFileSync(join(dir, "keepme.js"), "utf8"), "original", "dist/ must be untouched");
});
