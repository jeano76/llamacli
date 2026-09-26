#!/usr/bin/env python3
"""End-to-end smoke test for the laya integration gate.

Boots a real `laya serve` instance in-process (CPU), then drives it exactly like the gate would:
health check -> resource gate config -> /v1/systemone inference -> response extraction.
Run with the venv python:  .venv/bin/python scripts/smoke_test.py
"""
import json
import socket
import subprocess
import sys
import time

REPO = "/home/jeano/llamacli_plugin"
VENV_PY = "/home/jeano/llamacli_plugin/.venv/bin/python"
HOST, PORT = "127.0.0.1", 8063


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def wait_health(timeout=90):
    start = time.time()
    while time.time() - start < timeout:
        try:
            import urllib.request
            with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=2) as r:
                body = json.load(r)
            if body.get("status") == "ok":
                return True
        except Exception:
            time.sleep(1.5)
    raise RuntimeError("laya serve did not become healthy in time")


def main() -> int:
    port = free_port()
    HOST, PORT = "127.0.0.1", port
    print(f"[gate] launching `laya serve` on :{PORT} (CPU, preload=english)")
    proc = subprocess.Popen(
        [VENV_PY, "-m", "laya", "serve"],
        cwd=REPO, env={**__import__("os").environ, "LAYA_DEVICE": "cpu",
                       "LAYA_PRELOAD": "1", "LAYA_MODELS": "english"},
    )
    try:
        wait_health()
        print("[gate] health OK")

        # Resource gate config (read the same way the gate does).
        with open(f"{REPO}/.llamacli/config.yaml") as f:
            cfg = json.load(f)
        print(f"[gate] config loaded; swapfree_kb={cfg['laya']['resourceGate'].get('swapFreeKb')}")

        # Inference call in the exact shape laya's validator accepts.
        payload = {
            "state": ("You are a decision gatekeeper for llamacli, a local agentic coding assistant. "
                      "Decide whether it is safe to launch an GPU model (llama.cpp) right now. "
                      "Only answer with the label of your choice."),
            "questions": {
                "has_gpu": {
                    "type": "noul",
                    "instructions": "Is a CUDA/GPU device present on this machine?",
                    "criteria": {"true": "Yes, a GPU is available.", "false": "No GPU detected."},
                },
                "free_memory_mb": {
                    "type": "score",
                    "instructions": "How much free swap/VRAM headroom (in MB) is available right now?",
                    "criteria": ["None — system under memory pressure.",
                                 "Enough for a small CPU model."],
                },
                "decision": {
                    "type": "choice",
                    "instructions": "Given the above, should llamacli proceed with the GPU turn?",
                    "criteria": {"safe": "Proceed", "hold": "Wait / fall back to CPU"},
                },
            },
        }
        import urllib.request
        req = urllib.request.Request(f"http://{HOST}:{PORT}/v1/systemone",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.load(r)
        print("[gate] /v1/systemone status:", resp.get("status"))
        print("[gate] answers:", json.dumps(resp.get("answers"), ensure_ascii=False))
        assert "decision" in resp.get("answers", {}), "expected a decision answer"
        # Extract the chosen label the same way the gate would.
        ans = resp["answers"]["decision"]
        if isinstance(ans, dict) and "choice" in ans:
            print("[gate] extracted decision =", ans["choice"])
        else:
            print("[gate] extracted decision =", ans)
        print("[gate] SMOKE TEST PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
