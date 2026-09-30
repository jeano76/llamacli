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
}

async function probePort(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DetectedServer | null> {
  const baseUrl = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const model = json.data?.[0]?.id ?? "local-model";
    return { baseUrl, model };
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
 *  fake servers instead of real fixed ports. */
export async function detectRunningServer(
  host = "127.0.0.1",
  ports: number[] = COMMON_PORTS
): Promise<DetectedServer | null> {
  const results = await Promise.all(ports.map((port) => probePort(host, port)));
  return results.find((r): r is DetectedServer => r !== null) ?? null;
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
  const serving = first.find((r): r is DetectedServer => r !== null);
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
  return { kind: "none" };
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
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return json.data?.[0]?.id ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
