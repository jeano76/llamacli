#!/usr/bin/env python3
"""
T0-1 / T0-2 / T0-3 / T0-5 — can a decision model be used here at all?

Run with the venv python and HF_HOME pointed at the NVMe copy:

  CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=2 \
  HF_HOME=/media/jeano/nvme-usb/hf-laya \
  .llamacli/laya-venv/bin/python scripts/t0_laya_cpu_check.py

First run (2026-10-04) found two defects in this file, both fixed here and both
worth stating because they are the kind that make a gate pass for the wrong
reason:
  - it kept every candidate Agent alive, so the "resident memory" figure was
    measured with TWO models loaded and came out 2x too high;
  - the question dicts were missing `instructions`, so the latency sweep never
    ran at all.
"""
import gc
import os
import statistics
import sys
import time

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HOME", "/media/jeano/nvme-usb/hf-laya")

MODEL = "convaiinnovations/laya"


def rss_mib() -> float:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return -1.0


def banner(text: str) -> None:
    print("\n" + "=" * 78)
    print(text)
    print("=" * 78)


import torch  # noqa: E402

import laya  # noqa: E402

# ── T0-1 ────────────────────────────────────────────────────────────────────
banner("T0-1  load on CPU only")
print(f"CUDA_VISIBLE_DEVICES = {os.environ.get('CUDA_VISIBLE_DEVICES')!r}")
print(f"torch {torch.__version__}  cuda_available={torch.cuda.is_available()}")
print(f"laya {getattr(laya, '__version__', '(n/a)')}  QTYPES={laya.QTYPES}")

base_rss = rss_mib()
print(f"RSS after imports (torch included, no model): {base_rss:.0f} MiB")

variants = [
    {"device": "cpu"},
    {"device": "cpu", "fast": True},
    {"device": "cpu", "subfolder": "typed-decisions"},
]
load_results = []
for kwargs in variants:
    label = ", ".join(f"{k}={v}" for k, v in kwargs.items())
    try:
        t0 = time.perf_counter()
        candidate = laya.load(MODEL, **kwargs)
        load_s = time.perf_counter() - t0
        rss = rss_mib()
        print(f"  OK   laya.load({label})  {load_s:5.1f}s  RSS={rss:.0f} MiB  (+{rss - base_rss:.0f})")
        load_results.append((label, load_s, rss, candidate))
        # Keep exactly ONE agent alive. Holding every candidate is what made the
        # first run of this script report 3,682 MiB for a model that costs 1,645.
        for _, _, _, other in load_results[:-1]:
            del other
        gc.collect()
    except Exception as exc:  # noqa: BLE001
        print(f"  FAIL laya.load({label})  {type(exc).__name__}: {str(exc)[:130]}")

if not load_results:
    print("\nT0-1 FAILED: no CPU load path works. Every other track is void.")
    sys.exit(2)

kept_label, load_s, loaded_rss, runner = load_results[0]
banner("T0-3  resident memory vs the 1.5 GiB budget")
print(f"  variant kept              {kept_label}")
print(f"  load time                 {load_s:.1f} s")
print(f"  weights on disk           {842_609_220 / 1048576:.0f} MiB")
print(f"  RSS before load           {base_rss:.0f} MiB")
print(f"  RSS after load            {loaded_rss:.0f} MiB")
print(f"  attributable to the model {loaded_rss - base_rss:.0f} MiB")
BUDGET_MIB = 1536
verdict = "WITHIN" if (loaded_rss - base_rss) <= BUDGET_MIB else "OVER"
print(f"  budget                    {BUDGET_MIB} MiB  -> {verdict}")
print(f"  (whole process, incl. the {base_rss:.0f} MiB torch import: {loaded_rss:.0f} MiB)")

# ── T0-2 ────────────────────────────────────────────────────────────────────
banner("T0-2  decision latency on this box (threads sweep)")

STATE = (
    "리팩터링이 변경했습니다. 그 테스트는 3번 실패했습니다. "
    "그런데 왜 실패했는지 로그가 없어서 다시 돌려서 확인해야 합니다."
)
# Format per Agent._check_question: `instructions` is required; a choice takes
# `criteria` as a list of labels; a noul takes `criteria` keyed only true/false.
QUESTIONS = {
    "bucket": {
        "type": "choice",
        "instructions": "Classify how much reasoning this request needs.",
        "criteria": ["trivial", "normal", "hard"],
    },
    "needs_repo_read": {
        "type": "noul",
        "instructions": "Does answering this require reading files in the repository?",
        "criteria": {"true": "the answer depends on repository contents", "false": "it can be answered from the message alone"},
    },
}

results = {}
for threads in (1, 2, 4):
    torch.set_num_threads(threads)
    try:
        for _ in range(3):  # warm-up: the first call pays lazy init
            laya.decide(runner, STATE, questions=QUESTIONS, return_details=True)
    except Exception as exc:  # noqa: BLE001
        print(f"  threads={threads}  FAILED: {type(exc).__name__}: {str(exc)[:140]}")
        continue
    times = []
    for _ in range(20):
        t0 = time.perf_counter()
        laya.decide(runner, STATE, questions=QUESTIONS, return_details=True)
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    p50 = statistics.median(times)
    p95 = times[int(len(times) * 0.95)]
    results[threads] = p50
    print(f"  threads={threads}  p50={p50:8.2f} ms   p95={p95:8.2f} ms   RSS={rss_mib():.0f} MiB")

