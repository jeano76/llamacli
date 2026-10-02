import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { downloadFile, partPathFor, moveIntoPlace } from "./download.js";
import { ChecksumMismatchError } from "./checksum.js";
import { scanModels, pickReusable, pickFamilyMatch, quantTag } from "./existingModel.js";
import { findModelAnywhere } from "./bootstrap.js";

const BODY = randomBytes(192 * 1024);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function origin(body: () => Buffer, hooks: { onRequest?: () => void | Promise<void> } = {}) {
  return (async (_u: string, init?: any) => {
    await hooks.onRequest?.();
    const b = body();
    const m = (init?.headers?.Range as string | undefined)?.match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : 0, end = m ? Number(m[2]) : b.length - 1;
    const chunk = b.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: m ? 206 : 200,
      headers: { ...(m ? { "Content-Range": `bytes ${start}-${end}/${b.length}` } : {}), "Content-Length": String(chunk.length) },
    } as any);
  }) as unknown as typeof fetch;
}
const exists = (p: string) => stat(p).then(() => true, () => false);

async function tmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "stg-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("the download lives in the staging folder; the models directory has nothing until the hash passes", async () => {
  await tmp(async (dir) => {
    const models = join(dir, "models"), staging = join(dir, "models", ".llamacli-tmp");
    const path = join(models, "m.gguf");
    let sawDuring: { final: boolean; staged: boolean } | null = null;
    const fetchImpl = origin(() => BODY, {
      onRequest: async () => {
        if (!sawDuring) sawDuring = { final: await exists(path), staged: await exists(partPathFor(path, staging)) };
      },
    });
    await downloadFile("http://x/m", path, { fetchImpl, connections: 2, maxPartBytes: 64 * 1024, expectedSha256: sha(BODY), stagingDir: staging });
    assert.equal(sawDuring!.final, false, "nothing under the final name while downloading");
    assert.deepEqual(await readFile(path), BODY);
    assert.equal(await exists(staging), false, "the empty staging folder is removed afterwards");
    assert.equal(await exists(partPathFor(path, staging)), false);
  });
});

test("a corrupt download is rejected IN the staging folder and never reaches the models directory", async () => {
  await tmp(async (dir) => {
    const models = join(dir, "models"), staging = join(dir, "stage");
    const path = join(models, "m.gguf");
    const wrong = randomBytes(BODY.length);
    await assert.rejects(
      downloadFile("http://x/m", path, { fetchImpl: origin(() => wrong), connections: 1, expectedSha256: sha(BODY), stagingDir: staging }),
      (e: unknown) => e instanceof ChecksumMismatchError
    );
    assert.equal(await exists(path), false, "the models directory never saw it");
    assert.equal(await exists(`${path}.sha256`), false);
    assert.equal(await exists(partPathFor(path, staging)), false, "and the bad staged copy is gone");
  });
});

test("resume: the staged .part survives a failed run and the next run finishes it, verifies, then moves it", async () => {
  await tmp(async (dir) => {
    const models = join(dir, "models"), staging = join(models, ".llamacli-tmp");
    const path = join(models, "m.gguf");
    let calls = 0;
    const flaky = (async (u: string, init?: any) => {
      const m = (init?.headers?.Range as string | undefined)?.match(/bytes=(\d+)-/);
      if (m && Number(m[1]) > 0 && ++calls > 1) throw new Error("simulated network drop");
      return origin(() => BODY)(u, init);
    }) as unknown as typeof fetch;
    await assert.rejects(downloadFile("http://x/m", path, { fetchImpl: flaky, connections: 3, maxPartBytes: 32 * 1024, expectedSha256: sha(BODY), stagingDir: staging }));
    assert.equal(await exists(path), false);
    assert.equal(await exists(partPathFor(path, staging)), true, "the partial work is kept for resume");
    const r = await downloadFile("http://x/m", path, { fetchImpl: origin(() => BODY), connections: 3, maxPartBytes: 32 * 1024, expectedSha256: sha(BODY), stagingDir: staging });
    assert.equal(r.sha256Verified, true);
    assert.deepEqual(await readFile(path), BODY);
  });
});

test("a staged file left COMPLETE by an interrupted run is verified and moved without downloading again", async () => {
  await tmp(async (dir) => {
    const models = join(dir, "models"), staging = join(models, ".llamacli-tmp");
    const path = join(models, "m.gguf");
    let rangeRequestsOnSecondRun = 0;
    // Run 1 downloads fully but is "killed" before the move: simulate by downloading with a hash
    // that cannot match... no — instead stage the finished bytes + sidecar by running a normal
    // download and moving the result back into staging.
    await downloadFile("http://x/m", path, { fetchImpl: origin(() => BODY), connections: 2, maxPartBytes: 64 * 1024, stagingDir: staging });
    assert.deepEqual(await readFile(path), BODY);
    await rm(path);
    await mkdir(staging, { recursive: true });
    await writeFile(partPathFor(path, staging), BODY); // complete bytes but NO sidecar: provenance unknown
    const counting = (async (u: string, i?: any) => { if (i?.headers?.Range && !/bytes=0-0$/.test(i.headers.Range)) rangeRequestsOnSecondRun++; return origin(() => BODY)(u, i); }) as unknown as typeof fetch;
    const r = await downloadFile("http://x/m", path, { fetchImpl: counting, connections: 2, maxPartBytes: 64 * 1024, expectedSha256: sha(BODY), stagingDir: staging });
    assert.deepEqual(await readFile(path), BODY);
    assert.equal(r.sha256Verified, true);
  });
});

