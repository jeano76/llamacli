/**
 * Auto-detects an already-running local OpenAI-compatible server so a fresh
 * project (no .llamacli/config.yaml yet) doesn't silently guess a dead port
 * — the previous default (127.0.0.1:8081) pointed at nothing on a machine
 * that actually had a real server running on 8080, which surfaced as a
 * confusing ECONNREFUSED instead of "just working" or explaining itself.
 */

import { COMMON_PORTS as SHARED_COMMON_PORTS } from "../setup/ports.js";

/** One list, shared. This module used to declare its own `[8080, 8081, 11434]`
 *  while `setup/ports.ts` declared `[8080, 11434]`, and the bootstrap read the
 *  second one — so a llama-server on 8081 was visible to config loading and
 *  invisible to the bootstrap that decides whether to spawn. Re-exported rather
 *  than redeclared so the two cannot drift apart again. */
export const COMMON_PORTS = SHARED_COMMON_PORTS;

/** How long a single probe may take.
 *
 *  Generous on purpose. llama-server serves NOTHING — not even /v1/models —
 *  until the weights are resident, and loading a 21 GB model takes minutes. At
 *  800 ms a server that was merely still loading looked identical to a server
 *  that was not there, and the bootstrap responded by planning a different port
 *  and spawning a second llama-server: two servers, one GPU. */
const PROBE_TIMEOUT_MS = 2000;

export interface DetectedServer {
  baseUrl: string;
  model: string;
  /**
   * What actually answered.
   *
   * "llama.cpp"  /props carries `build_info`, which llama.cpp always emits
   *              (server-context.cpp's props handler fills it from
   *              llama_build_info()).
   * "other"      an OpenAI-compatible server that isn't llama.cpp (Ollama,
   *              vLLM). Genuinely usable, so it IS adopted -- just labelled.
   * "stub"       answers the API but has no real weights behind it.
   * undefined    an injected detector that predates this field; treated as
   *              "unknown, assume fine" so test doubles need not know about it.
   */
  verified?: ServerKind;
  /** Why a server was rejected, when it was. User-facing. */
  reason?: string;
}

export type ServerKind = "llama.cpp" | "other" | "stub";

/** Whether a reported model id names a .gguf file on disk.
 *
 *  llama.cpp reports the FULL PATH of the file it loaded, so that is what a
 *  real one looks like. Ollama reports names like `llama3:8b`, which is not a
 *  path -- that difference is what keeps the stub test below from rejecting
 *  Ollama. */
function looksLikeGgufPath(model: string): boolean {
  return model.includes("/") && /\.gguf$/i.test(model);
}

/** Reads the model list. llama.cpp has used two shapes for this over time --
 *  OpenAI's `data[].id` and a `models[]` array -- so both are read. Picking
 *  one and missing the other means silently falling back to "local-model",
 *  which is a name the server does not actually have. */
function modelFromListResponse(json: any): string | null {
  const fromData = json?.data?.[0]?.id;
  if (typeof fromData === "string" && fromData) return fromData;
  const fromModels = json?.models?.[0]?.name ?? json?.models?.[0]?.model;
  if (typeof fromModels === "string" && fromModels) return fromModels;
  return null;
}

