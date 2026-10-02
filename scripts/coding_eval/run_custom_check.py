"""python3 run_custom_check.py <task_id> <candidate.py>  -> exit 0 and prints PASS, else FAIL: reason."""
import sys, importlib.util, traceback, resource
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
sys.setrecursionlimit(3000)
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from custom_tasks import TASKS
tid, path = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("cand", path); mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    dict((t[0], t[2]) for t in TASKS)[tid](mod)
    print("PASS")
except AssertionError as e:
    print("FAIL:", str(e)[:300]); sys.exit(1)
except BaseException as e:
    print("FAIL:", type(e).__name__, str(e)[:200]); sys.exit(1)
