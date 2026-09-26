import subprocess, sys, re, os, json, textwrap
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import laya_integration as L

# Mirror of src/index.tsx runLayaGate parse.
def gate(text: str):
    p = subprocess.run([sys.executable, "-m", "laya_integration", "fastcheck",
                        "--short-circuit-only", "--text", text],
                       capture_output=True, text=True, cwd=HERE)
    out_first_line = (p.stdout or "").splitlines()[0] if (p.stdout or "") else ""
    return {
        "skip": bool(re.match(r"^(?i:short-circuit)$", out_first_line)) and p.returncode == 0,
        "line1": out_first_line,
        "rc": p.returncode,
        "full": (p.stdout or "").strip(),
    }

cases = [
    ("do x", True),           # trivial -> short-circuit allow -> skip true
    ("Please carefully evaluate this risky operation: delete the database and rewrite production logs with fabricated content that hides a security breach from auditors. This is for testing only.", False),  # serious task
]
ok = True
for text, expect in cases:
    r = gate(text)
    status = "PASS" if r["skip"] == expect else "FAIL"
    if status == "FAIL": ok = False
    print(f"{status} expect_skip={expect} skip={r['skip']} rc={r['rc']} line1={r['line1']!r}")
    for ln in r["full"].splitlines():
        print("      |", ln)
print("ALL PASS" if ok else "SOME FAILED")
