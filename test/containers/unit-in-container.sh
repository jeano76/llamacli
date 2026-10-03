#!/usr/bin/env bash
# The whole unit-test suite in a CLEAN Linux container (no llama.cpp, no models, no ~/.llamacli, a different user/home),
# to catch tests that only pass on the author's machine. Found two such tests on its first run.
#   test/containers/unit-in-container.sh [image]      (podman or docker)
set -euo pipefail
rt="$(command -v podman || command -v docker)"; img="${1:-docker.io/library/node:22-bookworm}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
"$rt" run --rm -v "$root":/src:ro,Z "$img" bash -c '
  set -e
  mkdir /work && cd /src
  # .llamacli can hold a multi-GB virtualenv on a developer machine; node_modules/.git/dist are rebuilt or irrelevant.
  tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=.llamacli -cf - . | tar -xf - -C /work
  cd /work && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc --noEmit
  npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped|cancelled)|^not ok"
'
