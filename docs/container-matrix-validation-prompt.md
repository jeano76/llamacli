# llamacli 다양한 사용자 환경(OS · 쉘 · CPU · GPU)을 컨테이너로 재현해 검증하는 프롬프트

> 이 문서는 에이전트(또는 개발자)에게 그대로 넘기는 작업 지시서다.
> 선행 문서: `docs/provisioning-matrix-and-single-server-prompt.md`(요구사항 R1~R6), `docs/provisioning-matrix-report.md`(지금까지의 구현·한계), `docs/multienv-acceptance-prompt.md`.
> 지금까지의 환경 검증은 **합성 단위 테스트**(`profiles.test.ts`, `matrix.test.ts`)와 **이 한 대의 머신(Linux, RTX 2070 SUPER 8 GiB)** 이 전부다.
> 이 작업은 그 사이의 빈칸 — *실제 프로세스·실제 파일시스템·실제 쉘·실제 패키지 매니저* 가 달라지는 환경 — 을 **컨테이너로 재현해 실제 바이너리(`dist/index.js`)로** 검증한다.

---

## 0. 목표와 정직한 범위

**목표:** "사용자 머신이 이렇게 생겼을 때 llamacli 가 (1) 하드웨어를 맞게 읽고 (2) 맞는 엔진/설정/모델을 고르고 (3) 단일 서버 정책을 지키며 (4) 실패 시 이유를 말한다"를 환경별로 *실행해서* 증명한다.

**컨테이너로 재현할 수 있는 것 / 없는 것을 먼저 구분한다. 이 구분이 이 작업의 절반이다.**

| 축 | 컨테이너로 | 방법 / 한계 |
|---|---|---|
| Linux 배포판·libc·패키지 매니저 | ✅ 실제 | Debian/Ubuntu(apt, glibc), Fedora(dnf), Arch(pacman), Alpine(apk, **musl**), openSUSE(zypper) |
| 쉘 (`bash`/`zsh`/`fish`/`dash`/`ash`/busybox `sh`) | ✅ 실제 | 로그인/비로그인, `SHELL` 환경변수, 대화형/비대화형, 한글 로케일/`LANG=C` |
| 사용자 권한 (root / 일반 / sudo 없음 / 읽기 전용 HOME / HOME 미설정) | ✅ 실제 | `--user`, `--read-only`, `tmpfs` |
| CPU 코어 수·RAM 한도 | ⚠️ cgroup | `--cpus`, `--memory`. **`os.totalmem()`/`os.cpus()` 는 cgroup 한도를 무시하고 호스트 값을 돌려준다 → 가설 H1(§6)** |
| NVIDIA GPU (실제) | ⚠️ 호스트 GPU 1대뿐 | `--gpus all` (nvidia-container-toolkit 필요). **호스트와 같은 8 GiB 카드만** 실제로 가능 |
| 다른 VRAM 크기·AMD·Intel·ROCm·Vulkan | ⚠️ **가짜 주입** | `nvidia-smi` 스텁, `/sys/class/drm` 가짜 트리(bind mount), `vulkaninfo` 스텁, mesa-lavapipe(소프트웨어 Vulkan) — *탐지 로직*은 검증되지만 *실제 가속*은 아님 |
| WSL | ⚠️ 가짜 주입 | `/proc/version` 에 `microsoft` 문자열 — bind mount 로 덮거나, 코드에 분류 seam 이 없으면 **seam 을 먼저 추가**(§5) |
| **Windows** (PowerShell/cmd/Git-Bash) | ❌ Linux 호스트 컨테이너 불가 | Windows 컨테이너는 Windows 호스트 필요. → **CI 러너(GitHub Actions `windows-latest`) 또는 VM** 으로 별도 수행. 이 문서의 컨테이너 계획에 *포함하지 않는다* — §8 에 별도 트랙으로 명시 |
| **macOS** (Metal) | ❌ 불가 | → CI `macos-14`(arm64) 러너. §8 |

> 컨테이너가 "된다"고 해서 Windows/macOS 가 검증된 것으로 보고하지 마라. 보고서는 **환경별로 `컨테이너 실검증 / 가짜 주입 / CI 러너 / 미검증`** 을 표시해야 한다.

## 1. 사전 확인 (이 머신 기준)

2026-10-03 기준 이 머신에는 **`docker`/`podman`/`nerdctl` 이 설치되어 있지 않다** (`which` 확인). 첫 단계는 런타임 확보다.

