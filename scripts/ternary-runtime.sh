#!/usr/bin/env bash
# Get a llama-server that can read the ternary quants (PTQ1_0 / PQ2_0), on any
# platform, verifying every rung before claiming it.
#
# Standalone on purpose: it must work on a machine where llamacli itself cannot run
# yet — which is exactly when the missing ternary-capable runtime is the problem.
# Same ladder and the same pinned release as src/setup/ternaryRuntime.ts, so the two
# cannot disagree about what "the right build" means.
#
# The ladder, best and cheapest first. Each rung is EXECUTED before it is accepted:
#
#   1. GPU prebuilt   (CUDA / Vulkan)  — needs a driver new enough to load it
#   2. CPU prebuilt                      — always available, slower
#   3. from source, the PrismML fork     — CUDA if nvcc exists, CPU if not
#
# Never stock ggml-org/llama.cpp: it rejects these models outright with
# "invalid ggml type 143", so it is not a fallback, it is the original bug.
#
# Usage:
#   scripts/ternary-runtime.sh [--dest DIR] [--model FILE] [--gpu auto|cuda|vulkan|cpu]
#                              [--force] [--no-build]
#
# WSL: detected automatically. The CUDA runtime arrives from the Windows driver, so
# a GPU prebuilt can unpack and pass a --version check and still fail to initialise
# the device — the binary is asked for its devices, and --gpu cpu is the escape
# hatch when passthrough is not cooperating.
#
# Exit codes: 0 a verified runtime is in place · 1 nothing worked (see the summary)
set -uo pipefail

RELEASE_TAG="${PRISM_RELEASE_TAG:-prism-b10743-adfffbe}"
FORK_REPO="${PRISM_REPO:-https://github.com/PrismML-Eng/llama.cpp}"
BASE_URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${RELEASE_TAG}"
DEST="${HOME}/.llamacli/prism-llama.cpp"
MODEL=""
FORCE=0
ALLOW_BUILD=1
GPU_OVERRIDE=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-build) ALLOW_BUILD=0; shift ;;
    --gpu) GPU_OVERRIDE="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '  · %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*" >&2; }
fail() { printf '  ! %s\n' "$*" >&2; }

ATTEMPTS=""

# ── platform ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "지원하지 않는 아키텍처: $ARCH_RAW"; exit 1 ;;
esac

# ── WSL ───────────────────────────────────────────────────────────────────────
# WSL reports itself as plain Linux, so nothing here can notice it by uname. It has
# to be asked, and it matters: under WSL the CUDA runtime is provided by the Windows
# driver through /usr/lib/wsl/lib, so a Linux CUDA prebuilt can unpack fine, pass a
# naive `--version` check, and still fail to initialise the device — which is the
# usual WSL symptom and is invisible without asking the binary for its devices.
IS_WSL=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi

GPU_KIND="cpu"
CUDA_TAG=""
if command -v nvidia-smi >/dev/null 2>&1; then
  CUDA_VER="$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA[ A-Z]*Version:[[:space:]]*\([0-9]*\.[0-9]*\).*/\1/p')"
  if [ -n "${CUDA_VER:-}" ]; then
    GPU_KIND="cuda"
    # Newest published tag the driver can run, else the oldest. Mirrors
    # pickPublishedCudaTag: the published set DIFFERS per platform and Windows has
    # no 12.8, so naming one that does not exist 404s behind a large download.
    major="${CUDA_VER%%.*}"; minor="${CUDA_VER#*.}"
    if [ "$OS" = "Darwin" ]; then :; elif [ "$ARCH" = x64 ] && [ "$OS" = Linux ]; then
      if [ "$major" -gt 13 ] || { [ "$major" -eq 13 ] && [ "$minor" -ge 3 ]; }; then CUDA_TAG=13.3
      elif [ "$major" -eq 13 ] || { [ "$major" -eq 12 ] && [ "$minor" -ge 8 ]; }; then CUDA_TAG=12.8
      else CUDA_TAG=12.4; fi
    else
      # Windows x64 publishes 12.4 and 13.3 only.
      if [ "$major" -gt 13 ] || { [ "$major" -eq 13 ] && [ "$minor" -ge 3 ]; }; then CUDA_TAG=13.3; else CUDA_TAG=12.4; fi
    fi
  fi
fi
[ "$GPU_KIND" = cpu ] && { command -v vulkaninfo >/dev/null 2>&1 && GPU_KIND=vulkan; }

