#!/usr/bin/env node
// Download behaviours against the mock Hub, using the BUILT dist (no network, no containers needed):
//   1. an interrupted download resumes — even though the CDN URL is re-signed on every request;
//   2. a complete file is judged by its hash and NOT downloaded again;
//   3. a same-size file with the wrong bytes is not trusted.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startMockHub } from "./mock-hub.mjs";

const dist = resolve(process.env.LLAMACLI_DIST || new URL("../../dist", import.meta.url).pathname);
const { downloadFile } = await import(pathToFileURL(join(dist, "setup/download.js")).href);

const body = randomBytes(6 * 1024 * 1024);
const sha = createHash("sha256").update(body).digest("hex");
const hub = await startMockHub({ files: { "m.gguf": body } });
const dir = mkdtempSync(join(tmpdir(), "dl-scn-"));
const dest = join(dir, "m.gguf");
const staging = join(dir, ".tmp");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const opts = { connections: 2, maxPartBytes: 512 * 1024, expectedSha256: sha, stagingDir: staging };

try {
  // 1. Interrupted, then resumed under a NEW signature.
  hub.state.dropAfterBytes = 200 * 1024;
  let firstFailed = false;
  try { await downloadFile(hub.url("m.gguf"), dest, { ...opts, connections: 1 }); } catch { firstFailed = true; }
  check("the first attempt is interrupted mid-transfer", firstFailed);
  const sigsBefore = new Set(hub.log.filter((l) => l.kind === "cdn").map((l) => l.signature));
  const before = hub.cdnBodyRequests().length;
  const r = await downloadFile(hub.url("m.gguf"), dest, opts);
  const ranges = hub.cdnBodyRequests().slice(before).map((l) => Number(/bytes=(\d+)/.exec(l.range)[1]));
  check("the retry completes and is hash-verified", r.sha256Verified === true && readFileSync(dest).equals(body));
  const sigsAfter = new Set(hub.log.filter((l) => l.kind === "cdn").map((l) => l.signature));
  check("the CDN really re-signed the URL between attempts", sigsAfter.size > sigsBefore.size, `${sigsBefore.size} → ${sigsAfter.size} distinct signatures`);
  check("the retry fetched only what was missing (resume honoured across a re-signed URL)", ranges.length > 0 && ranges.every((s) => s > 0) , `first byte requested: ${Math.min(...ranges)}`);

  // 2. Complete file: hash decides, nothing is downloaded.
  const n2 = hub.cdnBodyRequests().length;
  const again = await downloadFile(hub.url("m.gguf"), dest, opts);
  check("a complete, hash-matching file is not downloaded again", hub.cdnBodyRequests().length === n2 && again.bytes === body.length);

  // 3. Same size, wrong bytes.
  writeFileSync(dest, Buffer.alloc(body.length, 7));
  const n3 = hub.cdnBodyRequests().length;
  await downloadFile(hub.url("m.gguf"), dest, opts);
  check("a same-size file with the wrong hash is replaced by a verified download", hub.cdnBodyRequests().length > n3 && readFileSync(dest).equals(body));
} finally {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} download checks passed`);
process.exit(bad ? 1 : 0);