1. 컨테이너 런타임 선택·설치 (rootless `podman` 권장: root 데몬 불필요, 사용자 서버에 영향 없음). 설치는 **사용자 확인 후**(패키지 설치·sudo).
2. GPU 컨테이너가 필요하면 `nvidia-container-toolkit` (+ CDI). 필요 여부는 §4 의 `gpu-real` 행에만 해당.
3. 호스트 안전 확인: 이 머신의 8080 llama-server 와 GPU VRAM 은 **사용자 서버**가 쓰고 있다(~7 GiB). 컨테이너 안에서 GPU 로 모델을 올리는 테스트는 **사용자 서버를 내려도 되는지 먼저 묻는다.** 그 전까지 GPU 실로드는 하지 않는다.

## 2. 이미 있는 자산 (재구현 금지, 재사용)

| 자산 | 용도 |
|---|---|
| `bin/llamacli-dist.tar.gz` + `bin/manifest.json`, `npm run build` | 컨테이너에 넣을 **배포 산출물**. 소스가 아니라 이걸 설치해서 검증한다(사용자가 쓰는 것과 같은 경로) |
| `scripts/live_single_server_check.ts` | 가짜 llama-server(argv0=`llama-server`)로 단일 서버 정책을 *실제 프로세스*로 확인 |
| `scripts/capture_screens.py`, `/tmp` pty+pyte 하네스 | 실제 바이너리를 pty 로 구동하고 화면을 텍스트로 재구성 |
| `src/setup/profiles.test.ts` 의 행 정의 | 컨테이너 행(§4)의 기대값 원천 — 같은 표를 *실행 환경으로* 확장 |
| `calibrate.ts` 의 가짜 서버(FAKE_MIN_MOE) | OOM 재시도·보정을 GPU 없이 재현 |

## 3. 설계 원칙

1. **빌드한 배포 산출물로 검증한다.** 이미지 안에서 `tar xzf bin/llamacli-dist.tar.gz` 후 `node dist/index.js`. 소스 체크아웃 경로(`tsx`)는 자체 업데이트 등 동작이 다르다.
2. **네트워크를 격리하고 가짜 외부 서비스를 둔다.** 실제 HF/GitHub 를 때리면 느리고 비결정적이다. 격리 네트워크 + 목(mock) 서버 컨테이너(§5).
3. **하드웨어는 두 층으로 나눈다:** (a) *탐지* — 가짜 `nvidia-smi`/sysfs/`vulkaninfo` 로 환경별 입력을 주입, (b) *실행* — 가짜 llama-server 로 프로세스 정책을 검증, 실제 llama.cpp 는 소수 컨테이너(`cpu-real`, `gpu-real`)에서만.
4. **각 컨테이너는 단일 책임의 한 줄 시나리오 + 기대 JSON** 으로 끝난다. 사람이 로그를 읽고 판단하는 검증은 합격이 아니다.
5. **실패는 환경 탓으로 돌리지 말고 분류한다:** (1) llamacli 결함, (2) 테스트 하네스 결함, (3) 컨테이너로 재현 불가한 한계.
6. **사용자 자산 불가침:** 컨테이너는 호스트의 `~/.llamacli`, `~/models`, `/media/*`, 8080 포트, 사용자 프로젝트 디렉토리를 **마운트하지 않는다.** 모델·엔진은 컨테이너 전용 볼륨.

## 4. 컨테이너 매트릭스

각 행은 `id | 베이스 | 쉘 | 사용자 | 자원 한도 | 하드웨어 주입 | 핵심 기대`. 컨테이너 하나 = 환경 하나.

### 4.1 OS · 쉘 · 권한 축 (GPU 없음, 가짜 서버)

