"""Hard-ish coding tasks with DIFFERENTIAL tests: the model's code is run against my reference
implementation on many generated inputs, so expected values are computed, not hand-written.

Each task: (id, prompt, check(module) -> None | raises AssertionError)."""
import heapq, json, csv, io, random, itertools
from collections import OrderedDict

TASKS = []
def task(id, prompt):
    def deco(fn):
        TASKS.append((id, prompt, fn)); return fn
    return deco

# ── 1. LRU cache ───────────────────────────────────────────────────────────
@task("lru_cache", """Implement a class `LRUCache` with `__init__(self, capacity: int)`, `get(self, key) -> int` and `put(self, key, value) -> None`.
`get` returns the value or -1 if absent and marks the key most-recently-used. `put` inserts/updates (marking it most-recently-used) and, if the size exceeds capacity, evicts the least-recently-used key. Both must be O(1) average.""")
def check_lru(m):
    rnd = random.Random(1)
    for _ in range(200):
        cap = rnd.randint(1, 5)
        c, ref = m.LRUCache(cap), OrderedDict()
        for _ in range(60):
            k = rnd.randint(0, 7)
            if rnd.random() < 0.5:
                v = rnd.randint(0, 99)
                c.put(k, v)
                if k in ref: ref.move_to_end(k)
                ref[k] = v
                if len(ref) > cap: ref.popitem(last=False)
            else:
                exp = -1
                if k in ref: ref.move_to_end(k); exp = ref[k]
                assert c.get(k) == exp, f"get({k}) -> {c.get(k)} expected {exp}"

# ── 2. expression evaluator ────────────────────────────────────────────────
@task("calc", """Implement `evaluate(expr: str) -> float` for arithmetic expressions with + - * /, parentheses, decimal numbers, spaces and unary minus (e.g. "-(2+3)*-4", "2*-3", "--5"). Standard precedence, left-associative. Do NOT use eval/exec/ast. Raise ValueError for malformed input (unbalanced parentheses, dangling operator, empty string, two numbers in a row, unknown characters). Division by zero should raise ZeroDivisionError.""")
def check_calc(m):
    rnd = random.Random(2)
    def gen(d=0):
        r = rnd.random()
        if d > 3 or r < 0.3: return str(rnd.choice([1, 2, 3, 4, 5, 7, 10, 2.5, 0.5]))
        if r < 0.4: return "-" + gen(d + 1)
        if r < 0.55: return "(" + gen(d + 1) + ")"
        return gen(d + 1) + rnd.choice([" + ", "-", " * ", "/", " - "]) + gen(d + 1)
    n = 0
    while n < 300:
        e = gen()
        try: ref = eval(e.replace("--", "- -") if False else e)
        except ZeroDivisionError:
            try: m.evaluate(e); assert False, f"{e!r} should raise ZeroDivisionError"
            except ZeroDivisionError: n += 1; continue
        except SyntaxError: continue
        got = m.evaluate(e)
        assert abs(got - ref) < 1e-9 * max(1, abs(ref)), f"{e!r}: {got} != {ref}"
        n += 1
    for e in ["-(2+3)*-4", "--5", "2*-3", " 7 ", "((1))", "10/4"]:
        assert abs(m.evaluate(e) - eval(e.replace("--5", "- -5") if e == "--5" else e)) < 1e-9, e
    for bad in ["(1+2", "1+", "", "2 $ 3", "1 2", "()", "1+)", "*3"]:
        try: m.evaluate(bad); assert False, f"{bad!r} should raise ValueError"
        except ValueError: pass

# ── 3. merge intervals ─────────────────────────────────────────────────────
@task("merge_intervals", """Implement `merge_intervals(intervals: list[list[int]]) -> list[list[int]]` that merges all overlapping OR touching intervals ([1,2] and [2,3] merge into [1,3]) and returns them sorted by start. The input is unsorted and must not be mutated. Empty input returns [].""")
def check_merge(m):
    def ref(iv):
        out = []
        for s, e in sorted(iv):
            if out and s <= out[-1][1]: out[-1][1] = max(out[-1][1], e)
            else: out.append([s, e])
        return out
    rnd = random.Random(3)
    for _ in range(500):
        iv = []
        for _ in range(rnd.randint(0, 8)):
            a = rnd.randint(0, 20); iv.append([a, a + rnd.randint(0, 6)])
        copy = [list(x) for x in iv]
        got = m.merge_intervals(iv)
        assert iv == copy, "input was mutated"
        assert [list(x) for x in got] == ref(iv), f"{iv}: {got} != {ref(iv)}"

