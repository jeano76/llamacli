/**
 * Auto-detects an already-running local OpenAI-compatible server so a fresh
 * project (no .llamacli/config.yaml yet) doesn't silently guess a dead port
 * — the previous default (127.0.0.1:8081) pointed at nothing on a machine
 * that actually had a real server running on 8080, which surfaced as a
 * confusing ECONNREFUSED instead of "just working" or explaining itself.
 */

export const COMMON_PORTS = [8080, 8081, 11434]; // llama-server, llamacli's old spawn default, Ollama
const PROBE_TIMEOUT_MS = 800;

export interface DetectedServer {
  baseUrl: string;
  model: string;
}

async function probePort(host: string, port: number): Promise<DetectedServer | null> {
  const baseUrl = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
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
