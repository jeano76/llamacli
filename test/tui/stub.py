"""Start the stub llama-server fixture on 8080 when that port is free (a clean machine has no server, and the CLI would
otherwise begin first-run provisioning: engine and model downloads)."""
import os, socket, subprocess, sys, time

def ensure_server(port=8080):
    s = socket.socket(); s.settimeout(0.5)
    busy = s.connect_ex(("127.0.0.1", port)) == 0
    s.close()
    if busy: return None
    here = os.path.dirname(os.path.abspath(__file__))
    stub = subprocess.Popen([sys.executable, os.path.join(here, "..", "containers", "fixtures", "stub-llama.py"), str(port)])
    time.sleep(1.0)
    print(f"[ui-test] port {port} was free: started a stub llama-server")
    return stub