async function probePort(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DetectedServer | null> {
  const baseUrl = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (url: string): Promise<any | null> => {
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  try {
    const listJson = await get(`${baseUrl}/v1/models`);
    if (!listJson) return null;
    // Fall back to a placeholder name when the list carries no usable id, and
    // DO NOT return null for it. Returning null here would make this port look
    // empty, and the caller would then bind a different port and start a second
    // llama-server beside whatever is already holding this one — the exact
    // out-of-memory the adopt-before-spawn path exists to prevent. A degenerate
    // responder is still a responder occupying the port.
    const model = modelFromListResponse(listJson) ?? "local-model";

    // One extra cheap GET. /props is llama.cpp-specific and is the only way to
    // tell a real llama-server from a stand-in that copied the two endpoints
    // llamacli actually calls.
    const props = await get(`${baseUrl}/props`);
    if (typeof props?.build_info === "string" && props.build_info) {
      return { baseUrl, model, verified: "llama.cpp" };
    }

    // No llama.cpp marker. If it names a .gguf that is not on disk, the API
    // answers but the weights do not exist -- a test double.
    const namedPath =
      (typeof props?.model_path === "string" && props.model_path) ||
      (looksLikeGgufPath(model) ? model : "");
    if (namedPath) {
      const { stat } = await import("node:fs/promises");
      const exists = await stat(namedPath).then((s) => s.isFile(), () => false);
      if (!exists) {
        return {
          baseUrl,
          model,
          verified: "stub",
          reason:
            `포트 ${port} 에서 API 는 응답하지만 그 모델 파일이 디스크에 없습니다: ${namedPath}. ` +
            `테스트용 더블 서버(CI 픽스처 등)가 llama.cpp 서버 자리를 차지한 것으로 보입니다. ` +
            `llamacli 는 이 서버에 연결하지 않습니다 — 정식 llama-server 를 띄우거나 그 포트를 비워 주세요.`,
        };
      }
    }

    return { baseUrl, model, verified: "other" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probes local ports in parallel and returns the first one that answers
 *  with a valid OpenAI-compatible /v1/models response, or null if none do.
 *  Never throws — a failed detection is not an error. `ports` defaults to
 *  COMMON_PORTS but is overridable for testing against non-privileged
 *  fake servers instead of real fixed ports.
 *
 *  A server classified as a **stub** is skipped. That is the whole point of the
 *  `verified` field: on this machine `harnessCli`'s CI fixture
 *  (`fake-llama-server.mjs`, configured via HARNESSIDE_LLAMA_SERVER) held port
 *  8080, answered /health and /v1/models perfectly, and returned a canned
 *  "가짜 응답입니다." to everything. Adoption existed to avoid spawning a SECOND
 *  llama-server — a real hazard, since a second one on an 8 GB card OOMs — but
 *  adopting a test double is not better than the alternative. A stub is not
 *  adopted and is not treated as "some server found"; it is reported, via
 *  `findStubServers`. */
export async function detectRunningServer(
  host = "127.0.0.1",
  ports: number[] = COMMON_PORTS
): Promise<DetectedServer | null> {
  const results = await Promise.all(ports.map((port) => probePort(host, port)));
  const found = results.filter((r): r is DetectedServer => r !== null);
  return found.find((r) => r.verified !== "stub") ?? null;
}

/** Every stub found on the probed ports, so the caller can SAY why it refused
 *  instead of silently moving on and looking like "no server found". */
export async function findStubServers(
  host = "127.0.0.1",
  ports: number[] = COMMON_PORTS
): Promise<DetectedServer[]> {
  const results = await Promise.all(ports.map((port) => probePort(host, port)));
  return results.filter((r): r is DetectedServer => r?.verified === "stub");
}

/** How long to keep re-probing a port that is LISTENING but not yet serving.
 *
 *  A llama-server binds its port before the model finishes loading, and answers
 *  nothing until the weights are resident. Treating "listening but silent" as
 *  "not there" is what made llamacli plan a different port and spawn a second
 *  server beside a perfectly good one — on the machine this was written for,
 *  the running server already held 7.2 GB of an 8 GB card, so the second one
 *  OOMed on load.
 *
 *  The signal is deliberately narrow: the port must ACCEPT a TCP connection.
 *  A connection refused is a definitive "nothing is here" and is never retried;
 *  only a silent listener is given time. */
const LOADING_WAIT_MS = 120_000;
const LOADING_POLL_MS = 1000;

/** Conservative read throughput for a cold model load, in bytes/second.
 *
 *  100 MB/s — a slow USB 3.0 external SSD. The model on the machine this was
 *  written for lives on one, and picking a fast number here would mean a budget
 *  shorter than the load it is meant to cover, which is the bug in a different
 *  coat. A load from an internal NVMe finishes well inside the budget; a load
 *  from a slow drive still does, and the cost of over-estimating is only that
 *  llamacli waits a little longer before giving up on someone else's server. */
const COLD_READ_BYTES_PER_SEC = 100 * 1024 * 1024;

/** How long to wait for a server that is loading a model of this size.
 *
 *  A fixed 2 minutes is shorter than loading a 21.8 GB model off a USB drive, so
 *  the wait expired while the load was still going and the caller fell through
 *  to spawning. Scaling by size is the only input that actually predicts the
 *  duration. The floor keeps a small model's wait sane, and the ceiling keeps a
 *  pathological size from parking a launch indefinitely.
 */
export function modelLoadBudgetMs(modelBytes: number): number {
  const GiB = 1024 ** 3;
  const readSeconds = (modelBytes / COLD_READ_BYTES_PER_SEC) * 1000;
  // Plus a minute for allocation, context setup and the first CUDA graph build,
  // none of which are I/O bound.
  const budget = readSeconds + 60_000;
  return Math.min(20 * 60_000, Math.max(LOADING_WAIT_MS, budget));
}

/** Polls a port that is accepting connections but not yet answering HTTP.
 *
 *  Returns the first successful probe, or null when the budget runs out. Kept
 *  separate from `probePort` so the "is it listening" test and the "is it
 *  serving" test stay distinguishable. */
export async function waitForServer(
  host: string,
  port: number,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    probeTimeoutMs?: number;
    onWait?: (waitedMs: number) => void;
  } = {}
): Promise<DetectedServer | null> {
  const budget = opts.timeoutMs ?? LOADING_WAIT_MS;
  const poll = opts.pollMs ?? LOADING_POLL_MS;
  const start = Date.now();
  let announced = 0;
  for (;;) {
    const hit = await probePort(host, port, opts.probeTimeoutMs);
    if (hit) return hit;
    const waited = Date.now() - start;
    if (waited >= budget) return null;
    // Report the wait at most every 30 s: a multi-minute model load is normal,
    // and a status line that updates every second hides everything above it.
    if (waited - announced >= 30_000) {
      announced = waited;
      opts.onWait?.(waited);
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** What discovery found, including the case that must never be collapsed into
 *  "absent".
 *
 *  `loading` is the load-bearing variant. Collapsing it into `none` is what let
 *  a healthy server be written off as absent, and the caller then claimed a
 *  different port and spawned a second one — on a card that could not hold both.
 *  A caller that receives `loading` knows a port is TAKEN and must not bind it.
 */
export type Discovery =
  | { kind: "found"; server: DetectedServer }
  | { kind: "loading"; baseUrl: string; port: number; waitedMs: number }
  /** Every listening port answered the API but has no real model behind it —
   *  a CI fixture holding the canonical port. Distinct from `none` so the
   *  caller can say WHY it refused instead of looking like an empty machine. */
  | { kind: "stub"; baseUrl: string; port: number; reason: string }
  | { kind: "none" };

/** Finds a running server, waiting out one that is still loading its model.
 *
 *  This is the entry point the bootstrap should use. The distinction it makes
 *  is the whole point: "nothing is listening on 8080" and "something is
 *  listening on 8080 and is 40 seconds into a 21 GB load" look identical to a
 *  single fast probe, and only the second one must not be answered by spawning
 *  a rival server.
 *
 *  Ports are probed in order, and the first that answers wins — the ordering
 *  still decides *which* server, but a port that is loading is waited on rather
 *  than passed over, because a lower-numbered port that is mid-load is far more
 *  likely to be the intended one than a higher-numbered port that happens to be
 *  up. Bounded per port so a permanently-silent listener cannot hang a launch
 *  forever; when the budget runs out the port is reported as `loading` rather
 *  than as free, because it is held.
 */
export async function discoverRunningServer(
  host = "127.0.0.1",
  ports: number[] = COMMON_PORTS,
  opts: {
    loadingWaitMs?: number;
    probeTimeoutMs?: number;
    pollMs?: number;
    onWait?: (port: number, waitedMs: number) => void;
  } = {}
): Promise<Discovery> {
  const budget = opts.loadingWaitMs ?? LOADING_WAIT_MS;
  // Probe every port once, fast, in parallel.
  const first = await Promise.all(ports.map((port) => probePort(host, port, opts.probeTimeoutMs)));
  // A STUB is not a serving server. Adopting one means talking to a test
  // double that answers every request with a canned string, so it is filtered
  // out here exactly as it is in detectRunningServer -- and it is deliberately
  // NOT added to `listeners` below, because a stub will never finish loading a
  // model it does not have; waiting out the whole budget on one is how a
  // first launch comes to look hung.
  const stubs = first.filter((r): r is DetectedServer => r?.verified === "stub");
  const serving = first.find((r): r is DetectedServer => r !== null && r.verified !== "stub");
  if (serving) return { kind: "found", server: serving };

  // Nothing is serving. Now find out which ports are merely LISTENING, and
  // give those a chance to finish loading.
  const listeners: number[] = [];
  await Promise.all(
    ports.map(async (port, i) => {
      if (first[i] !== null) return;
      if ((await isListening(host, port)) === "in-use") listeners.push(port);
    })
  );
  listeners.sort((a, b) => a - b);
  for (const port of listeners) {
    const startedAt = Date.now();
    const hit = await waitForServer(host, port, {
      timeoutMs: budget,
      pollMs: opts.pollMs,
      probeTimeoutMs: opts.probeTimeoutMs,
      onWait: (waited) => opts.onWait?.(port, waited),
    });
    if (hit) return { kind: "found", server: hit };
    // Out of budget and still silent. The port is HELD — by a server that is
    // almost certainly mid-load — so it is reported as such. Returning `none`
    // here is what let the caller plan a different port and bind a second
    // llama-server onto the same GPU.
    return { kind: "loading", baseUrl: `http://${host}:${port}`, port, waitedMs: Date.now() - startedAt };
  }
  // Only reachable when every listening port was a stub. `none` alone would be
  // indistinguishable from "nothing is running", which is what makes a test
  // double holding 8080 look like an empty machine.
  return stubs.length > 0
    ? { kind: "stub", baseUrl: stubs[0].baseUrl, port: Number(new URL(stubs[0].baseUrl).port), reason: stubs[0].reason ?? "" }
    : { kind: "none" };
}

/** Whether a TCP connection is accepted. Distinct from an HTTP probe. */
export async function isListening(
  host: string,
  port: number
): Promise<"in-use" | "free" | "unknown"> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    // Short: a firewall that DROPs rather than REJECTs would otherwise hang
    // for the OS default (~2 min) per port.
    const timer = setTimeout(() => { socket.destroy(); resolve("unknown"); }, 400);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("in-use"); });
    socket.once("error", () => { clearTimeout(timer); resolve("free"); });
    socket.connect(port, host);
  });
}

/** Asks an already-known baseUrl (from an existing config.yaml) which model
 *  it currently has loaded, via the same /v1/models endpoint. Unlike
 *  detectRunningServer this doesn't scan ports — it's for refreshing a
 *  config's `model` field on every load so swapping the model file on the
 *  server (e.g. re-quantizing, switching checkpoints) doesn't leave a
 *  stale name sitting in every project's config.yaml. Returns null (never
 *  throws) if the server is unreachable or the response is malformed, so
 *  callers can fall back to the last-known value instead of breaking
 *  offline use. */
export async function detectModelAt(baseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) return null;
    // Both shapes, for the same reason probePort reads both: this value is
    // written into every project's config.yaml as the live model name, so
    // missing the `models[]` variant records a name the server never reported.
    const json = await res.json();
    return modelFromListResponse(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
