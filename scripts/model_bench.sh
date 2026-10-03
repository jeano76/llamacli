#!/bin/bash
# tg/pp benchmark of the local models, with the flags llamacli itself launches llama-server with.
#
#   scripts/model_bench.sh <outdir>
#
# STOP THE SERVER FIRST. llama-bench loads its own copy of the model, and an 8 GB card
# already holding a served model will OOM (or silently measure CPU). Nothing here stops or
# starts a server.
#
# Override any path/flag through the environment (BENCH_*). Each model gets its own result
# file (jsonl) and error log in <outdir>; docs/model-bench-2026-10-03.md explains how the
# numbers are read.
set -u
OUT=${1:?usage: model_bench.sh <outdir>}
mkdir -p "$OUT"

MODELS=${BENCH_MODELS:-/media/jeano/nvme-usb/models}
STOCK=${BENCH_STOCK_BIN:-$HOME/llama.cpp/build-opt/bin/llama-bench}                    # stock llama.cpp

# Production-shaped: full GPU offload, flash-attn, q8_0 KV cache, 6 threads, ub 512 / b 2048.
# pp512 and tg128 at depth 0 and 8192 (compaction happens deep in the context, not at 0),
# 2 repetitions each.
COMMON=${BENCH_COMMON:--ngl 999 -fa 1 -ctk q8_0 -ctv q8_0 -t 6 -ub 512 -b 2048 -p 512 -n 128 -d 0,8192 -r 2 -o jsonl}
# --n-cpu-moe only means something for MoE models; a dense model gets 0.
MOE_LAYERS=${BENCH_N_CPU_MOE:-32}

run() { # name binary model n-cpu-moe
  echo "=== $1 start $(date +%T)" | tee -a "$OUT/bench.log"
  "$2" -m "$3" -ncmoe "$4" $COMMON > "$OUT/bench_$1.jsonl" 2> "$OUT/bench_$1.err"
  echo "=== $1 done rc=$? $(date +%T)" | tee -a "$OUT/bench.log"
}

run ornith35b "$STOCK" "$MODELS/Ornith-1.5-35B-A3B-Q4_K_M.gguf"           "$MOE_LAYERS"
run qwen35b   "$STOCK" "$MODELS/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"           "$MOE_LAYERS"
echo ALLDONE | tee -a "$OUT/bench.log"
