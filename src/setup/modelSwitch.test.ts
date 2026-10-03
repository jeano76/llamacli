import { test } from "node:test";
import assert from "node:assert/strict";
import { switchModelAndServer, type PortOwner } from "./modelSwitch.js";
import { findRung } from "./modelMetrics.js";

const ornith = findRung("ornith-35b")!;

const TUNING = { contextSize: 16384, threads: 10, gpuLayers: 99, cpuMoeLayers: 0, flashAttn: true };

/** Records every start/stop in order, so "did it start before stopping?" and
 *  "which port did it start on?" are both answerable. */
function fakeServer(sink: { events: string[] }, fail = false) {
  return {
    start: async () => {
      sink.events.push("start");
      if (fail) throw new Error("llama-load: failed to load model");
    },
    stop: () => sink.events.push("stop"),
    logTail: (n = 20) => `tail(${n})`,
  };
}

function base(owner: PortOwner, sink: { events: string[] }) {
  return {
    modelPath: "/models/Ornith.gguf",
    port: 8080,
    binPath: "/opt/llama-server",
    tuning: TUNING,
    detectOwner: async () => owner,
    makeServer: () => fakeServer(sink),
  };
}

test("the port is reused verbatim -- never re-planned", async () => {
  // The invariant this module exists for. planPorts used to see 8080 busy and
  // move llamacli to 8081, which means spawning a SECOND llama-server; on an
  // 8 GB card whose first server already holds 7.2 GB that is an OOM at load,
  // not a slowdown.
  const sink = { events: [] as string[] };
  let seen: number | undefined;
  const r = await switchModelAndServer({
    ...base({ kind: "none" }, sink),
    makeServer: (cfg) => {
      seen = cfg.port;
      return fakeServer(sink);
    },
  });
  assert.equal(r.port, 8080, "the reported port must be the requested one");
  assert.equal(seen, 8080, "the spawned server must bind the requested port");
  assert.equal(r.ok, true);
});

test("an existing llamacli server is stopped BEFORE the replacement starts", async () => {
  // Starting the replacement while the old process still holds the port gives an
  // "address already in use" failure that reads like a config problem when it is
  // really a race -- so the ORDER is asserted, not assumed. Both the stop and the
  // start are recorded, because an earlier version of this test watched only the
  // start (the stop goes through process.kill, not the server object) and so
  // passed whether or not the stop ever happened.
  const order: string[] = [];
  const sink = { events: [] as string[] };
  const r = await switchModelAndServer({
    ...base({ kind: "ours", pid: 4242 }, sink),
    stopProcess: async (pid) => {
      // Yields, because the real one does: `stopPid` polls for up to 10 s
      // waiting for the port to be released. A stub that returned synchronously
      // made a fire-and-forget stop indistinguishable from a waited one -- the
      // test passed with the ordering deliberately broken.
      await new Promise((r) => setTimeout(r, 1));
      order.push(`stop:${pid}`);
    },
    makeServer: () => ({
      start: async () => void order.push("start"),
      stop: () => {},
      logTail: () => "",
    }),
  });
  assert.deepEqual(order, ["stop:4242", "start"], "the old server must let go of the port first");
  assert.equal(r.ok, true);
  assert.equal(r.stopped?.kind, "ours", "what was stopped is reported, so the status line can say so");
});

test("an unattributable process is NEVER stopped", async () => {
  // The one case that is refused. The port is not ours and the holder is not
  // ours; killing a stranger's process because a model changed is not a decision
  // this code should make on its own. Failing closed matters -- misclassifying
  // it as ours would let a model switch kill it.
  const sink = { events: [] as string[] };
  const r = await switchModelAndServer(base({ kind: "foreign", pid: 999 }, sink));
  assert.equal(r.ok, false);
  assert.deepEqual(sink.events, [], "nothing may be started or stopped");
  assert.match(r.lines.join("\n"), /알 수 없는 프로세스/);
});

test("a systemd unit is reported, not fought over", async () => {
  // The unit owns the port and will keep holding it, so a bare kill races the
  // unit's own restart. Worse, "restart the unit" does NOT load a new model --
  // the unit names its own -- so proceeding would leave the new model unused
  // while looking like success.
  const sink = { events: [] as string[] };
  const r = await switchModelAndServer(base({ kind: "systemd", unit: "llama-server.service" }, sink));
  assert.equal(r.ok, false);
  assert.deepEqual(sink.events, []);
  assert.match(r.lines.join("\n"), /llama-server\.service/);
  assert.match(r.lines.join("\n"), /재시작/);
});

test("a start failure is reported with the log tail, not thrown", async () => {
  const sink = { events: [] as string[] };
  const r = await switchModelAndServer({ ...base({ kind: "none" }, sink), makeServer: () => fakeServer(sink, true) });
  assert.equal(r.ok, false);
  assert.equal(r.ready, false);
  assert.match(r.lines.join("\n"), /failed to load model/);
  assert.match(r.lines.join("\n"), /tail\(12\)/, "the child's own output is the diagnosis, so it must be included");
});

test("a failed start still reports the port it was asked for", async () => {
  // The port is a fact about the install, not about the outcome, and a caller
  // retrying needs to know which port to retry on.
  const sink = { events: [] as string[] };
  const r = await switchModelAndServer({ ...base({ kind: "none" }, sink), makeServer: () => fakeServer(sink, true) });
  assert.equal(r.port, 8080);
});

test("the replacement server is configured like the old one", async () => {
  // A bare `-ngl 0` default would run a model that used to be fully resident on
  // the CPU. The tuned flags are the whole reason a model that fits is fast.
  const sink = { events: [] as string[] };
  let cfg: any;
  await switchModelAndServer({
    ...base({ kind: "none" }, sink),
    makeServer: (c) => {
      cfg = c;
      return fakeServer(sink);
    },
  });
  assert.equal(cfg.gpuLayers, 99);
  assert.equal(cfg.contextSize, 16384);
  assert.equal(cfg.modelPath, "/models/Ornith.gguf");
  assert.equal(cfg.binPath, "/opt/llama-server");
});

test("host defaults to loopback", async () => {
  // Anything else would bind a local model server to the network.
  const sink = { events: [] as string[] };
  let cfg: any;
  await switchModelAndServer({
    ...base({ kind: "none" }, sink),
    makeServer: (c) => {
      cfg = c;
      return fakeServer(sink);
    },
  });
  assert.equal(cfg.host, "127.0.0.1");
});

test("progress is streamed as it happens, not only at the end", async () => {
  // A model load is minutes long. Reporting nothing until the end looks exactly
  // like a hang.
  const seen: string[] = [];
  const sink = { events: [] as string[] };
  await switchModelAndServer({ ...base({ kind: "none" }, sink), onProgress: (l) => seen.push(l) });
  assert.ok(seen.length >= 2, `expected progress lines, got ${seen.length}`);
  assert.match(seen.join("\n"), /포트 8080/);
});

test("a non-default port is preserved just as strictly", async () => {
  // 8080 is the common case, so a test that only asserts 8080 would pass even if
  // the value were hardcoded somewhere.
  const sink = { events: [] as string[] };
  let seen: number | undefined;
  const r = await switchModelAndServer({
    ...base({ kind: "none" }, sink),
    port: 8084,
    makeServer: (c) => {
      seen = c.port;
      return fakeServer(sink);
    },
  });
  assert.equal(seen, 8084);
  assert.equal(r.port, 8084);
});
