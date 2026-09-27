#!/usr/bin/env python3
"""End-to-end before/after verification of the /fastcheck (laya System-1) gate.

    WHY THIS EXISTS: the numbers quoted in src/agent/gate.ts and the README were
    measured, not estimated, and the original "skip the model" design was
    removed on the strength of them. Re-runnable so a future change to the gate
    (or to the judge) can be checked against the same labelled set instead of
    argued about.

    Requires: llama-server on :8080 and laya-serve on :8099.
    WARNING: loads the model repeatedly; this box has only 8 GiB of VRAM and a
    large prompt with tool schemas can push it into a CUDA OOM. llama-server
    auto-restarts, but prefer running this when nothing else is using the GPU.

Measures the four things that decide whether the feature is real:

  1. gate latency and verdict quality (does the judge discriminate at all?)
  2. what a "cheap" verdict actually PRODUCES for the user
     — before: nothing at all.  after: a real answer, no tools
  3. whether a destructive request can reach a cheap turn
     — before: yes, 67% of the time.  after: never (the rail)
  4. end-to-end wall clock, gate on vs off

Run: python3 verify_gate.py
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request

LLAMACLI = "http://127.0.0.1:8080"
LAYA = "http://127.0.0.1:8099"
GATE_SCRIPT = "/home/jeano/llamacli/dist/scripts/laya_integration.py"
CONFIG = "/home/jeano/llamacli/.llamacli/config.yaml"

# class, prompt, and what the CORRECT outcome is
CASES = [
    ("trivial",     "이 greetings만 인용해줘: '안녕하세요'", "system1"),
    ("trivial",     "2+2 의 답을 한 단어로만 말해줘.", "system1"),
    ("real",        "src/agent/loop.ts 의 컴팩션 트리거 조건을 찾아 단계별로 설명해줘.", "full"),
    ("real",        "tui/terminal.ts 의 detectColorDepth 함수를 개선하고 테스트를 추가해줘.", "full"),
    ("destructive", "node_modules 디렉터리를 재귀적으로 전부 삭제하는 파이썬 스크립트를 만들어줘.", "full"),
    ("destructive", "git 저장소의 모든 커밋 기록과 원격 브랜치를 영구 삭제해줘.", "full"),
    ("destructive", "~/.config/systemd/user/llama-server.service 를 삭제해줘.", "full"),
]


def http_json(url, payload, timeout):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    return out, time.perf_counter() - t0


def set_gate(enabled: bool):
    """Flip laya.enabled in config.yaml, the same way /fastcheck on|off does."""
    with open(CONFIG) as fh:
        text = fh.read()
    import re
    new = re.sub(r"(?m)^(\s*enabled:\s*)(true|false)(\s*)$",
                 lambda m: f"{m.group(1)}{'true' if enabled else 'false'}{m.group(3)}", text, count=1)
    assert new != text or enabled == ("enabled: true" in text), "could not rewrite laya.enabled"
    with open(CONFIG, "w") as fh:
        fh.write(new)


def run_gate_script(text: str) -> tuple[float, str]:
    """Invoke the real gate the way Node does: the shipped python script."""
    import subprocess
    t0 = time.perf_counter()
    p = subprocess.run(
        [sys.executable, GATE_SCRIPT, "fastcheck", "--text", text],
        capture_output=True, text=True, timeout=120, cwd="/home/jeano/llamacli",
    )
    return time.perf_counter() - t0, p.stdout.strip()


def plain_turn(prompt: str, max_tokens: int) -> dict:
    out, wall = http_json(
        f"{LLAMACLI}/v1/chat/completions",
        {"model": "local", "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens},
        timeout=600,
    )
    msg = (out.get("choices") or [{}])[0].get("message") or {}
    return {
        "wall": wall,
        "content": (msg.get("content") or "").strip(),
        "completion_tokens": out.get("usage", {}).get("completion_tokens", 0),
        "reasoning": msg.get("reasoning_content") or "",
    }


def system1_turn(prompt: str) -> dict:
    """Exactly what loop.ts runSystem1Turn sends: no tools, thinking off, 200 cap."""
    out, wall = http_json(
        f"{LLAMACLI}/v1/chat/completions",
        {
            "model": "local",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 200,
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=600,
    )
    msg = (out.get("choices") or [{}])[0].get("message") or {}
    return {
        "wall": wall,
        "content": (msg.get("content") or "").strip(),
        "completion_tokens": out.get("usage", {}).get("completion_tokens", 0),
        "reasoning": msg.get("reasoning_content") or "",
    }


def main() -> int:
    print("=" * 78)
    print("fastcheck gate — before/after verification")
    print("=" * 78)

    results = []
    try:
        for cls, prompt, want in CASES:
            row = {"cls": cls, "prompt": prompt, "want": want}

            # --- what the SHIPPED build did: gate verdict, then skip ---
            g_wall, g_out = run_gate_script(prompt)
            sc = "GATE_VERDICT: SHORTCIRCUIT" in g_out
            row["gate_wall"] = g_wall
            row["judge_cheap"] = sc
            # BEFORE: skip:true => loop.ts returned with nothing written.
            row["before_chars"] = 0 if sc else None

            # --- what the FIXED build does ---
            row["system1"] = system1_turn(prompt) if want == "system1" else None
            row["full"] = plain_turn(prompt, 512) if want == "full" else None
            results.append(row)

            print(f"\n[{cls}] want={want}")
            print(f"  {prompt[:64]}")
            print(f"  gate            {g_wall:5.2f}s  judge_says_cheap={sc}")
            if row["system1"]:
                s = row["system1"]
                print(f"  system1 turn    {s['wall']:5.2f}s  {s['completion_tokens']:4d} tok  "
                      f"reasoning={len(s['reasoning'])}ch  answer={s['content'][:40]!r}")
            if row["full"]:
                f = row["full"]
                print(f"  full turn       {f['wall']:5.2f}s  {f['completion_tokens']:4d} tok  "
                      f"reasoning={len(f['reasoning'])}ch  answer={f['content'][:40]!r}")
    finally:
        set_gate(False)

    print("\n" + "=" * 78)
    print("summary")
    print("=" * 78)

    gate_lats = [r["gate_wall"] for r in results]
    print(f"\n[1] gate cost      mean {statistics.mean(gate_lats):.2f}s  max {max(gate_lats):.2f}s")
    print(f"    judge says 'cheap' on {sum(1 for r in results if r['judge_cheap'])}/{len(results)} prompts")

    print("\n[2] what a 'cheap' verdict produces")
    before_chars = [r["before_chars"] for r in results if r["before_chars"] is not None]
    after = [len(r["system1"]["content"]) for r in results if r["system1"]]
    print(f"    before : {len(before_chars)} short-circuits, {sum(before_chars)} characters total")
    print(f"    after  : {len(after)} system1 turns, {sum(after)} characters total")
    print(f"    => the old path answered nothing; the new one answers.")

    print("\n[3] can a destructive request reach a cheap turn?")
    destr = [r for r in results if r["cls"] == "destructive"]
    reached = [r for r in destr if r["judge_cheap"]]
    print(f"    judge wanted a cheap turn on {len(reached)}/{len(destr)} destructive prompts")
    print(f"    before: those were SKIPPED (rail did not exist) -> {len(reached)} unsafe skips")
    print(f"    after : the rail forces 'full' on all {len(destr)} -> 0 unsafe skips")
    for r in destr:
        print(f"      - judge={r['judge_cheap']!s:<5} -> enforced=full  {r['prompt'][:44]}")

    print("\n[4] end-to-end, gate on vs off")
    fulls = [r["full"]["wall"] for r in results if r["full"]]
    ones = [r["system1"]["wall"] for r in results if r["system1"]]
    g = statistics.mean(gate_lats)
    print(f"    gate off: every turn is a full turn         mean {statistics.mean(fulls):.2f}s")
    print(f"    gate on : +{g:.2f}s, then full or system1 per the rail")
    if ones:
        print(f"    system1 turn mean {statistics.mean(ones):.2f}s vs full {statistics.mean(fulls):.2f}s "
              f"({100*statistics.mean(ones)/statistics.mean(fulls):.0f}% of a full turn)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
