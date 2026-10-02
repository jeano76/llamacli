# llamacli 초기 구동 환경 자동 구축 — 최적 엔진/모델 설치 + 빌드 환경 구성 프롬프트

> 이 문서는 **에이전트에게 주는 실행 지시문**입니다. 그대로 넘기면 됩니다.
> 대상 저장소: `/home/jeano/llamacli` · 작성 기준일: 2026-10-02
> 근거: `src/setup/*`, `src/backend/resolve.ts`, `src/index.tsx` 를 직접 읽고 작성했습니다.
> 코드와 이 문서가 다르면 **코드가 맞습니다.** 줄 번호가 아닌 함수명으로 찾으세요.

---

## 0. 목표

llamacli를 **아무것도 설치되지 않은 머신**에서 처음 실행해도, **사용자 개입 없이**:

1. 그 머신의 하드웨어(OS/CPU/RAM/GPU 종류·VRAM)를 정확히 파악하고,
2. 그 하드웨어에 **최적인 추론 엔진**(llama-server 바이너리, 가속기 포함)을 확보하고,
3. 그 엔진이 읽을 수 있는 **최적 모델**을 고르고 내려받고,
4. 엔진 확보에 **빌드가 필요하면 빌드 환경(컴파일러/CMake/SDK)까지 스스로 구축**하고,
5. 결과를 `.llamacli/config.yaml` 에 기록해 이후 실행은 파일 몇 개 확인으로 끝나게 한다.

원칙(기존 코드의 설계 철학이며 **깨면 안 된다**):

- **사용자에게 묻지 않는다.** 질문 대신 측정으로 결정하고 보고한다.
- **멱등.** 두 번째 실행은 아무것도 하지 않는다.
- **실패해도 던지지 않는다.** `ensureLocalStack` 은 `ok:false` 리포트를 반환하고 호출자가 가진 것으로 계속 시작한다.
- **실행해보지 않은 것은 성공이라 주장하지 않는다.** (`verifyLlamaServer` 의 정신)
- **이미 돌고 있는 서버는 건드리지 않는다.** 8 GB 카드에서 두 번째 서버는 OOM 이다.

---

## 1. 현재 구현 — 이미 있는 것 (다시 만들지 마라)

### 1.1 진입 흐름

`index.tsx` / `backend/resolve.ts` → `ensureLocalStack()` (`src/setup/bootstrap.ts`)

| 단계 | 하는 일 | 소스 |
|---|---|---|
| 1 | 하드웨어 측정 (`nvidia-smi` CSV, `os`, 도구 존재 `command -v`) | `hardware.ts: detectHardware` |
| 2 | llama-server 바이너리 탐색 + 실행 가능성 probe | `llamaCpp.ts: findLlamaServer` |
| 2a | 없음 + 모델이 ternary 필요 → **PrismML fork 사전빌드 → 소스빌드** 사다리 | `ternaryRuntime.ts: acquireTernaryLlamaServer` |
| 2b | 없음 + 일반 모델 → **stock llama.cpp 소스 빌드** | `llamaCpp.ts: buildLlamaCpp` |
| 2.5 | 이미 떠 있는 서버 탐지 → 있으면 **채택하고 종료** (로딩 중이면 대기) | `backend/detect.ts: discoverRunningServer` |
| 3 | 모델 결정: 기존 사용 모델 유지 → 없으면 HF 검색 후 `chooseModel` | `modelCatalog.ts` |
| 3.5 | 선택 바이너리가 선택 모델을 읽는지 확인, 안 되면 ternary 런타임으로 교체 | `bootstrap.ts: checkBinaryAgainstChosenModel` |
| 4 | 디스크 여유 확인 → 병렬 range 다운로드(8 conn, 재개 지원) | `disk.ts`, `download.ts` |
| 5 | 포트 계획(`planPorts`) → 튜닝(`tuneForHardware`) → config 저장 | `ports.ts`, `tuning.ts` |

### 1.2 이미 정교한 부분

