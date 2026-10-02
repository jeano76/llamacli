import test from "node:test";
import assert from "node:assert/strict";
import { provisionForSwitch, pinnedPortProbe, type ProvisionOptions } from "./provision.js";
import { tcpPortProbe, type PortState } from "./ports.js";
import type { Hardware } from "./hardware.js";

/** The minimum a fake bootstrap must look like for provisioning to read a result
 *  out of it. Everything else is a real call the tests must not make. */
function fakeEnsure(result: Record<string, any>, seen: Record<string, any> = {}) {
  return (async (opts: any) => {
    Object.assign(seen, opts);
    return {
      ok: true,
      steps: [],
      errors: [],
      hardware: { cpus: 12, ramTotalBytes: 1, gpus: [], os: "linux" },
      llama: { binPath: "/opt/llama-server", backend: "test" },
      modelPath: "/models/m.gguf",
      tuning: { gpuLayers: 999, threads: 6, contextSize: 32768 },
      ports: { llamaPort: 8084 },
      config: {},
      ...result,
    };
  }) as unknown as ProvisionOptions["ensureLocalStack"];
}

const HW = { cpus: 12, ramTotalBytes: 32 * 1024 ** 3, gpus: [], os: "linux" } as unknown as Hardware;

const base = (over: Partial<ProvisionOptions> = {}): ProvisionOptions => ({
  projectRoot: "/p",
  port: 8084,
  hardware: HW,
  log: () => {},
  ...over,
});

test("provisions and hands back what the switch needs", async () => {
  const res = await provisionForSwitch(
    base({ ensureLocalStack: fakeEnsure({}) })
  );
  assert.equal(res.ok, true);
  assert.equal(res.binPath, "/opt/llama-server");
  assert.equal(res.modelPath, "/models/m.gguf");
  // The port is a decision, not a re-derivation.
  assert.equal(res.port, 8084);
  // Tuning must travel with it: the old model's flags are sized for the old model.
  assert.equal(res.tuning?.contextSize, 32768);
});

test("does NOT adopt the server it is about to replace", async () => {
  // The bootstrap's first act is to adopt a running server and return early. Here
  // that server holds the PREVIOUS model, so adopting it would skip provisioning
  // entirely and leave the selection recorded but unserved — the exact gap this
  // module exists to close.
  const seen: Record<string, any> = {};
  await provisionForSwitch(base({ ensureLocalStack: fakeEnsure({}, seen) }));
  const detect = seen.detectServer as (h: string, p: number[]) => Promise<unknown>;
  assert.equal(typeof detect, "function", "a real detector would adopt the old server");
  assert.deepEqual(await detect("127.0.0.1", [8084]), { kind: "none" });
});

test("keeps the recorded port instead of letting planPorts walk off it", async () => {
  // planPorts MOVES off an occupied port: a recorded 8084 with 8080 free becomes
  // 8080, which starts a SECOND server on a card whose first server already holds
  // most of the VRAM. The recorded port is pinned.
  const seen: Record<string, any> = {};
  await provisionForSwitch(base({ ensureLocalStack: fakeEnsure({}, seen) }));
  assert.equal(await seen.probe(8084), "free", "the port we are about to take over must read free");
});

test("pins ONLY the recorded port and asks about the rest", async () => {
  const asked: number[] = [];
  const probe = pinnedPortProbe(8084, async (p) => {
    asked.push(p);
    return "in-use";
  });
  assert.equal(await probe(8084), "free");
  assert.equal(await probe(9000), "in-use");
  assert.deepEqual(asked, [9000], "the pinned port must not be probed at all");
});

test("refuses to switch when provisioning moved the port anyway", async () => {
  // Unreachable through the pinned probe, and that is the point: a switch that
  // quietly relocated the server is what this whole feature is built around not
  // doing. If it ever happens, it is reported rather than performed.
  const res = await provisionForSwitch(
    base({ ensureLocalStack: fakeEnsure({ ports: { llamaPort: 8080 } }) })
  );
  assert.equal(res.ok, false);
  assert.equal(res.binPath, undefined, "nothing to switch with");
  assert.match(res.lines.join("\n"), /8080/);
  assert.match(res.lines.join("\n"), /포트는 사용자가 정한 값/);
});

test("reports a missing binary instead of pretending to be ready", async () => {
  const res = await provisionForSwitch(
    base({ ensureLocalStack: fakeEnsure({ ok: false, llama: undefined, errors: ["llama.cpp: 설치 실패"] }) })
  );
  assert.equal(res.ok, false);
  assert.equal(res.binPath, undefined);
  assert.match(res.lines.join("\n"), /llama-server 를 준비하지 못했습니다/);
});

test("reports a missing model file", async () => {
  const res = await provisionForSwitch(
    base({ ensureLocalStack: fakeEnsure({ ok: false, modelPath: undefined }) })
  );
  assert.equal(res.ok, false);
  assert.match(res.lines.join("\n"), /모델 파일을 확보하지 못했습니다/);
});

test("a thrown bootstrap becomes a report, not a dead session", async () => {
  // This runs inside a live slash command. An exception here would take down a
  // working install in order to report a compile failure.
  const boom = (async () => {
    throw new Error("cmake: command not found");
  }) as unknown as ProvisionOptions["ensureLocalStack"];
  const res = await provisionForSwitch(base({ ensureLocalStack: boom }));
  assert.equal(res.ok, false);
  assert.match(res.lines.join("\n"), /cmake: command not found/);
});

test("bootstraps in non-force mode so the port and binPath survive", async () => {
  // `force` is what /reset uses; it keeps only user-owned config keys, which drops
  // llama.port and llama.binPath — the two fields this path exists to carry.
  const seen: Record<string, any> = {};
  await provisionForSwitch(base({ ensureLocalStack: fakeEnsure({}, seen) }));
  assert.equal(seen.force, false);
  assert.equal(seen.allowBuild, true, "selecting a model that cannot run yet is a request to build");
});

test("forwards every provision line to the caller", async () => {
  const seen: string[] = [];
  await provisionForSwitch(
    base({
      log: (l) => seen.push(l),
      ensureLocalStack: (async (opts: any) => {
        opts.log("llama.cpp: 빌드 중");
        opts.log("모델 다운로드 중…");
        return {
          ok: true, steps: [], errors: [], hardware: HW,
          llama: { binPath: "/opt/llama-server", backend: "test" },
          modelPath: "/models/m.gguf", ports: { llamaPort: 8084 }, config: {},
        };
      }) as unknown as ProvisionOptions["ensureLocalStack"],
    })
  );
  // A long compile is invisible to the user if these never surface.
  assert.ok(seen.includes("llama.cpp: 빌드 중"));
  assert.ok(seen.includes("모델 다운로드 중…"));
});