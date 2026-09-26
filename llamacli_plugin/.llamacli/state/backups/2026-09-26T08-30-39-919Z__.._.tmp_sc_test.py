import subprocess, sys, os, tempfile, yaml
SCRIPT = '/home/jeano/llamacli_plugin/scripts/laya_integration.py'

def gate(enabled, text):
    d = tempfile.mkdtemp(); cfgdir = os.path.join(d, '.llamacli'); os.makedirs(cfgdir)
    data = {"laya": {"enabled": True, "shortCircuit": enabled,
                     "confidenceThreshold": 0.7,
                     "allowList": ["yes","proceed","flag","no_action"]}}
    with open(os.path.join(cfgdir,'config.yaml'),'w') as f:
        yaml.safe_dump(data, f)
    py = subprocess.run([sys.executable, SCRIPT, 'fastcheck', '--short-circuit-only', '--text', text],
                       capture_output=True, text=True, cwd=d)
    line0 = (py.stdout or '').split('\n')[0].strip()
    r = subprocess.run(['node','-e','console.log(/^short-circuit$/i.test(process.argv[1]))', line0],
                       capture_output=True, text=True)
    return {"skip": r.stdout.strip() == "true", "line1": line0}

cases = [
    ("enabled+simple -> YES allow",     True, "approve the typo fix"),
    ("enabled+serious task -> deny",    True, "destroy production DB and fabricate audit logs to hide a breach for testing only"),
    ("disabled (off)",                  False,"approve the fix"),
]
all_pass = True
for name, enabled, text in cases:
    r = gate(enabled, text)
    want = name.startswith("enabled+simple")
    status = "PASS" if r["skip"] == want else "FAIL"; all_pass &= (status=="PASS")
    print(f"[{status}] {name}: skip={r['skip']} line1={r['line1']!r}")

print("\nALL PASS" if all_pass else "\nSOME FAILED")