- **ternary 사다리**: GPU 사전빌드 → CPU 사전빌드 → fork 소스빌드(CUDA는 `nvcc` 있을 때만). 각 칸을 **실제로 실행해 검증**(`--version`, GPU면 `--list-devices`, 모델 있으면 `-ngl 0` 호환 probe). 플랫폼별 자산 선택은 `prismAssetFor` (linux/darwin/win32, cuda/vulkan/cpu, x64/arm64).
- **모델 선택**: `chooseModel` — Bonsai(dense, 1-bit; 27B→8B→4B 순, 파일 전체가 VRAM+1GiB 에 들어가야 함) → Ornith 35B-A3B(MoE, VRAM ≥6 GiB, RAM ≥ 모델×1.4) → Ornith 9B → 에러.
- **튜닝**: `tuneForHardware` — ngl / `--n-cpu-moe` / ctx(4096~32768) / threads. 자기 서버 VRAM 환급(`budgetVramGiB`).
- **플랫폼 헬퍼**: `hostEnv.ts` (홈 디렉토리, `ss` vs `netstat`, systemd 유무).

---

## 2. 분석으로 확인된 공백 — 이것이 이번 작업의 대상이다

각 항목은 코드에서 직접 확인한 사실이다. **구현 전에 재현부터 하라.**

### G1. GPU 백엔드 탐지가 NVIDIA 전용이다  ← 가장 큰 공백
- `detectHardware`: `gpuBackend: gpus.length > 0 ? "cuda" : "none"`. **`"vulkan"` 은 타입에만 있고 어디서도 대입되지 않는다.**
- AMD(ROCm/Vulkan), Intel(Arc/iGPU, SYCL/Vulkan), **Apple Silicon(Metal, 통합 메모리)** 은 전부 "GPU 없음 → CPU" 로 판정된다.
- 결과: Mac M-series 는 Metal 을 못 쓰고 CPU 로 돈다. Apple 은 통합 메모리라 `vramTotalBytes` 개념 자체가 달라 `chooseModel`/`tuneForHardware` 의 VRAM 계산도 재설계가 필요하다.
- 요구: `Hardware` 에 `gpuBackend: "cuda" | "rocm" | "vulkan" | "metal" | "none"` 와 벤더 중립 `Gpu`(`vendor`, `unifiedMemory` 포함)를 도입. 탐지 수단: `nvidia-smi`, `rocm-smi`/`rocminfo`, `vulkaninfo --summary`, `system_profiler SPDisplaysDataType`/`sysctl hw.memsize`(macOS), Windows 는 `Get-CimInstance Win32_VideoController`.

### G2. stock llama.cpp 는 "빌드만" 가능하다 (사전빌드 경로 없음)
- 일반 모델 + 바이너리 없음 → 무조건 `buildLlamaCpp` (10~40분). ternary 경로에는 있는 "사전빌드 → 검증 → 소스빌드" 사다리가 **stock 에는 없다.**
- ggml-org/llama.cpp 릴리스는 플랫폼별 사전빌드(ubuntu cpu/vulkan, macos arm64/x64, win cpu/cuda/vulkan, 번들 cudart)를 게시한다. 이를 `acquireTernaryLlamaServer` 와 같은 구조(`prismAssetFor` 대응물)로 받아 검증하고, 실패 시에만 소스빌드해야 한다.
- 요구: 엔진 획득을 **하나의 사다리**로 통합(`acquireLlamaServer({ flavor: "stock" | "prism" })`). 소스빌드는 마지막 칸.

