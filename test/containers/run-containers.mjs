#!/usr/bin/env node
// Container runner: builds one image per OS row and runs the probe inside it, with real cgroup limits
// (--memory/--cpus) and the fixtures' fake hardware, then applies the SAME machine checks as the host runner.
//   npm run build && node test/containers/run-containers.mjs [rowId ...]      (podman or docker)
//
// STATUS: not executed on the author's machine — no container runtime was installed there, and rootless
// containers were blocked (AppArmor restricts unprivileged user namespaces; installing podman needs sudo).
// Treat results from this runner as UNVERIFIED until it has been run somewhere that has a runtime.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get, check, loadMatrix } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const rt = ["podman", "docker"].find((c) => spawnSync(c, ["--version"]).status === 0);
if (!rt) { console.error("No container runtime (podman/docker) found. See docs/container-matrix-validation-prompt.md §1."); process.exit(2); }
const { os_rows, rows } = loadMatrix();
const only = new Set(process.argv.slice(2));
const SHELL = { bash: ["bash", "-c"], dash: ["dash", "-c"], zsh: ["zsh", "-c"], fish: ["fish", "-c"], busybox: ["busybox", "sh", "-c"], sh: ["sh", "-c"] };

const results = [];
for (const row of os_rows) {
  if (only.size && !only.has(row.id)) continue;
  const tag = `llamacli-matrix-${row.id}`;
  const b = spawnSync(rt, ["build", "-f", join(here, "Containerfile"), "--build-arg", `BASE=${row.image}`, "--build-arg", `PKG=${row.pkg}`, "-t", tag, root], { encoding: "utf8" });
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
