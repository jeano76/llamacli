#!/usr/bin/env node
// Container runner: builds one image per OS row and runs the probe inside it, with real cgroup limits
// (--memory/--cpus) and the fixtures' fake hardware, then applies the SAME machine checks as the host runner.
//   npm run build && node test/containers/run-containers.mjs [rowId ...]      (podman or docker)
//
// STATUS: executed with rootless podman 5.7 (cgroup v2): 27/27 rows passed — see docs/container-matrix-report.md.
// The images hold the dist's setup modules only (no TUI dependencies); the TUI is covered by tui-smoke.py on the host.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get, check, loadMatrix } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const rt = ["podman", "docker"].find((c) => spawnSync(c, ["--version"]).status === 0);
if (!rt) { console.error("No container runtime (podman/docker) found. See docs/container-matrix-validation-prompt.md §1."); process.exit(2); }
const { os_rows, rows } = loadMatrix();
const only = new Set(process.argv.slice(2));
const qualify = (img) => (img.includes("/") ? img : `docker.io/library/${img}`); // podman refuses short names without a registry
const SHELL = { bash: ["bash", "-c"], dash: ["dash", "-c"], zsh: ["zsh", "-c"], fish: ["fish", "-c"], busybox: ["busybox", "sh", "-c"], sh: ["sh", "-c"] };

const results = [];
for (const row of os_rows) {
  if (only.size && !only.has(row.id)) continue;
  const tag = `llamacli-matrix-${row.id}`;
  const b = spawnSync(rt, ["build", "-f", join(here, "Containerfile"), "--build-arg", `BASE=${qualify(row.image)}`, "--build-arg", `PKG=${row.pkg}`, "-t", tag, root], { encoding: "utf8" });
  if (b.status !== 0) { results.push({ id: row.id, ok: false, failures: [`image build failed: ${b.stderr.slice(-300)}`] }); continue; }
  const user = row.user === "root" ? ["--user", "0"] : ["--user", "user"];
  const [sh, ...args] = SHELL[row.shell];
  const p = spawnSync(rt, ["run", "--rm", ...user, tag, sh, ...args, "node /opt/matrix/probe.mjs"], { encoding: "utf8", timeout: 120000 });
  let out; const failures = [];
  try { out = JSON.parse(p.stdout.trim().split("\n").pop()); } catch { failures.push(`no JSON (exit ${p.status}): ${(p.stderr || p.stdout).slice(0, 300)}`); }
  if (out) for (const [path, want] of Object.entries(row.expect ?? {})) { const why = check(get(out, path), want); if (why) failures.push(`${path} = ${JSON.stringify(get(out, path))} — ${why}`); }
  results.push({ id: row.id, ok: failures.length === 0, failures, observed: out ?? null });
}
// Hardware / limit rows inside one reference image (debian:12): same rows as host mode, now in a container.
for (const row of rows) {
  if (!(row.where ?? []).includes("container")) continue;
  if (only.size && !only.has(row.id)) continue;
  const tag = "llamacli-matrix-os-debian-bash-user";
  const flags = [];
  if (row.limits?.memory) flags.push("--memory", row.limits.memory);
  if (row.limits?.cpus) flags.push("--cpus", String(row.limits.cpus));
  for (const [k, v] of Object.entries(row.env ?? {})) flags.push("-e", `${k}=${v}`);
  if (row.drm) {
    // A fake /sys/class/drm tree, mounted read-only (":Z" relabels for SELinux hosts).
    const tree = mkdtempSync(join(tmpdir(), "drm-"));
    const dev = join(tree, "card0", "device");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "vendor"), row.drm.vendor + "\n");
    writeFileSync(join(dev, "mem_info_vram_total"), String(row.drm.vramGiB * 1024 ** 3) + "\n");
    writeFileSync(join(dev, "mem_info_vram_used"), "0\n");
    // Rootless podman maps the container's `user` to a sub-uid, which cannot read a host 0700 temp dir.
    for (const d of [tree, join(tree, "card0"), dev]) chmodSync(d, 0o755);
    for (const f of ["vendor", "mem_info_vram_total", "mem_info_vram_used"]) chmodSync(join(dev, f), 0o644);
    flags.push("-v", `${tree}:/fake-drm:ro,Z`, "-e", "LLAMACLI_DRM_ROOT=/fake-drm");
  }
  const [sh, ...args] = SHELL[row.shell ?? "bash"];
  const p = spawnSync(rt, ["run", "--rm", "--user", "user", ...flags, tag, sh, ...args, "node /opt/matrix/probe.mjs"], { encoding: "utf8", timeout: 120000 });
  let out; const failures = [];
  try { out = JSON.parse(p.stdout.trim().split("\n").pop()); } catch { failures.push(`no JSON (exit ${p.status})`); }
  if (out) for (const [path, want] of Object.entries(row.expect ?? {})) { const why = check(get(out, path), want); if (why) failures.push(`${path} = ${JSON.stringify(get(out, path))} — ${why}`); }
  results.push({ id: row.id, ok: failures.length === 0, failures, observed: out ?? null });
}
for (const r of results) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}`); for (const f of r.failures) console.log(`        ✗ ${f}`); }
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "containers.json"), JSON.stringify({ at: new Date().toISOString(), runtime: rt, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
