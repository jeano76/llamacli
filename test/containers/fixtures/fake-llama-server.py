import sys, os, http.server
a = sys.argv
port = int(a[a.index("--port") + 1])
moe = int(a[a.index("--n-cpu-moe") + 1]) if "--n-cpu-moe" in a else 0
if moe < int(os.environ.get("FAKE_MIN_MOE", "0")):
    sys.stderr.write("ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory\n"); sys.exit(1)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"data":[{"id":"fake"}],"status":"ok"}')
    def log_message(self, *x): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
