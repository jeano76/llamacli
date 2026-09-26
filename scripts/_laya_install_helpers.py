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
    """Resolve the laya venv root (defaults to project-local `.llamacli/laya-venv`)."""
    if venv_root is not None:
        return Path(venv_root)
    return Path.cwd() / ".llamacli" / LAYA_VENV_NAME


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


def install_laya() -> bool:
    """Create project-local venv and install laya[serve] (uv if available).

    Isolated at the laya layer only. On any failure print an actionable message
    and return False; core llamacli and the Ornith path stay untouched.
    """
    base = Path.cwd() / ".llamacli" / LAYA_VENV_NAME
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
        installer = ["uv", "pip", "install", "laya[serve]"]
    else:
        installer = [str(python), "-m", "pip", "install", "laya[serve]"]
    try:
        subprocess.run(installer, check=True, capture_output=True, timeout=600)  # noqa: S603
    except Exception as exc:  # noqa: BLE001
        print(f"[laya] install failed. Fix manually with:\n"
              f"    uv venv .llamacli/{LAYA_VENV_NAME}\n"
              f"    uv pip install laya[serve]\n(detail: {exc})", file=sys.stderr)
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
    """Start ``<venv-python> -m laya serve``; return (proc, port).

    Progress is printed live so the UI output window shows install/boot status.
    On failure print an actionable message and raise; core llamacli untouched.
    """
    python = venv_python_path()
    if not python or not python.exists():
        raise RuntimeError("laya venv not found; run 'install' first")

    port = int(os.environ.get("LAYA_PORT", "8099"))
    cmd = [str(python), "-m", "laya", "serve"]
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
