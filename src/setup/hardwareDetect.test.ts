import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHardware, vulkanSummaryHasGpu, APPLE_GPU_MEMORY_FRACTION, type HostProbe } from "./hardware.js";

const GiB = 1024 ** 3;

/** A machine described as data: which commands exist, what they print, which files exist. */
function machine(o: {
  platform?: string;
  arch?: string;
  ramGiB?: number;
  commands?: Record<string, string>; // present tools -> stdout
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}) {
  const commands = o.commands ?? {};
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(" "));
    // tool probe: `sh -c "command -v X"` / `where X`
    if (file === "sh" || file === "where") {
      const tool = file === "sh" ? args[1].replace("command -v ", "") : args[0];
      if (tool in commands) return "/usr/bin/" + tool;
      throw new Error("not found");
    }
    if (file in commands) return commands[file];
    throw new Error(`ENOENT ${file}`);
  };
  const host: Partial<HostProbe> = {
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    ramTotalBytes: (o.ramGiB ?? 16) * GiB,
    ramAvailableBytes: (o.ramGiB ?? 16) * GiB * 0.8,
    cpuCount: 8,
    readText: async (p) => o.files?.[p] ?? null,
    listDir: async (p) => o.dirs?.[p] ?? [],
  };
  return { run, host, calls };
}

test("NVIDIA stays cuda, with the vendor unset-or-nvidia and nvcc deciding canBuildCuda", async () => {
  const m = machine({
    commands: { "nvidia-smi": "0, NVIDIA GeForce RTX 2070 SUPER, 8192, 7456\n", nvcc: "" },
  });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "cuda");
  assert.equal(hw.canBuildCuda, true);
  assert.equal(hw.gpus.length, 1);
  assert.equal(hw.gpus[0].vramTotalBytes, 8192 * 1024 * 1024);
});

test("NVIDIA without nvcc cannot build CUDA but still runs a CUDA prebuilt", async () => {
  const m = machine({ commands: { "nvidia-smi": "0, RTX 4090, 24564, 24000\n" } });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "cuda");
  assert.equal(hw.canBuildCuda, false);
});

test("no GPU at all is cpu / none", async () => {
  const m = machine({});
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "none");
  assert.deepEqual(hw.gpus, []);
});

test("AMD GPU is read from sysfs and picks vulkan without a HIP compiler", async () => {
  const dev = "/sys/class/drm/card1/device";
  const m = machine({
    dirs: { "/sys/class/drm": ["card1", "card1-DP-1", "renderD128"] },
    files: {
      [`${dev}/vendor`]: "0x1002\n",
      [`${dev}/mem_info_vram_total`]: String(20 * GiB) + "\n",
      [`${dev}/mem_info_vram_used`]: String(1 * GiB) + "\n",
    },
  });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "vulkan");
  assert.equal(hw.gpus.length, 1);
  assert.equal(hw.gpus[0].vendor, "amd");
  assert.equal(hw.gpus[0].vramTotalBytes, 20 * GiB);
  assert.equal(hw.gpus[0].vramFreeBytes, 19 * GiB);
  assert.equal(hw.canBuildCuda, false, "an AMD card must never ask for -DGGML_CUDA=ON");
});

test("AMD GPU with hipcc is rocm and can build rocm", async () => {
  const dev = "/sys/class/drm/card0/device";
  const m = machine({
    commands: { hipcc: "" },
    dirs: { "/sys/class/drm": ["card0"] },
    files: { [`${dev}/vendor`]: "0x1002", [`${dev}/mem_info_vram_total`]: String(16 * GiB) },
  });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "rocm");
  assert.equal(hw.canBuildRocm, true);
});

test("an AMD APU that reports no dedicated VRAM is not mistaken for a 0-byte GPU", async () => {
  const dev = "/sys/class/drm/card0/device";
  const m = machine({
    dirs: { "/sys/class/drm": ["card0"] },
    files: { [`${dev}/vendor`]: "0x1002", [`${dev}/mem_info_vram_total`]: "0" },
  });
  const hw = await detectHardware(m.run as never, m.host);
  assert.deepEqual(hw.gpus, []);
});

test("an Intel GPU with no VRAM figure is vulkan for the engine but sized like a CPU box", async () => {
  const m = machine({
    commands: { vulkaninfo: "deviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU\n" },
    dirs: { "/sys/class/drm": ["card0"] },
    files: { "/sys/class/drm/card0/device/vendor": "0x8086" },
  });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "vulkan");
  assert.deepEqual(hw.gpus, []);
});

test("software-only Vulkan (llvmpipe) is not an accelerator", () => {
  assert.equal(vulkanSummaryHasGpu("deviceType = PHYSICAL_DEVICE_TYPE_CPU\n"), false);
  assert.equal(vulkanSummaryHasGpu("deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU\n"), true);
});

test("Apple Silicon is metal, unified memory, and a fraction of RAM — not all of it", async () => {
  const m = machine({ platform: "darwin", arch: "arm64", ramGiB: 24 });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "metal");
  assert.equal(hw.gpus.length, 1);
  assert.equal(hw.gpus[0].vendor, "apple");
  assert.equal(hw.gpus[0].unifiedMemory, true);
  assert.equal(hw.gpus[0].vramTotalBytes, Math.floor(24 * GiB * APPLE_GPU_MEMORY_FRACTION));
  assert.ok(hw.gpus[0].vramTotalBytes < 24 * GiB);
});

test("an Intel Mac has no Metal path here and is cpu", async () => {
  const m = machine({ platform: "darwin", arch: "x64" });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.gpuBackend, "none");
});

test("Windows probes tools with `where`, not the POSIX `command -v`", async () => {
  const m = machine({ platform: "win32", commands: { cmake: "", git: "" } });
  const hw = await detectHardware(m.run as never, m.host);
  assert.equal(hw.tools.cmake, true);
  assert.equal(hw.tools.git, true);
  assert.equal(hw.tools.ninja, false);
  assert.ok(!m.calls.some((c) => c.startsWith("sh ")), "no sh on Windows");
});

import { tuneForHardware } from "./tuning.js";
import type { Hardware } from "./hardware.js";

const baseHw = (over: Partial<Hardware>): Hardware => ({
  cpuCount: 8, ramTotalBytes: 32 * GiB, ramAvailableBytes: 24 * GiB,
  gpus: [], gpuBackend: "none", canBuildCuda: false, tools: {}, platform: "linux", ...over,
});

test("tuning: NVIDIA rationale wording is unchanged", () => {
  const t = tuneForHardware(baseHw({
    gpus: [{ index: 0, name: "RTX 2070 SUPER", vramTotalBytes: 8 * GiB, vramFreeBytes: 7 * GiB }],
    gpuBackend: "cuda",
  }));
  assert.ok(t.rationale.some((r) => r.startsWith("NVIDIA GPU 0번 (RTX 2070 SUPER, VRAM 8.0 GiB) 우선 오프로드")));
});

test("tuning: an AMD card is not called NVIDIA", () => {
  const t = tuneForHardware(baseHw({
    gpus: [{ index: 0, name: "RX 7900", vramTotalBytes: 20 * GiB, vramFreeBytes: 19 * GiB, vendor: "amd" }],
    gpuBackend: "vulkan",
  }));
  assert.ok(t.rationale.some((r) => r.startsWith("AMD GPU 0번")));
  assert.ok(!t.rationale.some((r) => r.includes("NVIDIA")));
});

test("tuning: unified memory never gets --n-cpu-moe, even when the model is larger than the budget", () => {
  const t = tuneForHardware(baseHw({
    gpus: [{ index: 0, name: "Apple", vramTotalBytes: 16 * GiB, vramFreeBytes: 12 * GiB, vendor: "apple", unifiedMemory: true }],
    gpuBackend: "metal",
  }), { modelBytes: 22 * GiB });
  assert.equal(t.cpuMoeLayers, 0);
});
