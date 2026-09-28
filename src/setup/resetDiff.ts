/**
 * Diffs a freshly-derived config against the loaded one, so `/reset` can say
 * what it actually changed.
 *
 * Extracted from index.tsx because a function that reports the result of a
 * destructive command is exactly the one that deserves a test, and importing
 * index.tsx to test it runs `main()`.
 *
 * The "nothing changed" case is a first-class outcome, not an error: `/reset`
 * on a machine whose settings are already optimal must be able to say so
 * plainly. Without this, a user who re-runs it has no way to distinguish
 * "already optimal" from "silently did nothing".
 */

export function describeReset(next?: Record<string, unknown>, prev?: Record<string, unknown>): string[] {
  if (!next) return [];
  const out: string[] = [];
  const a = (prev ?? {}) as Record<string, any>;
  const b = next as Record<string, any>;
  if (a.model !== b.model) out.push(`모델: ${a.model ?? "(없음)"} → ${b.model ?? "(없음)"}`);
  for (const key of ["gpuLayers", "threads", "contextSize", "cpuMoeLayers", "port", "batchSize", "parallel"]) {
    if (a.llama?.[key] !== b.llama?.[key]) {
      out.push(`llama.${key}: ${a.llama?.[key] ?? "(없음)"} → ${b.llama?.[key] ?? "(없음)"}`);
    }
  }
  if (a.laya?.port !== b.laya?.port) out.push(`laya.port: ${a.laya?.port ?? "(없음)"} → ${b.laya?.port ?? "(없음)"}`);
  if (a.baseUrl !== b.baseUrl) out.push(`baseUrl: ${a.baseUrl ?? "(없음)"} → ${b.baseUrl ?? "(없음)"}`);
  if (a.backend !== b.backend) out.push(`backend: ${a.backend ?? "(없음)"} → ${b.backend ?? "(없음)"}`);
  return out;
}