# ── 4. topological sort ────────────────────────────────────────────────────
@task("toposort", """Implement `toposort(n: int, edges: list[tuple[int,int]]) -> list[int] | None`. Nodes are 0..n-1; an edge (a, b) means a must come before b. Return the LEXICOGRAPHICALLY SMALLEST topological order (at every step pick the smallest available node), or None if the graph has a cycle.""")
def check_topo(m):
    def ref(n, edges):
        indeg = [0] * n; adj = [[] for _ in range(n)]
        for a, b in edges: adj[a].append(b); indeg[b] += 1
        h = [i for i in range(n) if indeg[i] == 0]; heapq.heapify(h); out = []
        while h:
            x = heapq.heappop(h); out.append(x)
            for y in adj[x]:
                indeg[y] -= 1
                if indeg[y] == 0: heapq.heappush(h, y)
        return out if len(out) == n else None
    rnd = random.Random(4)
    for _ in range(500):
        n = rnd.randint(0, 8)
        edges = [(rnd.randrange(n), rnd.randrange(n)) for _ in range(rnd.randint(0, 10))] if n else []
        got = m.toposort(n, edges)
        assert got == ref(n, edges), f"n={n} edges={edges}: {got} != {ref(n, edges)}"

# ── 5. bug fix ─────────────────────────────────────────────────────────────
@task("fix_flatten", '''The following function is supposed to flatten arbitrarily nested lists/tuples into one flat list, treating strings (and bytes) as atoms. It crashes with RecursionError on strings. Fix it and return the complete corrected function `flatten`.

```python
def flatten(x):
    out = []
    for item in x:
        if hasattr(item, "__iter__") or hasattr(item, "__getitem__"):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out
```
Only lists and tuples are containers to descend into; everything else (str, bytes, dict, set, numbers, None) is an atom. The top-level argument is always a list or tuple.''')
def check_flatten(m):
    def ref(x):
        out = []
        for i in x:
            if isinstance(i, (list, tuple)): out += ref(i)
            else: out.append(i)
        return out
    cases = [[], [1, [2, [3, [4]]]], ["ab", ["cd", ("ef",)]], [(), [[]], [(1,)]], [b"x", {1, 2}, {"a": 1}, None, 3.5],
             [[[[[]]]]], ["", ["a"]], [1, (2, [3, (4, [5])])]]
    for c in cases:
        assert m.flatten(c) == ref(c), f"{c!r}: {m.flatten(c)!r}"

# ── 6. roman numerals ──────────────────────────────────────────────────────
@task("roman", """Implement `to_roman(n: int) -> str` for 1..3999 and `from_roman(s: str) -> int`. `from_roman` must accept ONLY canonical numerals: raise ValueError for "IIII", "VX", "IC", "", "MMMM", "IIX", lowercase letters, or anything that `to_roman` would not produce. `to_roman` raises ValueError outside 1..3999.""")
def check_roman(m):
    vals = [(1000,"M"),(900,"CM"),(500,"D"),(400,"CD"),(100,"C"),(90,"XC"),(50,"L"),(40,"XL"),(10,"X"),(9,"IX"),(5,"V"),(4,"IV"),(1,"I")]
    def ref(n):
        s = ""
        for v, r in vals:
            while n >= v: s += r; n -= v
        return s
    for n in range(1, 4000):
        r = ref(n)
        assert m.to_roman(n) == r, f"to_roman({n})"
        assert m.from_roman(r) == n, f"from_roman({r})"
    for bad in ["IIII", "VX", "IC", "", "MMMM", "IIX", "iv", "XM", "VV", "IL", "LC"]:
        try: m.from_roman(bad); assert False, f"from_roman({bad!r}) should raise"
        except ValueError: pass
    for bad in [0, 4000, -3]:
        try: m.to_roman(bad); assert False, f"to_roman({bad}) should raise"
        except ValueError: pass

# ── 7. word wrap ───────────────────────────────────────────────────────────
@task("wrap_text", """Implement `wrap_text(text: str, width: int) -> list[str]`: greedy word wrap. Words are separated by any run of whitespace (collapse it; ignore leading/trailing whitespace). Put as many words per line as fit within `width` characters (single space between words). A word longer than `width` is split into chunks of exactly `width` characters (the last chunk may be shorter) and each chunk goes on its own line; the next word then starts a new line. Empty/blank text returns [].""")
def check_wrap(m):
    def ref(text, w):
        lines, cur = [], ""
        for word in text.split():
            if len(word) > w:
                if cur: lines.append(cur); cur = ""
                chunks = [word[i:i+w] for i in range(0, len(word), w)]
                lines.extend(chunks); continue
            if not cur: cur = word
            elif len(cur) + 1 + len(word) <= w: cur += " " + word
            else: lines.append(cur); cur = word
        if cur: lines.append(cur)
        return lines
    rnd = random.Random(7)
    for _ in range(500):
        words = ["".join(rnd.choice("abcde") for _ in range(rnd.randint(1, 9))) for _ in range(rnd.randint(0, 10))]
        text = "".join(w + rnd.choice([" ", "  ", "\n", "\t ", " "]) for w in words)
        text = rnd.choice(["", "  "]) + text
        w = rnd.randint(1, 12)
        assert m.wrap_text(text, w) == ref(text, w), f"{text!r} w={w}: {m.wrap_text(text, w)} != {ref(text, w)}"

