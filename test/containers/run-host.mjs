#!/usr/bin/env node
// Host-mode runner: executes the rows of matrix.yaml that are marked `host` WITHOUT a container runtime —
// real processes, real cgroup limits (systemd-run --user --scope), real shells, fixtures for hardware.
//   npm run build && node test/containers/run-host.mjs [rowId ...]
// Isolation is by environment (PATH stubs, LLAMACLI_DRM_ROOT, cgroup scope), not by a separate filesystem, so
// this is weaker than a container: it cannot test distro/libc/package-manager differences.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get, check, loadMatrix } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { rows } = loadMatrix();
const only = new Set(process.argv.slice(2));

const SHELLS = { bash: ["bash", "-c"], dash: ["dash", "-c"], busybox: ["busybox", "sh", "-c"], sh: ["sh", "-c"] };

const results = [];
for (const row of rows) {
  if (!(row.where ?? []).includes("host")) continue;
  if (only.size && !only.has(row.id)) continue;
  const work = mkdtempSync(join(tmpdir(), `lc-${row.id}-`));
  try {
    const stubs = join(work, "stubs");
    mkdirSync(stubs);
    for (const f of ["nvidia-smi", "vulkaninfo"]) { copyFileSync(join(here, "fixtures", f), join(stubs, f)); chmodSync(join(stubs, f), 0o755); }
    const env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, LLAMACLI_NO_UPDATE: "1", ...(row.env ?? {}) };
    if (!row.env?.FAKE_NVIDIA) delete env.FAKE_NVIDIA;
    if (!row.env?.FAKE_VULKAN) delete env.FAKE_VULKAN;
    if (row.drm) {
      const dev = join(work, "drm", "card0", "device");
      mkdirSync(dev, { recursive: true });
      writeFileSync(join(dev, "vendor"), row.drm.vendor + "\n");
      writeFileSync(join(dev, "mem_info_vram_total"), String(row.drm.vramGiB * 1024 ** 3) + "\n");
      writeFileSync(join(dev, "mem_info_vram_used"), "0\n");
      env.LLAMACLI_DRM_ROOT = join(work, "drm");
    }
    const [sh, ...shArgs] = SHELLS[row.shell ?? "bash"];
    const inner = `node ${JSON.stringify(join(here, "probe.mjs"))}`;
    let cmd = [sh, ...shArgs, inner];
    if (row.limits) {
      const props = [];
      if (row.limits.memory) props.push("-p", `MemoryMax=${row.limits.memory}`);
      if (row.limits.cpus) props.push("-p", `CPUQuota=${row.limits.cpus * 100}%`);
      cmd = ["systemd-run", "--user", "--scope", "--quiet", ...props, ...cmd];
    }
    const t0 = Date.now();
    const p = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8", timeout: 60000 });
    let out; let failures = [];
    try { out = JSON.parse(p.stdout.trim().split("\n").pop()); } catch { failures.push(`no JSON from probe (exit ${p.status}): ${(p.stderr || p.stdout).slice(0, 300)}`); }
    if (out) for (const [path, want] of Object.entries(row.expect ?? {})) {
      const why = check(get(out, path), want);
      if (why) failures.push(`${path} = ${JSON.stringify(get(out, path))} — ${why}`);
    }
    results.push({ id: row.id, mode: "host", shell: row.shell ?? "bash", limits: row.limits ?? null, ok: failures.length === 0, failures, ms: Date.now() - t0, observed: out ?? null });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const r of results) {
  const o = r.observed;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(22)} ${o ? `cpu=${o.detected.cpuCount} ram=${o.detected.ramGiB}G gpu=${o.detected.gpuBackend} ladder=${o.engineLadder.join(">")} model=${o.model.replace(/-Q4_K_M.gguf/, "")} ngl=${o.tuning.gpuLayers} moe=${o.tuning.cpuMoeLayers} ctx=${o.tuning.contextSize}` : ""}`);
  for (const f of r.failures) console.log(`        ✗ ${f}`);
}
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "host.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} rows passed (host mode) → test/containers/results/host.json`);
process.exit(bad ? 1 : 0);