### G3. 빌드 환경 구축이 apt + sudo 에 하드코딩돼 있다
- `installBuildPackages`: `sudo -n apt-get install -y build-essential cmake git curl libcurl4-openssl-dev pkg-config`, CUDA 면 `cuda-toolkit-12-4` 추가. 문제:
  1. **apt 가 아닌 배포판**(Fedora `dnf`, Arch `pacman`, Alpine `apk`, openSUSE `zypper`) 미지원.
  2. **macOS**(Xcode CLT, `brew install cmake`), **Windows**(VS Build Tools + CMake + Git, `winget`/`choco`) 미지원 — 소스빌드 경로가 사실상 Linux/Debian 계열 전용.
  3. `detectHardware` 가 `PROBE_TOOLS`(git/cmake/make/ninja/g++/cc/nvcc/curl/pkg-config) 를 이미 측정하는데 **`installBuildPackages` 는 그 결과를 쓰지 않고 항상 전부 설치 시도**한다. 필요한 것만 설치해야 한다(이미 있으면 sudo 자체가 불필요).
  4. `cuda-toolkit-12-4` 고정: 드라이버가 지원하는 CUDA 버전(`detectCudaVersion`)과 무관하고, NVIDIA apt 저장소가 등록돼 있지 않으면 설치가 실패한다. 드라이버 CUDA 버전 이하의 툴킷을 고르고, 저장소 미등록이면 등록 단계를 먼저 수행해야 한다.
  5. sudo 불가(비밀번호 필요/권한 없음) 시 `sudo -n` → 대화형 sudo 순서로 시도하는데, **비대화형 환경(CI/SSH 파이프)에서는 멈추거나 실패**한다. 이때의 대안: **사용자 영역 설치**(예: `pip install cmake`, `conda`/`micromamba`, 사전빌드 우선)로 sudo 없이 가는 경로.
- 요구: `BuildEnvPlan` 을 만든다 — (OS, 패키지 매니저, 이미 있는 도구, 필요한 도구, 필요 시 sudo 여부) → 실행 **전에** 계획을 로그로 보여주고 → 실행 → **각 도구를 실제로 실행해 버전 확인**.

### G4. CMake 플래그가 단일 경로다
- `buildLlamaCpp` 는 `-DGGML_CUDA=ON` 또는 CPU 두 가지뿐. `-DGGML_HIP`(ROCm), `-DGGML_VULKAN`, `-DGGML_METAL`(macOS 기본), `-DGGML_SYCL`, **`CMAKE_CUDA_ARCHITECTURES`**(현재 GPU compute capability 로 한정하면 빌드 시간 대폭 단축) 가 없다.
- 빌드 디렉토리명이 `build-cuda`/`build-cpu` 두 개로 고정이라 `BUILD_DIR_PREFERENCE`(`build-opt`, `build-cuda`, `build-cpu`, …) 및 `backendFromPath` 와 맞물린다 — 새 백엔드를 추가하면 둘 다 갱신해야 한다.
- 빌드 후 검증이 "파일이 존재하는가" (`isExecutable`) 뿐이다. 소스빌드 결과도 사전빌드처럼 **`--list-devices` 로 가속기 초기화를 검증**해야 한다 (현재 ternary 사다리의 소스빌드 칸만 검증함; stock 빌드 경로는 검증 없음).

### G5. 소스빌드 사전점검(preflight) 부재
- 빌드 시작 전 확인하지 않는 것: **디스크 여유**(소스+빌드 산출물, CUDA 는 수 GB), **RAM**(CUDA 템플릿 컴파일은 `-j` 당 수 GB; `-j min(cpu,16)` 은 RAM 8 GB 머신에서 OOM-kill 위험), **네트워크 도달성**(github.com).
- 요구: `-j` 를 `min(cpuCount, floor(ramAvailableGiB / 2), 16)` 류로 RAM 제한. 실패 시 `-j1` 로 1회 재시도.
- 모델 다운로드는 `disk.ts` 로 선확인하지만 **엔진 설치에는 같은 확인이 없다.**

### G6. 엔진 ↔ 모델 결정 순서의 비대칭
- 엔진(2단계)은 모델(3단계)보다 먼저 정해진다. 설정이 비어 있는 **첫 실행**에서는 stock 이 먼저 빌드되고, 모델이 Bonsai 로 정해지면 3.5단계에서 ternary 런타임을 **추가로** 받는다 → **10~40분 빌드를 한 뒤 버려질 수 있다.**
- 요구: 첫 실행에서는 **모델을 먼저 "계획"(다운로드 없이 `chooseModel` 만)** 한 뒤, 그 모델이 필요로 하는 엔진 하나만 확보한다. 모델 결정이 네트워크(HF 검색)를 필요로 하므로, 오프라인이면 하드웨어 기반 기본값으로 계획한다.

