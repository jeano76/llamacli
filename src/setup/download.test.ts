import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Transfer, formatBytes, formatEta, progressBar, formatProgress,
  parseContentRangeTotal, planRanges, downloadFile, downloadFiles, existingSize,
} from "./download.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "llamacli-dl-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A local server that serves `body` and honours Range requests, counting how
 *  many requests it saw and what byte-ranges were asked for. No network, no
 *  multi-GB fixtures — the point of the range-splitting tests is the
 *  arithmetic, not the throughput. */
async function withRangeServer(
  body: Buffer,
  fn: (info: { requests: string[]; peakConcurrency: () => number; port: number }) => Promise<void>
): Promise<void> {
  // The in-flight counter is held across a real DELAY, not just around
  // res.end(). A handler that buffers and ends synchronously never has more
  // than one request open at a time regardless of what the client does, so a
  // concurrency assertion measured that way would pass for a client that is in
  // fact fully serial. The delay is what makes overlap observable.
  const HOLD_MS = 40;
  let inFlight = 0;
  let maxConcurrent = 0;
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    const range = req.headers.range;
    requests.push(range ?? "(no range)");
    setTimeout(() => {
      inFlight--;
      if (range) {
        const m = /bytes=(\d+)-(\d+)?/.exec(range);
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(slice.length),
        });
        res.end(slice);
      } else {
        res.writeHead(200, {
          "Accept-Ranges": "bytes",
          "Content-Length": String(body.length),
        });
        res.end(body);
      }
    }, HOLD_MS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  // Exposed as a FUNCTION, not a value or a getter. A snapshot taken at
  // listen() time — or even one captured by the caller's destructuring, which
  // evaluates at call time, before the first request — reports the peak as 0
  // and makes a real concurrency assertion silently vacuous.
  try { await fn({ requests, peakConcurrency: () => maxConcurrent, port }); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

// ── Progress math ───────────────────────────────────────────────────────────

test("Transfer reports received bytes, a percent, and an ETA that shrinks as bytes arrive", () => {
  // Injectable clock: the rate math is the part that is easy to get subtly
  // wrong, and it must be testable without sleeping on a real download.
  let t = 0;
  const tr = new Transfer("model.gguf", 1000, () => t);
  assert.equal(tr.progress().percent, 0);
  assert.equal(tr.progress().etaSeconds, -1, "no rate yet => no ETA, not Infinity");

  t += 1000;
  tr.add(500);
  const mid = tr.progress();
  assert.equal(mid.receivedBytes, 500);
  assert.equal(mid.percent, 50);
  assert.ok(mid.bytesPerSecond > 0, "rate should be positive after 500 bytes in 1s");

  t += 1000;
  tr.add(500);
  const end = tr.progress();
  assert.equal(end.percent, 100);
  assert.equal(end.etaSeconds, 0, "nothing left => ETA 0");
});

test("Transfer.etaSeconds is -1 (not NaN/Infinity) when the server never revealed a size", () => {
  const tr = new Transfer("unknown", -1, () => 0);
  tr.add(10_000);
  const p = tr.progress();
  assert.equal(p.totalBytes, -1);
  assert.equal(p.percent, -1, "no total => no percent");
  assert.equal(p.etaSeconds, -1);
  assert.equal(p.receivedBytes, 10_000, "bytes are still reported even with no total");
});

test("Transfer.setTotal never lets the bar exceed 100% when a server under-reports the size", () => {
  const tr = new Transfer("m", 100, () => 0);
  tr.add(100);
  tr.setTotal(50); // a server reporting LESS than we already have
  assert.equal(tr.progress().percent, 100);
});

test("formatBytes uses binary units and never renders a negative or NaN value", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  assert.equal(formatBytes(-5), "?");
  assert.equal(formatBytes(NaN), "?");
});

test("formatEta renders mm:ss / h:mm:ss and shows 확인 중 when unknown", () => {
  assert.equal(formatEta(-1), "확인 중");
  assert.equal(formatEta(64), "1:04");
  assert.equal(formatEta(3723), "1:02:03");
});

