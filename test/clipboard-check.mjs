// Clipboard round trip using the SHIPPED dist: copySelection() → read the clipboard back → compare.
// Korean + emoji on purpose: `clip.exe` reads stdin in the OEM code page and mangles exactly this text.
//   LLAMACLI_DIST=<dir> node test/clipboard-check.mjs
// Windows: powershell Get-Clipboard · macOS: pbpaste · Linux: wl-paste (Wayland) / xclip -o / xsel -o (X11).
// Run on a developer machine it SAVES the current clipboard text first and RESTORES it afterwards.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const dist = resolve(process.env.LLAMACLI_DIST || new URL("../../dist", import.meta.url).pathname);
const { copySelection, clipboardTools } = await import(pathToFileURL(join(dist, "tui/selection.js")).href);


const text = "드래그 복사 확인 — 한글 ✓ 😀 line2\n  indented 둘째 줄";
const lf = (t) => t.replace(/\r\n/g, "\n");
const winRead = (shell) => execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], { encoding: "utf8" });
const tryRead = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return r.status === 0 ? r.stdout : undefined; };
function readClipboard() {
  if (process.platform === "win32") { for (const sh of ["powershell", "pwsh"]) { try { return lf(winRead(sh)).replace(/\n$/, ""); } catch { /* next */ } } return undefined; }
  if (process.platform === "darwin") return tryRead("pbpaste", []);
  if (process.env.WAYLAND_DISPLAY) { const v = tryRead("wl-paste", ["-n"]); if (v !== undefined) return v; }
  return tryRead("xclip", ["-selection", "clipboard", "-o"]) ?? tryRead("xsel", ["--clipboard", "--output"]);
}
function writeClipboard(t) {
  if (process.platform === "darwin") return spawnSync("pbcopy", [], { input: t, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
  if (process.platform === "win32") return true; // restoring on a throwaway CI runner is unnecessary
  if (process.env.WAYLAND_DISPLAY) return spawnSync("wl-copy", [], { input: t, stdio: ["pipe", "ignore", "ignore"] }) /* wl-copy forks a daemon that would hold inherited pipes open */.status === 0;
  return spawnSync("xclip", ["-selection", "clipboard"], { input: t, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
}
const before = process.env.CI ? undefined : readClipboard();

console.log("tools tried in order:", clipboardTools(process.env, process.platform).map((t) => t.cmd).join(" > "));
const r = await copySelection(text, { write: () => {}, path: join(tmpdir(), "llamacli-copy-check.txt") });
console.log("result:", JSON.stringify({ via: r.via, tool: r.tool, path: r.path, advice: r.advice }));
if (r.via !== "system") { console.error("FAIL: no system clipboard tool took the text"); process.exit(1); }

const got = readClipboard();
if (before !== undefined) writeClipboard(before); // put the developer's clipboard back
if (got === undefined) { console.error("FAIL: could not read the clipboard back"); process.exit(1); }
if (got !== text) {
  console.error("FAIL: clipboard text differs");
  console.error("  expected:", JSON.stringify(text));
  console.error("  got:     ", JSON.stringify(got));
  process.exit(1);
}
console.log(`PASS: ${r.tool} put ${text.length} chars (Korean + emoji + newline) on the clipboard exactly`);
