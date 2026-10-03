// Windows clipboard round trip using the SHIPPED dist: copySelection() → read the clipboard back → compare.
// Korean + emoji on purpose: `clip.exe` reads stdin in the OEM code page and mangles exactly this text.
//   LLAMACLI_DIST=<dir> node test/windows/clipboard-check.mjs
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const dist = resolve(process.env.LLAMACLI_DIST || new URL("../../dist", import.meta.url).pathname);
const { copySelection, clipboardTools } = await import(pathToFileURL(join(dist, "tui/selection.js")).href);

const text = "드래그 복사 확인 — 한글 ✓ 😀 line2\n  indented 둘째 줄";
const readBack = (shell) =>
  execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], { encoding: "utf8" }).replace(/\r\n/g, "\n").replace(/\n$/, "");

console.log("tools tried in order:", clipboardTools(process.env, process.platform).map((t) => t.cmd).join(" > "));
const r = await copySelection(text, { write: () => {}, path: join(tmpdir(), "llamacli-copy-check.txt") });
console.log("result:", JSON.stringify({ via: r.via, tool: r.tool, path: r.path, advice: r.advice }));
if (r.via !== "system") { console.error("FAIL: no system clipboard tool took the text"); process.exit(1); }

let got;
for (const sh of ["powershell", "pwsh"]) { try { got = readBack(sh); break; } catch { /* try next */ } }
if (got === undefined) { console.error("FAIL: could not read the clipboard back"); process.exit(1); }
if (got !== text) {
  console.error("FAIL: clipboard text differs");
  console.error("  expected:", JSON.stringify(text));
  console.error("  got:     ", JSON.stringify(got));
  process.exit(1);
}
console.log(`PASS: ${r.tool} put ${text.length} chars (Korean + emoji + newline) on the clipboard exactly`);