# ── 8. dijkstra ────────────────────────────────────────────────────────────
@task("dijkstra", """Implement `shortest_path(graph: dict, src, dst) -> tuple` where graph maps node -> {neighbor: weight} (non-negative ints, directed). Return (distance, path) where path is a list of nodes from src to dst, or (None, []) if dst is unreachable. If src == dst return (0, [src]). Nodes that appear only as neighbors may have no entry in the dict.""")
def check_dij(m):
    def ref(g, s, t):
        dist = {s: 0}; h = [(0, s)]
        while h:
            d, u = heapq.heappop(h)
            if d > dist.get(u, 1e18): continue
            for v, w in g.get(u, {}).items():
                if d + w < dist.get(v, 1e18): dist[v] = d + w; heapq.heappush(h, (d + w, v))
        return dist.get(t)
    rnd = random.Random(8)
    for _ in range(400):
        n = rnd.randint(1, 8); g = {}
        for _ in range(rnd.randint(0, 14)):
            a, b = rnd.randrange(n), rnd.randrange(n)
            g.setdefault(a, {})[b] = rnd.randint(0, 9)
        s, t = rnd.randrange(n), rnd.randrange(n)
        d, p = m.shortest_path(g, s, t)
        exp = ref(g, s, t)
        if exp is None: assert (d, p) == (None, []), f"unreachable: got {(d, p)}"; continue
        assert d == exp, f"dist {d} != {exp} for {g} {s}->{t}"
        assert p and p[0] == s and p[-1] == t, f"bad path {p}"
        assert sum(g[a][b] for a, b in zip(p, p[1:])) == exp, f"path {p} does not sum to {exp}"

# ── 9. nested list parser ──────────────────────────────────────────────────
@task("parse_nested", """Implement `parse_nested(s: str)` that parses a string such as "[1, [2,3], [], -4]" into the corresponding Python nested list of ints. Allow whitespace anywhere between tokens and negative integers. Do NOT use json, ast or eval. Raise ValueError for anything malformed: missing/extra brackets or commas, trailing commas, "[1 2]", non-integers like 1.5 or abc, text after the closing bracket, empty string. The top level must be a list.""")
def check_nested(m):
    rnd = random.Random(9)
    def gen(d=0):
        out = []
        for _ in range(rnd.randint(0, 3)):
            out.append(gen(d + 1) if d < 3 and rnd.random() < 0.35 else rnd.randint(-20, 99))
        return out
    for _ in range(300):
        v = gen(); s = json.dumps(v)
        s = s.replace(",", rnd.choice([",", " , ", ",\n"])).replace("[", rnd.choice(["[", " [ "]))
        assert m.parse_nested(s) == v, f"{s!r}"
    for bad in ["", "[", "]", "[1,]", "[,1]", "[1 2]", "[1.5]", "[abc]", "[1]x", "[[1]", "1", "[1,,2]", "[--1]", "[+1]x"]:
        try: m.parse_nested(bad); assert False, f"{bad!r} should raise ValueError"
        except ValueError: pass

# ── 10. CSV line ───────────────────────────────────────────────────────────
@task("parse_csv_line", """Implement `parse_csv_line(line: str) -> list[str]` for ONE CSV record (RFC-4180 style): fields separated by commas; a field may be wrapped in double quotes, in which case it can contain commas and a doubled quote ("") stands for one literal quote. Unquoted fields are taken verbatim (no stripping). An empty line returns [""]. Do NOT use the csv module.""")
def check_csv(m):
    rnd = random.Random(10)
    alphabet = ['a', 'b', ' ', ',', '"', 'x']
    for _ in range(600):
        fields = ["".join(rnd.choice(alphabet) for _ in range(rnd.randint(0, 5))) for _ in range(rnd.randint(1, 5))]
        buf = io.StringIO(); csv.writer(buf, lineterminator="").writerow(fields); line = buf.getvalue()
        got = m.parse_csv_line(line)
        ref = next(csv.reader([line]), [""]) if line else [""]
        assert got == ref, f"{line!r}: {got} != {ref}"

# ── 11. min window ─────────────────────────────────────────────────────────
@task("min_window", """Implement `min_window(s: str, t: str) -> str`: the shortest substring of `s` that contains every character of `t` with at least the same multiplicity (e.g. t="aab" needs two 'a'). If several have the same length return the LEFTMOST. If none exists, or t is empty, return "". Must run in O(len(s)+len(t)).""")
def check_minwin(m):
    from collections import Counter
    def ref(s, t):
        if not t: return ""
        need = Counter(t); best = None
        for i in range(len(s)):
            for j in range(i + 1, len(s) + 1):
                if not (Counter(s[i:j]) - need == Counter(s[i:j]) - need and not (need - Counter(s[i:j]))): continue
                if best is None or j - i < len(best): best = s[i:j]
                break
        return best or ""
    rnd = random.Random(11)
    for _ in range(600):
        s = "".join(rnd.choice("abc") for _ in range(rnd.randint(0, 12)))
        t = "".join(rnd.choice("abc") for _ in range(rnd.randint(0, 4)))
        assert m.min_window(s, t) == ref(s, t), f"s={s!r} t={t!r}: {m.min_window(s, t)!r} != {ref(s, t)!r}"
