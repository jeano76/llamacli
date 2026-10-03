#!/usr/bin/env python3
"""
Verifies scripts/decision_corpus.json against its source, byte for byte.

This exists because it already went wrong once. The hand-transcribed version of
the corpus collapsed whitespace and silently repaired the user's typos — 깋 푸시
멎 became 깃 푸시 머지, `llama.x\\x7fcpp` became `llama.cpp`. For a corpus whose
entire purpose is "what does the decision model do with the input the user
actually typed", editing the input invalidates the measurement while still
producing plausible-looking numbers.

So: `text` is always regenerated from the source by index, and this check fails
loudly if it ever drifts again. Run it before trusting any corpus number.

  python3 scripts/corpus_verify.py
"""
import collections
import json
import sys

SRC = "/home/jeano/llamacli/.llamacli/state/prompt-history.json"
CORPUS = "/home/jeano/llamacli/scripts/decision_corpus.json"
KINDS = {"slash", "ack", "status", "task"}

src = json.load(open(SRC))
corpus = json.load(open(CORPUS))
items = corpus["items"]
problems = []

if corpus.get("n") != len(src):
    problems.append(f"corpus.n={corpus.get('n')} but source has {len(src)}")
if len(items) != len(src):
    problems.append(f"items={len(items)} but source has {len(src)}")

for i, text in enumerate(src):
    if i >= len(items):
        problems.append(f"missing item {i}")
        continue
    it = items[i]
    if it.get("i") != i:
        problems.append(f"index field {it.get('i')} != position {i}")
    if it.get("text") != text:
        problems.append(
            f"DRIFT at {i}: corpus={it.get('text','')[:45]!r} source={text[:45]!r}"
        )
    if it.get("kind") not in KINDS:
        problems.append(f"bad kind at {i}: {it.get('kind')!r}")
    if it.get("kind") != "task" and it.get("deep"):
        problems.append(f"non-task marked deep at {i}")

print(f"source {SRC}")
print(f"  entries: {len(src)}")
print(f"corpus {CORPUS}")
print(f"  items:   {len(items)}")
print()

if problems:
    print(f"FAIL — {len(problems)} problem(s):")
    for p in problems:
        print(f"  - {p}")
    print("\nRegenerate `text` from the source by index; do not retype it.")
    sys.exit(1)

print("PASS — every text is byte-exact from the source, all labels well-formed.")

kinds = collections.Counter(i["kind"] for i in items)
tasks = [i for i in items if i["kind"] == "task"]
deep = sum(1 for i in tasks if i["deep"])
print()
print("surface (what a per-turn gate can even see):")
for k, v in kinds.most_common():
    print(f"  {k:<8}{v:3d}/{len(items)}  {100 * v / len(items):5.1f}%")
print(f"  -> model-bound turns: {len(tasks)}/{len(items)} ({100 * len(tasks) / len(items):.0f}%)")
print()
print("the A1 (thinking-budget) decision's ceiling:")
print(f"  task={len(tasks)}  deep={deep}  shallow={len(tasks) - deep}")
print(f"  a gate can only ever act on the shallow ones: "
      f"{len(tasks) - deep}/{len(items)} = {100 * (len(tasks) - deep) / len(items):.0f}% of all turns")
if len(tasks) - deep < 5:
    print("  WARNING: fewer than 5 positives. Any precision figure computed on this")
    print("  subset is n<5 and is not evidence (research doc §3.2).")