test("progressBar is fixed width and handles an unknown percent", () => {
  assert.equal(progressBar(0, 10).length, 10);
  assert.equal(progressBar(100, 10).length, 10);
  assert.equal(progressBar(50, 10), "█████░░░░░");
  assert.equal(progressBar(-1, 10).trim(), "?", "unknown percent renders as ?");
});

test("formatProgress includes received/total, rate, and remaining time on one line", () => {
  const line = formatProgress({
    label: "Ornith.gguf", receivedBytes: 5_368_709_120, totalBytes: 21_864_081_056,
    bytesPerSecond: 40_000_000, etaSeconds: 412, percent: 24.6,
  }, 8);
  assert.match(line, /\[.{8}\]/);
  assert.match(line, /5\.0 GB \/ 20\.4 GB/);
  assert.match(line, /38\.1 MB\/s/);
  assert.match(line, /남은 시간 6:52/);
});

// ── Range arithmetic ────────────────────────────────────────────────────────

test("parseContentRangeTotal reads the total from a 206 Content-Range", () => {
  assert.equal(parseContentRangeTotal("bytes 0-0/12345", "1", 206), 12345);
  assert.equal(parseContentRangeTotal("bytes 10-20/999", null, 206), 999);
});

test("parseContentRangeTotal falls back to Content-Length for a 200 and to -1 for a chunked response", () => {
  assert.equal(parseContentRangeTotal(null, "777", 200), 777);
  assert.equal(parseContentRangeTotal(null, null, 200), -1);
  assert.equal(parseContentRangeTotal("bytes 0-0/*", null, 206), -1, "'*' total is unknown, not zero");
});

test("planRanges tiles [0,total) exactly — no gap, no overlap, no byte lost", () => {
  const total = 1000;
  const ranges = planRanges(total, 4, 1_000_000);
  assert.equal(ranges.length, 4);
  // The property that matters: concatenating every range reproduces the file.
  let expectedStart = 0;
  for (const r of ranges) {
    assert.equal(r.start, expectedStart, "range must start where the previous ended");
    assert.ok(r.end >= r.start, "range must be non-empty");
    expectedStart = r.end + 1;
  }
  assert.equal(expectedStart, total, "ranges must end exactly at total-1");
});

test("planRanges caps part size so a huge file is split even with few connections", () => {
  const ranges = planRanges(1000, 2, 100);
  assert.ok(ranges.length >= 10, `expected >=10 parts from the 100-byte cap, got ${ranges.length}`);
  let next = 0;
  for (const r of ranges) { assert.equal(r.start, next); next = r.end + 1; }
  assert.equal(next, 1000);
});

test("planRanges on an unknown size returns no ranges (caller falls back to single stream)", () => {
  assert.deepEqual(planRanges(-1, 8, 1024), []);
  assert.deepEqual(planRanges(1000, 0, 1024), []);
});

// ── Real parallel download against a local server ───────────────────────────