| id | 베이스 | 쉘 / 실행 방식 | 사용자 | 핵심 기대 |
|---|---|---|---|---|
| `deb-bash-user` | debian:12 | bash, 대화형 | 일반, sudo 없음 | 패키지 설치가 필요하면 **명령만 출력**하고 임의 실행 안 함; 사전빌드 경로 우선 |
| `ubu-bash-sudo` | ubuntu:24.04 | bash | 일반 + sudo(비번 없음) | 빌드 도구 부족 시 `apt-get` 계획 제시, 승인 시 실행 |
| `ubu-root` | ubuntu:24.04 | bash | root | root 일 때 `sudo` 없이 계획 생성 |
| `fed-zsh` | fedora:40 | zsh | 일반 | `dnf` 계획, zsh 에서 `/server`·`/models` 문자열 처리(글로빙 `*`, `!`) 영향 없음 |
| `arch-fish` | archlinux | fish | 일반 | `pacman` 계획, fish 의 `$status`/따옴표 규칙에서 자식 프로세스 실행 정상 |
| `alp-ash-musl` | alpine:3.20 | busybox ash | 일반 | **musl**: glibc 전용 사전빌드를 받지 않고 CPU 소스 빌드/안내로 분기해야 함(§6 H2) |
| `deb-dash-sh` | debian:12-slim | `/bin/sh`(dash) 비대화형 | 일반 | `sh -c` 로 호출돼도 동작; bash 전용 문법 의존 없음 |
| `ubu-nolocale` | ubuntu:24.04 | bash, `LANG=C`, `TERM=dumb` | 일반 | 비-UTF-8/`dumb` 터미널에서 박스·막대 문자 깨짐 대신 ASCII 폴백(`LLAMACLI_ASCII`), 마우스 비활성 |
| `ubu-ro-home` | ubuntu:24.04 | bash | 일반, `--read-only` + tmpfs `/tmp` | 쓰기 불가 HOME 에서 **크래시하지 않고** 이유를 말함(설정·체크포인트 저장 실패 처리) |
| `ubu-nohome` | ubuntu:24.04 | bash | `HOME` 미설정 | `homedir()` 폴백, `/root` 같은 하드코딩 경로 없음 |
| `ubu-smallroot` | ubuntu:24.04 | bash | 일반, 루트 FS 작은 용량(`--storage-opt`/tmpfs) | 디스크 부족 시 **다운로드 전에** 다른 마운트 제안 또는 중단, 부분 파일 정리 |

### 4.2 CPU · RAM 축 (cgroup 한도, GPU 없음)

| id | 한도 | 기대 |
|---|---|---|
| `cpu2-ram4` | `--cpus 2 --memory 4g` | 9B(5.1 GiB)는 RAM 부족 **경고**, 35B 불가. 스레드 수는 2 기준 |
| `cpu4-ram8` | `--cpus 4 --memory 8g` | 9B 선택, 컨텍스트 하향, 스레드 4 기준 |
| `cpu12-ram32` | `--cpus 12 --memory 32g` | 35B 가능 판정(GPU 없으면 CPU 전용 느림 경고) |
| `cpu64-ram128` | 한도 없음(호스트가 허용하는 한) | 상한 컨텍스트 98,304 이하, 스레드 상한 |

각 행은 **호스트가 12코어/31 GiB 인 상태에서** 실행한다 — 한도보다 호스트 값이 크므로 H1(§6)이 있으면 그대로 드러난다.

### 4.3 GPU 축

| id | 주입 | 기대 |
|---|---|---|
| `gpu-none` | 없음 | CPU 사다리, `-ngl 0`, `--n-cpu-moe` 없음 |
| `gpu-nv-8g-fake` | 가짜 `nvidia-smi`(8192 MiB, 여유 7456) | CUDA 사다리(cuda→vulkan→cpu), 35B MoE `--n-cpu-moe` > 0, 단일 포트 |
| `gpu-nv-4g-fake` | 가짜 4096 MiB | 9B 밀집, 부분 오프로드(`-ngl` < 999) 가능성, 컨텍스트 경고 |
| `gpu-nv-24g-fake` | 가짜 24564 MiB | 35B 전부 VRAM(`--n-cpu-moe` 0), 컨텍스트 상한 |
| `gpu-nv-driver-old` | 가짜 `nvidia-smi` CUDA Version 11.x | 발행된 CUDA 자산이 없음 → Vulkan→CPU 로 **이유 안내 후** 넘어감 |
| `gpu-nv-no-smi` | `nvidia-smi` 없음 + `/dev/nvidia*` 만 | GPU 없음으로 오판해도 크래시 없이 CPU, 이유 로그 |
| `gpu-amd-fake` | `/sys/class/drm/card0/device/{vendor=0x1002, mem_info_vram_*}` 가짜 트리 | Vulkan(ROCm 도구 없음) 사다리 |
| `gpu-intel-vk` | `vulkaninfo --summary` 스텁(DISCRETE_GPU, VRAM 미상) | Vulkan, VRAM 0 으로 보수적 9B |
| `gpu-vulkan-sw` | mesa-lavapipe 설치(소프트웨어 Vulkan) | 실제 `vulkaninfo` 가 CPU 장치(`PHYSICAL_DEVICE_TYPE_CPU`)를 **GPU 로 오인하지 않음** |
| `gpu-real` (선택) | `--gpus all` 실제 RTX 2070 SUPER | §7 의 실검증. **사용자 서버 중단 허락 필요** |

