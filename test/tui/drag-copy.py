#!/usr/bin/env python3
"""A plain (no-Shift) mouse drag in the REAL TUI lands in the OS clipboard.
Drives `node dist/index.js` on a pty (POSIX) / ConPTY (Windows), runs `/server` to put text on screen, sends SGR mouse
reports (press, motion, release) over one row, then reads the system clipboard with the platform's own tool and compares.
Locally it saves and restores the developer's clipboard; in CI it just checks.

    python3 test/tui/drag-copy.py            (env: LLAMACLI_DIST_INDEX to point at another dist/index.js)
"""
import os, re, subprocess, sys, tempfile, time, shutil, pyte
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from term import Term, IS_WIN
from stub import ensure_server

DIST = os.environ.get("LLAMACLI_DIST_INDEX", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "dist", "index.js"))
COLS, ROWS = 120, 40

def read_clipboard():
    def run(cmd):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10)
            return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None
        except Exception:
            return None
    if IS_WIN:
        for sh in ("powershell", "pwsh"):
            v = run([sh, "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])
            if v is not None: return v.replace("\r\n", "\n").rstrip("\n")
        return None
    if sys.platform == "darwin": return run(["pbpaste"])
    if os.environ.get("WAYLAND_DISPLAY"):
        v = run(["wl-paste", "-n"])
        if v is not None: return v
    return run(["xclip", "-selection", "clipboard", "-o"]) or run(["xsel", "--clipboard", "--output"])

def write_clipboard(text):
    if IS_WIN or text is None: return
    cmd = ["pbcopy"] if sys.platform == "darwin" else (["wl-copy"] if os.environ.get("WAYLAND_DISPLAY") else ["xclip", "-selection", "clipboard"])
    try: subprocess.run(cmd, input=text.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception: pass

stub = ensure_server()
proj = tempfile.mkdtemp(prefix="drag-copy-")
before = None if os.environ.get("CI") else read_clipboard()
term = None
rc = 1
try:
    env = dict(os.environ, TERM="xterm-256color", LLAMACLI_NO_UPDATE="1", LLAMACLI_MOUSE="1", COLUMNS=str(COLS), LINES=str(ROWS))
    term = Term(["node", DIST], proj, env, COLS, ROWS)
    screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            d = term.read(0.1)
            if d: stream.feed(d)
    start = time.time()
    while time.time() - start < 40:
        pump(0.3)
        shown = "\n".join(screen.display)
        if re.search(r"CLI\s+v\d", shown) and "%" in shown and ("░" in shown or "...." in shown): break
    else:
        print("FAIL: the TUI did not come up"); print("\n".join(l.rstrip() for l in screen.display if l.strip())[-600:]); raise SystemExit(1)
    pump(1.0)
    for ch in "/server":
        term.write(ch); pump(0.12)
    pump(0.5); term.write("\r"); pump(6)
    target = None
    for i, l in enumerate(screen.display):
        if "[server]" in l: target = i + 1; break
    if not target:
        print("FAIL: /server printed nothing to drag over"); print("\n".join(l.rstrip() for l in screen.display if l.strip())[-600:]); raise SystemExit(1)
    line = screen.display[target - 1]
    c0 = line.index("[server]") + 1
    c1 = c0 + 20
    expected = line[c0 - 1:c1].rstrip()
    term.write(f"\x1b[<0;{c0};{target}M"); pump(0.4)
    for c in range(c0 + 1, c1 + 1, 4):
        term.write(f"\x1b[<32;{c};{target}M"); pump(0.12)
    term.write(f"\x1b[<32;{c1};{target}M"); pump(0.12)
    term.write(f"\x1b[<0;{c1};{target}m"); pump(2.5)
    status = "\n".join(l.rstrip() for l in screen.display if "[복사]" in l)
    got = read_clipboard()
    if got is None:
        print("FAIL: could not read the system clipboard"); raise SystemExit(1)
    if got.strip() != expected.strip():
        print(f"FAIL: clipboard differs\n  expected: {expected!r}\n  got:      {got!r}\n  status:   {status!r}"); raise SystemExit(1)
    print(f"PASS: a plain drag put {len(expected)} chars on the clipboard exactly: {expected!r}")
    print(f"      status line: {status.strip()}")
    rc = 0
except SystemExit as e:
    rc = e.code or 0
finally:
    if term: term.close()
    if stub: stub.terminate()
    write_clipboard(before)
    shutil.rmtree(proj, ignore_errors=True)
sys.exit(rc)
