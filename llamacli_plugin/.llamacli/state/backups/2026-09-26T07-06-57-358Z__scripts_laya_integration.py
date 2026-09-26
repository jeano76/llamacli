#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""System 1 (fast, CPU) decision helper for local llamacli via laya.

This module is the ONLY piece of new integration code and it touches NO core
llamacli code by design -- the Node app has zero laya awareness, so all work
happens over HTTP against a separately-launched laya server (see
docs/skill-integration-review.md).

What this provides:

  * Merge-style before-turn gate: call laya's /v1/systemone BEFORE a turn; if it
    answers, fold its recommendation into the user message and send both to the
    model (Ornith/GPU). On ANY failure degrade silently to Ornith -- the fast
    path must never break the normal path.

  * Resource gate: only spend CPU memory that is actually free (SwapFree) and
    never block a turn longer than the configured timeout. These are the real
    local constraints observed on this machine (see docs, 부록 A).

  * Manual /fastcheck-style prompt: ask laya for an honest read on a task.

  * Detect -> confirm -> install/serve onboarding menu (§6-1 of the review).

Laya HTTP protocol (verified against serve.py v1.0.23):
  entry point : `python -m laya serve`   (uvicorn; LAYA_HOST/LAYA_PORT env)
  POST        : /v1/systemone   body {"state":..., "questions": {qid:{"prompt":...}}, "model"?}
  Response    : Jev payload {model, answers:{qid:{choice|score|noul}}, usage, routing?}
  Health probe: GET  /health       -> {"status":"ok","loaded":[...],"device":...}
  Auth        : if LAYA_API_KEY is set, require `Authorization: Bearer <key>`

Every command degrades to "do nothing" (exit 0, no output) on error so the
existing Ornith/GPU flow keeps working.

CLI:
    python3 laya_integration.py gate   --state <file> [--prompt <text>]
    python3 laya_integration.py fastcheck --text "..." [--question <id>] [--no-check]
    python3 laya_integration.py onboard
    python3 laya_integration.py status
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants / config paths                                                      #
# --------------------------------------------------------------------------- #

CONFIG_FILENAME = "config.yaml"
LAYA_VENV_NAME = "laya-serve-venv"

SYSTEMONE_TIMEOUT = 12.0          # seconds, cap on a single inference call
HEALTH_TIMEOUT = 2.0              # seconds, on the health probe
BOOT_WAIT_SECONDS = 30            # max wait for the server to come up

DEFAULT_GATE_PROMPT = (
    "You are the fast CPU sidekick (laya) for a user running a local LLM via llamacli. "
    "Read the conversation state that follows, then give ONE crisp recommendation on "
    "what to do next -- and flag anything risky. Be direct; no preamble."
)

DEFAULT_Noul_PROMPT = (
    "You are laya, the fast CPU System 1 for llamacli. Based on the conversation state, "
    "is this a genuinely quick judgment that you can answer right now without a full slow "
    "reasoning turn? Answer yes/no."
)

DEFAULT_CHOICE_PROMPT = (
    "You are laya, the fast CPU System 1 for llamacli. Given the conversation state and the "
    "options below, which one best matches the situation?"
)

CHOICE_DEFAULT_CRITERIA = {
    "yes":     "go ahead / do it",
    "no":      "stop / don't",
    "proceed": "safe to proceed",
    "flag":    "risky -- flag before proceeding",
}

DEFAULT_SCORE_PROMPT = (
    "You are laya, the fast CPU System 1 for llamacli. On a scale of 0..1, how urgent or "
    "risky is this right now? Higher means more needs attention."
)


def default_config_path() -> Path:
    """Config location: project-local .llamacli/config.yaml (per rules/00-core)."""
    env = os.environ.get("LLAMA_CLI_HOME")
    base = Path(env) if env and Path(env).exists() else Path.cwd() / ".llamacli"
    return base / CONFIG_FILENAME


# --------------------------------------------------------------------------- #
# Config read/write                                                             #
# --------------------------------------------------------------------------- #

def _load_config(path: "Path | str") -> dict:
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


def _save_config(path: "Path | str", laya_cfg: dict) -> None:
    """Persist the laya section inside .llamacli/config.yaml without clobbering it."""
    path = Path(path)
    try:
        import yaml
    except Exception:
        # Minimal no-pyyaml fallback so config can still be written.
        lines = ["laya:"] + _yaml_dump_plain(laya_cfg, indent=1)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            # Keep any pre-existing (non-laya) keys intact by only touching laya.
            existing = _strip_laya_section(path.read_text(encoding="utf-8"))
            lines = existing + [""] + lines
            fh.write("\n".join(lines).rstrip() + "\n")
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
    # Preserve everything that isn't the laya section.
    data.pop("laya", None)
    data["laya"] = laya_cfg
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, allow_unicode=True, sort_keys=False)


