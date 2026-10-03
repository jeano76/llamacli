/**
 * Live check of the single-server policy against REAL processes, with no GPU and none of the user's
 * servers involved: a throwaway fake `llama-server` (argv0 = llama-server, answers /v1/models) on a
 * free port, driven through the real reportServer / detectPortOwner / switchModelAndServer.
 *
 *   npx tsx scripts/live_single_server_check.ts
 *
 * Asserts: unconfirmed restart leaves the live pid alone; confirmed restart replaces it on the SAME
 * port with the NEW model; a foreign listener on the port is never killed even with confirm.
 */
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { reportServer } from "../src/setup/serverReport.js";
import { runServerRestart } from "../src/setup/serverCommand.js";
import { switchModelAndServer, detectPortOwner } from "../src/setup/modelSwitch.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

const dir = await mkdtemp(join(tmpdir(), "llamacli-live-"));
const spawned: number[] = [];
try {
  const py = join(dir, "fake.py");
  await writeFile(py, `
import sys, http.server
a = sys.argv; port = int(a[a.index("--port") + 1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"data":[{"id":"fake"}],"status":"ok"}')
    def log_message(self, *x): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
`);
  const bin = join(dir, "llama-server");
  await writeFile(bin, `#!/bin/bash\nexec -a llama-server python3 ${py} "$@"\n`);
  await chmod(bin, 0o755);
  const modelA = join(dir, "A-Q4_K_M.gguf"), modelB = join(dir, "B-Q4_K_M.gguf");
  await writeFile(modelA, Buffer.alloc(2048)); await writeFile(modelB, Buffer.alloc(2048));
  const port = await freePort();

  const startA = spawn(bin, ["-m", modelA, "--host", "127.0.0.1", "--port", String(port), "-c", "8192", "-np", "1"], { detached: true, stdio: "ignore" });
  startA.unref(); spawned.push(startA.pid!);
  for (let i = 0; i < 50 && (await detectPortOwner(port)).kind === "none"; i++) await sleep(100);
  const ownerA = await detectPortOwner(port);
  assert.equal(ownerA.kind, "ours", `fake server should be attributed as ours, got ${JSON.stringify(ownerA)}`);
  const pidA = (ownerA as any).pid as number;
  console.log(`[live] A running pid=${pidA} port=${port}`);

  const config = { model: modelB, llama: { modelPath: modelB, port, binPath: bin, contextSize: 8192, threads: 2, gpuLayers: 0 } };
  const COMPAT = { location: { binPath: bin, source: "path", backend: "cpu" }, rejected: [] };
  // Only OUR fake is in scope: the user's real servers are deliberately not listed.
  const live = [{ pid: pidA, port, cmdline: `llama-server -m ${modelA} --host 127.0.0.1 --port ${port} -c 8192 -np 1` }];
  const mkReport = () => reportServer({
    config: config as any, projectRoot: dir, findServer: async () => COMPAT as any,
    resolvePort: async () => ({ port, source: "recorded", servers: live }),
  });
  const deps = {
    switchServer: (o: any) => switchModelAndServer({ ...o, waitGpuRelease: async () => ({ released: true, waitedMs: 0 }) }),
    record: async () => {}, sync: async () => [] as string[], describePlan: async () => [] as string[],
  };
  const tuning = { contextSize: 8192, threads: 2, gpuLayers: 0 };

  const r1 = await runServerRestart({ report: await mkReport(), tuning, confirmed: false }, deps);
  assert.equal(r1.restarted, false); assert.ok(alive(pidA), "unconfirmed restart must not touch the live server");
  console.log("[live] unconfirmed restart: server untouched ✔\n  " + r1.lines.join("\n  "));

  const r2 = await runServerRestart({ report: await mkReport(), tuning, confirmed: true }, deps);
  assert.equal(r2.restarted, true, r2.lines.join("\n"));
  await sleep(300);
  const ownerB = await detectPortOwner(port);
  assert.equal(ownerB.kind, "ours"); spawned.push((ownerB as any).pid);
  assert.notEqual((ownerB as any).pid, pidA); assert.ok(!alive(pidA), "old server must be gone");
  const cmd = (await import("node:fs/promises")).readFile(`/proc/${(ownerB as any).pid}/cmdline`, "utf8");
  assert.match((await cmd).replace(/\0/g, " "), /B-Q4_K_M\.gguf/);
  console.log(`[live] confirmed restart: pid ${pidA} → ${(ownerB as any).pid}, same port ${port}, model B ✔`);

  // foreign: a plain listener on a different port must never be signalled.
  const fport = await freePort();
  const foreign = spawn("python3", ["-m", "http.server", String(fport), "--bind", "127.0.0.1"], { detached: true, stdio: "ignore" });
  foreign.unref(); spawned.push(foreign.pid!);
  for (let i = 0; i < 50 && (await detectPortOwner(fport)).kind === "none"; i++) await sleep(100);
  const fo = await detectPortOwner(fport);
  assert.equal(fo.kind, "foreign", JSON.stringify(fo));
  const rep = await reportServer({ config: { ...config, llama: { ...config.llama, port: fport } } as any, projectRoot: dir, findServer: async () => COMPAT as any, resolvePort: async () => ({ port: fport, source: "recorded", servers: [] }) });
  const r3 = await runServerRestart({ report: rep, tuning, confirmed: true }, deps);
  assert.equal(r3.restarted, false); assert.ok(alive(foreign.pid!), "a foreign listener must never be killed");
  console.log("[live] foreign listener: refused, still alive ✔");
  console.log("[live] ALL OK");
} finally {
  for (const p of spawned) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  await rm(dir, { recursive: true, force: true });
}
