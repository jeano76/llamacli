#!/usr/bin/env python3
"""Llama CLI laya integration — the "System 1" fast-check gate.

This script is spawned by `src/index.tsx` (the Node entry point) and owns the
whole live lifecycle that Node cannot do from inside a bounded spawn:

    * reading/writing this project's config (`.llamacli/config.yaml`, laya section),
    * booting the laya server/venv on demand,
    * waiting for it to become healthy.

Node only bounds how long it will wait for us (laya.timeoutSeconds) and surfaces
our stdout as a status line the model reads. We therefore always print plain,
human-readable prose and keep exit codes honest:

    * 0  -> success / "please read this status" (even a degraded-but-reported state),
    * !=0-> we could not do our job at all; the caller will silently fall back.

Commands
--------
    enable      Enable the gate in config, print guidance if laya is not installed yet.
    disable     Disable the gate in config and stop (no health check).
    status      Print enabled state + integration health. Never fails on degraded.
    fastcheck --text "<user text>"   The gate itself: evaluate userText, print a verdict.

The real laya system is an LLM-agent framework; here we implement a small,
self-contained evaluator so the feature works end-to-end even when no server is
present, while degrading to a safe "proceed" verdict instead of crashing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


# --------------------------------------------------------------------------- #
# Config IO — read/write only the flat `laya:` subsection of .llamacli/config.yaml
# --------------------------------------------------------------------------- #

DEFAULTS = {
    "enabled": False,
    "shortCircuit": True,
    "timeoutSeconds": 30,
    "questionType": "noul",   # noul | choice | score
    "actProbabilityThreshold": 0.20,
    "confidenceThreshold": 0.65,
}


def config_path(args) -> Path:
    """Locate the project's config.yaml.

    Resolution order: --config flag > LAYA_CONFIG_PATH env > <cwd>/.llamacli/config.yaml.
    Node sets cwd == projectRoot before spawning us.
    """
    if getattr(args, "config", None):
        return Path(args.config)
    override = os.environ.get("LAYA_CONFIG_PATH")
    if override:
        return Path(override)
    default = Path.cwd() / ".llamacli" / "config.yaml"
    return default


def load_config(path: Path) -> dict:
    """Read the whole config as a nested dict. Returns {} when missing/empty.

    We depend on PyYAML only lightly and never let an import failure break us; if
    PyYAML is unavailable we fall back to a minimal reader that understands the
    flat `laya:` subsection plus simple top-level keys. That keeps feature parity
    for what this script actually needs.
    """
    if not path.exists():
        return {}

    try:
        import yaml  # type: ignore
    except Exception:
        yaml = None

    def _read_all(text: str) -> dict:
        if yaml is not None:
            parsed = yaml.safe_load(text)
            return parsed if isinstance(parsed, dict) else {}
        return _minimal_yaml_parse(text)

    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = text = fh.read()
        # `text`/`data` reused below; ensure both bound.
        return _read_all(text if "text" in dir() else data)
    except Exception:
        # Malformed YAML: do not crash the caller's status line. Return defaults-empty.
        return {}


def _minimal_yaml_parse(text: str) -> dict:  # pragma: no cover - fallback only
    """Extremely small subset parser, enough for this project's flat config files.

    Understands top-level `key: value` pairs and a single nested mapping block
    (one level deep, e.g. `laya:` / `compaction:`). Booleans and numbers are typed;
    everything else stays a string. This is never used when PyYAML is installed.
    """
    result: dict = {}
    current_key: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if indent == 0 and ":" in line:
            key, _, rest = line.partition(":")
            key = key.strip()
            rest = rest.strip()
            current_key = None if not rest else key
            result[current_key or ""] = _coerce_value(rest)
        elif stripped.startswith("- ") and current_key is not None:  # list item (rare here)
            continue
        elif indent > 0 and ":" in stripped and current_key is not None:
            k, _, v = stripped.partition(":")
            result[current_key] = {k.strip(): _coerce_value(v.strip())}
    return result


def _coerce_value(value: str):
    if value == "":
        return True  # YAML treats a bare key as true; matches our default 'enabled' semantics.
    low = value.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    # Strip surrounding quotes when present.
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[1:-1]
    return value


def laya_section(path: Path) -> dict:
    cfg = load_config(path)
    section = cfg.get("laya") if isinstance(cfg.get("laya"), dict) else {}
    # Merge over defaults so an incomplete `laya:` block still behaves sensibly.
    merged = {**DEFAULTS, **{k: v for k, v in section.items()}}
    return merged


def write_config(path: Path, laya_settings: dict):
    """Update only the `laya:` subsection of config.yaml, preserving everything else."""
    text = ""
    if path.exists():
        text = path.read_text(encoding="utf-8")

    try:
        import yaml  # type: ignore
    except Exception:
        yaml = None

    if yaml is not None:
        parsed = yaml.safe_load(text) if text.strip() else {}
        if not isinstance(parsed, dict):
            parsed = {}
        merged = {**DEFAULTS, **laya_settings}
        parsed["laya"] = sorted_dict(merged)
        # Ensure the target directory exists before writing the atomic temp file.
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            yaml.safe_dump(parsed, fh, sort_keys=False, default_flow_style=False)
        os.replace(str(tmp), str(path))
    else:  # pragma: no cover - fallback path; append a laya block if missing.
        if not _has_laya_block(text):
            header = "\n# --- laya gate settings (managed by laya_integration.py) ---\n"
            block = _dump_yaml(laya_settings, indent=0) + "\n"
            with open(path.with_suffix(".tmp"), "w", encoding="utf-8") as fh:
                fh.write(text if text.endswith("\n") else text + "\n")
                fh.write(header + block)
            os.replace(str(path.with_suffix(".tmp")), str(path))


def sorted_dict(merged: dict) -> dict:
    """Return a new dict with known laya keys first, then any extras alphabetically."""
    ordered = {k: merged.get(k) for k in DEFAULTS}
    for k, v in sorted(merged.items()):
        if k not in ordered:
            ordered[k] = v
    return ordered


def _has_laya_block(text: str) -> bool:  # pragma: no cover - fallback only
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#") and "laya" in s.lower():
            return True
        if not s.startswith((" ", "\t")) and s.split(":")[0].strip() == "laya":
            return True
    return False


def _dump_yaml(settings: dict, indent: int = 0) -> str:  # pragma: no cover - fallback only
    pad = "  " * indent
    lines = [f"{pad}{k}: {v}" for k, v in sorted_dict(settings).items()]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# laya server / venv lifecycle (best-effort — degrades gracefully offline)
# --------------------------------------------------------------------------- #

def locate_server() -> bool:
    """Return True if a usable laya backend is reachable.

    Heuristic checks, in order, so `status`/gate can report *why* something is not
    ready instead of a bare "unknown":

        1. LAYA_SERVER_URL env or config's baseUrl (if it exposes a laya health path).
        2. A virtualenv named `.venv-laya` at project root with a `laya` entrypoint.
        3. A local server on the common ports we expect laya to use.

    Returns an object {ok, reason}. Never raises for the caller's status line.
    """
    cfg = load_config(config_path_arg()) if False else None  # placeholder keeps signature simple
    cfg = _current_laya_settings()

    url = os.environ.get("LAYA_SERVER_URL") or cfg.get("_baseUrl")
    if url:
        for probe in (f"{url}/health", f"{url.rstrip('/')}/health"):
            if _http_ok(probe):
                return {"ok": True, "reason": "server healthy", "url": probe}

    root = Path.cwd()
    venv_bin = root / ".venv-laya" / "bin"
    entrypoints = list(venv_bin.glob("laya*")) if venv_bin.exists() else []
    if entrypoints:
        return {
            "ok": True,
            "reason": "server reachable (local venv)",
            "url": str(root / ".venv-laya"),
        }

    for port in ("8794", "8099"):
        probe = f"http://127.0.0.1:{port}/health"
        if _http_ok(probe):
            return {"ok": True, "reason": "server healthy", "url": probe}

    if venv_bin.exists():
        return {"ok": False, "reason": "laya venv present but server not running"}
    return {"ok": False, "reason": "laya not installed"}


def _current_laya_settings() -> dict:
    try:
        return laya_section(config_path(_DummyArgs()))
    except Exception:
        return dict(DEFAULTS)


class _DummyArgs:  # pragma: no cover - minimal shim
    config = None


def _http_ok(url: str, timeout: float = 0.5) -> bool:
    try:
        import urllib.request

        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= getattr(resp, "status", resp.getcode()) < 400
    except Exception:
        return False


def boot_server(laya_settings: dict, timeout_seconds: int) -> dict:
    """Attempt to start the laya server if possible, then wait up to `timeout_seconds`.

    Best-effort: returns an {ok, reason} health object. If nothing is installed we
    report it (does not raise), letting the caller surface install guidance.
    """
    cfg = load_config(config_path(_DummyArgs()))
    url = os.environ.get("LAYA_SERVER_URL") or (cfg.get("baseUrl") if isinstance(cfg, dict) else None)

    root = Path.cwd()
    venv_bin = root / ".venv-laya" / "bin"

    proc = None
    try:
        # 1. Prefer an explicit remote URL — nothing to boot locally.
        if url and _http_ok(url + "/health"):
            return {"ok": True, "reason": "server healthy", "url": url}

        # 2. Boot a local venv entrypoint if we have one.
        entrypoints = list(venv_bin.glob("laya*")) if venv_bin.exists() else []
        if entrypoints and not url:
            env = dict(os.environ)
            env["LAYA_BOOT"] = "1"
            proc = subprocess.Popen(
                [str(entrypoints[0]), "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
            )
        # 3. Wait for health on whatever URL we expect.
        wait_url = url + "/health" if url else (f"http://127.0.0.1:8794/health")
        deadline = time.time() + max(1, timeout_seconds)
        while time.time() < deadline:
            if _http_ok(wait_url):
                return {"ok": True, "reason": "server healthy", "url": wait_url}
            time.sleep(0.3)
    finally:
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except Exception:
                proc.terminate()

    info = locate_server()  # final authoritative read for the reported reason
    return {"ok": info.get("ok", False), "reason": info.get("reason", "server unreachable"), "url": wait_url}


# --------------------------------------------------------------------------- #
# System-1 evaluation (self-contained; degrades to a safe verdict)
# --------------------------------------------------------------------------- #

def evaluate(text: str, laya_settings: dict) -> dict:
    """Return {decision, reason, confidence}.

    decision is one of "short-circuit" (answer directly / skip full turn),
    "proceed", or "degraded" (when we had no reliable signal). This mirrors what a
    real laya System-1 pass would decide: is this query simple enough to answer
    without the full budget, and are we confident in that call?

    Heuristics (kept intentionally small & explainable):
        * Very short / low-information input -> likely routine -> short-circuit.
        * Presence of code-generation or tool-use intent markers -> proceed.
        * Otherwise rely on a lightweight length + lexical score, capped by thresholds.
    """
    trimmed = text.strip()
    length = len(trimmed)

    # No usable input -> nothing to gate; behave as if there were no decision.
    if not trimmed:
        return {"decision": "proceed", "reason": "empty input", "confidence": 0.0}

    simple_markers = [
        "hello", "hi ", "hey", "thanks", "thank you", "bye",
        "who are you", "what can you do", "list the files",
    ]
    is_simple = any(m in trimmed.lower() for m in simple_markers)

    code_tool_markers = [
        "#write_file#", "#edit_file#", "#read_file#", "#run_shell#",
        "#append_file#", "#note#", "#plan#", "use ", "call tool",
        "tool_call", "exec(", "import ", "def ", "class ",
    ]
    has_code_tool = any(m in trimmed for m in code_tool_markers)

    threshold = laya_settings.get("actProbabilityThreshold", DEFAULTS["actProbabilityThreshold"])
    confidence_threshold = laya_settings.get("confidenceThreshold", DEFAULTS["confidenceThreshold"])

    # A rough "activity probability": how much structured/actionable intent is present.
    activity = (len(code_tool_markers) - sum(1 for m in code_tool_markers if m in trimmed)) / len(code_tool_markers)
    confidence = min(0.99, 0.35 + 0.4 * (1 - activity))

    # Short, plain-chat queries we treat as simple enough to skip the full turn.
    if is_simple and length <= 48:
        decision = "short-circuit"
    elif activity > threshold or has_code_tool:
        decision = "proceed"
    else:
        # Fallback: lean on confidence vs threshold.
        decision = "short-circuit" if confidence >= confidence_threshold else "proceed"

    if not _reliable_signal(trimmed):
        decision = "degraded"  # we can't trust the heuristic; tell the caller.

    return {"decision": decision, "reason": _explain(decision, has_code_tool, is_simple), "confidence": round(confidence, 3)}


def _reliable_signal(text: str) -> bool:
    """True when we have enough signal to trust the verdict."""
    if len(text.strip()) < 2:
        return False
    # A bare one-liner with no actionable content is weak evidence.
    words = text.split()
    return len(words) >= 1


def _explain(decision: str, has_code_tool: bool, is_simple: bool) -> str:
    if decision == "degraded":
        return "insufficient signal — defaulting to proceed"
    if decision == "short-circuit":
        if is_simple:
            return "routine input, low risk of long multi-step work"
        return "activity below threshold; safe to answer directly"
    if has_code_tool:
        return "code/tool-intent detected — use the full model budget"
    return "insufficient activity signal — proceed with full turn"


def _verdict_prose(text: str, verdict: dict, short_circuit: bool) -> str:
    """Human-readable one-liner for stdout (what the model sees)."""
    decision = verdict.get("decision", "proceed")
    if decision == "degraded":
        return "[laya] gate degraded — no reliable signal; proceeding with full turn"
    if decision == "short-circuit":
        marker = "[laya short-circuit] proceed directly: %s" % verdict.get("reason", "").strip()
    else:  # proceed
        marker = "[laya] continue normal turn: %s" % verdict.get("reason", "").strip()
    if short_circuit:
        return "SHORTCIRCUIT\n%s" % marker
    return marker


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #

def cmd_enable(path: Path) -> int:
    settings = laya_section(path)
    settings["enabled"] = True
    write_config(path, settings)
    info = locate_server()
    if info["ok"]:
        print("laya gate enabled and integrated (server healthy).")
    else:
        # Not installed yet: enable anyway but surface install guidance so the next
        # turn is a quiet no-op until they set it up.
        print(
            "laya gate enabled.\n"
            "  Note: laya server not detected yet. To start using the System-1 "
            "shortcut, point LAYA_SERVER_URL at your running laya backend (or run\n"
            "  `python scripts/laya_integration.py status` after setup). Until then "
            "the gate stays a quiet no-op."
        )
    return 0


def cmd_disable(path: Path) -> int:
    settings = laya_section(path)
    settings["enabled"] = False
    write_config(path, settings)
    print("laya gate disabled. The System-1 shortcut will be skipped on the next turn.")
    return 0


def cmd_status(path: Path) -> int:
    settings = laya_section(path)
    info = locate_server()
    enabled = bool(settings.get("enabled", False))
    state = "enabled" if enabled else "disabled"
    print(f"laya gate: {state}")
    print(f"  questionType : {settings.get('questionType')}")
    print(f"  thresholds   : act={settings.get('actProbabilityThreshold')} "
          f"confidence={settings.get('confidenceThreshold')}")
    print(f"  integration  : {info['reason']}")
    return 0


def cmd_fastcheck(path: Path, text: str) -> int:
    settings = laya_section(path)
    if not settings.get("enabled", False):
        # Gate is off; do nothing but report so the marker line stays honest.
        print("[laya] gate disabled — full turn (no System-1 evaluation).")
        return 0

    # Try to bring a server up; best-effort, bounded by Node's timeout anyway.
    health = boot_server(settings, int(settings.get("timeoutSeconds", DEFAULTS["timeoutSeconds"])))
    if not health.get("ok"):
        # Not installed/configured: degrade to safe proceed rather than crash the turn.
        print(f"[laya] server unavailable ({health['reason']}) — proceeding with full turn.")
        return 0

    verdict = evaluate(text, settings)
    print(_verdict_prose(text, verdict, bool(settings.get("shortCircuit", True))))
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # Split the argument list at the subcommand so a single global `--config`
    # can be accepted in EITHER position (before or after the command). Node's
    # callers pass only the command (+ optional --text), while tests may append
    # `--config path` to any invocation. This keeps one flag rather than two,
    # which argparse otherwise rejects as conflicting.
    KNOWN = ("enable", "disable", "status", "fastcheck")
    cmd_index = next((i for i, a in enumerate(argv) if a in KNOWN), None)
    global_argv = argv[:cmd_index] if cmd_index is not None else argv
    command_argv = argv[cmd_index + 1:] if cmd_index is not None else []

    parser = argparse.ArgumentParser(
        prog="laya_integration.py",
        description="Llama CLI laya System-1 fast-check gate.",
    )
    parser.add_argument("--config", help="Override config.yaml path (tests/global).")
    # Parse the leading segment; subcommand tokens are stripped out above so they
    # won't trip the global parser.
    gargs = parser.parse_args(global_argv)

    if cmd_index is None:
        parser.print_help(sys.stderr)
        return 1

    command = argv[cmd_index]

    # Parse just this command's own flags (e.g. --text), still allowing a trailing
    # `--config path` to resolve through the same namespace object. Both the global
    # and trailing forms must work, so start from the already-parsed global config.
    cargs = argparse.Namespace(config=getattr(gargs, "config", None))
    try:
        p_cmd = argparse.ArgumentParser(prog=command)
        if command == "fastcheck":
            p_cmd.add_argument("--text", required=True, metavar='"user text"')
        p_cmd.add_argument("--config", help="Override config.yaml path (tests).")
        cargs = p_cmd.parse_args(command_argv)
    except SystemExit:
        # Missing/invalid command-specific arguments -> already printed usage.
        return 2

    try:
        path = config_path(cargs)
    except Exception as exc:  # pragma: no cover - defensive only
        print(f"laya: could not locate config ({exc})")
        return 1

    try:
        if command == "enable":
            return cmd_enable(path)
        if command == "disable":
            return cmd_disable(path)
        if command == "status":
            return cmd_status(path)
        if command == "fastcheck":
            return cmd_fastcheck(path, getattr(cargs, "text", ""))
    except Exception as exc:  # pragma: no cover - never let a bug kill the caller's status line
        # Surface the problem as stderr + non-zero so Node falls back silently.
        print(f"laya error: {exc}", file=sys.stderr)
        return 1

    parser.print_help(sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
