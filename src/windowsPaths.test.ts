import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReusable, pickFamilyMatch } from "./setup/existingModel.js";
import { reportServer } from "./setup/serverReport.js";
import { gateServerReplacement } from "./setup/serverPolicy.js";
import { modelFamilyOf } from "./setup/modelCatalog.js";

// Windows-shaped paths (drive letters, backslashes) through the product's PURE logic, runnable on any OS. This does not
// replace the Windows CI run (real filesystem/shell/process behaviour) — it keeps the string handling honest locally.

const W = (name: string, drive = "C") => `${drive}:\\Users\\me\\models\\${name}`;

test("existing-model reuse matches by file NAME on a Windows path, across drives", () => {
  const local = [
    { path: W("Ornith-1.5-35B-A3B-Q4_K_M.gguf", "D"), sizeBytes: 21 * 1024 ** 3 },
    { path: W("other.gguf"), sizeBytes: 1 },
  ];
  const hit = pickReusable({ filename: "Ornith-1.5-35B-A3B-Q4_K_M.gguf", sizeBytes: 20 * 1024 ** 3 }, local);
  assert.equal(hit?.path, W("Ornith-1.5-35B-A3B-Q4_K_M.gguf", "D"));
  const fam = pickFamilyMatch("Ornith-1.5-35B-A3B-Q8_0.gguf", local);
  assert.equal(fam?.path, W("Ornith-1.5-35B-A3B-Q4_K_M.gguf", "D"), "same family, other quant, found on another drive");
  assert.equal(modelFamilyOf("Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "Ornith-1.5-35B-A3B");
});

test("/server names models, not full Windows paths, in the summary and the restart plan", async () => {
  const COMPAT = { location: { binPath: "C:\\llama\\bin\\llama-server.exe", source: "path", backend: "cuda" }, rejected: [] };
  const rep = await reportServer({
    config: { llama: { port: 8080, modelPath: W("B-Q4_K_M.gguf"), binPath: "C:\\llama\\bin\\llama-server.exe" } },
    projectRoot: "C:\\proj",
    detectOwner: async () => ({ kind: "ours", pid: 7 }),
    resolvePort: async () => ({ port: 8080, source: "recorded", servers: [{ pid: 7, port: 8080, cmdline: `llama-server.exe -m ${W("A-Q4_K_M.gguf")} --port 8080` }] }),
    findServer: async () => COMPAT as any,
  });
  assert.match(rep.summary, /실행 중인 서버의 모델 A-Q4_K_M\.gguf/);
  assert.match(rep.summary, /config 의 모델 B-Q4_K_M\.gguf/);
  assert.doesNotMatch(rep.summary, /Users/, "no full path leaks into the one-line summary");
  assert.match(rep.restartPlan, /A-Q4_K_M\.gguf → B-Q4_K_M\.gguf/);
  assert.match(rep.summary, /llama-server\.exe/, "the build is shown by its last segments");
});

test("the confirm gate lists several Windows servers by model name", () => {
  const g = gateServerReplacement({
    owner: { kind: "ours", pid: 1 }, port: 8080, changes: [], confirmed: true, confirmCommand: "/x",
    servers: [
      { pid: 1, port: 8080, cmdline: `llama-server.exe -m ${W("A.gguf")} --port 8080` },
      { pid: 2, port: 8081, cmdline: `llama-server.exe -m ${W("B.gguf")} --port 8081` },
    ],
  });
  assert.equal(g.proceed, false);
  assert.match(g.lines.join("\n"), /A\.gguf/);
  assert.match(g.lines.join("\n"), /B\.gguf/);
});
