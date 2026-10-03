"""A tiny cross-platform terminal driver for UI tests: spawn a program on a pseudo-terminal, feed its output to a VT
screen (pyte), write keystrokes/mouse reports to it.  POSIX: pty.  Windows: ConPTY through pywinpty.
Requires: pip install pyte  (+ pywinpty on Windows)."""
import os, sys, time, queue, threading, shutil

IS_WIN = os.name == "nt"

class Term:
    def __init__(self, argv, cwd, env, cols=110, rows=36):
        self.cols, self.rows = cols, rows
        argv = [shutil.which(argv[0]) or argv[0]] + list(argv[1:])
        if IS_WIN:
            from winpty import PtyProcess
            self._p = PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
            self._q = queue.Queue()
            def pump():
                try:
                    while True:
                        chunk = self._p.read(65536)
                        if chunk == "" and not self._p.isalive(): break
                        if chunk: self._q.put(chunk.encode("utf-8", "replace"))
                except Exception:
                    pass
            threading.Thread(target=pump, daemon=True).start()
        else:
            import pty, fcntl, termios, struct
            self._pid, self._fd = pty.fork()
            if self._pid == 0:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            fcntl.ioctl(self._fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            self._exit = None

    def read(self, timeout=0.2):
        """Bytes available within `timeout` seconds (possibly b'')."""
        if IS_WIN:
            out = b""
            end = time.time() + timeout
            while time.time() < end:
                try: out += self._q.get(timeout=max(0.01, end - time.time()))
                except queue.Empty: break
                while not self._q.empty(): out += self._q.get_nowait()
                break
            return out
        import select
        r, _, _ = select.select([self._fd], [], [], timeout)
        if not r: return b""
        try: return os.read(self._fd, 65536)
        except OSError: return b""

    def write(self, data):
        if isinstance(data, str): data = data.encode()
        if IS_WIN: self._p.write(data.decode("utf-8", "replace"))
        else: os.write(self._fd, data)

    def exit_code(self):
        """None while running, else the exit status."""
        if IS_WIN:
            return None if self._p.isalive() else (self._p.exitstatus if self._p.exitstatus is not None else 0)
        if self._exit is not None: return self._exit
        done, status = os.waitpid(self._pid, os.WNOHANG)
        if done: self._exit = os.waitstatus_to_exitcode(status); return self._exit
        return None

    def close(self):
        if self.exit_code() is not None: return
        try: self.write(b"\x03"); time.sleep(0.4); self.write(b"\x03"); time.sleep(0.4)
        except Exception: pass
        if IS_WIN:
            try: self._p.terminate(force=True)
            except Exception: pass
            return
        for sig in (15, 9):
            try: os.kill(self._pid, sig)
            except Exception: break
            t_end = time.time() + 2
            while time.time() < t_end:
                try: done, _ = os.waitpid(self._pid, os.WNOHANG)
                except ChildProcessError: done = self._pid
                if done: return
                time.sleep(0.1)
        try: os.close(self._fd)
        except Exception: pass