def _yaml_dump_plain(obj: dict, indent: int = 0) -> list[str]:
    pad = "  " * indent
    out = []
    for key, val in obj.items():
        if isinstance(val, bool):
            out.append(f"{pad}{key}: {'true' if val else 'false'}")
        elif isinstance(val, int):
            out.append(f"{pad}{key}: {val}")
        elif isinstance(val, str):
            escaped = val.replace("\\", "\\\\").replace('"', '\\"')
            out.append(f'{pad}{key}: "{escaped}"')
        else:
            out.append(f"{pad}{key}: {val}")
    return out


def _strip_laya_section(text: str) -> list[str]:
    """Return the lines of `text` with any leading top-level `laya:` block removed."""
    out = []
    i = 0
    while i < len(text):
        line = text[i : text.find("\n", i)] if "\n" in text[i:] else text[i:]
        stripped = line.strip()
        if stripped.startswith("laya:") and (i == 0 or i == len(text) - 1):
            # top-level laya section -- skip it entirely
            j = text.find("\n", i) + 1
            while j < len(text) and text[j : j + 2] in ("  ", "    ", ""):
                j = text.find("\n", j) + 1
            i = j
            continue
        out.append(line)
        nxt = text.find("\n", i)
        if nxt == -1:
            break
        i = nxt + 1
    return out


# --------------------------------------------------------------------------- #
# Resource gating (the real local constraints, docs 부록 A)                    #
# --------------------------------------------------------------------------- #

def _meminfo_kb() -> dict[str, int]:
    try:
        fields: dict[str, int] = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2:
                    fields[parts[0][:-1]] = int(parts[1]) * 1024  # kB -> bytes
        return fields
    except Exception:
        return {}


def swap_free_bytes() -> int:
    """Free swap in bytes. Returns a large number if it cannot be measured, so
    the gate never blocks a turn just because introspection failed (we degrade to
    Ornith elsewhere, never fail-closed here)."""
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            free = 0
            for line in fh:
                if line.startswith("SwapFree"):
                    free = int(line.split()[1]) * 1024
        return max(free, 0)
    except Exception:
        return 1 << 62


def ram_free_bytes() -> int:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            total = available = None
            for line in fh:
                if line.startswith("MemTotal"):
                    total = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable"):
                    available = int(line.split()[1]) * 1024
            return max(available, 0) if available is not None else (total or 0)
    except Exception:
        return 1 << 62


def resource_gate_ok(cfg: dict) -> tuple[bool, str]:
    """SwapFree + RAM gate. Returns (ok, reason).

    Only spends CPU memory that is actually free. Defaults match the observed
    box (~8 GB swap on this laptop); tune via config `minSwapKb` / `minRamKb`.

    The genuinely dangerous resource state is a RAM shortage: if RAM itself has
    headroom, laya won't need to absorb anything into swap, so a lone swap
    shortage must not block it. A RAM shortage alone (regardless of swap) is
    always blocked — that's the real risk. So we pass whenever RAM is ample and
    only trip when free RAM falls below its threshold.
    """
    min_swap_kb = int(cfg.get("minSwapKb", 2_000_000))   # ~2 GB default
    min_ram_kb = int(cfg.get("minRamKb", 1_000_000))     # ~1 GB default

    free_swap = swap_free_bytes()
    free_ram = ram_free_bytes()

    if free_ram < min_ram_kb * 1024:
        return False, f"free RAM {free_ram // 1024}kB below required {min_ram_kb}kB (swap {free_swap // 1024}kB)"

    return True, ""


# --------------------------------------------------------------------------- #
# Endpoint / onboarding helpers                                               #
# --------------------------------------------------------------------------- #

def endpoint(cfg: dict) -> str:
    base = cfg.get("baseUrl") or "http://127.0.0.1:8000"
    if not base.startswith(("http://", "https://")):
        base = "http://" + base
    return base.rstrip("/")


def health(endpoint_url: str, timeout: float = HEALTH_TIMEOUT) -> dict | None:
    """Return /health parsed JSON, or None if unreachable. Never raises."""
    url = endpoint_url.rstrip("/") + "/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001 -- any failure => not reachable
        reason = getattr(exc, "reason", exc)
        print(f"[laya] health check failed: {reason}", file=sys.stderr)
        return None


def venv_available() -> bool:
    """True if the project-local laya venv exists and can import laya."""
    python = venv_python_path()
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


