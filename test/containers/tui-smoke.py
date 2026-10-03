#!/usr/bin/env python3
"""Starts the REAL built CLI in a pty under different terminal/home/locale conditions and checks that it comes up
and stays up (no crash, no stack trace on screen). Always runs in an empty temp project: it never answers the
resume prompt and never touches a real project.

    python3 test/containers/tui-smoke.py [variant ...]   (needs `pip install pyte`)
"""
import re, os, pty, pyte, select, struct, fcntl, termios, time, sys, tempfile, shutil, json, stat

DIST = os.environ.get("LLAMACLI_DIST_INDEX", os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../dist/index.js"))
COLS, ROWS = 110, 36
READY_TIMEOUT = int(os.environ.get("SMOKE_READY_TIMEOUT", "30"))

def variants(tmp):
    ro_home = os.path.join(tmp, "ro-home"); os.makedirs(ro_home); os.chmod(ro_home, stat.S_IRUSR | stat.S_IXUSR)
    return {
        "baseline":      dict(env={}),
        "lang-c-dumb":   dict(env={"LANG": "C", "LC_ALL": "C", "TERM": "dumb"}),
        "lang-c-xterm":  dict(env={"LANG": "C", "LC_ALL": "C", "TERM": "xterm"}),
        "ro-home":       dict(env={"HOME": ro_home}),
        "no-home":       dict(env={}, unset=["HOME"]),
        "bad-home":      dict(env={"HOME": "/nonexistent/home"}),
        "no-mouse":      dict(env={"LLAMACLI_MOUSE": "0"}),
    }

def run_variant(name, spec, tmp):
    proj = tempfile.mkdtemp(prefix=f"smoke-{name}-", dir=tmp)
    env = dict(os.environ, TERM="xterm-256color", LLAMACLI_NO_UPDATE="1", COLUMNS=str(COLS), LINES=str(ROWS))
    env.update(spec.get("env", {}))
    for k in spec.get("unset", []): env.pop(k, None)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(proj)
        os.execvpe("node", ["node", DIST], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
    raw = b""; end = time.time() + READY_TIMEOUT; exited = None; ready_at = None
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            raw += d; stream.feed(d)
        shown = "\n".join(screen.display)
        if ready_at is None and re.search(r"CLI\s+v\d", shown) and "%" in shown and ("░" in shown or "...." in shown): ready_at = round(time.time() - (end - READY_TIMEOUT), 1)
        if ready_at is not None and time.time() - (end - READY_TIMEOUT) > ready_at + 2: break
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: exited = os.waitstatus_to_exitcode(status); break
    text = "\n".join(l.rstrip() for l in screen.display if l.strip())
    alive = exited is None
    if alive:
        try: os.write(fd, b"\x03"); time.sleep(0.5); os.write(fd, b"\x03"); time.sleep(0.5)
        except Exception: pass
        for sig in (15, 9):
            try: os.kill(pid, sig)
            except Exception: break
            t_end = time.time() + 2
            while time.time() < t_end:
                try: done, _ = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError: done = pid
                if done: break
                time.sleep(0.1)
            else: continue
            break
    try: os.close(fd)
    except Exception: pass
    bad = [w for w in ("TypeError", "ReferenceError", "ENOENT", "EACCES", "EROFS", "Unhandled", "    at ") if w in text]
    banner = ready_at is not None  # the TUI frame itself, not merely a startup notice that mentions "llamacli"
    ok = alive and banner and not bad
    return dict(id=name, ok=ok, ready_seconds=ready_at, alive=alive, exit=exited, banner=banner, errors_on_screen=bad, screen_tail=text.splitlines()[-6:])

if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="llamacli-smoke-")
    try:
        specs = variants(tmp); only = set(sys.argv[1:])
        results = [run_variant(n, s, tmp) for n, s in specs.items() if not only or n in only]
    finally:
        os.chmod(os.path.join(tmp, "ro-home"), 0o700)
        shutil.rmtree(tmp, ignore_errors=True)
    for r in results:
        print(("PASS" if r["ok"] else "FAIL"), r["id"].ljust(14), f"alive={r['alive']} tui_ready_after={r['ready_seconds']}s errors={r['errors_on_screen']}")
        if not r["ok"]: print("      screen tail:", " | ".join(r["screen_tail"]))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"); os.makedirs(out, exist_ok=True)
    json.dump(results, open(os.path.join(out, "tui-smoke.json"), "w"), ensure_ascii=False, indent=2)
    sys.exit(0 if all(r["ok"] for r in results) else 1)
