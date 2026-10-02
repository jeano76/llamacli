#!/usr/bin/env python3
"""Runs the coding eval against ONE already-running llama-server and grades it by EXECUTING the code.

  python3 eval_model.py --port 8080 --name qwen36 --out results/ [--he-step 4] [--think on|off]

Two suites:
  humaneval : every Nth HumanEval problem (default 4 -> 41 problems), thinking OFF, graded by the
              dataset's own tests.
  custom    : custom_tasks.py (11 harder tasks), thinking ON by default (what llamacli uses for
              agent work), graded by differential tests against reference implementations.
temperature 0 and repeat_penalty 1.1 (llamacli's own value). Pass@1, one attempt per problem.
Model-generated code runs in a subprocess with a timeout and a memory limit, in a temp dir.
"""
import argparse, json, os, re, resource, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from custom_tasks import TASKS

def chat(port, prompt, think, max_tokens, timeout=900):
    body = {
        "model": "x", "messages": [{"role": "user", "content": prompt}],
        "temperature": 0, "repeat_penalty": 1.1, "max_tokens": max_tokens, "seed": 1,
        "chat_template_kwargs": {"enable_thinking": think},
    }
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=timeout))
    return r, time.time() - t

def extract_code(text):
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text or "", re.S)
    return (blocks[-1] if blocks else (text or "")).strip("\n")

def limits():
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))

def run_py(args, timeout, cwd):
    try:
        p = subprocess.run(["python3", *args], capture_output=True, text=True, timeout=timeout, cwd=cwd,
                           preexec_fn=limits, env={"PATH": os.environ["PATH"], "HOME": cwd})
        return p.returncode == 0, (p.stdout + p.stderr).strip()[-300:]
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT"

def he_problems(step):
    path = os.environ.get("HUMANEVAL", "/tmp/claude-1000/codingeval/HumanEval.jsonl")
    rows = [json.loads(l) for l in open(path)]
    return rows[::step]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080); ap.add_argument("--name", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--he-step", type=int, default=4)
    ap.add_argument("--custom-think", default="on", choices=["on", "off"])
    ap.add_argument("--suites", default="humaneval,custom")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rec = open(os.path.join(a.out, f"{a.name}.jsonl"), "w")
    summary = {"name": a.name}

    def emit(suite, tid, passed, why, r, wall):
        u = r.get("usage", {}); m = r["choices"][0]["message"]
        row = {"suite": suite, "id": tid, "passed": passed, "why": why, "completion_tokens": u.get("completion_tokens"),
               "reasoning_chars": len(m.get("reasoning_content") or ""), "wall_s": round(wall, 1),
               "finish": r["choices"][0].get("finish_reason"), "tg": round(r.get("timings", {}).get("predicted_per_second", 0), 1)}
        rec.write(json.dumps(row, ensure_ascii=False) + "\n"); rec.flush()
        print(f"  [{suite}] {tid:18} {'PASS' if passed else 'FAIL'}  {row['completion_tokens']} tok  {row['wall_s']}s  {'' if passed else why[:70]}", flush=True)
        return row

    suites = a.suites.split(",")
    if "humaneval" in suites:
        rows = []
        for p in he_problems(a.he_step):
            prompt = ("Complete the following Python function. Reply with the COMPLETE function (including its signature "
                      "and any imports it needs) in a single ```python code block and nothing else.\n\n" + p["prompt"])
            r, wall = chat(a.port, prompt, think=False, max_tokens=1024)
            code = extract_code(r["choices"][0]["message"].get("content"))
            header = "\n".join(l for l in p["prompt"].splitlines() if l.startswith(("import ", "from ")))
            prog = f"{header}\n\n{code}\n\n{p['test']}\n\ncheck({p['entry_point']})\n"
            with tempfile.TemporaryDirectory() as d:
                f = os.path.join(d, "prog.py"); open(f, "w").write(prog)
                ok, why = run_py([f], 20, d)
            rows.append(emit("humaneval", p["task_id"], ok, why, r, wall))
        summary["humaneval"] = {"n": len(rows), "passed": sum(x["passed"] for x in rows),
                                "tokens": sum(x["completion_tokens"] or 0 for x in rows), "secs": round(sum(x["wall_s"] for x in rows))}
    if "custom" in suites:
        think = a.custom_think == "on"; rows = []
        only = set(filter(None, os.environ.get("CUSTOM_ONLY", "").split(",")))
        for tid, spec, _ in TASKS:
            if only and tid not in only: continue
            prompt = ("Write Python 3 code for the task below. Reply with ONLY the code in a single ```python code block "
                      "(no tests, no prints, no explanation).\n\n" + spec)
            r, wall = chat(a.port, prompt, think=think, max_tokens=12000)
            code = extract_code(r["choices"][0]["message"].get("content"))
            with tempfile.TemporaryDirectory() as d:
                f = os.path.join(d, "cand.py"); open(f, "w").write(code)
                ok, why = run_py([os.path.join(HERE, "run_custom_check.py"), tid, f], 120, d)
            rows.append(emit("custom", tid, ok, why, r, wall))
        summary["custom"] = {"n": len(rows), "passed": sum(x["passed"] for x in rows), "think": think,
                             "tokens": sum(x["completion_tokens"] or 0 for x in rows), "secs": round(sum(x["wall_s"] for x in rows))}
    print(json.dumps(summary, ensure_ascii=False))
    json.dump(summary, open(os.path.join(a.out, f"{a.name}.summary.json"), "w"), ensure_ascii=False)

if __name__ == "__main__":
    main()
