import sys, os, re, importlib, json
sys.path.insert(0, "/home/jeano/llamacli_plugin/scripts")
import laya_integration as L

def sc(text, cfg):
    return L.short_circuit_verdict(L._canned_sc_result(text, cfg), cfg)

ON = {"shortCircuit": True, "allowList": ["yes","no","proceed","flag","no_action"],
      "confidenceThreshold": 0.7}

# 1) enabled + yes/high-conf -> allow (skip true)
print("enable+yes:", sc("do x", dict(ON)))
# 2) enabled + no/conf -> deny (skip false, line still SHORTCIRCUIT)
print("enable+no: ", sc("", {**ON}))  # empty text -> 'no' label via _canned_sc_result? check
# 3) disabled -> deny
print("disabled:  ", sc("do x", {"shortCircuit": False}))
# 4) low confidence -> deny
LOW = dict(ON); LOW["confidenceThreshold"] = 0.95
print("lowconf:   ", sc("do x", LOW))
# 5) verdict not in allow-list (e.g. "proceed" removed)
NOACT = {**ON, "allowList": ["yes","no"]}
print("off-allow: ", sc("", NOACT))

# confirm _canned_sc_result decision label for empty text
print("empty-answer:", L._decision_from_answer(L._canned_sc_result("", ON)["answers"]["decision"]))
print("text-answer: ", L._decision_from_answer(L._canned_sc_result("do x", ON)["answers"]["decision"]))

# verify Node regex behavior on our line1
for line in ["SHORTCIRCUIT", "Short-circuit", "NOT APPLIED"]:
    print(f"regex {line!r}: ->", bool(re.match(r'^(?i:short-circuit)$', line)))
