/**
 * Remote browser control over the Chrome DevTools Protocol (CDP), so the
 * agent can drive/inspect a browser the user already has running with
 * --remote-debugging-port=<port> — this never launches or manages a
 * browser process itself, only attaches to one that's already listening.
 * Uses Node's built-in WebSocket (stable since Node 22), so no extra
 * dependency is needed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BrowserConfig {
  debugPort: number;
  host?: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function endpoint(config: BrowserConfig): string {
  return `http://${config.host ?? "127.0.0.1"}:${config.debugPort}`;
}

async function listTargets(config: BrowserConfig): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`${endpoint(config)}/json/list`);
  } catch (err: any) {
    throw new Error(
      `couldn't reach the browser debug port at ${endpoint(config)} (${err.message}) — ` +
        `make sure the browser was started with --remote-debugging-port=${config.debugPort}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `couldn't reach the browser debug port at ${endpoint(config)} (${res.status}) — ` +
        `make sure the browser was started with --remote-debugging-port=${config.debugPort}`
    );
  }
  return (await res.json()) as CdpTarget[];
}

async function pickTarget(config: BrowserConfig, targetId?: string): Promise<CdpTarget> {
  const targets = await listTargets(config);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (targetId) {
    const found = pages.find((t) => t.id === targetId);
    if (!found) throw new Error(`no open page tab with id ${targetId}`);
    return found;
  }
  if (pages.length === 0) throw new Error("no open page tabs found on the browser debug port");
  return pages[0];
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  waitForEvent(method: string, timeoutMs?: number): Promise<any>;
  close(): void;
}

/** Default timeout for both connecting and each individual CDP command —
 *  exported so tests can shrink it instead of waiting out the real
 *  default, same pattern as tools/index.ts's RUN_SHELL_TIMEOUT_MS. */
export let CDP_TIMEOUT_MS = 15_000;
export function setCdpTimeoutForTests(ms: number): void {
  CDP_TIMEOUT_MS = ms;
}

/** Opens one CDP WebSocket session for the duration of a single tool call —
 *  simple request/response tool calls don't need a pooled/persistent
 *  connection, so each browser_* call opens, does its work, and closes. */
function openSession(wsUrl: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const eventWaiters = new Map<string, Array<(params: any) => void>>();
    let nextId = 0;

    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out connecting to ${wsUrl}`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        // No timeout here previously — if the browser tab never sends a
        // response for this command id (it crashed, hung, navigated away
        // mid-command, or the connection silently stalled without an
        // actual WebSocket error event), this promise waited forever,
        // hanging the entire agent turn indefinitely. Same class of bug
        // already fixed for run_shell (tools/index.ts) — a tool call must
        // always fail visibly within a bounded time instead of blocking
        // the whole loop. Reuses the same timeoutMs the session's own
        // connect step uses, for a consistent bound across the whole
        // session lifetime rather than a separate magic number.
        send(method, params = {}) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`timed out waiting for a response to ${method} (CDP command id ${id})`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        waitForEvent(method, waitMs = timeoutMs) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), waitMs);
            const list = eventWaiters.get(method) ?? [];
            list.push((params) => {
              clearTimeout(timer);
              res(params);
            });
            eventWaiters.set(method, list);
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener("message", (ev: any) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const waiters = eventWaiters.get(msg.method);
        if (waiters?.length) {
          eventWaiters.set(msg.method, []);
          waiters.forEach((w) => w(msg.params));
        }
      }
    });

    ws.addEventListener("error", (err: any) => {
      clearTimeout(openTimer);
      reject(new Error(`CDP connection error: ${err?.message ?? err}`));
    });
  });
}

async function withSession<T>(
  config: BrowserConfig,
  targetId: string | undefined,
  fn: (session: CdpSession) => Promise<T>
): Promise<T> {
  const target = await pickTarget(config, targetId);
  const session = await openSession(target.webSocketDebuggerUrl!);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function listTabs(config: BrowserConfig): Promise<string> {
  const targets = await listTargets(config);
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return "(no open page tabs)";
  return pages.map((t) => `${t.id}  ${t.title || "(untitled)"}  ${t.url}`).join("\n");
}

export async function navigate(config: BrowserConfig, url: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    await session.send("Page.enable");
    const loaded = session.waitForEvent("Page.loadEventFired", 20_000);
    await session.send("Page.navigate", { url });
    await loaded;
    return `navigated to ${url}`;
  });
}

export async function evaluate(config: BrowserConfig, expression: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    const result = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw");
    }
    const value = result.result?.value;
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

export async function screenshot(config: BrowserConfig, outPath: string, targetId?: string): Promise<string> {
  return withSession(config, targetId, async (session) => {
    const result = await session.send("Page.captureScreenshot", { format: "png" });
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(result.data, "base64"));
    return outPath;
  });
}
