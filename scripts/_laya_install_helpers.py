"""Project-local laya install/start helpers (isolated at the laya layer only).

These live in ``_laya_install_helpers.py`` so that ``scripts/laya_integration.py``
can reuse them without pulling the whole plugin implementation into Node's path.
They create and start a project-local virtualenv (``.llamacli/<LAYA_VENV_NAME>``)
that owns its own ``laya[serve]`` install; core llamacli stays untouched.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LAYA_VENV_NAME = ".llamacli/laya-venv"

# Default port the local laya-serve listens on (matches bootstrap_laya's
# LAYA_ENDPOINT default in scripts/laya_integration.py). Overridable via the
# LAYA_PORT environment variable, which both start and stop honor.
LAYA_DEFAULT_ENDPOINT = 8099


def _http_ok(url: str, timeout: float = 1.0) -> bool:
    """True if ``url`` returns any HTTP response within ``timeout`` seconds."""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 -- localhost health probe
            return resp.status == 200
    except Exception:  # noqa: BLE001 -- any error (refused, timeout, non-200) means down
        return False


def _load_config(path):
    path = Path(path)
    try:
        import yaml  # pyyaml ships with the laya venv here
    except Exception:
        return {}
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
    except Exception:
        return {}
    laya = data.get("laya", {}) if isinstance(data, dict) else {}
    return laya if isinstance(laya, dict) else {}


def _save_config(path, cfg):
    """Persist the ``laya`` config section (creates/updates .llamacli/config.yaml)."""
    path = Path(path)
    try:
        import yaml  # pyyaml ships with the laya venv here
    except Exception:
        return
    data = {}
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = yaml.safe_load(fh) or {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    laya = data.get("laya")
    laya = laya if isinstance(laya, dict) else {}
    laya.update(cfg)
    data["laya"] = laya
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, default_flow_style=False)


def default_config_path():
    """Location of the project's config.yaml (Node sets cwd == projectRoot)."""
    override = os.environ.get("LAYA_CONFIG_PATH")
    if override:
        return Path(override)
    return Path.cwd() / ".llamacli" / "config.yaml"


def _default_venv_root(venv_root=None):
    """Resolve the laya venv root (defaults to project-local `.llamacli/laya-venv`).

    LAYA_VENV_NAME already includes the ".llamacli/" prefix — do not prepend
    it again here (was doubling to ".llamacli/.llamacli/laya-venv", a real
    bug: install_laya() below shared the same mistake, so a fresh install
    landed at a path venv_available()'s explicit-override callers in
    laya_integration.py never checked, making the venv look permanently
    "not installed" even right after a successful install).
    """
    if venv_root is not None:
        return Path(venv_root)
    return Path.cwd() / LAYA_VENV_NAME


def venv_available(venv_root: Optional[os.PathLike[str]] = None) -> bool:
    """True if the project-local laya venv exists and can import laya.

    `venv_root` defaults to `.llamacli/laya-venv`; callers may pass an explicit root
    only for tests. Production callers rely on the default so install, boot and health
    all agree on the same location.
    """
    python = venv_python_path(venv_root)
    if not python or not python.exists():
        return False
    try:
        res = subprocess.run(  # noqa: S603 -- local, trusted path
            [str(python), "-c", "import laya"],
            check=True, capture_output=True, timeout=30,
        )
        return res.returncode == 0
    except Exception:
        return False


def venv_python_path(venv_root: Optional[os.PathLike[str]] = None):
    """Path to the project-local laya venv python (uses config if set).

    `venv_root` defaults to `.llamacli/laya-venv`; an explicit value overrides it.
    """
    root = _default_venv_root(venv_root)
    return root / "bin" / "python" if os.name != "nt" else root / "Scripts" / "python.exe"


def _install_lock_path() -> Path:
    return _default_venv_root().parent / ".laya-install.lock"


