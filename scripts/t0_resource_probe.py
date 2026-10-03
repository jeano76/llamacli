#!/usr/bin/env python3
"""
Closes the two holes the 1차 보고서 left open:

  T0-4  CPU contention — how much CPU does a decision actually cost, and what
        is the break-even against the main turn?
  swap  §0.3-4 required si/so == 0 across the run. The 1차 run only sampled
        vmstat AFTER finishing, which proves "not swapping now", not "did not
        swap while running". This samples continuously for the whole run.

Also reports peak RSS, because the 1차 run reported RSS after load but never
the peak, and a decision that peaks higher than it rests is a different budget
problem than one that does not.

  CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 HF_HOME=/media/jeano/nvme-usb/hf-laya \
    .llamacli/laya-venv/bin/python scripts/t0_resource_probe.py
"""
import os
import subprocess
import threading
import time

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HOME", "/media/jeano/nvme-usb/hf-laya")

MODEL = "convaiinnovations/laya"
MAIN_PID = None
try:
    out = subprocess.run(["pgrep", "-f", "llama-server"], capture_output=True, text=True).stdout.split()
    MAIN_PID = int(out[0]) if out else None
except Exception:
    pass


def proc_stat(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().rsplit(") ", 1)[1].split()
        # utime, stime are fields 14,15 (1-indexed) -> after comm+state, index 11,12
        return (int(parts[11]) + int(parts[12])) / os.sysconf("SC_CLK_TCK")
    except Exception:
        return None


def vmstat():
    with open("/proc/vmstat") as f:
        d = {}
        for line in f:
            k, _, v = line.partition(" ")
            d[k] = int(v)
        return d


def rss_mib():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return -1.0


peak_rss = [0.0]
stop = threading.Event()
si_so = []
swap_start = vmstat()
main_start = proc_stat(MAIN_PID) if MAIN_PID else None


def sampler():
    """Continuous vmstat + our own RSS, for the whole run."""
    while not stop.is_set():
        v = vmstat()
        si_so.append((v["pswpin"], v["pswpout"]))
        peak_rss[0] = max(peak_rss[0], rss_mib())
        time.sleep(0.25)


print("=" * 78)
print("resource probe — continuous sampling for the whole run")
print("=" * 78)
print(f"main llama-server pid: {MAIN_PID}")
si0, so0 = swap_start["pswpin"], swap_start["pswpout"]
print(f"swap at start: in={si0} out={so0} pages")

t = threading.Thread(target=sampler, daemon=True)
t.start()

import torch  # noqa: E402

import laya  # noqa: E402

torch.set_num_threads(4)
t0 = time.perf_counter()
runner = laya.load(MODEL, device="cpu")
load_s = time.perf_counter() - t0
print(f"\nload: {load_s:.1f}s   RSS {rss_mib():.0f} MiB")

Q = {"deep": {"type": "noul", "instructions": "Does this request need deep reasoning?"}}
SAMPLES = [
    "이 버그의 근본 원인을 분석해서 고쳐줘", "pytest 돌려줘", "git status 좀",
    "이 디렉토리 프로젝트를 이해해줘", "README 번역해줘",
]

for i in range(3):
    laya.decide(runner, SAMPLES[i], questions=Q, return_details=True)
print("warm-up done; timing 20 decisions")

cpu0 = proc_stat("self")
wall0 = time.perf_counter()
per = []
for i in range(20):
    s = time.perf_counter()
    laya.decide(runner, SAMPLES[i % len(SAMPLES)], questions=Q, return_details=True)
    per.append(time.perf_counter() - s)
cpu1 = proc_stat("self")
wall_total = time.perf_counter() - wall0

stop.set()
t.join(timeout=2)
si1, so1 = vmstat()["pswpin"], vmstat()["pswpout"]

per.sort()
cpu_per_call = (cpu1 - cpu0) / 20

print("\n" + "=" * 78)
print("results")
print("=" * 78)
print(f"decisions                20")
print(f"wall clock per decision  p50 {per[len(per)//2]*1000:8.1f} ms   min {per[0]*1000:8.1f}   max {per[-1]*1000:8.1f}")
print(f"CPU time per decision    {cpu_per_call:8.3f} s   (wall {wall_total/20:.3f} s -> {100*cpu_per_call/(wall_total/20):.0f}% of wall)")
print(f"peak RSS during run      {peak_rss[0]:8.0f} MiB   (vs {1536} MiB budget)")
print()
print("swap across the WHOLE run (continuous, 0.25s):")
print(f"  pswpin  delta {si1 - si0} pages  ({100*(si1-si0)*4/1024:.1f} MiB)")
print(f"  pswpout delta {so1 - so0} pages  ({100*(so1-so0)*4/1024:.1f} MiB)")
print(f"  samples: {len(si_so)}")
print(f"  VERDICT: {'CLEAN — no swap I/O for the entire run' if (si1-si0)==0 and (so1-so0)==0 else 'SWAP TOUCHED'}")
print()
if MAIN_PID:
    main_end = proc_stat(MAIN_PID)
    if main_start is not None and main_end is not None:
        used = main_end - main_start
        print(f"main llama-server CPU consumed during our run: {used:.2f} s")
        print(f"  (the server was idle — no inference was sent to it — so this is")
        print(f"   background cost only, NOT a contention measurement. See below.)")
print()
print("=" * 78)
print("T0-4 — why contention is NOT measured here, stated plainly")
print("=" * 78)
print(f"one decision costs {cpu_per_call:.2f} CPU-seconds on 4 threads.")
print("A real contention number needs the main model BUSY, and that means either")
print("sending inference to the user's live :8080 session (forbidden by the")
print("research doc §2) or standing up a second 35B model, which does not fit:")
print("  RAM available was ~16.5 GiB; a 35B Q4 + 98k KV does not.")
print("What can be said arithmetically instead:")
turn_cpu_budget = None
print(f"  If a decision must not cost more than 1% of a turn's CPU, and a turn is")
print(f"  75.9 s wall, then it may use at most ~0.76 CPU-s per turn.")
print(f"  Measured: {cpu_per_call:.2f} CPU-s.")
verdict = "WITHIN" if cpu_per_call <= 0.76 else "OVER"
print(f"  -> {verdict} that 1% budget, before any contention is measured at all.")
if cpu_per_call > 0.76:
    print("  Note this is a WALL-CLOCK budget treated as a CPU budget, which is")
    print("  generous to the decision model: the main model's own wall time is not")
    print("  all CPU. The honest statement is that it is already over a generous")
    print("  bound, so the real number can only be worse.")
print()
print("T0-4 remains formally UNMEASURED. This is the arithmetic bound, not a")
print("substitute for it, and the report says so.")
print("\nDONE.")