case "$GPU_OVERRIDE" in
  cpu) GPU_KIND=cpu; CUDA_TAG="" ;;
  cuda) GPU_KIND=cuda ;;
  vulkan) GPU_KIND=vulkan; CUDA_TAG="" ;;
  auto) ;;
  *) fail "--gpu 는 auto|cuda|vulkan|cpu 중 하나여야 합니다: $GPU_OVERRIDE"; exit 2 ;;
esac

HAVE_NVCC=0
command -v nvcc >/dev/null 2>&1 && HAVE_NVCC=1

# ── asset naming ────────────────────────────────────────────────────────────
asset_for() { # $1 = cpu|cuda|vulkan
  case "$OS" in
    Darwin) echo "llama-${RELEASE_TAG}-bin-macos-${ARCH}.tar.gz" ;;
    Linux)
      case "$1" in
        cuda)  echo "llama-${RELEASE_TAG}-bin-linux-cuda-${CUDA_TAG}-x64.tar.gz" ;;
        vulkan) echo "llama-${RELEASE_TAG}-bin-ubuntu-vulkan-${ARCH}.tar.gz" ;;
        *)     echo "llama-${RELEASE_TAG}-bin-ubuntu-${ARCH}.tar.gz" ;;
      esac ;;
    MINGW*|MSYS*|CYGWIN*) echo "llama-${RELEASE_TAG}-bin-win-${1/win/cpu}"; ;; # refined below
  esac
}
win_asset() { # $1 = cpu|cuda
  case "$1" in
    cuda) if [ "$ARCH" = x64 ]; then echo "llama-${RELEASE_TAG}-bin-win-cuda-${CUDA_TAG}-x64.zip"
          else echo "llama-${RELEASE_TAG}-bin-win-cuda-13.4-arm64.zip"; fi ;;
    *) echo "llama-${RELEASE_TAG}-bin-win-cpu-${ARCH}.zip" ;;
  esac
}
# Windows ships its CUDA runtime as a SEPARATE asset; without it the binary unpacks
# and then fails to load, which reads as a corrupt download.
win_companion() { # $1 = cuda
  case "$1" in
    cuda) if [ "$ARCH" = x64 ]; then echo "cudart-llama-bin-win-cuda-${CUDA_TAG}-x64.zip"
          else echo "cudart-llama-bin-win-cuda-13.4-arm64.zip"; fi ;;
  esac
}
strip_for() {
  case "$OS" in Darwin|Linux) echo 1 ;; *) echo 0 ;; esac
}
is_windows() {
  case "$OS" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac
}
format_for() { case "$OS" in Darwin|Linux) echo tar.gz ;; *) echo zip ;; esac; }

unpack() { # $1 archive $2 dest $3 strip
  if [ "$(format_for)" = tar.gz ]; then
    tar -xzf "$1" -C "$2" --strip-components="$3" 2>/dev/null || tar -xzf "$1" -C "$2"
  else
    command -v unzip >/dev/null 2>&1 || { fail "unzip 이 필요합니다 (Windows 는 PowerShell Expand-Archive 사용)."; return 1; }
    unzip -qo "$1" -d "$2"
  fi
}

# ── verification: does it actually RUN ──────────────────────────────────────
BIN_NAME="llama-server"
if is_windows; then BIN_NAME="llama-server.exe"; fi

