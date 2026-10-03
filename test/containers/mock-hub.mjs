// A tiny stand-in for the Hugging Face Hub + its CDN, for download scenarios without the network.
//   import { startMockHub } from "./mock-hub.mjs";  const hub = await startMockHub({ files: { "m.gguf": Buffer } });
// Behaviour copied from the real thing where it matters to llamacli:
//  - /resolve/ answers 302 to a CDN URL whose Signature/Expires CHANGE ON EVERY REQUEST (the cause of a resume that never resumed);
//  - the CDN supports Range (206 + Content-Range) and can drop the connection after N bytes (`dropAfterBytes`, once per arming);
//  - /api/models/<repo>?blobs=true lists siblings with lfs.sha256 and size.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

export async function startMockHub({ repo = "ornith-ai/Ornith-1.5-9B-GGUF", files }) {
  const sha = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, createHash("sha256").update(b).digest("hex")]));
  const log = [];          // { kind: "api"|"resolve"|"cdn", range?, signature? }
  const state = { dropAfterBytes: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === `/api/models/${repo}`) {
      log.push({ kind: "api" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ siblings: Object.entries(files).map(([rfilename, b]) => ({ rfilename, size: b.length, lfs: { sha256: sha[rfilename], size: b.length } })) }));
      return;
    }
    const m = new RegExp(`^/${repo}/resolve/main/(.+)$`).exec(url.pathname);
    if (m && files[m[1]]) {
      log.push({ kind: "resolve", range: req.headers.range });
      const sig = randomBytes(8).toString("hex");
      res.writeHead(302, { location: `/cdn/${m[1]}?X-Xet-Cas-Uid=public&Expires=${Date.now() + 3600e3}&Signature=${sig}` });
      return res.end();
    }
    const c = /^\/cdn\/(.+)$/.exec(url.pathname);
    if (c && files[c[1]]) {
      const body = files[c[1]];
      const rg = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      log.push({ kind: "cdn", range: req.headers.range, signature: url.searchParams.get("Signature") });
      const start = rg ? Number(rg[1]) : 0;
      const end = rg && rg[2] ? Math.min(Number(rg[2]), body.length - 1) : body.length - 1;
      const chunk = body.subarray(start, end + 1);
      res.writeHead(rg ? 206 : 200, { "content-length": chunk.length, "accept-ranges": "bytes", ...(rg ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}) });
      if (state.dropAfterBytes > 0 && start > 0 && chunk.length > 1) {
        const n = Math.min(state.dropAfterBytes, chunk.length - 1);
        state.dropAfterBytes = 0;
        res.write(chunk.subarray(0, n));
        setTimeout(() => req.socket.destroy(), 10);
        return;
      }
      return res.end(chunk);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, repo, sha, log, state,
    url: (name) => `${base}/${repo}/resolve/main/${name}`,
    cdnBodyRequests: () => log.filter((l) => l.kind === "cdn" && l.range && l.range !== "bytes=0-0"),
    close: () => new Promise((r) => server.close(r)),
  };
}
