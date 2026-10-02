/**
 * "Will this model actually use the GPU?" — said twice during a model switch: as a plan
 * once the old server has released its VRAM, and as a result read from the new server's
 * own load log. The plan can be wrong (an unexpected process holds memory, a build that
 * lacks the backend), and the log is what really happened, so both are shown.
 */

import type { Hardware } from "./hardware.js";
import { pickPrimaryGpu } from "./hardware.js";
import type { LlamaTuning } from "./tuning.js";

const GiB = 1024 ** 3;

/** The plan, from a hardware reading taken AFTER the old server was stopped. */
export function describeGpuPlan(hw: Hardware, tuning: Pick<LlamaTuning, "gpuLayers" | "contextSize" | "cpuMoeLayers">): string[] {
  const gpu = pickPrimaryGpu(hw);
  if (!gpu) {
    return [
      `GPU: 사용할 수 있는 GPU 가 없습니다 → CPU 전용으로 실행합니다 (${hw.gpuBackend === "none" ? "가속기 미검출" : `${hw.gpuBackend} 백엔드는 있으나 VRAM 정보 없음`}).`,
    ];
  }
  const total = gpu.vramTotalBytes / GiB;
  const free = (gpu.vramFreeBytes > 0 ? gpu.vramFreeBytes : gpu.vramTotalBytes) / GiB;
  const where = gpu.unifiedMemory ? "통합 메모리" : "VRAM";
  const head = `GPU: ${gpu.name} — ${where} ${total.toFixed(1)} GiB 중 ${free.toFixed(1)} GiB 사용 가능 (이전 서버 종료 후 재측정)`;
  if (tuning.gpuLayers <= 0) {
    return [head, "  → GPU 에 올리지 않습니다 (-ngl 0, CPU 전용)."];
  }
  const layers = tuning.gpuLayers >= 999 ? "전체 레이어" : `${tuning.gpuLayers}개 레이어`;
  const moe = tuning.cpuMoeLayers > 0 ? `, MoE expert ${tuning.cpuMoeLayers}개 층은 CPU` : "";
  return [head, `  → GPU 오프로드: ${layers}${moe}, 컨텍스트 ${tuning.contextSize.toLocaleString()} 토큰.`];
}

/**
 * The RESULT, from what the new llama-server itself printed while loading.
 *
 * Matches the three lines llama.cpp prints and nothing speculative: the device it
 * initialised, and `offloaded N/M layers to GPU`. If none are present the report says
 * so rather than assuming the plan held — "asked for -ngl 999" and "the GPU was used"
 * are different facts, and a CPU fallback is silent on a full or unsupported device.
 */
export function summarizeGpuOffload(gpuLog: string, tuning: Pick<LlamaTuning, "gpuLayers">): string {
  const off = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i.exec(gpuLog);
  const device = /(?:using device|found \d+ (?:CUDA|ROCm|Vulkan)[^\n]*|ggml_(?:cuda|vulkan)_init:[^\n]*)\s*([A-Za-z0-9_:() .\-]+)?/i.exec(gpuLog);
  const dev = /using device\s+(\S+)\s*\(([^)]*)\)/i.exec(gpuLog);
  const devText = dev ? `${dev[1]} ${dev[2]}` : undefined;
  if (off) {
    const [n, m] = [Number(off[1]), Number(off[2])];
    if (n === 0) return `GPU 적용: 아니오 — 서버가 레이어를 GPU 에 올리지 않았습니다 (0/${m}). CPU 로 실행 중입니다.`;
    return `GPU 적용: 예 — ${n}/${m} 레이어를 GPU 에 올렸습니다${devText ? ` (${devText})` : ""}.`;
  }
  if (tuning.gpuLayers <= 0) return "GPU 적용: 아니오 — 계획대로 CPU 전용입니다.";
  void device;
  if (/out of memory|cudaMalloc failed|failed to allocate/i.test(gpuLog)) {
    return "GPU 적용: 확인 실패 — 로그에 메모리 부족 흔적이 있습니다.";
  }
  return "GPU 적용: 서버 로그에서 오프로드 결과를 확인하지 못했습니다 (계획은 GPU 오프로드였음).";
}

/** Log lines worth keeping for `summarizeGpuOffload` — the manager's tail buffer drops
 *  the early part of a long load, which is where these are printed. */
export const GPU_LOG_LINE = /offloaded\s+\d+\s*\/\s*\d+\s+layers|using device|ggml_(?:cuda|vulkan)_init|found \d+ (?:CUDA|ROCm|Vulkan)|out of memory|cudaMalloc failed|failed to allocate/i;

/**
 * Waits until `pid` no longer shows up as a GPU compute process, so the next server is
 * sized against memory that is actually free. A process that has exited has released its
 * VRAM, but the driver can lag a moment behind; sizing the new context in that gap reads
 * the old server's memory as still taken. Best-effort: with no nvidia-smi there is
 * nothing to wait for.
 */
export async function waitForGpuRelease(
  pid: number,
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ released: boolean; waitedMs: number }> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 500;
  let waited = 0;
  for (;;) {
    let out: string;
    try {
      out = await run("nvidia-smi", ["--query-compute-apps=pid", "--format=csv,noheader"], 5000);
    } catch {
      return { released: true, waitedMs: waited }; // no NVIDIA tooling: nothing to wait on
    }
    const pids = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!pids.includes(String(pid))) return { released: true, waitedMs: waited };
    if (waited >= timeoutMs) return { released: false, waitedMs: waited };
    await sleep(pollMs);
    waited += pollMs;
  }
}
