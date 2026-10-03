import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { downloadFile, partPathOf, formatProgress, type TransferProgress } from "./download.js";
import { sha256File, normalizeSha256, ChecksumMismatchError } from "./checksum.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A range-capable fake origin. `body()` is evaluated per request so a test can make the
 *  origin change between attempts; `drops` makes the first N range requests fail. */
function origin(body: () => Buffer, o: { drops?: number } = {}) {
  let drops = o.drops ?? 0;
  const requests: { range?: string }[] = [];
  const fetchImpl = (async (_url: string, init?: any) => {
    const b = body();
    const range = init?.headers?.Range as string | undefined;
    requests.push({ range });
    const m = range?.match(/bytes=(\d+)-(\d+)/);
    if (m && Number(m[1]) > 0 && drops > 0) { drops--; throw new Error("simulated network drop"); }
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : b.length - 1;
    const chunk = b.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: m ? 206 : 200,
      headers: { ...(m ? { "Content-Range": `bytes ${start}-${end}/${b.length}` } : {}), "Content-Length": String(chunk.length) },
    } as any);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

async function tmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dlv-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const BODY = randomBytes(256 * 1024);

test("normalizeSha256 accepts the shapes the Hub and GitHub use, and nothing else", () => {
  const h = "a".repeat(64);
  assert.equal(normalizeSha256(h), h);
  assert.equal(normalizeSha256(`sha256:${h.toUpperCase()}`), h);
  assert.equal(normalizeSha256(`"${h}"`), h);
  assert.equal(normalizeSha256(`W/"${h}"`), h);
  assert.equal(normalizeSha256("abc"), null);
  assert.equal(normalizeSha256(undefined), null);
  assert.equal(normalizeSha256("a".repeat(63)), null);
});

test("sha256File hashes in a stream and reports progress", async () => {
  await tmp(async (dir) => {
    const p = join(dir, "f.bin");
    await writeFile(p, BODY);
    const seen: number[] = [];
    assert.equal(await sha256File(p, { onProgress: (x) => seen.push(x.hashedBytes), throttleMs: 0 }), sha(BODY));
    assert.equal(seen[seen.length - 1], BODY.length);
  });
});

test("a download whose hash matches is reported verified, and a .sha256 file is left beside it", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const o = origin(() => BODY);
    const r = await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, connections: 4, maxPartBytes: 32 * 1024, expectedSha256: `sha256:${sha(BODY)}` });
    assert.equal(r.sha256Verified, true);
    assert.equal(r.parallel, true);
    assert.equal(r.connections, 4, "large files are fetched over several connections");
    assert.deepEqual(await readFile(path), BODY);
    assert.equal((await readFile(`${path}.sha256`, "utf8")).trim(), `${sha(BODY)}  m.gguf`);
  });
});

test("the verify phase is reported on the same progress channel, as one line", async () => {
  await tmp(async (dir) => {
    const phases: TransferProgress[] = [];
    await downloadFile("http://x/m", join(dir, "m.gguf"), {
      fetchImpl: origin(() => BODY).fetchImpl, expectedSha256: sha(BODY), onProgress: (p) => phases.push(p),
    });
    const verify = phases.filter((p) => p.phase === "verify");
    assert.ok(verify.length > 0);
    assert.match(formatProgress(verify[verify.length - 1]), /100%.*SHA-256 검증 중/);
  });
});

test("a corrupted download is discarded, fetched again once, and the clean copy is accepted", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const bad = Buffer.from(BODY); bad[1000] ^= 0xff;
    let served = 0;
    // First full download returns damaged bytes of the right length; the retry gets the real ones.
    const o = origin(() => (served++ < 1 ? bad : BODY));
    const r = await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, connections: 1, expectedSha256: sha(BODY) });
    assert.equal(r.sha256Verified, true);
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("when the origin keeps serving different bytes it fails with a mismatch and leaves NO file behind", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const wrong = randomBytes(BODY.length);
    await assert.rejects(
      downloadFile("http://x/m", path, { fetchImpl: origin(() => wrong).fetchImpl, connections: 1, expectedSha256: sha(BODY) }),
      (e: unknown) => e instanceof ChecksumMismatchError && /일치하지 않습니다/.test((e as Error).message)
    );
    await assert.rejects(stat(path), "no unverified file may be left under the final name");
    await assert.rejects(stat(partPathOf(path)), "and no .part either");
  });
});