verify() { # $1 binPath
  [ -f "$1" ] || { echo "파일 없음"; return 1; }
  # `--version` exits on its own; still bounded, because a broken dynamic link can
  # leave it waiting on a loader prompt.
  command -v timeout >/dev/null 2>&1 && local T="timeout 90" || local T=""
  # shellcheck disable=SC2086
  if ! $T "$1" --version >/dev/null 2>&1; then
    echo "실행되지 않음: $( { $T "$1" --version; } 2>&1 | head -1)"
    return 1
  fi
  # `--version` does NOT initialise CUDA, and the model check below runs at -ngl 0,
  # so neither proves the accelerator loads. Under WSL that is exactly the thing
  # that fails — the runtime comes from the Windows driver, and a binary that cannot
  # find it still passes every other check and then dies on the first real request.
  # Asking for the device list is what actually exercises it.
  if [ "$WANT_GPU" -eq 1 ]; then
    local devs
    devs="$({ $T "$1" --list-devices; } 2>&1)"
    # Herestring, never `printf | grep -q`: with `pipefail` the early-exiting grep
    # closes the pipe, a large printf dies of SIGPIPE, and the pipeline reports 141 —
    # so a match is reported as ABSENT. That inverted exactly the checks whose whole
    # job is to notice a failure.
    if [ $? -ne 0 ] || ! grep -qiE 'CUDA[0-9]|Vulkan|ROCm' <<<"$devs"; then
      echo "가속기를 초기화할 수 없음: $(grep -viE '^$' <<<"$devs" | head -1)"
      if [ "$IS_WSL" -eq 1 ]; then
        echo "(WSL: Windows NVIDIA 드라이버가 /usr/lib/wsl/lib 에 CUDA 런타임을 제공합니다 — 없으면 --gpu cpu 로 다시 시도하세요)"
      fi
      return 1
    fi
  fi

  if [ -n "$MODEL" ] && [ -f "$MODEL" ]; then
    # `--no-warmup` stops after LOADING, but the server then binds and serves — it
    # does NOT exit. Without `timeout` this blocks forever, which is exactly what an
    # unbounded probe looks like to whoever is waiting.
    local out rc
    out="$({ $T "$1" -m "$MODEL" -c 64 -ngl 0 --no-warmup; } 2>&1)"
    rc=$?
    if grep -qiE 'invalid ggml type|unknown ggml type' <<<"$out"; then
      echo "양자화 미지원: $(grep -iE 'invalid ggml type|unknown ggml type' <<<"$out" | head -1)"
      return 1
    fi
    # 124 is timeout's code. Having read the weights without complaint is the
    # signal, so a bounded run that loaded successfully still counts as a pass.
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && ! grep -qi 'model loaded' <<<"$out"; then
      echo "모델 로드 실패: $(tail -1 <<<"$out")"
      return 1
    fi
    # The diagnostic the user needs to act on, not just a verdict.
    grep -qi 'model loaded' <<<"$out" || {
      echo "모델 로드 실패 (model loaded 없음): $(tail -3 <<<"$out" | tr '\n' ' ')"
      return 1
    }
  fi
  echo "ok"; return 0
}

record() { ATTEMPTS="${ATTEMPTS}  $2 $1\n"; }
RESULT=""
WANT_GPU=0

try_prebuilt() { # $1 kind, $2 label
  local asset subdir strip
  if is_windows; then
    asset="$(win_asset "$1")"; subdir="$([ "$1" = cpu ] && echo cpu || echo "cuda-${CUDA_TAG}")"
  else
    asset="$(asset_for "$1")"
    case "$1" in cuda) subdir="cuda-${CUDA_TAG}";; vulkan) subdir=vulkan;; *) subdir=cpu;; esac
  fi
  strip="$(strip_for)"
  local root="$DEST/$subdir" bin="$DEST/$subdir/$BIN_NAME"

  if [ "$FORCE" -eq 0 ] && [ -f "$root/.llama_release" ] && [ "$(cat "$root/.llama_release")" = "$RELEASE_TAG" ]; then
    if [ -f "$bin" ]; then
      local why; WANT_GPU=0; [ "$1" = cuda ] || [ "$1" = vulkan ] && WANT_GPU=1
      why="$(verify "$bin")"
      if [ "$why" = "ok" ]; then
        say "이미 설치됨: $bin"; record OK "$2"; RESULT="$bin"; return 0
      fi
      say "설치되어 있지만 검증 실패 — $why"
    fi
  fi

  step "$2 받기 ($asset)"
  mkdir -p "$root" || return 1
  if ! curl -L --fail --progress-bar -o "$DEST/$asset" "$BASE_URL/$asset" 2>/dev/null; then
    fail "다운로드 실패: $asset"; record FAIL "$2 (다운로드 실패)"; return 1
  fi
  if is_windows; then
    local comp; comp="$(win_companion "$1")"
    if [ -n "$comp" ]; then
      curl -L --fail --progress-bar -o "$DEST/$comp" "$BASE_URL/$comp" 2>/dev/null \
        || { fail "런타임 번들 실패: $comp"; record FAIL "$2 (런타임 없음)"; rm -f "$DEST/$asset"; return 1; }
      unpack "$DEST/$comp" "$root" 0 || { rm -f "$DEST/$asset" "$DEST/$comp"; return 1; }
    fi
  fi
  unpack "$DEST/$asset" "$root" "$strip" || { rm -f "$DEST/$asset"; record FAIL "$2 (압축 해제 실패)"; return 1; }
  rm -f "$DEST/$asset"

  local why; WANT_GPU=0; [ "$1" = cuda ] || [ "$1" = vulkan ] && WANT_GPU=1
  why="$(verify "$bin")"
  if [ "$why" != "ok" ]; then
    fail "검증 실패: $why"; record FAIL "$2 ($why)"; rm -rf "$root"; return 1
  fi
  if [ -n "$MODEL" ] && [ -f "$MODEL" ] && [ "${QUIET:-0}" -eq 0 ]; then
    say "모델 검증 통과: $MODEL"
  fi
  printf '%s' "$RELEASE_TAG" > "$root/.llama_release"
  say "준비 완료: $bin"; record OK "$2"; RESULT="$bin"; return 0
}