### 4.4 서버 상태 축 (R4/R6 의 컨테이너 버전)

각각 위 환경 하나 위에서, 컨테이너 안에 가짜 llama-server 를 미리 띄우고 시작한다.

| id | 상태 | 기대 |
|---|---|---|
| `srv-same` | 같은 모델로 실행 중 | 재기동 0, 연결만 |
| `srv-diff` | 다른 모델로 실행 중 | 연결 + 불일치 안내, `/server restart` 는 확인 전 `stop` 0 |
| `srv-foreign` | `python -m http.server` 가 포트 점유 | 종료 0, 다른 포트/중단 안내 |
| `srv-two` | llama-server 2개 | 자동 정리 0, 목록·선택 |
| `srv-systemd-like` | (systemd 없는 컨테이너) | `systemd` 분기를 타지 않고 정상 동작 |

## 5. 하네스 구현 지시

1. **디렉토리:** `test/containers/` — `Dockerfile.<id>` 또는 단일 `Containerfile` + `--build-arg`, `matrix.yaml`(§4 표를 데이터로), `run.sh`(매트릭스 순회), `expect/<id>.json`, `fixtures/`(가짜 nvidia-smi, 가짜 sysfs 트리, vulkaninfo 스텁, 가짜 llama-server).
2. **설치:** 모든 컨테이너는 `bin/llamacli-dist.tar.gz` 를 풀어 `node dist/index.js`. Node 는 배포판 패키지 대신 공식 바이너리(musl 은 alpine 패키지)로 통일.
3. **목(mock) 외부 서비스** — 컨테이너 1개(`mock-hub`): HF 모델 목록 API(`/api/models/<repo>` 의 `siblings[].lfs.sha256`), `/resolve/main/<file>`(Range 지원, **매번 서명이 바뀌는 CDN 리다이렉트** 포함 → 재개 키 회귀 방지), GitHub releases JSON + 자산(.tar.gz/.zip, sha256 `digest`), self-update manifest.
   - **Seam 필요:** `HF_ENDPOINT`(`modelCatalog.ts:76`)와 `STOCK_RELEASES_URL`(`stockRuntime.ts:37`)은 **상수로 하드코딩**되어 있다. 환경변수 오버라이드(`LLAMACLI_HF_ENDPOINT`, `LLAMACLI_RELEASES_URL`, 필요 시 self-update URL)를 **먼저 추가**하고 테스트로 고정한다(기본값은 현재와 동일, 프로덕션 동작 무변경).
   - 작은 가짜 GGUF(헤더만 유효한 수 MB)로 카탈로그·튜너 경로를 돌리고, 실제 모델 로드는 `cpu-real` 에서만.
4. **가짜 하드웨어:** PATH 앞에 스텁 디렉토리. `nvidia-smi` 는 질의 인자별 출력 지원(`--query-gpu=name,memory.total,memory.free`, `--query-compute-apps`, 기본 출력의 `CUDA Version`). sysfs 는 컨테이너에 읽기 전용 bind mount(`/sys/class/drm/card0/device/...`)가 안 되면 `LLAMACLI_*` seam 대신 **`HostProbe` 주입 지점**(`detectHardware(run, hostOverride)`)을 환경변수로 노출하는 테스트 전용 진입점을 둔다(프로덕션 경로 무변경).
5. **구동:** pty+pyte(§2) 로 `node dist/index.js` 를 띄우고 `/server`, `/models`, `/reset`, `/models <n> confirm` 을 입력 → 화면 텍스트에서 기대 문자열을 *기계적으로* 단언. 비대화형 케이스는 `sh -c` + 종료 코드/표준출력.
   - **재개 프롬프트("이전 작업이 있습니다… Y/N") 에는 절대 대신 답하지 않는다.** 모든 컨테이너는 빈 프로젝트 디렉토리에서 시작.
6. **산출:** 컨테이너마다 `results/<id>.json` = `{ id, detected:{os,shell,cpu,ram,gpu,backend}, plan:{engine,backend,model,tuning}, server:{action,stopCalls}, ok, failures:[...] }`, 그리고 전체 `docs/container-matrix-report.md`.

