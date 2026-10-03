#!/usr/bin/env python3
"""
T7-0 — the prerequisite, before any fine-tuning: does a gate have anything to act on?

Two questions, in order:

  1. SURFACE. Over this machine's REAL user prompts, how many turns are actual
     requests at all? A per-turn decision gate only sees turns that reach the
     model. If most input is a slash command or a one-word acknowledgement, the
     ceiling on every per-turn gate (A1 thinking budget, A7 skill injection, A4
     compaction routing) is low before any accuracy question is asked.

  2. SEPARATION. On the subset that IS a task, can either checkpoint tell deep
     work from shallow work? This is the A1 decision, on real data rather than
     the hand-built n=30 of T0-5.

  CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 HF_HOME=/media/jeano/nvme-usb/hf-laya \
    .llamacli/laya-venv/bin/python scripts/decision_corpus_bench.py
"""
import collections
import json
import os
import statistics
import time

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HOME", "/media/jeano/nvme-usb/hf-laya")

CORPUS = "/home/jeano/llamacli/scripts/decision_corpus.json"
MODEL = "convaiinnovations/laya"

data = json.load(open(CORPUS))
items = data["items"]


def banner(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


# ── 1. SURFACE ──────────────────────────────────────────────────────────────
banner("1. SURFACE — what actually reaches the model")
counts = collections.Counter(i["kind"] for i in items)
n = len(items)
for k, v in counts.most_common():
    print(f"  {k:<8} {v:3d}/{n}  {100 * v / n:5.1f}%")
tasks = [i for i in items if i["kind"] == "task"]
print(f"\n  -> a per-turn gate sees {len(tasks)}/{n} turns ({100 * len(tasks) / n:.0f}%) as requests.")
print(f"  -> {n - len(tasks)}/{n} ({100 * (n - len(tasks)) / n:.0f}%) never become a model task at all.")

banner("2. SEPARATION — deep vs shallow, on the task subset only")
deep = [i for i in tasks if i["deep"]]
shallow = [i for i in tasks if not i["deep"]]
print(f"  deep={len(deep)}  shallow={len(shallow)}")
print("  A gate's upside is bounded by how many of these it can move cheaply;")
print("  its downside is a wrong call on a turn that mattered.")

import torch  # noqa: E402

import laya  # noqa: E402

Q = {"deep": {"type": "noul", "instructions": "Does this request need deep reasoning: reading code, multi-step work, or judgement?"}}


def p_true(entry):
    if isinstance(entry, dict):
        if "true" in entry:
            return float(entry["true"])
        vals = [v for v in entry.values() if isinstance(v, (int, float))]
        return float(max(vals)) if vals else 0.5
    return float(entry)


# typed-decisions is the FINE-TUNED checkpoint (the article's 0.766 vs the root's
# 0.36 zero-shot). If anything can overturn the T0-5 verdict, it is this one —
# which is why it gets its own run rather than being folded into the others.
for sub in (None, "multilingual", "typed-decisions"):
    label = "root (english)" if sub is None else f"subfolder={sub}"
    try:
        kw = {"device": "cpu"}
        if sub:
            kw["subfolder"] = sub
        t0 = time.perf_counter()
        r = laya.load(MODEL, **kw)
        load_s = time.perf_counter() - t0
    except Exception as exc:  # noqa: BLE001
        print(f"  {label}: LOAD FAILED {type(exc).__name__}: {str(exc)[:90]}")
        continue

    pos, neg = [], []
    per_item = []
    for it in items:
        v = p_true(laya.decide(r, it["text"], questions=Q, return_details=True).probabilities["deep"])
        per_item.append((v, it))
        if it["kind"] == "task":
            (pos if it["deep"] else neg).append(v)

    margin = statistics.mean(pos) - statistics.mean(neg)
    print(f"\n  --- {label} (load {load_s:.1f}s) ---")
    print(f"  task subset: mean P(deep) deep={statistics.mean(pos):.4f}  shallow={statistics.mean(neg):.4f}")
    print(f"  MARGIN {margin:+.4f}   bar 0.25")

    print(f"  {'t':>5} {'flips':>7} {'prec':>6} {'rec':>6}")
    best = None
    for i in range(30, 96, 5):
        th = i / 100
        tp = sum(1 for v in pos if v >= th)
        fp = sum(1 for v in neg if v >= th)
        f = tp + fp
        if f < 1:
            continue
        pr = tp / f
        print(f"  {th:5.2f} {f:4d}/{len(tasks):<3d} {pr:6.2f} {tp / len(pos):6.2f}")
        if best is None or pr > best[1]:
            best = (th, pr, f)
    if best and best[2] >= 5:
        print(f"  best t={best[0]:.2f} precision={best[1]:.2f} over {best[2]} flips "
              f"({100 * best[2] / len(tasks):.0f}% of tasks acted on)")
    elif best:
        print(f"  best t={best[0]:.2f} precision={best[1]:.2f} but only {best[2]} flips — n too small to be evidence (§3.2)")

    print("  the 5 it is most confident are deep:")
    for v, it in sorted(per_item, key=lambda x: -x[0])[:5]:
        mark = "T" if it["kind"] == "task" else "-"
        agree = "" if ((it["kind"] == "task") == (it["deep"])) else "   <-- disagrees with the label"
        print(f"    {v:.3f} [{mark}] {it['text'].strip()[:56]}{agree}")
    del r

print("\nDONE.")