// Windows scenarios against the SHIPPED dist (bin/llamacli-dist.tar.gz extracted by the workflow), no build needed:
// the same probe the container matrix uses, launched from each Windows shell, plus the download scenarios
// (mock Hub on loopback; real Windows file semantics: rename-over-open files, locked files, drive-letter paths).
//   LLAMACLI_DIST=<dir> node test/windows/run.mjs
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { get, check } from "../containers/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, "..", "containers", "probe.mjs");
const dist = resolve(process.env.LLAMACLI_DIST || join(here, "../../dist"));
const env = { ...process.env, LLAMACLI_DIST: dist, LLAMACLI_NO_UPDATE: "1" };
delete env.FAKE_NVIDIA; delete env.FAKE_VULKAN;

// A hosted runner has no GPU: Windows must say so (and not mistake "Microsoft Basic Render Driver" for one).
const expect = {
  "detected.platform": "win32", "detected.gpuBackend": "none", "detected.gpus": [],
  "engineLadder.0": "cpu", "tuning.gpuLayers": 0, "tuning.cpuMoeLayers": 0,
};
const shells = [
  ["pwsh", ["pwsh", "-NoProfile", "-Command", `node "${probe}"`]],
  ["powershell", ["powershell", "-NoProfile", "-Command", `node "${probe}"`]],
  ["cmd", ["cmd", "/d", "/s", "/c", `node "${probe}"`]],
  ["git-bash", ["bash", "-c", `node "${probe.replace(/\\/g, "/")}"`]],
];
const results = [];
for (const [name, cmd] of shells) {
  const p = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8", timeout: 120000 });
  const failures = [];
  let out;
  if (p.error) failures.push(`${cmd[0]} not runnable: ${p.error.message}`);
  else {
    try { out = JSON.parse(p.stdout.trim().split(/\r?\n/).pop()); } catch { failures.push(`no JSON (exit ${p.status}): ${(p.stderr || p.stdout).slice(0, 400)}`); }
  }
  if (out) for (const [path, want] of Object.entries(expect)) { const why = check(get(out, path), want); if (why) failures.push(`${path} = ${JSON.stringify(get(out, path))} — ${why}`); }
  results.push({ shell: name, ok: failures.length === 0, failures, observed: out ?? null });
  console.log(`${failures.length ? "FAIL" : "PASS"}  probe via ${name}${out ? `  cpu=${out.detected.cpuCount} ram=${out.detected.ramGiB}G ladder=${out.engineLadder.join(">")} manager=${out.buildPlan.manager} model=${out.model.replace("-Q4_K_M.gguf", "")}` : ""}`);
  for (const f of failures) console.log(`        ✗ ${f}`);
}
const dl = spawnSync(process.execPath, [join(here, "..", "containers", "download-scenario.mjs")], { env, encoding: "utf8", timeout: 180000 });
process.stdout.write(dl.stdout);
if (dl.status !== 0) process.stderr.write(dl.stderr);
results.push({ shell: "download-scenario", ok: dl.status === 0, failures: dl.status === 0 ? [] : [dl.stdout.split(/\r?\n/).filter((l) => l.startsWith("FAIL")).join(" | ") || dl.stderr.slice(0, 300)], observed: null });

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "windows.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