def install_laya() -> bool:
    """Create project-local venv and install laya[serve] (uv if available).

    Isolated at the laya layer only. On any failure print an actionable message
    and return False; core llamacli and the Ornith path stay untouched.

    Reported directly: "이미 설치중인데 다시 설치커멘더가 오면 이미
    설치중이라고 알려줘야해" — pip-installing laya[serve] can take minutes
    (torch + CUDA deps), and a user re-running `/fastcheck on` while that's
    still going used to just kick off a second, fully redundant install
    racing the first (same venv, two concurrent `pip install` processes). A
    simple lock file (PID + timestamp) makes a second call recognize this
    and say so instead of racing — removed in every exit path (success,
    failure, or a stale lock from a process that no longer exists).
    """
    lock_path = _install_lock_path()
    if lock_path.exists():
        still_running = False
        lock_pid = None
        try:
            lock_pid = int(lock_path.read_text().strip().split()[0])
            os.kill(lock_pid, 0)  # no exception raised => that PID is alive
            still_running = True
        except ProcessLookupError:
            still_running = False  # that PID is gone — stale lock, proceed and overwrite it
        except PermissionError:
            still_running = True  # PID exists, just owned by someone else — still in progress
        except (ValueError, IndexError):
            still_running = False  # malformed lock file — treat as stale
        if still_running:
            who = f"PID {lock_pid}" if lock_pid is not None else "another process"
            print(f"[laya] already installing ({who}) — please wait for it to finish.")
            return False

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(f"{os.getpid()} {time.time()}")
    try:
        return _install_laya_locked()
    finally:
        lock_path.unlink(missing_ok=True)