## 6. 검증하며 확인해야 할 가설 (이미 코드에서 의심되는 것)

| # | 가설 | 확인 방법 | 맞으면 |
|---|---|---|---|
| H1 | **cgroup 한도 무시**: `hardware.ts` 가 `os.totalmem()`/`os.cpus()` 를 쓴다(15행·294행). `--memory 4g` 컨테이너에서도 호스트 31 GiB 로 인식해 35B/큰 컨텍스트를 고른다 → OOM-kill | `cpu2-ram4` 에서 `detected.ram` 과 선택 모델 확인 | `/sys/fs/cgroup/memory.max`(v2)·`memory.limit_in_bytes`(v1), `cpu.max` 를 읽어 `min(host, limit)` 사용. 컨테이너 테스트로 고정 |
| H2 | **musl(Alpine)**: GitHub 사전빌드 자산은 glibc(ubuntu) 용. musl 에서 받으면 실행 검증에서 실패 → 사다리가 다음 후보/소스 빌드로 넘어가야 함 | `alp-ash-musl` | 실패 후 이유 안내·소스 빌드(cmake/g++ 계획) 확인 |
| H3 | **TERM=dumb / 비UTF-8**: 박스·막대·한글 폭 계산이 깨지거나 ANSI 가 새어 나옴 | `ubu-nolocale` | ASCII 폴백/ANSI 비활성 동작 확인·수정 |
| H4 | **읽기 전용 HOME**: 설정/체크포인트/프롬프트 히스토리 쓰기 실패가 크래시 | `ubu-ro-home` | 이유 안내 + 메모리 모드로 계속 |
| H5 | **WSL 미분류**: WSL 은 linux 로 취급되고 GPU(`/usr/lib/wsl`, `nvidia-smi` 는 있으나 `/dev/nvidia*` 없음) 패스스루를 특별 취급하지 않음 | 가짜 `/proc/version`+nvidia-smi | WSL 분기/안내 추가 여부 결정 |
| H6 | **소프트웨어 Vulkan 오인**: lavapipe 가 `vulkaninfo` 에 `PHYSICAL_DEVICE_TYPE_CPU` 로 나오는데, 정규식(`DISCRETE|INTEGRATED|VIRTUAL`)이 이를 제외하는지 | `gpu-vulkan-sw` | 확인(현 코드는 제외하는 것으로 보임 — 실제 `vulkaninfo` 출력으로 증명) |
| H7 | **dash/비대화형**: `sh -c "llamacli …"` 에서 쉘 문법 의존, 종료 코드 | `deb-dash-sh` | 종료 코드·표준출력 계약 문서화 |
| H8 | **디스크 부족 + 다른 마운트**: 컨테이너의 작은 루트 + 큰 볼륨에서 `selectModelPath` 전환이 맞는지 | `ubu-smallroot` | 전환/중단, `.llamacli-tmp` 정리 |

> 가설은 "의심"이지 결함이 아니다. **재현해 확인한 것만** 결함으로 보고하고 고친다. 맞지 않으면 "아님"으로 기록한다.

## 7. GPU 실검증 트랙 (`gpu-real`, 허락 후)

1. 호스트에서 사용자 서버를 내려도 되는지 **먼저 묻는다.** 허락 전에는 이 트랙을 수행하지 않는다. 허락 후 포트 소유 pid 로만 종료, VRAM 반환 확인(`nvidia-smi`), **끝나면 같은 명령으로 원래 서버를 복구**하고 헬스·VRAM 을 확인한다.
2. 컨테이너 안에서 실제 `llama-server`(stock CUDA 사전빌드)와 **작은 GGUF**(수십~수백 MB)로: 엔진 사다리 실행 검증 → 모델 로드 → `/health` → 단일 서버 정책 → `calibrate`(OOM 재시도/하향/상향은 작은 모델로는 의미가 없으니 **가짜 서버 시나리오로 대체**).
3. 20 GiB 급 모델을 컨테이너 검증 목적으로 받지 않는다.

## 8. 컨테이너로 못 하는 환경 — 별도 트랙 (계획만 명시)