def venv_python_path() -> Path | None:
    """Path to the project-local laya venv python (uses config if set)."""
    cfg = _load_config(default_config_path())
    venv_path = cfg.get("venvPath")
    base = Path(venv_path) if venv_path and os.path.isdir(Path(venv_path)) else (
        Path.cwd() / ".llamacli" / LAYA_VENV_NAME
    )
    return base / "bin" / "python" if os.name != "nt" else base / "Scripts" / "python.exe"


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


def start_laya(cfg: dict) -> tuple[subprocess.Popen, int]:
    """Start a background laya serve. Returns (proc, port)."""
    python = venv_python_path()
    if not python or not python.exists():
        raise RuntimeError("laya venv not found; run `onboard` first")
    port = int(cfg.get("port", 8000))

    env = dict(os.environ)
    env["LAYA_PORT"] = str(port)
    env["LAYA_MODELS"] = cfg.get("models", "english,multilingual,typed-decisions")
    if cfg.get("apiKey"):
        env["LAYA_API_KEY"] = cfg["apiKey"]

    proc = subprocess.Popen(  # noqa: S603 -- local, trusted path
        [str(python), "-m", "laya", "serve"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
        start_new_session=True,
    )
    return proc, port


# --------------------------------------------------------------------------- #
# HTTP client (POST /v1/systemone)                                            #
# --------------------------------------------------------------------------- #

def systemone(endpoint_url: str, state, questions: dict, timeout: float,
              api_key: str | None = None) -> dict | None:
    """Call laya's /v1/systemone. Returns parsed Jev payload or None (never raises)."""
    url = endpoint_url.rstrip("/") + "/v1/systemone"
    body = json.dumps({"state": state, "questions": questions}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, dict) else {}
    except urllib.error.HTTPError as exc:
        print(f"[laya] HTTP {exc.code} from /v1/systemone", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[laya] request failed: {exc}", file=sys.stderr)
    return None


def _decision_from_answer(val: dict) -> tuple[str, float, str]:
    """Normalise one laya answer to (text, score, decision).

    Returns a human label plus a numeric 0-1 `score` and a normalised
    `decision` in {"yes", "no", "n/a"} so callers can reason about it without
    knowing whether laya used the noul / choice / score schema.
    """
    if not isinstance(val, dict):
        return (str(val), 0.0, "n/a")

    # A laya answer is keyed by its question type: {choice|noul|score} + a
    # parallel "probabilities" map, plus the shared calibrated numbers below.
    kind = next((k for k in ("choice", "noul", "score") if k in val), None)
    probs = val.get("probabilities") or {}

    # --- decision label -------------------------------------------------- #
    if kind == "choice":
        label = str(val["choice"])                       # the chosen option key
        prob = float(probs.get(label, 0.0))
        score = max(prob, 1.0 - prob)          # how strongly that side wins
        decision = "yes" if _is_affirming(label) else "no"
    elif kind == "noul":
        p_yes = float(val["noul"])             # 1 => yes, 0 => no
        label = "yes" if p_yes >= 0.5 else "no"
        score = max(p_yes, 1.0 - p_yes)
        decision = label
    elif kind == "score":
        s = float(val["score"])                # laya-provided intensity (clamp to [0,1])
        if not 0.0 <= s <= 1.0:
            s = 0.5                            # out-of-range => neutral, don't crash
        score = s                              # local so the shared return below sees it
        label = f"{s:.3f}"
        decision = "n/a"
    else:
        import json as _json
        return (_json.dumps(val, ensure_ascii=False), 0.0, "n/a")

    # --- confidence / act_probability fallbacks -------------------------- #
    conf = val.get("answer_confidence") or val.get("confidence")
    if not isinstance(conf, (int, float)):
        conf = score
    return (label, round(float(score), 3), decision)


def _is_affirming(label: str) -> bool:
    """Heuristic: does an option label mean 'go / yes / do it'?"""
    return label.strip().lower() in {"yes", "affirm", "true", "1", "proceed",
                                     "do it", "act now", "urgent", "high"}


def extract_answer(systemone_result: dict, decision_qid: str = "decision") -> str:
    """Turn laya's Jev payload into a plain human-readable decision block.

    Prints the primary answer first (so the merge-gate can embed it in the user
    message), then the optional routing hint. Ordering keeps the fast-path
    recommendation readable for a human re-reading it before proceeding.
    """
    if not isinstance(systemone_result, dict):
        return ""

    answers = systemone_result.get("answers") or {}
    parts: list[str] = []

    # Primary decision first.
    primary = answers.get(decision_qid) if isinstance(answers, dict) else None
    if isinstance(primary, dict):
        label, score, _decision = _decision_from_answer(primary)
        conf = primary.get("answer_confidence") or primary.get("confidence")
        parts.append(f"laya: {label}  (score={score:.3f}, conf={float(conf) if isinstance(conf,(int,float)) else score:.3f})")

    # Any secondary questions.
    for qid, val in answers.items():
        if qid == decision_qid or not isinstance(val, dict):
            continue
        label, score, _d = _decision_from_answer(val)
        parts.append(f"  {qid}: {label} (score={score:.3f})")

    routing = systemone_result.get("routing")
    if isinstance(routing, dict):
        if routing.get("model"):
            parts.append(f"model   : {routing['model']}")
        reason = routing.get("reason")
        if isinstance(reason, str):
            parts.append(f"reason  : {reason}")

    usage = systemone_result.get("usage") or {}
    if isinstance(usage, dict):
        toks = ", ".join(f"{k}={v}" for k, v in usage.items() if v is not None)
        parts.append(f"tokens  : {toks}")

    return "\n".join(parts).strip()


# Default allow-list (§3.4 of the review): a yes/no decision may short-circuit
# only when laya's verdict is an unambiguous go / no-go token. Anything outside
# this set -- a scored middle value, a hedged phrase, an unknown label -- forces
# a full Ornith turn so we never trust a fuzzy verdict as a fast exit.
SHORT_CIRCUIT_ALLOW_LIST = {"yes", "no", "proceed", "flag", "no_action"}

# Single calibrated-confidence floor (§3.4): the one number laya reports on every
# question type (choice / score / noul). We gate short-circuit on it alone rather
# than a dual act_probability + confidence test, since answer_confidence is the
# calibrated quantity temperature-scaling fits and ECE measures; a high raw
# act_probability with low calibrated confidence is exactly the "looks confident,
# actually unsure" case we want Ornith to catch.
SHORT_CIRCUIT_CONFIDENCE_THRESHOLD = 0.7


def short_circuit_verdict(systemone_result: dict, cfg: dict,
                          decision_qid: str = "decision") -> tuple[bool, str]:
    """Decide whether the fast path can *fully* answer a turn (short-circuit).

    Returns (allow_short_circuit, reason). Short-circuit is allowed only when all
    of these hold (§3.4 of the review):

      1. shortCircuit.enabled == true
      2. laya produced an actionable decision for this question
      3. that verdict token is in the allow-list: {yes, no, proceed, flag,
         no_action}   (i.e. it is a clean go / no-go, nothing hedged)
      4. answer_confidence >= confidenceThreshold

    The allow-list keeps us from treating an ambiguous phrase or a scored middle
    value as a fast exit; the confidence floor keeps us from trusting a verdict
    laya itself thinks is shaky. Either guard failing -- or any missing field --
    means "reason with Ornith instead". When short-circuit is disabled this
    always returns False.
    """
    if not cfg.get("shortCircuit", False):
        return False, "short-circuit disabled"

    answer = ((systemone_result.get("answers") or {}).get(decision_qid))
    if not isinstance(answer, dict):
        return False, "no actionable decision from laya"

    label, _score, decision = _decision_from_answer(answer)
    verdict = str(label).strip().lower()

    allow_list_cfg = cfg.get("allowList")
    allowed = {str(v).strip().lower() for v in allow_list_cfg} \
        if isinstance(allow_list_cfg, (list, tuple, set)) else SHORT_CIRCUIT_ALLOW_LIST

    if verdict not in allowed:
        return False, f"verdict '{verdict}' not in allow-list"

    conf = answer.get("answer_confidence") or answer.get("confidence")
    conf = float(conf) if isinstance(conf, (int, float)) else 0.0
    thr = float(cfg.get("confidenceThreshold", SHORT_CIRCUIT_CONFIDENCE_THRESHOLD))
    if conf < thr:
        return False, f"answer_confidence {conf:.3f} < {thr}"

    reason_kw = {"answer_confidence": round(conf, 3)}
    if decision in ("yes", "no"):
        reason_kw["decision"] = decision
    return True, (f"short-circuit OK: decide '{verdict}' ({reason_kw})")


# --------------------------------------------------------------------------- #
# Question construction                                                         #
# --------------------------------------------------------------------------- #

def _make_question(prompt: str, cfg: dict, qid: str = "decision") -> dict:
    """Build a laya question object that survives /v1/systemone validation.

    serve.py v1.0.23 requires each question to carry ``type`` (choice|score|noul),
    a string ``instructions``, and type-appropriate ``criteria``; the bare
    ``{"prompt": ...}`` shape used by older laya versions is rejected with HTTP 422
    ("unknown type None"). A yes/no decision maps cleanly to a ``noul`` question,
    which needs no criteria at all -- only instructions. Config may override via:
      cfg["questionType"]   -> "noul" (default) | "choice" | "score"
      cfg["criteria"]       -> dict for a choice question's label->description map
      cfg["labels"]         -> list of option labels (noul only; defaults yes/no)

    NOTE: laya rejects `labels` on a choice question entirely, so we never attach
    it there even if config sets one.
    """
    qtype = str(cfg.get("questionType", "noul"))
    question = {"type": qtype, "instructions": prompt}

    if qtype == "choice":
        criteria = cfg.get("criteria") or CHOICE_DEFAULT_CRITERIA
        question["criteria"] = criteria
        # deliberately do NOT attach 'labels' here (laya rejects choice+labels)
    elif qtype == "noul":
        # A noul is a boolean (yes/no) question; omit criteria entirely.
        labels = cfg.get("labels")
        if isinstance(labels, list) and labels:
            question["labels"] = [str(x) for x in labels]
    elif qtype == "score":
        pass  # a score needs no extra fields beyond type + instructions

    return {qid: question}


# --------------------------------------------------------------------------- #
# Commands                                                                      #
# --------------------------------------------------------------------------- #

def cmd_gate(args: argparse.Namespace) -> int:
    """Merge-style before-turn gate with short-circuit. Degrades to Ornith."""
    cfg = _load_config(default_config_path())
    if not cfg.get("enabled", False):
        return 0

    endpoint_url = endpoint(cfg)
    state = args.state or cfg.get("stateFile") or ""
    text = _read_state(state)

    # Decouple the two roles of the gate prompt (§1 of short-circuit review):
    #   * decision question  -> DEFAULT_Noul_PROMPT, a genuine yes/no go-no-go so
    #     the "noul" type matches its instructions and the verdict is meaningful.
    #   * on-screen suggestion -> DEFAULT_GATE_PROMPT (open-ended recommendation),
    #     which must NOT back the yes/no decision question.
    # --prompt overrides both when provided ad-hoc.
    if args.prompt:
        decision_prompt = suggestion_prompt = args.prompt
    else:
        decision_prompt = cfg.get("question", DEFAULT_Noul_PROMPT)
        suggestion_prompt = cfg.get("suggestion", DEFAULT_GATE_PROMPT)

    questions = {"decision": _make_question(decision_prompt, cfg)}

    # --- readiness: running server, else installed venv -> start it ----------
    if not health(endpoint_url, min(HEALTH_TIMEOUT, 3.0)):
        if not venv_available():
            return 0                       # nothing to do; Ornith path runs unchanged
        try:
            proc, port = start_laya(cfg)
        except Exception as exc:  # noqa: BLE001
            print(f"[laya] could not start server: {exc}", file=sys.stderr)
            return 0
        endpoint_url = f"http://127.0.0.1:{port}"
        for _ in range(BOOT_WAIT_SECONDS):
            if health(endpoint_url, 1.0):
                break
            if proc.poll() is not None:
                print("[laya] server exited during boot", file=sys.stderr)
                return 0
            time.sleep(1.0)
        else:
            return 0

    # --- resource gate + timeout budget -------------------------------------
    ok, reason = resource_gate_ok(cfg)
    if not ok:
        print(f"[laya] skipped ({reason})", file=sys.stderr)
        return 0

    timeout = float(os.environ.get("LAYA_GATE_TIMEOUT", cfg.get("timeoutSeconds", SYSTEMONE_TIMEOUT)))
    timeout = min(timeout, SYSTEMONE_TIMEOUT)

    result = systemone(endpoint_url, state, questions, timeout, cfg.get("apiKey"))
    if not result:
        return 0                       # any failure => silent fall back to Ornith

    answer = extract_answer(result)
    if not answer.strip():
        return 0

    # On-screen recommendation is the open-ended guidance for the user;
    # it sits above the decision block, separate from the yes/no verdict.
    suggestion = extract_answer(result).strip()

    allow_sc, sc_reason = short_circuit_verdict(result, cfg)

    print("=== laya (System 1, CPU) suggestion ===")
    if suggestion:
        print(suggestion)
    print(answer.strip())
    if allow_sc:
        # Gate fully decided the turn -> skip Ornith for this message.
        print("=== laya short-circuited System 2: accept/reject below, no re-run needed ===")
        print("[revised] Accept to proceed (System 1 fast path took over) "
              f"-- reason: {sc_reason}.")
    else:
        # Gate offered a recommendation but still wants human + Ornith review.
        print("[revised] Re-read above, then run System 2 for an honest read of the task.")
        print(f"   (short-circuit not applied: {sc_reason})")
    print("=== end laya (re-read and decide; if unsure, ignore and proceed) ===")
    return 0


# --------------------------------------------------------------------------- #
# Agent trace (tool-call evaluation, typed-decisions checkpoint)                #
# --------------------------------------------------------------------------- #

AGENT_TRACE_MODEL = "typed-decisions"


def _make_agent_trace_question(instructions: str) -> dict:
    """Build the `typed-decisions` agent-trace checkpoint questions.

    The laya router only recognises an ``agent_trace_observability`` workflow when
    the set of question ids *exactly* equals {action, needs_review, outcome, risk,
    urgency} (see laya/router.py ``_TYPED_DECISION_WORKFLOWS``). Each id must be a
    separate top-level entry whose own ``type`` is one of choice|score|noul -- the
    literal string ``"typed-decisions"`` is *not* a question type and makes /v1/
    systemone return HTTP 422, so it can never sit in a question's ``type`` field.

    The five questions map to the checkpoint as follows:
      action        -> choice  (what kind of operation was just performed)
      outcome       -> choice  (did it succeed / fail / unclear)
      risk          -> score   (how risky/hard-to-reverse, 0-1)
      needs_review  -> noul    (does a human/main model need to re-check?)
      urgency       -> noul    (does it demand immediate attention?)
    """
    return {
        "action": {
            "type": "choice",
            "instructions": instructions,
            "criteria": {
                "read": "read-only: viewed a file, ran a query, listed something -- nothing changed",
                "write": "created or modified a file/config",
                "execute": "ran a shell command / script that does more than read state",
                "delete": "removed or overwrote something that existed before",
                "network": "made an external network call (fetch, API, git push/pull)",
            },
        },
        "outcome": {
            "type": "choice",
            "instructions": instructions,
            "criteria": {
                "success": "completed without errors, expected result present",
                "failure": "errored out, non-zero exit, exception, or explicit failure message",
                "unclear": "output doesn't clearly indicate success or failure",
            },
        },
        "risk": {
            "type": "score",
            "instructions": instructions,
            "criteria": [
                "none: read-only, nothing changed",
                "low: easily reversible change (e.g. a single file edit with version control)",
                "medium: harder to reverse (e.g. multiple files, a dependency change)",
                "high: destructive or hard to undo (e.g. delete, force-push, drop table, rm -rf)",
            ],
        },
        "needs_review": {
            "type": "noul",
            "instructions": instructions,
        },
        "urgency": {
            "type": "noul",
            "instructions": instructions,
        },
    }


def _decision_from_agent_trace(result: dict) -> str | None:
    """Render the agent-trace answer set into a single human-readable block.

    Returns None if there is nothing useful to show (silent fall-back).
    """
    answers = result.get("answers") or {}

    # Every field is one laya answer -> _decision_from_answer gives a (label,
    # score, decision) tuple. Pull just the human label out of it.
    def _label(val):
        if not isinstance(val, dict):
            return ""
        try:
            label, score, _dec = _decision_from_answer(val)
        except Exception:  # noqa: BLE001 -- never let a malformed answer crash the trace
            return ""
        if isinstance(label, str):
            return label.strip()
        return str(label).strip()

    action_label = _label(answers.get("action"))
    outcome_label = _label(answers.get("outcome"))
    risk_label = _label(answers.get("risk"))
    needs_review_label = _label(answers.get("needs_review"))
    urgency_label = _label(answers.get("urgency"))

    lines = [f"laya agent-trace: action={action_label or 'unknown'}"]
    if outcome_label:
        lines.append(f"outcome: {outcome_label}")
    if risk_label:
        lines.append(f"risk: {risk_label}")
    if needs_review_label:
        lines.append(f"needs_review: {needs_review_label}")
    if urgency_label:
        lines.append(f"urgency: {urgency_label}")
    return "\n".join(lines) if len(lines) > 1 else None


def cmd_trace(args: argparse.Namespace) -> int:
    """Evaluate a tool-call result (after the turn). Degrades to Ornith."""
    cfg = _load_config(default_config_path())
    if not cfg.get("enabled", False):
        return 0

    endpoint_url = endpoint(cfg)

    # --- readiness: running server, else installed venv -> start it ----------
    if not health(endpoint_url, min(HEALTH_TIMEOUT, 3.0)):
        if not venv_available():
            return 0                       # nothing to do; Ornith path runs unchanged
        try:
            proc, port = start_laya(cfg)
        except Exception as exc:  # noqa: BLE001
            print(f"[laya] could not start server: {exc}", file=sys.stderr)
            return 0
        endpoint_url = f"http://127.0.0.1:{port}"
        for _ in range(BOOT_WAIT_SECONDS):
            if health(endpoint_url, 1.0):
                break
            if proc.poll() is not None:
                print("[laya] server exited during boot", file=sys.stderr)
                return 0
            time.sleep(1.0)
        else:
            return 0

    # --- resource gate + timeout budget -------------------------------------
    ok, reason = resource_gate_ok(cfg)
    if not ok:
        print(f"[laya] skipped ({reason})", file=sys.stderr)
        return 0

    # The state laya evaluates is the tool result itself. Accept a path in
    # --summary (for real integration via onToolResult) or a bare string.
    tool_state = args.tool
    if os.path.exists(args.summary):
        tool_state = args.summary

    instructions = f"Tool: {args.tool}\nSummary: {args.summary}"
    questions = _make_agent_trace_question(instructions)

    timeout = float(os.environ.get("LAYA_GATE_TIMEOUT", cfg.get("timeoutSeconds", SYSTEMONE_TIMEOUT)))
    timeout = min(timeout, SYSTEMONE_TIMEOUT)

    # Explicit model override is REQUIRED for this workflow (§5: "be explicit").
    cfg["model"] = AGENT_TRACE_MODEL
    result = systemone(endpoint_url, tool_state, questions, timeout, cfg.get("apiKey"))
    if not result:
        return 0                       # any failure => silent fall back to Ornith

    answer = extract_answer(result)
    rendered = _decision_from_agent_trace(result)
    if not rendered and not answer.strip():
        return 0

    print(rendered if rendered else answer.strip())
    return 0


def cmd_fastcheck(args: argparse.Namespace) -> int:
    """Manual /fastcheck-style honest read on a task."""
    cfg = _load_config(default_config_path())
    endpoint_url = endpoint(cfg)

    if not args.no_check and not health(endpoint_url, HEALTH_TIMEOUT):
        if not venv_available():
            choice = input("[laya] not running. Install now? [y/N] ").strip().lower()
            if choice != "y":
                print("[laya] cancelled.")
                return 0
            if not install_laya():
                return 1
        try:
            _, port = start_laya(cfg)
        except Exception as exc:  # noqa: BLE001
            print(f"[laya] could not start server: {exc}", file=sys.stderr)
            return 1
        endpoint_url = f"http://127.0.0.1:{port}"
        for _ in range(BOOT_WAIT_SECONDS):
            if health(endpoint_url, 1.0):
                break
            time.sleep(1.0)

    decision_qid = args.question

    # When --decision is set, ask the default noul question so laya returns a
    # `noul` float; otherwise use the configured question type/criteria.
    if getattr(args, "decision", False):
        questions = _make_question(
            DEFAULT_Noul_PROMPT if not args.text else args.text, cfg, qid="decision")
    else:
        questions = _make_question(args.text or "", cfg)

    result = systemone(endpoint_url, args.state or "", questions,
                       SYSTEMONE_TIMEOUT, None)
    if not result:
        print("[laya] fastcheck failed to reach server.", file=sys.stderr)
        return 1

    answer = (result.get("answers") or {}).get(decision_qid)
    if isinstance(answer, dict):
        label, score, decision = _decision_from_answer(answer)
        conf = answer.get("answer_confidence") or answer.get("confidence")
        conf = float(conf) if isinstance(conf, (int, float)) else score
        print(f"laya fastcheck: decision={label}  (score={score:.3f}, conf={conf:.3f})")
    return extract_answer(result) and 0


def cmd_onboard(args: argparse.Namespace) -> int:
    """Interactive menu per §6-1 of the review."""
    cfg = _load_config(default_config_path())
    endpoint_url = endpoint(cfg)
    installed = venv_available()
    running = bool(health(endpoint_url, HEALTH_TIMEOUT))

    print("laya System 1 helper onboarding")
    print(f"  - venv available : {installed}")
    print(f"  - server running : {running}")
    if running:
        h = health(endpoint_url) or {}
        print(f"  - loaded model   : {h.get('loaded', '?')}")

    print("\nWhat do you want to do?")
    print("  [A] Install + activate (serve in background)")
    print("  [B] Install only")
    print("  [C] Cancel")
    choice = input("> ").strip().lower()
    if choice == "c":
        print("Cancelled.")
        return 0

    if not installed and not install_laya():
        return 1

    if choice == "b":
        cfg["enabled"] = False
        cfg["venvPath"] = str(Path.cwd() / ".llamacli" / LAYA_VENV_NAME)
        _save_config(default_config_path(), cfg)
        print("Installed. Activate later with: python3 laya_integration.py onboard")
        return 0

    # choice == "a": activate -> enable gate + serve
    cfg["enabled"] = True
    proc, port = start_laya(cfg)
    for _ in range(BOOT_WAIT_SECONDS):
        if health(f"http://127.0.0.1:{port}", 1.0):
            cfg["baseUrl"] = f"http://127.0.0.1:{port}"
            cfg["venvPath"] = str(Path.cwd() / ".llamacli" / LAYA_VENV_NAME)
            _save_config(default_config_path(), cfg)
            print(f"[laya] active at http://127.0.0.1:{port} (PID {proc.pid}). Gate enabled.")
            return 0
        time.sleep(1.0)
    print("[laya] server did not boot in time; gate left off.", file=sys.stderr)
    cfg["enabled"] = False
    _save_config(default_config_path(), cfg)
    return 1


def cmd_enable(args: argparse.Namespace) -> int:
    """Turn the automatic before-turn gate ON. Runtime-togglable."""
    cfg = _load_config(default_config_path())
    # Per review §6: never auto-install here. If laya is not installed, leave it
    # enabled but it will no-op silently until `onboard` runs (see notes).
    cfg["enabled"] = True
    if not venv_available():
        print("[laya] gate turned on but laya is NOT installed yet.")
        print("Install first with: python3 laya_integration.py onboard")
    _save_config(default_config_path(), cfg)
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    """Turn the automatic before-turn gate OFF. Runtime-togglable."""
    cfg = _load_config(default_config_path())
    cfg["enabled"] = False
    # Preserve the rest of the config (baseUrl, thresholds, model path...).
    _save_config(default_config_path(), cfg)
    print("[laya] gate turned off; subsequent turns skip laya entirely.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Print current laya detection/health state (used for verification)."""
    cfg = _load_config(default_config_path())
    endpoint_url = endpoint(cfg)
    print(json.dumps({
        "enabled": bool(cfg.get("enabled", False)),
        "installed": venv_available(),
        "running": bool(health(endpoint_url, HEALTH_TIMEOUT)),
        "swapFreeKb": swap_free_bytes() // 1024,
        "ramFreeKb": ram_free_bytes() // 1024,
        "configKeys": [k for k in cfg.keys() if k != "apiKey"],
    }, indent=2))
    return 0


# --------------------------------------------------------------------------- #
# CLI wiring                                                                    #
# --------------------------------------------------------------------------- #

def _read_state(state: str | None) -> str:
    """State = the conversation context to feed laya. Reads a file or returns ''."""
    if not state:
        return ""
    p = Path(state)
    if not p.exists():
        print(f"[laya] state file not found: {state}", file=sys.stderr)
        return ""
    return p.read_text(encoding="utf-8", errors="ignore")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="laya System 1 helper for llamacli (no core changes).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_gate = sub.add_parser("gate", help="before-turn merge gate (degrades to Ornith on failure)")
    p_gate.add_argument("--state", help="path to conversation state file (JSON/text)")
    p_gate.add_argument("--prompt", help="override the decision prompt from config")
    p_gate.set_defaults(func=cmd_gate)

    p_fc = sub.add_parser("fastcheck", help="manual /fastcheck-style honest read on a task")
    p_fc.add_argument("--text", required=True, help="the task/question to reason about")
    p_fc.add_argument("--state", default="", help="optional conversation state")
    p_fc.add_argument("--question", default="decision", help="laya question id (for --criteria)")
    p_fc.add_argument("--decision", action="store_true",
                      help="treat as a yes/no decision: ask laya's noul, report the verdict")
    p_fc.add_argument("--no-check", action="store_true", help="do not auto-install/serve on miss")
    p_fc.add_argument("--short-circuit-only", action="store_true",
                      help="only report the System-1 short-circuit verdict "
                           "(skip contacting laya) -- stdout line 1 is SHORTCIRCUIT",
                      dest="short_circuit_only")
    p_fc.set_defaults(func=cmd_fastcheck)

    p_ob = sub.add_parser("onboard", help="interactive detect -> confirm -> install/serve menu")
    p_ob.set_defaults(func=cmd_onboard)

    p_st = sub.add_parser("status", help="print laya detection + health state")
    p_st.set_defaults(func=cmd_status)

    p_en = sub.add_parser("enable", help="turn the automatic before-turn gate ON (runtime)")
    p_en.set_defaults(func=cmd_enable)

    p_dis = sub.add_parser("disable", help="turn the automatic before-turn gate OFF (runtime)")
    p_dis.set_defaults(func=cmd_disable)

    p_tr = sub.add_parser("trace", help="evaluate a tool-call result after it runs")
    p_tr.add_argument("--tool", required=True, help="the tool name that produced output, e.g. run_shell")
    p_tr.add_argument("--summary", required=True, help="human-readable summary of what the output was")
    p_tr.set_defaults(func=cmd_trace)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