test("resume: an interrupted multi-connection download continues, and the finished file is verified", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const first = origin(() => BODY, { drops: 99 });
    await assert.rejects(downloadFile("http://x/m", path, { fetchImpl: first.fetchImpl, connections: 4, maxPartBytes: 32 * 1024, expectedSha256: sha(BODY) }));
    // The .part exists with whatever landed; the next run resumes from it.
    const second = origin(() => BODY);
    const r = await downloadFile("http://x/m", path, { fetchImpl: second.fetchImpl, connections: 4, maxPartBytes: 32 * 1024, expectedSha256: sha(BODY) });
    assert.equal(r.sha256Verified, true);
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("resume that stitched bytes from a CHANGED origin is caught by the hash, not shipped", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const v2 = Buffer.from(BODY); v2.fill(0x5a, 0, 64 * 1024); // the publisher re-uploaded the start of the file
    await assert.rejects(downloadFile("http://x/m", path, { fetchImpl: origin(() => BODY, { drops: 99 }).fetchImpl, connections: 4, maxPartBytes: 32 * 1024 }));
    // Later the origin serves v2, but the expected hash is v2's: the resumed mixture of v1 + v2 bytes must NOT pass.
    const r = await downloadFile("http://x/m", path, { fetchImpl: origin(() => v2).fetchImpl, connections: 4, maxPartBytes: 32 * 1024, expectedSha256: sha(v2) });
    assert.equal(r.sha256Verified, true, "after the discard-and-refetch the final file is exactly v2");
    assert.deepEqual(await readFile(path), v2);
  });
});

test("a complete file whose hash disagrees with the (here: bogus) publisher hash is NOT silently trusted, but the working file is never deleted", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    await writeFile(path, BODY);
    // The origin serves the same bytes, so a re-fetch cannot satisfy the bogus hash either: it must fail loudly...
    await assert.rejects(downloadFile("http://x/m", path, { fetchImpl: origin(() => BODY).fetchImpl, expectedSha256: "0".repeat(64), resumeFrom: BODY.length }), ChecksumMismatchError);
    // ...and the file that was already there is only ever replaced by a VERIFIED download.
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("no hash given: behaviour is unchanged and nothing claims to be verified", async () => {
  await tmp(async (dir) => {
    const r = await downloadFile("http://x/m", join(dir, "m.gguf"), { fetchImpl: origin(() => BODY).fetchImpl });
    assert.equal(r.sha256Verified, undefined);
  });
});

// ── an already-downloaded model is judged by its HASH, never re-downloaded for size or a lost sidecar ──

const bodyRequests = (o: { requests: { range?: string }[] }) => o.requests.filter((r) => r.range && r.range !== "bytes=0-0");

test("a file already under its final name whose hash matches: nothing is downloaded", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    await writeFile(path, BODY);
    const o = origin(() => BODY);
    const r = await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, expectedSha256: sha(BODY) });
    assert.equal(bodyRequests(o).length, 0, "only the one-byte probe touched the network");
    assert.equal(r.bytes, BODY.length);
  });
});

test("a same-size file with a DIFFERENT hash is not trusted: it is fetched anew and replaced", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    await writeFile(path, Buffer.alloc(BODY.length, 7)); // right size, wrong bytes
    const o = origin(() => BODY);
    const r = await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, connections: 2, maxPartBytes: 64 * 1024, expectedSha256: sha(BODY), stagingDir: join(dir, "tmp") });
    assert.equal(r.sha256Verified, true);
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("a full-length .part with NO resume sidecar is hashed and promoted, not re-downloaded", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const staging = join(dir, "tmp");
    const part = join(staging, "m.gguf.part");
    await (await import("node:fs/promises")).mkdir(staging, { recursive: true });
    await writeFile(part, BODY);
    const o = origin(() => BODY);
    const r = await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, expectedSha256: sha(BODY), stagingDir: staging });
    assert.equal(bodyRequests(o).length, 0, "the bytes were already there");
    assert.equal(r.sha256Verified, true);
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("a full-length .part that does NOT hash right (zero-filled regions) is discarded and fetched", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const staging = join(dir, "tmp");
    await (await import("node:fs/promises")).mkdir(staging, { recursive: true });
    await writeFile(join(staging, "m.gguf.part"), Buffer.alloc(BODY.length));
    const o = origin(() => BODY);
    await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, connections: 2, maxPartBytes: 64 * 1024, expectedSha256: sha(BODY), stagingDir: staging });
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("a full-length .part WITH an incomplete sidecar is a resume in progress: it is not hashed and discarded", async () => {
  await tmp(async (dir) => {
    const path = join(dir, "m.gguf");
    const staging = join(dir, "tmp");
    const part = join(staging, "m.gguf.part");
    await (await import("node:fs/promises")).mkdir(staging, { recursive: true });
    const half = BODY.length / 2;
    const bytes = Buffer.alloc(BODY.length); BODY.copy(bytes, 0, 0, half);
    await writeFile(part, bytes);
    await writeFile(`${part}.progress.json`, JSON.stringify({ url: "http://x/m", totalBytes: BODY.length, ranges: [{ start: 0, end: half - 1 }], updatedAt: 1 }));
    const o = origin(() => BODY);
    await downloadFile("http://x/m", path, { fetchImpl: o.fetchImpl, connections: 2, maxPartBytes: 64 * 1024, expectedSha256: sha(BODY), stagingDir: staging });
    assert.deepEqual(await readFile(path), BODY);
    const starts = bodyRequests(o).map((r) => Number(r.range!.match(/bytes=(\d+)/)![1]));
    assert.ok(starts.every((s) => s >= half), `only the missing half is requested, got ${starts}`);
  });
});