test("downloadFile fetches in parallel byte-ranges and writes a byte-exact file", () =>
  withTempDir(async (dir) => {
    // 256 KB of deterministic bytes — big enough to be split into many ranges,
    // small enough to be instant.
    const body = Buffer.alloc(256 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const dest = join(dir, "model.gguf");
    const progress: number[] = [];

    await withRangeServer(body, async ({ requests, port, peakConcurrency }) => {
      const result = await downloadFile(`http://127.0.0.1:${port}/model.gguf`, dest, {
        connections: 4,
        maxPartBytes: 16 * 1024, // force many segments
        onProgress: (p) => progress.push(p.receivedBytes),
      });
      assert.equal(result.parallel, true, "server supports ranges => parallel path taken");
      assert.ok(requests.length > 4, `expected several range requests, saw ${requests.length}`);
      assert.ok(requests.some((r) => r !== "(no range)"), "must have used Range headers");
      // The actual point of the feature: more than one request genuinely in
      // flight at the same time, not merely more than one request made.
      assert.ok(peakConcurrency() > 1, `expected concurrent range requests, saw max ${peakConcurrency()}`);
      // Byte-exactness is the whole point: a one-byte gap/overlap would produce
      // a 22 GB model that fails to load with no obvious cause.
      const got = await readFile(dest);
      assert.equal(got.length, body.length);
      assert.ok(got.equals(body), "downloaded bytes must equal the source exactly");
    });

    const sizes = await existingSize(dest);
    assert.equal(sizes, body.length);
    assert.ok(progress.length >= 1);
  }));

test("downloadFile is idempotent: a second run on a complete file does not re-download", () =>
  withTempDir(async (dir) => {
    const body = Buffer.alloc(8 * 1024, 7);
    const dest = join(dir, "model.gguf");
    await withRangeServer(body, async ({ requests, port }) => {
      await downloadFile(`http://127.0.0.1:${port}/m.gguf`, dest, { connections: 2, maxPartBytes: 1024 });
      const afterFirst = requests.length;
      const again = await downloadFile(`http://127.0.0.1:${port}/m.gguf`, dest, { connections: 2, maxPartBytes: 1024 });
      assert.equal(again.bytes, body.length);
      // The point of this test: re-running bootstrap (which happens on every
      // launch) must not refetch 22 GB that is already on disk.
      assert.equal(requests.length, afterFirst + 1, "only the size probe should hit the network");
    });
  }));

test("downloadFile falls back to a single stream when the server ignores Range", () =>
  withTempDir(async (dir) => {
    const body = Buffer.alloc(4 * 1024, 3);
    const dest = join(dir, "model.gguf");
    // This server NEVER honours Range — it always answers 200 with the whole
    // body, which is what several CDNs/proxies do.
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const result = await downloadFile(`http://127.0.0.1:${port}/m.gguf`, dest, { connections: 8 });
      assert.equal(result.parallel, false, "no range support => single stream");
      const got = await readFile(dest);
      assert.ok(got.equals(body), "single-stream body must still be written correctly");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));

test("downloadFile leaves a .part file and does not produce a truncated file when a segment fails", () =>
  withTempDir(async (dir) => {
    const body = Buffer.alloc(32 * 1024, 1);
    const dest = join(dir, "model.gguf");
    const server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
      // Fail any range that is NOT the initial one-byte probe, to simulate a
      // CDN that accepts the probe and then drops a real segment.
      //
      // Failing the probe instead would be a different test entirely: a probe
      // that 500s is read as "this server does not support ranges", and the
      // single-stream fallback is then the CORRECT behaviour — there is nothing
      // to assert about a half-written parallel file.
      const isProbe = req.headers.range === "bytes=0-0";
      if (!isProbe && req.headers.range) { res.writeHead(500); res.end("boom"); return; }
      const s = Number(m?.[1] ?? 0);
      const e = m?.[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(req.headers.range ? 206 : 200, {
        "Content-Range": `bytes ${s}-${e}/${body.length}`,
        "Content-Length": String(body.length - s),
      });
      res.end(body.subarray(s, e + 1));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      await assert.rejects(
        () => downloadFile(`http://127.0.0.1:${port}/m.gguf`, dest, { connections: 2, maxPartBytes: 8 * 1024 }),
        /500|failed|returned HTTP/i,
        "a failed segment must surface an error, not a silently short file"
      );
      // Crucially the destination must NOT exist as a complete-looking file:
      assert.equal(await existingSize(dest), 0, "no partial file left at the final path");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));

// ── Multi-file ──────────────────────────────────────────────────────────────

test("downloadFiles fetches multiple files concurrently and aggregates one progress total", () =>
  withTempDir(async (dir) => {
    const bodies = [Buffer.alloc(4 * 1024, 1), Buffer.alloc(6 * 1024, 2), Buffer.alloc(2 * 1024, 3)];
    // Delay each response so overlapping requests are actually observable — see
    // withRangeServer's note on why a synchronous handler cannot measure this.
    let maxConcurrent = 0;
    let inFlight = 0;
    const server = createServer((req, res) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      setTimeout(() => {
        inFlight--;
        const idx = Number((req.url ?? "/0").slice(1));
        const body = bodies[idx] ?? bodies[0];
        const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
        if (req.headers.range) {
          const s = Number(m?.[1] ?? 0), e = m?.[2] ? Number(m[2]) : body.length - 1;
          res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${body.length}` });
          res.end(body.subarray(s, e + 1));
        } else {
          res.writeHead(200, { "Content-Length": String(body.length) });
          res.end(body);
        }
      }, 40);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const dests = bodies.map((_, i) => join(dir, `f${i}.bin`));
      const last: { received: number; total: number }[] = [];
      const result = await downloadFiles(
        dests.map((p, i) => ({ url: `http://127.0.0.1:${port}/${i}`, path: p })),
        { connections: 2, maxPartBytes: 1024, fileConcurrency: 3, onProgress: (p) => last.push({ received: p.receivedBytes, total: p.totalBytes }) }
      );
      assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors}`);
      assert.equal(result.results.length, 3);
      // Aggregate total = sum of all three (4+6+2 KB), and the final progress
      // should have received all of it.
      const sum = bodies.reduce((n, b) => n + b.length, 0);
      assert.equal(result.totalBytes, sum);
      const final = last[last.length - 1];
      assert.equal(final.received, sum, "aggregate progress must count every byte once");
      assert.equal(final.total, sum);
      // Files actually downloaded concurrently, not serially.
      assert.ok(maxConcurrent > 1, `expected concurrent file fetches, saw max ${maxConcurrent}`);
      for (let i = 0; i < dests.length; i++) {
        const got = await readFile(dests[i]);
        assert.ok(got.equals(bodies[i]), `file ${i} must be byte-exact`);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));

test("downloadFiles reports which files failed without discarding the ones that succeeded", () =>
  withTempDir(async (dir) => {
    const good = Buffer.alloc(2 * 1024, 9);
    const server = createServer((req, res) => {
      if ((req.url ?? "").includes("missing")) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Length": String(good.length) });
      res.end(good);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const result = await downloadFiles([
        { url: `http://127.0.0.1:${port}/good`, path: join(dir, "good.bin") },
        { url: `http://127.0.0.1:${port}/missing`, path: join(dir, "missing.bin") },
      ], { connections: 1, fileConcurrency: 2 });
      assert.equal(result.errors.length, 1, "the 404 must be reported");
      assert.equal(result.results.length, 1, "the good file still completed");
      assert.ok((await readFile(join(dir, "good.bin"))).equals(good));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));

test("downloadFiles skips a file that is already complete instead of re-downloading it", () =>
  withTempDir(async (dir) => {
    const body = Buffer.alloc(3 * 1024, 5);
    const path = join(dir, "already.bin");
    await writeFile(path, body); // pretend a previous run finished it
    // A well-behaved server, because the skip decision is made from the SIZE it
    // reports: a server that can't answer the size probe has told us nothing to
    // compare against, and re-downloading is then correct rather than a bug.
    let bodyBytes = 0;
    const server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
      if (req.headers.range) {
        const s = Number(m?.[1] ?? 0), e = m?.[2] ? Number(m[2]) : body.length - 1;
        res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${body.length}` });
        res.end(body.subarray(s, e + 1));
        return;
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      bodyBytes += body.length;
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const result = await downloadFiles([{ url: `http://127.0.0.1:${port}/x`, path }], { connections: 1 });
      assert.equal(result.skippedComplete, 1, "complete file must be skipped");
      assert.equal(result.errors.length, 0);
      assert.equal(bodyBytes, 0, "no body should have been transferred");
      assert.ok((await readFile(path)).equals(body), "and the file is left untouched");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));

test("downloadFiles recognises a completed download staged as a .part file", () =>
  withTempDir(async (dir) => {
    const body = Buffer.alloc(3 * 1024, 6);
    const path = join(dir, "staged.bin");
    // A run that died between writing the last byte and the rename leaves the
    // bytes in the .part file. Re-running must treat that as done rather than
    // fetching 22 GB again — and must then finish the job by renaming it into
    // place, so the file is actually usable afterwards.
    await writeFile(`${path}.part`, body);
    const server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? "");
      if (req.headers.range) {
        const s = Number(m?.[1] ?? 0), e = m?.[2] ? Number(m[2]) : body.length - 1;
        res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${body.length}` });
        res.end(body.subarray(s, e + 1));
        return;
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const result = await downloadFiles([{ url: `http://127.0.0.1:${port}/x`, path }], { connections: 1 });
      assert.equal(result.skippedComplete, 1, "a complete .part counts as done");
      assert.equal(result.errors.length, 0);
      assert.ok((await readFile(path)).equals(body), "and it is promoted to the final path");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));