### G7. 하드웨어 → 모델 매핑이 단일 머신 기준으로 튜닝돼 있다
- `chooseModel` 주석: "8 GB VRAM, 30 GB RAM 한 대에서 측정한 값". `MIN_35B_VRAM_GIB=6`, `MIN_RAM_MULTIPLE=1.4`, `RESERVE_GIB=1.0` 은 다른 구성(24 GB 카드, GPU 없음 16 GB RAM, Apple 통합 메모리)에서 **검증된 적이 없다.**
- GPU 없음(`vramTotalBytes=0`)일 때 Bonsai/35B 를 모두 건너뛰고 9B 로 내려가는데, **CPU 전용 16 GB 머신에서 9B Q4_K_M(≈5.5 GB)이 실용 속도인지**, 더 작은 모델(Bonsai 4B 등)이 낫지 않은지 판단 근거가 없다.
- 요구: 프로파일별 기대 tok/s 를 **실측**(§4)하고 임계값을 그 근거로 조정. 상수마다 "어느 프로파일에서 측정했다"를 주석으로 남긴다.

### G8. 다중 GPU
- `pickPrimaryGpu` 는 free VRAM 최대 1개만 쓴다. 이종 GPU(24 GB + 8 GB)에서 `--tensor-split`/`--main-gpu` 활용 여부는 결정돼 있지 않다. **범위 밖으로 둘지 먼저 결정**하고 문서화하라(결정 없이 구현 금지).

### G9. 첫 실행 경험(UX)
- 빌드 10~40분, 모델 20 GB 다운로드는 길다. 진행 표시는 다운로드(`renderProgressLine`)에만 있고, **빌드 중에는 `cmake --build` 출력이 흐름에 없다**(`run` 이 stdout 을 버퍼링만 함). 사용자는 멈춘 것으로 오해한다.
- 요구: 빌드 단계 진행률(`[ 42%]` 라인 파싱)을 TUI 로그에 한 줄 갱신으로 표시. 다운로드와 빌드를 **병렬**로 진행할 수 있는지 검토(둘은 독립: 모델 파일 ↔ 엔진 빌드. 단 §G6 의 결정이 선행).

### G10. 문서화되지 않은 비목표
- **vLLM**: 컴팩션 연구 문서에는 등장하지만 `src/setup/` 에는 설치/탐지 경로가 **없다.** 이번 작업 범위에 넣을지 먼저 결정할 것(기본 권고: 제외, `backend: openai-compatible` 로 외부 서버 채택만 지원).

---

## 3. 수행 순서 (한 번에 하나, 각 단계마다 테스트 + 커밋)

> 각 단계 후 `npm run typecheck && npm test` 통과 필수. 한 단계에서 여러 문제가 보여도 **하나만** 고치고 재실행.

**Step 0 — 결정 확정 (코드 작성 금지)**
G8(다중 GPU), G10(vLLM), Apple 통합 메모리 모델링 방식을 **짧은 결정 기록**으로 남기고 진행. 사용자 확인이 필요한 건 이 단계에서 한 번에 묻는다. 이후엔 묻지 않는다.

**Step 1 — 하드웨어 탐지 확장 (G1)**
- `Hardware`/`Gpu` 타입 확장, 벤더별 탐지 함수를 `run` seam 으로 추가, **합성 머신 단위 테스트**(NVIDIA / AMD / Intel / Apple / 무GPU / `nvidia-smi` 는 있는데 드라이버 로드 실패).
- 기존 `parseNvidiaSmiCsv` 테스트는 그대로 통과해야 한다(하위 호환).
- `chooseModel`/`tuneForHardware` 가 새 필드를 소비하도록 연결하되, **NVIDIA 경로의 출력은 바이트 단위로 동일**해야 한다(회귀 방지 테스트).

