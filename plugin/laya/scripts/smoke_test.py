import sys, json, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8000"
KEY = None  # set if LAYA_API_KEY is enabled on the server

def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if KEY:
        req.add_header("Authorization", "Bearer " + KEY)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, (json.loads(e.read().decode()) if True else None)

# health
s, h = api("GET", "/health")
print("HEALTH:", s, json.dumps(h, ensure_ascii=False))
if s != 200:
    sys.exit("health not ok")

questions = {
    "q1": {
        "type": "choice",
        "instructions": "Use laya (System 1) to decide. Should we deploy the payment service now?",
        "criteria": {"yes": "metrics healthy, tests green, window open", "no": "any red flag"},
    }
}

s, resp = api("POST", "/v1/systemone", {
    "state": {"user_turn": "Shall I deploy the payment service now?"},
    "questions": questions,
})
print("SYSTEMONE:", s)
print(json.dumps(resp, ensure_ascii=False, indent=2))
if s != 200:
    sys.exit(1)
print("OK")