build_fork() {
  [ "$ALLOW_BUILD" -eq 1 ] || { fail "--no-build 지정됨"; return 1; }
  local mode="cpu" flags="-DGGML_CUDA=OFF" d="build-cpu"
  if [ "$HAVE_NVCC" -eq 1 ]; then mode=cuda; flags="-DGGML_CUDA=ON"; d="build-cuda"; fi
  # A GPU with no toolkit cannot be targeted: cmake errors out at configure time,
  # so "the box has a GPU" must not decide this — `nvcc` does.
  [ "$HAVE_NVCC" -eq 0 ] && [ "$mode" = cuda ] && mode=cpu
  step "fork 소스 빌드 ($mode) — ${FORK_REPO}"
  [ -d "$DEST/fork/.git" ] || { say "소스를 받습니다"; git clone --depth 1 "$FORK_REPO" "$DEST/fork" || { record FAIL "소스 빌드"; return 1; }; }
  cmake -B "$d" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=ON $flags -S "$DEST/fork" >/dev/null 2>&1 \
    || { fail "cmake 설정 실패"; record FAIL "소스 빌드 (cmake)"; return 1; }
  say "컴파일 중 (-j$(nproc 2>/dev/null || echo 4)) — 10~40분 걸릴 수 있습니다"
  cmake --build "$d" --config Release -j "$(nproc 2>/dev/null || echo 4)" >/dev/null 2>&1 \
    || { fail "컴파일 실패"; record FAIL "소스 빌드 (컴파일)"; return 1; }
  local bin="$DEST/fork/$d/bin/$BIN_NAME"
  local why; why="$(verify "$bin")"
  if [ "$why" != "ok" ]; then fail "검증 실패: $why"; record FAIL "소스 빌드 ($why)"; return 1; fi
  say "준비 완료: $bin"; record OK "소스 빌드 ($mode)"; RESULT="$bin"; return 0
}

# ── the ladder ──────────────────────────────────────────────────────────────
step "플랫폼: $OS/$ARCH · GPU: $GPU_KIND${CUDA_TAG:+ (CUDA $CUDA_TAG)} · nvcc: $([ $HAVE_NVCC -eq 1 ] && echo 있음 || echo 없음)"
if [ "$IS_WSL" -eq 1 ]; then
  say "WSL 로 감지되었습니다."
  if [ -d /usr/lib/wsl/lib ]; then
    say "Windows 드라이버의 CUDA 런타임(/usr/lib/wsl/lib) 을 찾았습니다."
  else
    fail "WSL CUDA 런타임(/usr/lib/wsl/lib) 이 없습니다 — Windows 쪽 NVIDIA 드라이버가 필요합니다."
    say "GPU 없이도 쓸 수 있습니다: --gpu cpu"
  fi
  say "GPU 오프로딩이 불안정하면  --gpu cpu 로 CPU 빌드로 고정할 수 있습니다."
fi
for t in curl tar cmake git; do
  command -v "$t" >/dev/null 2>&1 || say "참고: $t 이 없어 해당 경로는 건너뜁니다"
done

# Each rung runs in THIS shell, not a subshell: a subshell would discard both the
# attempt log and the RESULT variable, and the ladder would silently report nothing.
if [ "$GPU_KIND" != cpu ] && [ -n "$CUDA_TAG" ]; then
  try_prebuilt cuda "${GPU_KIND} 사전 빌드" || true
fi
if [ -z "$RESULT" ]; then try_prebuilt cpu "CPU 사전 빌드" || true; fi
if [ -z "$RESULT" ]; then build_fork || true; fi

printf '\n== 시도한 사다리\n'
printf "%b" "$ATTEMPTS"
if [ -n "$RESULT" ]; then
  printf '\n성공: %s\n' "$RESULT"
  printf '다음 실행에서 llama.binPath 로 쓰이려면:\n  %s\n' "$RESULT"
  exit 0
fi
printf '\n실패: 어느 방법으로도 동작하는 런타임을 만들지 못했습니다.\n'
printf '  · CUDA 툴킷이 필요하면 설치: https://developer.nvidia.com/cuda-downloads\n'
printf '  · 릴리스 자산 목록: %s\n' "$BASE_URL"
exit 1
