import sys; sys.path.insert(0, 'scripts')
from laya_integration import endpoint, _load_config, default_config_path, systemone

cfg = _load_config(default_config_path())

# case A: fastcheck --decision (what the CLI builds)
qA = {"decision": {"type": "noul", "instructions": "read a small local file"}}
print("A decision path:", systemone(endpoint(cfg), "", qA, 10.0, None))

# case B: fastcheck without --decision
qB = _make_question("read a small local file", cfg) if False else {"noul": {"type":"noul","instructions":"read a small local file"}}
print("B default path:", systemone(endpoint(cfg), "", qB, 10.0, None))