| 환경 | 수단 | 최소 검증 |
|---|---|---|
| Windows PowerShell / cmd / Git-Bash | GitHub Actions `windows-latest` (또는 Windows VM) | 하드웨어 탐지(`powershell Get-CimInstance`), win zip(+cudart) 자산 선택·`.exe` 경로·따옴표, 포트 소유자 `netstat`, 가짜 llama-server(`.cmd`) 로 단일 서버 정책 |
| macOS arm64 | `macos-14` | Metal 자산, 통합 메모리 예산, `brew` 계획 |
| WSL2 | Windows 러너 + WSL 또는 가짜 주입(§6 H5) | GPU 패스스루 분류 |
이 트랙은 이 문서의 산출물이 아니라 **CI 워크플로 초안 + 체크리스트**까지만 작성하고, 실행 결과가 없으면 보고서에 "미검증"으로 남긴다.

## 9. 수행 순서 (한 번에 하나, 단계마다 커밋)

1. 런타임 확보(§1, 사용자 확인) → 최소 컨테이너(`deb-bash-user`, 가짜 하드웨어 없음)에서 `dist` 구동 + `/server` 화면 단언 하나를 통과시킨다. (하네스 골격 증명)
2. Seam 추가(§5-3, §5-4): HF/릴리스 URL 오버라이드, `HostProbe` 환경 주입. 단위 테스트로 기본값 불변 증명.
3. `mock-hub` + 가짜 하드웨어 스텁 + 가짜 llama-server 이미지 레이어.
4. §4.1 → §4.2 → §4.3 → §4.4 순으로 컨테이너 추가. 행마다 `expect/<id>.json` 을 **먼저** 쓰고(기대 우선), 실행해 어긋나면 §6 가설로 분류.
5. 확인된 결함을 **하나씩** 고치고 해당 컨테이너 행을 회귀 테스트로 남긴다(H1 부터).
6. §7(허락 시), §8 CI 초안, 보고서.

## 10. 합격 기준

- [ ] §4 의 모든 행이 `matrix.yaml` + `expect/*.json` 으로 존재하고 `run.sh` 한 번으로 전부 실행된다(런타임은 podman/docker 중 아무거나).
- [ ] 각 행의 `ok` 는 **기계 판정**이다(화면/종료코드/JSON 단언). 로그를 사람이 읽어야 하는 행은 없다.
- [ ] H1~H8 이 각각 `확인됨(결함, 수정+회귀 테스트)` / `아님(증거)` / `재현 불가(이유)` 중 하나로 보고서에 기록된다.
- [ ] 단일 서버 정책(§4.4): 모든 환경에서 `stop` 호출 0(미확정), foreign 종료 0, 두 번째 서버 기동 0.
- [ ] 보고서에 환경별 신뢰도 표: `컨테이너 실검증 / 가짜 주입 / CI 러너 / 미검증` — Windows·macOS 는 CI 결과가 없으면 **미검증**.
- [ ] 기본 동작 불변: seam 은 환경변수 미설정 시 현재와 동일(기존 `npm test` 1247개 + 신규 전부 통과).
- [ ] 호스트 불가침: 실행 전후 호스트의 8080 서버 pid·명령줄·VRAM 이 동일(또는 허락된 §7 만 변경 후 복구).

## 11. 하지 말 것

- 컨테이너 결과를 Windows/macOS 검증으로 보고하지 않는다.
- 실제 HF/GitHub 를 기본 경로로 때리지 않는다(느리고 비결정적, 속도 제한). 실제 네트워크 스모크는 1개 행만 선택적으로.
- 호스트의 사용자 서버·모델·설정·체크포인트를 마운트하거나 건드리지 않는다. `pgrep` 이름 매칭으로 프로세스를 죽이지 않는다(포트 소유 pid).
- 가설을 증거 없이 결함으로 단정하지 않는다. 컨테이너에서 재현되지 않으면 고치지 않는다.
- 프로덕션 동작을 바꾸는 seam 을 넣지 않는다(기본값 동일, 테스트 전용 진입점은 환경변수로만).
- 폐기한 기능(Bonsai/PrismML fork)을 되살리지 않는다.

## 12. 산출물

1. `test/containers/**` (Containerfile, matrix.yaml, run.sh, expect/, fixtures/, mock-hub).
2. seam 추가 커밋 + 단위 테스트.
3. 확인된 결함 수정 커밋(가설별) + 회귀 테스트.
4. `docs/container-matrix-report.md` — 행별 결과, H1~H8 판정, 환경별 신뢰도 표, 남은 한계.
5. CI 워크플로 초안(Windows/macOS, §8) — 실행 결과 없으면 "미검증" 명시.
6. `npm run build` 로 갱신한 `bin/` 커밋. 푸시는 사용자 확인 후.
