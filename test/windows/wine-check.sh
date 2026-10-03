#!/usr/bin/env bash
# OPTIONAL local Windows check under Wine (not run on the author's machine: Wine is not installed there).
# Runs the container-matrix probe with the WINDOWS build of Node, so process.platform === "win32" and paths use
# backslashes, against the shipped dist. Wine has no PowerShell/winget and different file-system details, so this is a
# smoke test, not a substitute for the GitHub Actions Windows run.
#
#   sudo apt install wine64
#   curl -LO https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip && unzip node-v22.11.0-win-x64.zip
#   WINE_NODE=$PWD/node-v22.11.0-win-x64/node.exe test/windows/wine-check.sh
set -euo pipefail
: "${WINE_NODE:?set WINE_NODE to the path of a Windows node.exe}"
command -v wine >/dev/null || { echo "wine not found (sudo apt install wine64)"; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/llamacli/dist"
tar xzf "$root/bin/llamacli-dist.tar.gz" -C "$work/llamacli/dist"
echo '{"type":"module"}' > "$work/llamacli/package.json"
export WINEDEBUG=-all
winpath() { winepath -w "$1" 2>/dev/null; }
LLAMACLI_DIST="$(winpath "$work/llamacli/dist")" LLAMACLI_NO_UPDATE=1 \
  wine "$WINE_NODE" "$(winpath "$root/test/containers/probe.mjs")" | tail -1 | tee "$work/probe.json"
node -e '
const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = [];
if (o.detected.platform !== "win32") bad.push("platform=" + o.detected.platform);
if (o.engineLadder[0] !== "cpu" && o.detected.gpuBackend === "none") bad.push("ladder=" + o.engineLadder);
console.log(bad.length ? "FAIL: " + bad.join("; ") : "PASS (wine): win32 detection and ladder look right");
process.exit(bad.length ? 1 : 0);
' "$work/probe.json"
