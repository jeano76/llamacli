#!/usr/bin/env python3
"""A minimal stand-in for a running llama.cpp server, so a UI test on a CLEAN machine adopts a server instead of
starting first-run provisioning (engine + model downloads). Answers what llamacli asks when it adopts and probes:
/health, /props (with build_info, so it is classified as llama.cpp), /v1/models, /slots, and a chat completion that
echoes the health probe's sentinel.   usage: stub-llama.py <port>"""
import json, re, sys, http.server

PORT = int(sys.argv[1])

class H(http.server.BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/health": return self._json({"status": "ok"})
        if p == "/props": return self._json({"build_info": "b1-stub", "model_path": "stub", "default_generation_settings": {"n_ctx": 8192}})
        if p == "/slots": return self._json([{"id": 0, "n_ctx": 8192, "is_processing": False}])
        if p in ("/v1/models", "/models"): return self._json({"models": [{"name": "stub", "model": "stub"}], "data": [{"id": "stub", "object": "model"}]})
        self._json({"error": "not found"}, 404)
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        text = " ".join(str(m.get("content", "")) for m in body.get("messages", []))
        m = re.search(r"string and nothing else:\s*(\S+)", text)
        out = m.group(1) if m else "ok"
        self._json({"id": "x", "object": "chat.completion", "model": "stub", "choices": [{"index": 0, "message": {"role": "assistant", "content": out}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
