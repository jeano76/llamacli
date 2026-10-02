import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, partPathOf } from "./download.js";
import { loadProgress, saveProgress, coveredBytes } from "./downloadProgress.js";

const TOTAL = 64 * 1024; // 64 KiB "model"

function rangedFetch(body: Buffer, opts: { interruptAfterBytes?: number } = {}) {
  const served = new Set<number>();
  let bytesServed = 0;
  return async (url: string, init?: any) => {
    const range = init?.headers?.Range as string | undefined;
    const m = range?.match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : body.length - 1;
    const chunk = body.subarray(start, end + 1);
    served.add(start);
    if (opts.interruptAfterBytes !== undefined) {
      bytesServed += chunk.length;
      if (bytesServed > opts.interruptAfterBytes) {
        // Simulate a network drop partway: the fetch rejects.
        throw new Error("simulated network drop");
      }
    }
    if (m) {
      return new Response(new Uint8Array(chunk), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": String(chunk.length),
        },
      } as any);
    }
    return new Response(new Uint8Array(chunk), {
      status: 200,
      headers: { "Content-Length": String(body.length) },
    } as any);
  };
}

test("an interrupted download is not mistaken for a complete one", async () => {
  // The scenario: a multi-hour model download is cut off partway (the whole
  // reason resumability matters). What does the NEXT run do with the .part?
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  try {
    const path = join(dir, "model.gguf");
    const body = Buffer.alloc(TOTAL, 0xab);

    // Run 1: fails partway through.
    await assert.rejects(
      downloadFile("http://x/m.gguf", path, {
        connections: 4,
        maxPartBytes: 8 * 1024,
        fetchImpl: rangedFetch(body, { interruptAfterBytes: 16 * 1024 }) as any,
      })
    );

    const part = partPathOf(path);
    const partStat = await stat(part).catch(() => null);
    assert.ok(partStat, "an interrupted download should leave a .part to resume from");
    assert.equal(partStat.size, TOTAL, "downloadRanges truncates the .part to full length up front");

    // Now the killer: does the next run treat that full-length .part as done?
    let promoted = false;
    await downloadFile("http://x/m.gguf", path, {
      connections: 4,
      maxPartBytes: 8 * 1024,
      fetchImpl: ((url: string, init?: any) => {
        promoted = true;
        return rangedFetch(body)(url, init);
      }) as any,
    });

    const finalBytes = await readFile(path);
    // If the incomplete .part was promoted, the file is full length but its
    // unwritten regions are SPARSE HOLES reading as zeros — a model that is the
    // right size, silently corrupt, with no error anywhere.
    const holes = finalBytes.filter((b) => b === 0).length;
    assert.equal(
      holes,
      0,
      `promoted file has ${holes} zero bytes of unwritten holes — a full-size but corrupt model, which is exactly the failure this must not allow`
    );
    assert.ok(finalBytes.equals(body), "the final file must be byte-exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resumed download only re-fetches the ranges the first run did not finish", async () => {
  // The real-world case, end to end: run 1 dies partway, run 2 picks up where it
  // stopped. The assertion is that run 2 does NOT re-request the ranges run 1
  // already landed -- otherwise a 20 GB model at ~3 h starts over every time.
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  try {
    const path = join(dir, "model.gguf");
    const body = Buffer.alloc(TOTAL, 0xab);
    const part = partPathOf(path);

    // Run 1: cut off after roughly half the segments.
    await assert.rejects(
      downloadFile("http://x/m.gguf", path, {
        connections: 4,
        maxPartBytes: 8 * 1024,
        fetchImpl: rangedFetch(body, { interruptAfterBytes: TOTAL / 2 }) as any,
      })
    );

    const state = await loadProgress(part, "http://x/m.gguf", TOTAL);
    assert.ok(state, "run 1 must have persisted progress to survive the crash");
    assert.ok(coveredBytes(state.ranges) > 0, "progress should record at least one finished range");
    assert.ok(coveredBytes(state.ranges) < TOTAL, "and it must NOT claim completion");

    const doneAfterFirst = state.ranges.map((r) => [r.start, r.end] as const);
    const requestedOnResume: [number, number][] = [];

    // Run 2: completes.
    await downloadFile("http://x/m.gguf", path, {
      connections: 4,
      maxPartBytes: 8 * 1024,
      fetchImpl: (async (url: string, init?: any) => {
        const range = init?.headers?.Range as string | undefined;
        const m = range?.match(/bytes=(\d+)-(\d+)/);
        // bytes=0-0 is the size probe, not a segment re-fetch.
        if (m && !(m[1] === "0" && m[2] === "0")) requestedOnResume.push([Number(m[1]), Number(m[2])]);
        return rangedFetch(body)(url, init);
      }) as any,
    });

    for (const [s2, e] of requestedOnResume) {
      const alreadyDone = doneAfterFirst.some(([ds, de]) => ds <= s2 && de >= e);
      assert.ok(!alreadyDone, `run 2 re-fetched ${s2}-${e}, which run 1 had already written`);
    }

    const finalBytes = await readFile(path);
    assert.ok(finalBytes.equals(body), "the resumed result must be byte-exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a .part with no state is re-fetched rather than trusted", async () => {
  // Bytes of unknown provenance cannot be promoted into a model file -- that is
  // the corruption this whole change exists to prevent. Re-fetching is the
  // expensive-but-correct answer.
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  try {
    const path = join(dir, "model.gguf");
    const body = Buffer.alloc(TOTAL, 0xab);
    await writeFile(partPathOf(path), body); // correct bytes, but no sidecar

    let fetchedSegments = 0;
    await downloadFile("http://x/m.gguf", path, {
      connections: 4,
      maxPartBytes: 8 * 1024,
      fetchImpl: (async (url: string, init?: any) => {
        const range = init?.headers?.Range as string | undefined;
        const m = range?.match(/bytes=(\d+)-(\d+)/);
        if (m && !(m[1] === "0" && m[2] === "0")) fetchedSegments++;
        return rangedFetch(body)(url, init);
      }) as any,
    });
    assert.ok(fetchedSegments > 0, "an untrusted .part must be re-fetched, not assumed complete");
    const finalBytes = await readFile(path);
    assert.ok(finalBytes.equals(body), "and the result must still be byte-exact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a state file for a DIFFERENT url is discarded", async () => {
  // The remote file changed, so the bytes on disk are no longer what is being
  // asked for. Trusting the old state would splice two different models.
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  try {
    const path = join(dir, "model.gguf");
    const part = partPathOf(path);
    const body = Buffer.alloc(TOTAL, 0xab);
    await saveProgress(part, { url: "http://other/m.gguf", totalBytes: TOTAL, ranges: [{ start: 0, end: TOTAL - 1 }], updatedAt: Date.now() });
    const loaded = await loadProgress(part, "http://x/m.gguf", TOTAL);
    assert.equal(loaded, null, "state for another url must not be adopted");

    await downloadFile("http://x/m.gguf", path, {
      connections: 2,
      maxPartBytes: 16 * 1024,
      fetchImpl: rangedFetch(body) as any,
    });
    const finalBytes = await readFile(path);
    assert.ok(finalBytes.equals(body), "the download must still produce the right bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