**Step 2 — 빌드 환경 계획/설치 (G3)**
- `src/setup/buildEnv.ts` 신설: `planBuildEnv(hw, platform, osRelease)` → `BuildEnvPlan`, `applyBuildEnv(plan, run)`.
- 패키지 매니저 탐지(apt/dnf/pacman/apk/zypper/brew/winget/choco) 는 **`/etc/os-release` + `command -v`** 로. 모르는 배포판은 **설치를 시도하지 않고** 필요한 도구 목록과 수동 명령을 리포트에 담아 반환.
- `PROBE_TOOLS` 측정 결과로 **없는 것만** 설치. sudo 필요 여부를 계획에 포함, 비대화형이면 사용자 영역 대안(사전빌드 우선, `pip --user cmake`) 사용.
- CUDA 툴킷: 드라이버 CUDA 버전 이하에서 선택, 저장소 미등록이면 등록 단계 포함. **툴킷 설치는 가장 비싸고 위험한 단계이므로 사전빌드가 동작하면 절대 하지 않는다**(G2 와 연결).
- 설치 후 각 도구를 **실행해 버전 검증**. `installBuildPackages` 의 기존 export 시그니처는 유지(테스트/호출자 호환), 내부를 새 계획에 위임.

**Step 3 — 엔진 획득 사다리 통합 (G2, G4, G5, G6)**
- `acquireLlamaServer({ flavor })` 로 일반화: **사전빌드(GPU) → 사전빌드(CPU) → 소스빌드** + 칸마다 `verifyLlamaServer`. stock 용 자산 선택기(`stockAssetFor`)는 `prismAssetFor` 와 같은 모양으로.
- 소스빌드 칸에 preflight(디스크/RAM/네트워크) 와 `-j` RAM 제한, `CMAKE_CUDA_ARCHITECTURES`, 백엔드별 플래그, 빌드 후 `--list-devices` 검증을 넣는다.
- 첫 실행 순서를 G6 대로 바꿔 **불필요한 stock 빌드가 일어나지 않게** 한다. `bootstrap.order.test.ts` 가 순서를 단언하고 있으므로 먼저 읽고, 기존 단언이 *의도된 동작*인지 *우연*인지 판단해서 바꿔라.
- 어떤 칸이 어떤 이유로 실패했는지 `attempts` 를 리포트에 그대로 남긴다.

**Step 4 — 모델 임계값 근거화 (G7)**
- §4 의 프로파일 시뮬레이션으로 현재 `chooseModel` 결과를 표로 먼저 뽑는다(**바꾸기 전 baseline**). 기대와 다른 행만 수정.

**Step 5 — 빌드 진행 표시 (G9)**
- `run` 을 스트리밍 변형으로 확장하거나 빌드 전용 spawn 래퍼 추가. TUI 에서 Ink 렌더링을 깨지 않도록 `onProgress` 주입 경로 사용(`bootstrap.ts` 의 기존 주석 참고 — `process.stdout` 직접 쓰기 금지).

**Step 6 — 전체 검증 후 push**
- `npm run check` 전체, §4 매트릭스, `npm run build`(→ `bin/llamacli-dist.tar.gz` 갱신됨. 기존 관례대로 `chore(bin): rebuild dist tarball …` 커밋을 별도로).

---

## 4. 검증 — "내 머신에서 된다"는 증거가 아니다

### 4.1 합성 프로파일 (단위 테스트, 빠름)
`Hardware` 를 주입하는 기존 seam 을 쓴다. 아래 프로파일 각각에 대해 **엔진 선택·빌드 환경 계획·모델 선택·튜닝 결과**가 기대와 일치하는지 단언.