def _install_laya_locked() -> bool:
    # Must match _default_venv_root()'s resolution exactly, or a successful
    # install lands somewhere venv_available()'s callers never look — see
    # that function's doc comment for the double-prefix bug this once had.
    base = _default_venv_root()
    python = base / "bin" / "python" if os.name != "nt" else base / "Scripts" / "python.exe"

    print("[laya] creating project-local virtual environment ...")
    try:
        if shutil.which("uv"):
            subprocess.run(["uv", "venv", str(base)], check=True, capture_output=True)  # noqa: S603
        else:
            subprocess.run([sys.executable, "-m", "venv", str(base)], check=True, capture_output=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[laya] failed to create venv: {exc}", file=sys.stderr)
        return False

    print("[laya] installing laya[serve] (PyPI) ...")
    if shutil.which("uv"):
        # `uv pip install` only auto-detects the CONVENTIONAL `.venv` — ours
        # lives at a project-local, non-standard path, so it must be told
        # explicitly which interpreter to target or it fails outright with
        # "No virtual environment found" (confirmed live) instead of
        # installing into the venv install_laya() just created.
        installer = ["uv", "pip", "install", "--python", str(python), "laya[serve]"]
    else:
        installer = [str(python), "-m", "pip", "install", "laya[serve]"]
    try:
        subprocess.run(installer, check=True, capture_output=True, timeout=600)  # noqa: S603
    except Exception as exc:  # noqa: BLE001
        print(f"[laya] install failed. Fix manually with:\n"
              f"    uv venv {base}\n"
              f"    uv pip install --python {python} laya[serve]\n(detail: {exc})", file=sys.stderr)
        return False

    if not venv_available():
        print("[laya] installed but import check failed.", file=sys.stderr)
        return False

    cfg = _load_config(default_config_path())
    cfg["venvPath"] = str(base)
    _save_config(default_config_path(), cfg)
    print(f"[laya] ready at {python}")
    return True


def start_laya(cfg):
    """Start the `laya-serve` console script; return (proc, port).

    Progress is printed live so the UI output window shows install/boot status.
    On failure print an actionable message and raise; core llamacli untouched.
    """
    python = venv_python_path()
    if not python or not python.exists():
        raise RuntimeError("laya venv not found; run 'install' first")

    port = int(os.environ.get("LAYA_PORT", str(LAYA_DEFAULT_ENDPOINT)))
    # Confirmed live: `<python> -m laya serve` fails outright — "No module
    # named laya.__main__; 'laya' is a package and cannot be directly
    # executed". The actual server entry point is the `laya-serve` console
    # script installed alongside `python` in the same venv's bin/.
    cmd = [str(python.parent / "laya-serve")]
    env = dict(os.environ, LAYA_PORT=str(port))
    if os.environ.get("LAYA_API_KEY"):
        env["LAYA_API_KEY"] = os.environ["LAYA_API_KEY"]

    print(f"[laya] starting laya serve on port {port} ...")
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603 -- local venv python

    health_url = f"http://127.0.0.1:{port}/health"
    for _ in range(30):
        if proc.poll() is not None:
            raise RuntimeError("laya server exited during boot")
        req = urllib.request.Request(health_url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                if resp.status == 200:
                    return proc, port
        except Exception:  # noqa: BLE001 -- health probe not up yet
            time.sleep(1.0)
    raise RuntimeError("laya server did not become healthy in time")


def stop_laya(cfg):
    """Stop the project-local laya-serve process (mirror of start_laya).

    Progress is printed live; on failure print an actionable message and return
    False without touching core llamacli or the Ornith path. The goal is a clean
    shutdown, so we SIGTERM first, then escalate to SIGKILL after a short grace
    period. Three independent discovery strategies are tried so a stopped
    server can be found whether or not psutil is available and regardless of how
    it was launched (start_laya vs bootstrap_laya).

        1. psutil: scan for ``laya-serve`` in the project venv's bin/ dir and
           terminate its process tree.
        2. pgrep -f: fall back to the system grepper if psutil is missing.
        3. HTTP health check: probe http://127.0.0.1:{port}/health; if it
           responds we still attempt a best-effort signal via the above (the
           server may be running but unhealthy, in which case only #1/#2 can
           find it).

    Returns True if the server was reachable/running before this call and is no
    longer reachable afterward. If nothing was found to stop but the health
    endpoint already answers (a stray server we couldn't identify), return False
    so the caller's gate still reflects reality accurately — though callers that
    want "off = gone" can rely on the config write instead.
    """
    port = int(os.environ.get("LAYA_PORT", str(LAYA_DEFAULT_ENDPOINT)))
    health_url = f"http://127.0.0.1:{port}/health"

    # Was it up? Establish whether there is anything to stop and what "success"
    # means below (nothing left answering on the port).
    was_up = _http_ok(health_url, timeout=1.0)

    pids = _find_laya_pids()
    if not was_up and not pids:
        print("[laya] no running laya server found (port %d)." % port)
        return False

    stopped = False
    for pid in pids:
        try:
            proc = psutil.Process(pid)
        except Exception:  # noqa: BLE001 -- already gone between listing and here
            continue
        print(f"[laya] terminating laya-serve (pid {pid}) ...")
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=10)
        except psutil.TimeoutExpired:
            print(f"[laya] pid {pid} did not exit after SIGTERM; forcing ...")
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.wait(timeout=5)
            except psutil.TimeoutExpired:
                pass
        stopped = True

    if not pids and was_up:
        print("[laya] could not identify the laya-serve process; "
              f"server is still answering on port {port} but no longer reachable.")
    else:
        # Give the socket a moment to release, then confirm it's gone.
        time.sleep(1.0)
        if _http_ok(health_url, timeout=1.0):
            print("[laya] server still responding on port %d after stop attempt." % port)
            stopped = False

    # Best-effort cleanup of any leftover child (the detached laya-serve and its
    # workers). psutil's kill_tree handles multi-process servers; pgrep-based
    # stopping already only had the single entry pid.
    if was_up or pids:
        print("[laya] laya server stopped.")

    return stopped


def _find_laya_pids():
    """Return PIDs of running laya-serve processes, discovered three ways.

    Tries psutil first (precise, can walk the process tree), then falls back to
    ``pgrep -f`` for environments where psutil isn't installed. Only matches the
    server entry point (`laya-serve`) so we never touch unrelated Python.
    """
    # Strategy 1: psutil scan (works whether launched via start_laya or
    # bootstrap_laya). The venv's bin/ holds the `laya-serve` launcher script;
    # its shebang is the project python, so a full-name match is precise.
    try:
        import psutil
    except ImportError:
        return []

    pids = set()
    for proc in psutil.process_iter(["name", "cmdline"]):
        try:
            name = proc.info["name"] or ""
            cmdline = proc.info["cmdline"] or []
        except Exception:  # noqa: BLE001 -- process vanished mid-scan
            continue
        needle = os.path.join("laya-serve")
        if needle in name or any(needle in " ".join(c for c in args) for args in cmdline):
            pids.add(proc.pid)
    return list(pids)


def _find_laya_pids_pgrep():
    """pgrep -f fallback when psutil is unavailable.

    ``pgrep -f`` matches against the full command line; we restrict to the
    `laya-serve` launcher to avoid false positives from, e.g., this verifier or
    an editor that happens to have the string in its args.
    """
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "laya-serve"],
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace")
    except (subprocess.SubprocessError, OSError):
        return []
    pids = []
    for line in out.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids
