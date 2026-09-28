#!/usr/bin/env python3
"""Capture REAL terminal frames from the built llamacli, rendered as text.

Every screenshot in docs/screenshots/ was produced by this script: it forks a
pty, runs the actual built binary, replays keystrokes, and interprets the VT100
output back into the visible screen. Nothing is mocked and no frame is
hand-drawn, so the captures are evidence rather than illustration — which is
how a status bar that was 41 columns wide on a 40-column terminal got caught.


Uses a pty and a tiny VT100 interpreter so what lands in the README is what
the terminal actually displayed — not a mock-up, and not raw escape bytes.

    python3 capture_frames.py <outdir> [cols] [rows]
"""
from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

CLI = ["node", "/home/jeano/llamacli/dist/index.js"]


class Screen:
    """Just enough VT100 to reconstruct the visible screen."""

    def __init__(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        self.buf = [[" "] * cols for _ in range(rows)]
        self.x = self.y = 0
        self.saved = None
        self.alt = False
        # (row, col) of the last cursor position the app SET, and whether it
        # was ever hidden. Used to verify the prompt cursor actually lands in
        # the input box rather than at the end of the frame (bottom-left).
        self.cursor_moves: list[tuple[int, int]] = []
        self.cursor_hidden = False
        self.main = [[" "] * cols for _ in range(rows)]

    def cursor_report(self) -> str:
        if not self.cursor_moves:
            return "no explicit cursor positioning seen"
        last = self.cursor_moves[-1]
        return (
            f"last cursor placed at row={last[0]} col={last[1]} "
            f"(1-based, {len(self.cursor_moves)} placements); "
            f"hidden={self.cursor_hidden}; final pen at row={self.y + 1} col={self.x + 1}"
        )

    def _clamp(self):
        self.x = max(0, min(self.cols - 1, self.x))
        self.y = max(0, min(self.rows - 1, self.y))

    def put(self, ch: str, width: int = 1):
        if self.y >= self.rows or self.x >= self.cols:
            return
        self.buf[self.y][self.x] = ch
        for i in range(1, width):
            if self.x + i < self.cols:
                self.buf[self.y][self.x + i] = ""
        self.x += width
        self._clamp()

    def feed(self, data: str):
        i, n = 0, len(data)
        while i < n:
            c = data[i]
            if c == "\x1b":
                m = re.match(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])", data[i:])
                if m:
                    self.csi(m.group(1), m.group(3))
                    i += m.end()
                    continue
                m = re.match(r"\x1b\]([^\x07\x1b]*)(\x07|\x1b\\)", data[i:])
                if m:
                    i += m.end()
                    continue
                m = re.match(r"\x1b([()][0-9A-Za-z]|[=><78MDEHc])", data[i:])
                if m:
                    i += m.end()
                    continue
                i += 1
                continue
            if c == "\r":
                self.x = 0
            elif c == "\n":
                self.y += 1
                if self.y >= self.rows:
                    self.buf.pop(0)
                    self.buf.append([" "] * self.cols)
                    self.y = self.rows - 1
            elif c == "\b":
                self.x = max(0, self.x - 1)
            elif c == "\t":
                self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif c == "\x07":
                pass
            else:
                import unicodedata
                self.put(c, 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1)
            i += 1
        self._clamp()

    def csi(self, params: str, final: str):
        priv = params.startswith("?")
        p = params[1:] if priv else params
        nums = [int(x) for x in p.split(";") if x.isdigit()]
        a = nums[0] if nums else None
        if priv:
            if final == "h" and a == 1049:
                self.main = [r[:] for r in self.buf]
                self.buf = [[" "] * self.cols for _ in range(self.rows)]
                self.alt = True
            elif final == "l" and a == 1049:
                self.alt = False
            return
        if final == "H" or final == "f":
            self.y = (nums[0] - 1) if len(nums) > 0 else 0
            self.x = (nums[1] - 1) if len(nums) > 1 else 0
            self.cursor_moves.append((self.y + 1, self.x + 1))
            self._clamp()
        elif final == "l" and a == 25:
            self.cursor_hidden = True
        elif final == "h" and a == 25:
            self.cursor_hidden = False
        elif final == "J":
            mode = a or 0
            if mode == 2:
                self.buf = [[" "] * self.cols for _ in range(self.rows)]
            elif mode == 0:
                for xx in range(self.x, self.cols):
                    self.buf[self.y][xx] = " "
                for yy in range(self.y + 1, self.rows):
                    self.buf[yy] = [" "] * self.cols
        elif final == "K":
            mode = a or 0
            if mode == 0:
                for xx in range(self.x, self.cols):
                    self.buf[self.y][xx] = " "
            elif mode == 2:
                self.buf[self.y] = [" "] * self.cols
        elif final == "A":
            self.y -= a or 1
        elif final == "B":
            self.y += a or 1
        elif final == "C":
            self.x += a or 1
        elif final == "D":
            self.x -= a or 1

    def text(self) -> str:
        return "\n".join("".join(r).rstrip() for r in self.buf).rstrip("\n")


def type_realistic(text: str, at: float, per: float = 0.13) -> list[tuple[float, bytes]]:
    """One keypress per write, spaced.

    Sending a whole command in a single write() is not what a terminal does —
    it made `/term` arrive as one 6-byte chunk and got misclassified as a
    paste, which is a capture artifact rather than app behaviour. Real typing
    produces one key per read, so the capture has to as well or it is testing
    a program that does not exist.
    """
    out = []
    for i, ch in enumerate(text):
        out.append((at + i * per, ch.encode()))
    return out


def run(keys: list[tuple[float, bytes]], cols: int, rows: int, settle: float = 6.0) -> Screen:
    env = dict(os.environ)
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "ko_KR.UTF-8",
                "COLUMNS": str(cols), "LINES": str(rows), "LLAMACLI_NO_UPDATE": "1"})
    for k in ("TMUX", "NO_COLOR", "WT_SESSION", "TERM_PROGRAM"):
        env.pop(k, None)

    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.chdir("/home/jeano/llamacli")
        os.execvpe(CLI[0], CLI, env)
        os._exit(1)

    sc = Screen(cols, rows)
    start = time.time()
    qi = 0
    last = time.time()
    while time.time() - start < settle:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            sc.feed(chunk.decode("utf-8", "replace"))
            last = time.time()
        now = time.time()
        while qi < len(keys) and keys[qi][0] <= now - start:
            os.write(fd, keys[qi][1])
            qi += 1
        if qi >= len(keys) and now - last > 2.5:
            break
    try:
        os.kill(pid, 15)
        os.waitpid(pid, os.WNOHANG)
    except Exception:
        pass
    return sc


def cmd(text: str, at: float = 2.5, per: float = 0.13) -> list[tuple[float, bytes]]:
    """Type `text` then press Enter, with Enter strictly after the last key.

    Hardcoding the Enter timestamp raced the final character (the `/term`
    capture was still sitting in the menu), which looked exactly like a
    broken command dispatch. Timing has to be derived from the typing itself.
    """
    keys = type_realistic(text, at, per)
    end = keys[-1][0] + per if keys else at
    return keys + [(end + per, b"\r")]


SHOTS = {
    "startup": ([], 100, 30),
    "slash-menu": ([(3.0, b"/")], 100, 30),
    "help": (cmd("/help"), 100, 34),
    "keys": (cmd("/keys"), 100, 40),
    "term-diagnostics": (cmd("/term"), 100, 26),
    "typed-input": (type_realistic("src/tui/App.tsx 의 컴팩션 조건을 설명해줘", 2.5), 100, 30),
    "narrow-80": ([(2.5, b"/")], 80, 24),
    "tiny-40": ([(2.5, b"/")], 40, 16),
}


def main() -> int:
    outdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/shots"
    os.makedirs(outdir, exist_ok=True)
    for name, (keys, cols, rows) in SHOTS.items():
        sc = run(keys, cols, rows)
        text = sc.text()
        path = os.path.join(outdir, f"{name}.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        width = max((len(l) for l in text.split("\n")), default=0)
        print(f"{name:20} {cols}x{rows}  maxcol={width:3d}  {len(text.splitlines())} lines  -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
