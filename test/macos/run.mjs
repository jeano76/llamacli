// macOS scenarios against the SHIPPED dist (no build): the container-matrix probe from each shell, plus the download
// scenarios. Hosted macOS runners are Apple Silicon: detection must say Metal (unified memory) and offer the single
// macOS prebuilt; no CUDA/Vulkan rungs.
//   LLAMACLI_DIST=<dir> node test/macos/run.mjs
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
const expect = { "detected.platform": "darwin", "detected.gpuBackend": "metal", "engineLadder.0": "metal", "engineLadder.1": undefined, "buildPlan.manager": "brew" };
const shells = [["zsh", ["zsh", "-c"]], ["bash", ["bash", "-c"]], ["sh", ["sh", "-c"]]];
const results = [];
for (const [name, [sh, flag]] of shells) {
  const p = spawnSync(sh, [flag, `node "${probe}"`], { env, encoding: "utf8", timeout: 120000 });
  const failures = []; let out;
  try { out = JSON.parse(p.stdout.trim().split("\n").pop()); } catch { failures.push(`no JSON (exit ${p.status}): ${(p.stderr || p.stdout).slice(0, 400)}`); }
  if (out) for (const [path, want] of Object.entries(expect)) { const why = check(get(out, path), want); if (why) failures.push(`${path} = ${JSON.stringify(get(out, path))} — ${why}`); }
  results.push({ shell: name, ok: failures.length === 0, failures, observed: out ?? null });
  console.log(`${failures.length ? "FAIL" : "PASS"}  probe via ${name}${out ? `  arch=${out.detected.arch} cpu=${out.detected.cpuCount} ram=${out.detected.ramGiB}G gpu=${out.detected.gpuBackend} gpuMem=${out.detected.gpus[0]?.vramGiB}G ladder=${out.engineLadder.join(">")} manager=${out.buildPlan.manager} model=${out.model.replace("-Q4_K_M.gguf", "")} ngl=${out.tuning.gpuLayers} ctx=${out.tuning.contextSize}` : ""}`);
  for (const f of failures) console.log(`        ✗ ${f}`);
}
const dl = spawnSync(process.execPath, [join(here, "..", "containers", "download-scenario.mjs")], { env, encoding: "utf8", timeout: 180000 });
process.stdout.write(dl.stdout);
results.push({ shell: "download-scenario", ok: dl.status === 0, failures: dl.status === 0 ? [] : [dl.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ") || dl.stderr.slice(0, 300)] });
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "macos.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
