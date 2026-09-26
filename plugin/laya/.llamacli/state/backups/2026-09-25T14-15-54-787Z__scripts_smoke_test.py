"""End-to-end smoke test against a real 'laya serve' instance."""

import json
import shutil
import subprocess
import sys
import time
import urllib.request

VENV_PY = "/home/jeano/llamacli_plugin/.venv/bin/python"
BASE = "http://127.0.0.1:8791"


def _curl(path, data=None):
    url = BASE + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"}, method="POST" if body else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw[:300]
        return e.code, parsed


def main():
    if shutil.which(VENV_PY) is None and not __import__("os").path.exists(VENV_PY):
        print("FAIL: venv python not found at", VENV_PY); return 1

    proc = subprocess.Popen(
        [VENV_PY, "-m", "laya", "serve"],
        env={**__import__("os").environ, "LAYA_PORT": "8791"},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    try:
        # wait for health
        ok = False
        for _ in range(60):
            try:
                st, body = _curl("/health")
                if st == 200 and body.get("status") == "ok":
                    ok = True; break
            except Exception:
                pass
            time.sleep(1)
        print("HEALTH:", (st, body))
        assert ok, "serve never became healthy"

        # happy path: flat question keyed by id with type/instructions/criteria
        q = {
            "q1": {
                "type": "choice",
                "instructions": "Should this be allowed?",
                "criteria": {"yes": "it is safe", "no": "it is risky"},
            }
        }
        st, body = _curl("/v1/systemone", {"state": "Test input", "questions": q})
        print("SYSTEMONE:", (st, json.dumps(body, ensure_ascii=False)[:600]))
        assert st == 200, f"expected 200, got {st}: {body}"
        assert "answers" in body and "model" in body

        # malformed question: missing type -> 422 naming the question
        st, body = _curl("/v1/systemone", {"state": "x", "questions": {"q1": {"instructions": "hi"}}})
        print("MALFORMED:", (st, json.dumps(body, ensure_ascii=False)[:300]))
        assert st == 422, f"expected 422, got {st}"

        return 0 if ok else 2
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