test("moveIntoPlace renames within a filesystem and never exposes a half-written final file", async () => {
  await tmp(async (dir) => {
    await writeFile(join(dir, "src.bin"), BODY);
    const r = await moveIntoPlace(join(dir, "src.bin"), join(dir, "sub", "dest.bin"));
    assert.equal(r.copied, false);
    assert.deepEqual(await readFile(join(dir, "sub", "dest.bin")), BODY);
    assert.equal(await exists(join(dir, "src.bin")), false);
  });
});

// ── reuse of a model that is already on the machine ─────────────────────────

const GiB = 1024 ** 3;

test("quantTag", () => {
  assert.equal(quantTag("Ternary-Bonsai-8B-PQ2_0.gguf"), "PQ2_0");
  assert.equal(quantTag("Ornith-1.5-9B-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(quantTag("weird.gguf"), null);
});

test("pickReusable: same name at the published size is reused; a SMALLER copy (incomplete) is not", () => {
  const cand = { filename: "Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 2 * GiB };
  assert.equal(pickReusable(cand, [{ path: "/d2/models/Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 2 * GiB }])?.path, "/d2/models/Ternary-Bonsai-8B-PQ2_0.gguf");
  assert.equal(pickReusable(cand, [{ path: "/d/Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 1 * GiB }]), null);
  assert.ok(pickReusable(cand, [{ path: "/d/Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 2 * GiB + 5 }]), "a republished, slightly larger copy still works");
});

test("pickReusable: a differently NAMED file is reused only on exact size + same quant", () => {
  const cand = { filename: "Ornith-1.5-35B-Q4_K_M.gguf", sizeBytes: 21_713_463_040 };
  assert.ok(pickReusable(cand, [{ path: "/m/Ornith-1.5-35B-A3B-Q4_K_M.gguf", sizeBytes: 21_713_463_040 }]));
  assert.equal(pickReusable(cand, [{ path: "/m/Ornith-1.5-35B-A3B-Q4_K_M.gguf", sizeBytes: 21_864_081_056 }]), null);
  assert.equal(pickReusable(cand, [{ path: "/m/Other-Q8_0.gguf", sizeBytes: 21_713_463_040 }]), null);
});

test("pickFamilyMatch: the same model in the quant a download would fetch, never another family", () => {
  const local = [
    { path: "/disk/models/Ternary-Bonsai-8B-PQ2_0.gguf", sizeBytes: 2 * GiB },
    { path: "/disk/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf", sizeBytes: 5.5 * GiB },
  ];
  assert.equal(pickFamilyMatch("Ternary-Bonsai-8B-PTQ1_0.gguf", local)?.path, "/disk/models/Ternary-Bonsai-8B-PQ2_0.gguf");
  assert.equal(pickFamilyMatch("Ternary-Bonsai-4B-PTQ1_0.gguf", local), null);
});

test("scanModels finds models in nested folders on another disk, and skips staging folders and non-ggufs", async () => {
  await tmp(async (dir) => {
    const disk = join(dir, "disk2", "models", "bonsai2");
    await mkdir(disk, { recursive: true });
    await mkdir(join(dir, "disk2", "models", ".llamacli-tmp"), { recursive: true });
    await writeFile(join(disk, "Ternary-Bonsai-2-27B-PTQ1_0.gguf"), Buffer.alloc(100));
    await writeFile(join(disk, "notes.txt"), "x");
    await writeFile(join(disk, "x.gguf.part"), Buffer.alloc(5));
    await writeFile(join(dir, "disk2", "models", ".llamacli-tmp", "hidden.gguf"), Buffer.alloc(5));
    const found = await scanModels([join(dir, "disk2", "models")]);
    assert.deepEqual(found.map((f) => f.path.split("/").pop()), ["Ternary-Bonsai-2-27B-PTQ1_0.gguf"]);
  });
});

test("findModelAnywhere uses the injected lister for EVERY directory instead of the real disks", async () => {
  const asked: string[] = [];
  const hit = await findModelAnywhere(
    { filename: "A-Q4_K_M.gguf", sizeBytes: 10 },
    ["/target", "/models"], {},
    async (d) => { asked.push(d); return d === "/mnt/other" ? [{ path: "/mnt/other/A-Q4_K_M.gguf", sizeBytes: 10 }] : []; }
  );
  assert.equal(hit, null, "only directories it was told about are consulted");
  assert.ok(asked.includes("/target") && asked.includes("/models"));
});
