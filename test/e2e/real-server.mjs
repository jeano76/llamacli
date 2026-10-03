#!/usr/bin/env node
// END-TO-END on the real thing, using the SHIPPED dist: detect hardware → download a tiny real GGUF from the Hugging Face Hub
// (hash-verified) → acquire the real stock llama.cpp prebuilt for THIS OS from GitHub (sha256-verified, run-verified by the
// engine ladder) → check the binary can read the model → start a real llama-server on a free port → /health, a real chat
// completion → stop it and confirm the port is released.
//
//   LLAMACLI_DIST=<dir> node test/e2e/real-server.mjs          (E2E_BACKEND=none to skip a GPU build on a machine that has one)
//
// This is the part the fake-server tests cannot prove: that the published binary for each OS actually starts and answers.
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dist = resolve(process.env.LLAMACLI_DIST || new URL("../../dist", import.meta.url).pathname);
const load = (p) => import(pathToFileURL(join(dist, p)).href);
const work = mkdtempSync(join(tmpdir(), "llamacli-e2e-"));
const t0 = Date.now();
const steps = [];
const log = (l) => console.log(`    ${l}`);
async function step(name, fn) {
  const s = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? "  — " + detail : ""}  (${((Date.now() - s) / 1000).toFixed(1)}s)`);
    return detail;
  } catch (e) {
    steps.push({ name, ok: false, error: String(e?.message ?? e) });
    console.log(`FAIL  ${name}  — ${String(e?.message ?? e).split("\n")[0]}`);
    throw e;
  }
}
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = (port) => new Promise((res) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false)); });

const MODEL = { url: "https://huggingface.co/ggml-org/test-model-stories260K/resolve/main/stories260K-f32.gguf", file: "stories260K-f32.gguf", sha: "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d" };

let server; let engine_;
try {
  const { detectHardware, defaultRun } = await load("setup/hardware.js");
  const { downloadFile } = await load("setup/download.js");
  const { acquireStockLlamaServer } = await load("setup/stockRuntime.js");
  const { probeModelCompatibility } = await load("setup/llamaCpp.js");
  const { LlamaServerManager } = await load("backend/llamaServer.js");

  const hw = await step("detect hardware", async () => {
    const h = await detectHardware();
    if (process.env.E2E_BACKEND) { h.gpuBackend = process.env.E2E_BACKEND; h.gpus = []; }
    return `${h.platform}/${h.arch} cpu=${h.cpuCount} ram=${(h.ramTotalBytes / 1024 ** 3).toFixed(1)}G backend=${h.gpuBackend}${h.libc ? " libc=" + h.libc : ""}`;
  }).then(() => detectHardware().then((h) => { if (process.env.E2E_BACKEND) { h.gpuBackend = process.env.E2E_BACKEND; h.gpus = []; } return h; }));

  const modelPath = join(work, "models", MODEL.file);
  await step("download a tiny real model (Hub, sha256-verified)", async () => {
    const r = await downloadFile(MODEL.url, modelPath, { connections: 1, expectedSha256: MODEL.sha, stagingDir: join(work, "tmp"), label: MODEL.file });
    if (!r.sha256Verified) throw new Error("hash was not verified");
    return `${(r.bytes / 1024 ** 2).toFixed(2)} MiB`;
  });

  const fetchWithToken = process.env.GITHUB_TOKEN
    ? (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } })
    : undefined;
  const engine = await step("acquire the stock llama.cpp prebuilt for this OS (GitHub, verified by running it)", async () => {
    const r = await acquireStockLlamaServer({ hardware: hw, run: defaultRun, log, destRoot: join(work, "llama"), installedRoot: join(work, "llama"), allowBuild: false, modelPath, fetchImpl: fetchWithToken });
    if (!r) throw new Error("no rung produced a runnable llama-server");
    engine_ = r;
    return `${r.backend} · ${r.binPath}`;
  }).then(() => engine_);

  await step("the binary can read the model", async () => {
    const c = await probeModelCompatibility(engine.binPath, modelPath);
    if (!c.ok) throw new Error(c.error ?? "probe failed");
  });

  const port = await freePort();
  await step("start a real llama-server and wait until it answers", async () => {
    server = new LlamaServerManager({ binPath: engine.binPath, modelPath, host: "127.0.0.1", port, contextSize: 512, threads: 2, gpuLayers: 0, parallel: 1 });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) throw new Error(`/health → HTTP ${res.status}`);
    return `port ${port}`;
  });

  await step("a real chat completion", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Once upon a time" }], max_tokens: 8, temperature: 0 }),
    });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j.choices) || j.choices.length === 0) throw new Error(`bad response: ${JSON.stringify(j).slice(0, 200)}`);
    return `${j.usage?.completion_tokens ?? "?"} tokens generated`;
  });

  await step("stop it and the port is released", async () => {
    server.stop();
    for (let i = 0; i < 50 && (await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 200));
    if (await portOpen(port)) throw new Error("port still open after stop()");
  });
} catch {
  /* reported by step() */
} finally {
  try { server?.stop(); } catch { /* already stopped */ }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
const bad = steps.filter((s) => !s.ok).length;
console.log(`\n${steps.length - bad}/${steps.length} e2e steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(bad || steps.length < 7 ? 1 : 0);
