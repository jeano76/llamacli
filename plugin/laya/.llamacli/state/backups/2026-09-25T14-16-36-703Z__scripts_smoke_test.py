#!/usr/bin/env python3
"""Smoke test for the laya integration gate: run a real `laya serve` and hit it."""
import json, os, signal, socket, subprocess, sys, time
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def free_tcp_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_health(url: str, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(url + "/health", timeout=2)
            if r.status_code == 200:
                return True
        except requests.RequestError:
            pass
        time.sleep(1.0)
    return False


def main() -> int:
    port = free_tcp_port()
    url = f"http://127.0.0.1:{port}"
    env = dict(os.environ, LAYA_HOST="127.0.0.1", LAYA_PORT=str(port))

    print(f"[smoke] launching `python -m laya serve` on {url} ...")
    proc = subprocess.Popen([sys.executable, "-m", "laya", "serve"],
                            cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        if not wait_for_health(url + "/health"):
            print("[smoke] server never became healthy")
            proc.send_signal(signal.SIGINT)
            return 1

        r = requests.get(url + "/health", timeout=5).json()
        print(f"[smoke] /health -> {r}")

        payload = {"state": "What should I do about my declining plant?",
                   "questions": {"q1": {"type": "noul",
                                         "instructions": "Is this an emergency?",
                                         "criteria": {}}}}
        print("[smoke] POST /v1/systemone")
        resp = requests.post(url + "/v1/systemone", json=payload, timeout=60)
        print(f"[smoke] status={resp.status_code}")
        if resp.status_code == 200:
            body = resp.json()
            print("[smoke] response keys:", list(body.keys()))
            print("[smoke] model:", body.get("model"))
            answers = body.get("answers", {})
            q1 = answers.get("q1", {})
            print("[smoke] answer for q1:", json.dumps(q1, ensure_ascii=False))
            return 0

        print("[smoke] unexpected status; response body:")
        print(resp.text)
        return 2
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
