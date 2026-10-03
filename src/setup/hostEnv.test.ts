import { test } from "node:test";
import assert from "node:assert/strict";
import { homeDir, defaultModelsDir, listeningPortsCommand, hasSystemd } from "./hostEnv.js";
import { binNameFor } from "./llamaCpp.js";

/**
 * These are the platform questions that had more than one right answer, and each
 * of them was a real bug before it had a function. Asserted here as units so the
 * failure names the cause rather than surfacing as a Windows-shaped mystery.
 */

test("home comes from HOME when set", () => {
  assert.equal(homeDir({ HOME: "/home/jeano" } as any), "/home/jeano");
});

test("home comes from USERPROFILE when HOME is unset", () => {
  // The Windows case, and the bug: HOME is normally NOT set there, so reading
  // only HOME produced a hardcoded POSIX root — a plausible path that cannot
  // exist, produced without any error.
  assert.equal(homeDir({ USERPROFILE: "C:\\Users\\jeano" } as any), "C:\\Users\\jeano");
});

test("HOME wins over USERPROFILE when both are set", () => {
  // The harness injects HOME; a Windows box that happens to export it (Git Bash
  // does) must not be overridden by a stale USERPROFILE.
  assert.equal(homeDir({ HOME: "/home/jeano", USERPROFILE: "C:\\Users\\jeano" } as any), "/home/jeano");
});

test("neither set does NOT yield /root", () => {
  // The specific failure: a hardcoded fallback is indistinguishable from a real
  // answer, so the caller cannot tell it is wrong.
  const h = homeDir({} as any);
  assert.notEqual(h, "/root", "a hardcoded POSIX root is the bug, not the fallback");
  assert.ok(h.length > 0, "must still return something usable");
});

test("the default models dir is under the home dir", () => {
  assert.equal(defaultModelsDir({ HOME: "/home/jeano" } as any).replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""), "/home/jeano/models"); // separator/drive are the runner's, not the product's
  // Prefix and suffix only, not the separator: `node:path.join` uses the RUNNER's
  // separator, so on Linux it yields "C:\\Users\\jeano/models" where real Windows
  // yields "C:\\Users\\jeano\\models". Asserting the separator here would be
  // asserting the test runner's platform, not the product's behaviour. What
  // matters — and what was broken — is that it follows USERPROFILE at all.
  const win = defaultModelsDir({ USERPROFILE: "C:\\Users\\jeano" } as any);
  assert.ok(win.startsWith("C:\\Users\\jeano"), `lost the profile dir: ${win}`);
  assert.ok(win.endsWith("models"), `lost the models leaf: ${win}`);
});

test("the default models dir is never a bare POSIX root", () => {
  const dir = defaultModelsDir({ USERPROFILE: "C:\\Users\\jeano" } as any);
  assert.ok(!dir.startsWith("/root"), `Windows env produced ${dir}`);
});

test("listening ports come from the platform's own tool", () => {
  assert.equal(listeningPortsCommand("linux").file, "ss");
  assert.equal(listeningPortsCommand("darwin").file, "ss");
  // `ss -ltnp` is Linux-only; on Windows the equivalent is netstat, whose pid is
  // a trailing column rather than embedded in a `users:` field.
  assert.equal(listeningPortsCommand("win32").file, "netstat");
  assert.deepEqual(listeningPortsCommand("win32").args, ["-ano"]);
});

test("systemd is only probed where it exists", () => {
  assert.equal(hasSystemd("linux"), true);
  assert.equal(hasSystemd("win32"), false);
  assert.equal(hasSystemd("darwin"), false);
});

test("the binary name carries the platform's executable suffix", () => {
  assert.equal(binNameFor("win32"), "llama-server.exe");
  assert.equal(binNameFor("linux"), "llama-server");
  assert.equal(binNameFor("darwin"), "llama-server");
});