| 프로파일 | OS | GPU | RAM | 기대 엔진 | 기대 모델 계열 |
|---|---|---|---|---|---|
| nvidia-small | Ubuntu | RTX 2070S 8GB | 30 | CUDA 사전빌드 | Bonsai 27B (5.5GB) 또는 Ornith 35B MoE |
| nvidia-large | Ubuntu | RTX 4090 24GB | 64 | CUDA 사전빌드 | 적합한 최대 |
| cpu-only | Ubuntu | 없음 | 16 | CPU 사전빌드 | 실측 근거로 결정(G7) |
| amd | Ubuntu | RX 7900 XT | 32 | Vulkan 사전빌드 (ROCm 은 소스빌드) | |
| apple | macOS arm64 | 통합 24GB | 24 | Metal 사전빌드 | |
| win-nvidia | Win11 | RTX 3060 12GB | 32 | CUDA 사전빌드 + cudart | |
| fedora-nodeps | Fedora | 없음 | 16 | CPU 사전빌드(빌드 도구 불필요) | |
| alpine-min | Alpine/musl | 없음 | 8 | 사전빌드 없음 → 소스빌드 + `apk` 계획 | 소형 |

### 4.2 실제 환경 (느림, 반드시 1회 이상)
- **깨끗한 컨테이너/VM**(`ubuntu:24.04`, `fedora`, `alpine`)에서 `HOME` 을 임시 디렉토리로, `PATH` 를 최소화해 **진짜 첫 실행**을 재현. 기존 `scripts/bare_env_check.ts` 를 먼저 읽고 확장.
- 격리 원칙: 매 시나리오는 이전 시나리오의 `~/.llamacli`, `~/models`, 실행 중 프로세스에 의존하지 않는다. **개발 머신의 8080 은 실제 서버가 상시 떠 있다** — 이를 건드리는 테스트는 그 머신을 테스트하는 것이다(기존 `detectServer` 주입 사용).
- 실패 주입: (a) 네트워크 차단, (b) 디스크 부족, (c) sudo 불가, (d) 드라이버는 있고 CUDA 런타임 없음(WSL), (e) 빌드 도중 kill → **재실행 시 이어서/정리 후 재시도**되는가.

### 4.3 합격 기준
1. 8 개 프로파일 모두에서 **사용자 입력 0회** 로 서버가 떠서 한 번의 응답을 받는다(가능한 환경에서) 또는 **정확한 사유와 수동 조치 한 줄**이 리포트에 담긴다.
2. 두 번째 실행은 **네트워크/빌드/sudo 호출 0회** (테스트로 단언: `run`/`fetch` spy 호출 수).
3. 이미 서버가 떠 있으면 **어떤 경우에도** 두 번째 서버를 띄우지 않는다(기존 회귀 테스트 유지).
4. 불필요한 소스빌드가 일어난 경우 0 (사전빌드가 동작하는 환경에서 `cmake` 호출 0회).
5. `npm run check` 통과, 기존 테스트를 지우거나 약화시키지 않았다.

---

## 5. 하지 말 것

- `ensureLocalStack` 이 **던지게** 만들지 마라. 항상 리포트.
- 사용자 확인 프롬프트를 추가하지 마라 (요구사항: 사용자 개입 없이).
- sudo 비밀번호를 받거나 저장하는 코드를 쓰지 마라.
- 실행해 검증하지 않은 바이너리를 `ok:true` 로 보고하지 마라.
- stock 빌드를 ternary 모델의 폴백으로 쓰지 마라 (원래 버그다 — `invalid ggml type 143`).
- 20 GB 모델을 지우거나 이동하는 정리 로직을 넣지 마라. 이 저장소에서 *삭제된 모델이 재다운로드된 사고*가 두 번 있었다.
- 한 번에 여러 Step 을 묶어 커밋하지 마라.
- 확인하지 않은 외부 사실(릴리스 자산 이름, 패키지 이름, CUDA 저장소 URL)을 **기억에서 쓰지 마라.** 구현 시점에 실제 릴리스 목록/패키지 인덱스를 조회해 확인하고, 확인 방법을 주석으로 남겨라.

## 6. 산출물

1. 위 Step 별 커밋 (+ 각 단계 테스트)
2. `docs/first-run-provisioning-report.md` — 프로파일 표 baseline vs 최종, 실제 환경에서 돌려본 것/못 돌려본 것(못 돌린 환경은 **"미검증"** 으로 명시), 남은 공백
3. `.llamacli/config.example.yaml` 에 새로 도입된 사용자 노출 설정이 있다면 추가