if results:
    bt = min(results, key=results.get)
    print(f"\n  best: threads={bt} at {results[bt]:.2f} ms p50")
    for t, v in sorted(results.items()):
        share = v / 75_900 * 100
        print(f"    threads={t}: {v:.1f} ms = {share:.2f}% of the measured 75.9 s main turn")
print("  article references: Tesla T4 'tens of ms', M3 Max 13.4 ms (en) / 7.4 ms")
print("  (multilingual). Neither is a CPU number; this box is the CPU case.")

# ── T0-5 ────────────────────────────────────────────────────────────────────
banner("T0-5  separation on Korean input vs the random baseline")

# Hand-built, n=30. WEAK BY CONSTRUCTION and labelled as such: a smoke test for
# "does anything separate at all", not a benchmark. A real corpus has to come
# from labelled sessions (doc section 3.5) before any of this is adopted.
KOREAN = [
    ("이 파일 3번째 줄이 뭔지 알려줘", 0), ("pytest 돌려줘", 0), ("git status 좀", 0),
    ("README에 설치 방법이 있는지 찾아줘", 0), ("package.json의 의존성 목록 보여줘", 0),
    ("테스트를 추가해줘", 0), ("타입 에러 고쳐줘", 0), ("이 함수를 설명해줘", 0),
    ("JSON 파싱 에러가 왜 나지?", 0), ("로그에서 에러 찾아줘", 0),
    ("코드 스타일을 맞춰줘", 0), ("설치 스크립트 고쳐줘", 0),
    ("npm 의존성 중 뭐가 outdated 야?", 0), ("테스트 커버리지 확인해줘", 0),
    ("이 버그의 근본 원인을 분석해서 고쳐줘", 1), ("아키텍처를 다시 설계하고 마이그레이션 계획을 세워줘", 1),
    ("성능 병목을 찾아서 최적화해줘", 1), ("보안 취약점을 점검해줘", 1),
    ("이거 왜 동작하지 않지?", 1), ("컴팩션 로직을 리팩터링해줘", 1),
    ("서버가 왜 500을 반환해?", 1), ("메모리 누수 Investigate 해줘", 1),
    ("이 PR 리뷰해줘", 1), ("데이터베이스 스키마를 바꿔줘", 1),
    ("설정 파일 문서 만들어줘", 1), ("왜 느린지 프로파일링해줘", 1),
    ("API 문서화해줘", 1), ("빌드 속도를 개선해줘", 1), ("새 모듈 만들어줘", 1),
    ("README 번역해줘", 1),
]

Q = {"hard": {"type": "noul", "instructions": "Does this request need deep reasoning?"}}


def _p_true(entry):
    """A noul's probabilities come back keyed {'true':…, 'false':…}, not as a
    bare float. Reading them as a float is a TypeError at best and a silent 0.0
    at worst; the first run of this script hit exactly that."""
    if isinstance(entry, dict):
        if "true" in entry:
            return float(entry["true"])
        vals = [v for v in entry.values() if isinstance(v, (int, float))]
        return float(max(vals)) if vals else 0.5
    return float(entry)


probs = []
for text, label in KOREAN:
    det = laya.decide(runner, text, questions=Q, return_details=True)
    p = getattr(det, "probabilities", None) or {}
    probs.append((text, label, _p_true(p.get("hard"))))

pos = [p for _, lb, p in probs if lb == 1]
neg = [p for _, lb, p in probs if lb == 0]
mean_pos, mean_neg = statistics.mean(pos), statistics.mean(neg)
margin = mean_pos - mean_neg

print(f"  checkpoint: repo root (default), Korean input")
print(f"  n={len(KOREAN)} (hand-built)  positive={len(pos)}  negative={len(neg)}")
print(f"  mean P(hard) on hard items   {mean_pos:.4f}")
print(f"  mean P(hard) on easy items   {mean_neg:.4f}")
print(f"  MARGIN                       {margin:+.4f}")
print( "  bar: >= 0.25 (the deleted gate's own bar; its four meta-questions")
print( "        scored 0.09-0.22 and the gate was removed)")
print()
best = None
for t in [x / 100 for x in range(30, 96, 5)]:
    tp = sum(1 for p in pos if p >= t)
    fp = sum(1 for p in neg if p >= t)
    flips = tp + fp
    if flips < 2:
        continue
    precision = tp / flips
    print(f"  t={t:.2f}  flips={flips:2d}/{len(KOREAN)}  precision={precision:.2f}  recall={tp / len(pos):.2f}")
    if best is None or precision > best[1]:
        best = (t, precision, flips)

print()
if margin >= 0.25:
    print("  margin >= 0.25: something separates on Korean. T2/T4 become buildable.")
else:
    print(f"  margin {margin:+.4f} < 0.25: NOTHING separates on this corpus.")
    print("  Per the article (random 0.318 vs zero-shot 0.36) that is the expected")
    print("  result without fine-tuning -> T7, not a green light.")
if best:
    print(f"  best operating point: t={best[0]:.2f} precision={best[1]:.2f} over {best[2]} flips")
    print("  (doc section 3.3: a low-accuracy classifier is usable ONLY if the")
    print("   positive class is narrow, precision is high, flips are rare, and a")
    print("   miss falls back safely. Judge it on those, not on accuracy.)")

print("\nDONE.")