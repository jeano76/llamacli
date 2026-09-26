import re, subprocess, sys

# Mirror Node runLayaGate stdout parse: /^short-circuit$/i on split(/\r?\n/)[0].
def gate_skip(stdout_text):
    first = stdout_text.split("\r\n" if "\r\n" in stdout_text else "\n")[0]
    return re.match(r"^(?:SKIP|SHORT-CIRCUIT|SHORTCIRCUIT)$", first, re.IGNORECASE) is not None

def run(argv):
    r = subprocess.run([sys.executable, "/home/jeano/llamacli_plugin/scripts/laya_integration.py", "fastcheck"] + argv,
                       capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout, r.stderr

cases = [
    ("trivial yes (allow-listed)", ["--short-circuit-only", "--text", "print hello"], True),
    ("ambiguous question (deny)",  ["--short-circuit-only", "--text", "Is this operation reversible and destructive? verify carefully"], False),
    ("empty text -> deny",         ["--short-circuit-only", "--text", ""], False),
]

all_ok = True
for name, argv, expected in cases:
    rc, out, err = run(argv)
    line1 = out.splitlines()[0] if out.strip() else "(empty stdout)"
    skip = gate_skip(out)
    ok = (skip == expected) and rc == 0
    all_ok &= ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: rc={rc} line1={line1!r} skip={skip} expect_skip={expected}")
    if err.strip():
        print("     stderr:", err.strip()[:200])

print("\nALL PASS" if all_ok else "\nSOME FAILED")
sys.exit(0 if all_ok else 1)
