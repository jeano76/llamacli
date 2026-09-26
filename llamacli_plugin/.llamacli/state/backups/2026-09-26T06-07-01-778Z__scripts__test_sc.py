import sys
sys.path.insert(0, ".")
from laya_integration import short_circuit_verdict, _make_agent_trace_question

# cfg with short-circuit enabled
cfg = {"shortCircuit": True}

def ans(kind, key, label_or_val, conf):
    # Build a laya answer shaped like the ones extract_answer/_decision_from_answer expect.
    if kind == "noul":
        return {"noul": label_or_val, "probabilities": {}, "answer_confidence": conf}
    if kind == "choice":
        return {key: key, "probabilities": {label_or_val: 1.0}, "answer_confidence": conf}
    raise ValueError(kind)

cases = []

# CASE 1: easy query -> noul yes with high confidence -> should short-circuit (allow=True)
r1 = {"answers": {"decision": ans("noul", None, 0.98, 0.95)}}
cases.append(("easy noul=yes conf=0.95 -> allow", r1, cfg, True))

# CASE 2: easy query -> noul no with high confidence -> should short-circuit (allow=True)
r2 = {"answers": {"decision": ans("noul", None, 0.02, 0.9)}}
cases.append(("easy noul=no conf=0.90 -> allow", r2, cfg, True))

# CASE 3: complex query -> scored middle value, verdict not in allow-list -> reject
r3 = {"answers": {"decision": {"score": 0.53, "probabilities": {}, "answer_confidence": 0.4}}}
cases.append(("complex score=0.53 conf=0.4 -> no-allow", r3, cfg, False))

# CASE 4: noul yes but confidence below threshold -> reject (high raw prob, low calibrated conf)
r4 = {"answers": {"decision": ans("noul", None, 0.7, 0.6)}}
cases.append(("complex conf=0.6 < 0.7 -> no-allow", r4, cfg, False))

# CASE 5: allow-list token 'flag' with high conf -> allow (out-of-box go/no-go tokens)
r5 = {"answers": {"decision": ans("choice", "flag", "flag", 0.92)}}
cases.append(("noul-like choice=flag conf=0.92 -> allow", r5, cfg, True))

# CASE 6: short-circuit disabled -> always reject regardless of confidence
cfg_off = {"shortCircuit": False}
cases.append(("SC disabled -> no-allow", r1, cfg_off, False))

def decision_of(r):
    a = r["answers"]["decision"]
    if "choice" in a: return next(iter(a["choice"].keys())) if isinstance(a.get("choice"), dict) else None
    return None

allok = True
for name, result, c, expected in cases:
    allow_sc, reason = short_circuit_verdict(result, c)
    ok = (allow_sc == expected)
    allok &= ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: got allow={allow_sc}, reason='{reason}'")

# --- agent trace question sanity: types must be in choice|score|noul, never "typed-decisions"
aq = _make_agent_trace_question("instructions text")
ids = set(aq.keys())
expected_ids = {"action", "needs_review", "outcome", "risk", "urgency"}
print(f"\nagent-trace ids: {sorted(ids)}  expected: {sorted(expected_ids)}  match={ids==expected_ids}")
bad_types = []
for qid, q in aq.items():
    if q.get("type") not in ("choice", "score", "noul"):
        bad_types.append((qid, q.get("type")))
print(f"agent-trace invalid types: {bad_types}  (should be empty)")
allok &= (ids == expected_ids) and not bad_types

# --- ensure 'typed-decisions' literal never appears as a question type anywhere ---
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "type" and v == "typed-decisions":
                return True
            if walk(v): return True
    elif isinstance(o, list):
        for x in o:
            if walk(x): return True
    return False

print(f"\n'typed-decisions' present as a question type: {walk(aq)} (should be False)")
allok &= not walk(aq)

print("\nALL PASS" if allok else "\nSOME FAILED")
sys.exit(0 if allok else 1)
