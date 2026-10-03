# 컨테이너 매트릭스 검증 보고서 (1차: 호스트 모드 → 2차: podman 컨테이너 실행)

기준 문서: `docs/container-matrix-validation-prompt.md`. 하네스: `test/containers/`.

## 0. 2차: podman(rootless 5.7, cgroup v2) 설치 후 컨테이너를 실제로 실행했다

사용자가 podman 을 설치한 뒤 `node test/containers/run-containers.mjs` 를 실행했다. **전체 21행 통과** (OS 7 + 쉘 3 + CPU/RAM 3 + GPU 8).

| 구분 | 이미지(실행 결과로 확인) | 결과 |
|---|---|---|
| Debian 12 (Node 18.20, glibc) bash/dash, sudo 없는 일반 사용자 | ✅ | `buildPlan.manager=apt`, libc=glibc |
| Ubuntu 24.04 (Node 18.19) 일반+sudo / root | ✅ | apt |
| Fedora 40 (Node 20.19) zsh | ✅ | dnf |
| Arch (Node 26) fish | ✅ | pacman |
| **Alpine 3.20 (Node 20.15, musl) busybox ash** | ✅ | apk, **libc=musl, 사전빌드 사다리 비어 있음(→ 소스 빌드)** — 아래 H2 |
| `--memory 4g --cpus 2` 등 **컨테이너 cgroup 한도** | ✅ | cpu=2, ram=4 GiB 로 인식 (H1 수정이 컨테이너에서도 유효) |
| NVIDIA 4/8/24 GiB·오래된 드라이버·없음, Intel Vulkan, 소프트웨어 Vulkan, AMD sysfs(마운트한 가짜 트리) | ✅ | 가짜 하드웨어 주입 |
| 다운로드 시나리오 6/6 (재서명 CDN 재개, 해시 판정) | ✅ Debian·Alpine·Fedora·Arch 4개 이미지 | |

컨테이너 안에서 돈 것은 **dist 의 설정/탐지 모듈(probe)과 다운로드 함수**다. 의존성(ink 등)이 없는 이미지라 **TUI 는 컨테이너에서 띄우지 않았다**(TUI 는 호스트 pty 스모크로만 검증).
GPU 는 전부 가짜 주입이므로 컨테이너의 실제 가속은 검증되지 않았다(`gpu-real` 은 사용자 서버를 내려야 해서 하지 않음).

### 컨테이너로 처음 드러난 결함 (H2 확정 → 수정)

**Alpine(musl)에서도 glibc 로 빌드된 사전빌드를 받으려 했다.** 사다리는 `ubuntu` glibc 자산을 고르고, 받은 뒤 실행 검증에서 떨어져야 비로소 다음 단계로 간다(대용량 다운로드 낭비).
→ `hardware.libc` (`/lib/ld-musl-*` 로 판별) 추가, `stockRungsFor` 가 musl 이면 사전빌드를 제시하지 않고 곧장 소스 빌드로 간다. 단위 테스트 2개 + Alpine 컨테이너 행(`detected.libc: musl`, `engineLadder: []`).

### 하네스 자체의 문제 (고침)
- dist 타르볼에 `dist/` 접두가 없고 `package.json{"type":"module"}` 도 없어 첫 실행이 `ERR_MODULE_NOT_FOUND`/`SyntaxError` → Containerfile 수정.
- podman 은 짧은 이미지 이름을 거부 → `docker.io/library/` 보강.
- rootless 에서 컨테이너 `user` 는 sub-uid 라 호스트의 0700 임시 디렉토리를 못 읽음(가짜 sysfs) → 0755 로.

## 1. 신뢰도 표

| 환경 | 상태 | 근거 |
|---|---|---|
| 쉘 bash / dash / busybox sh 에서 `probe` | ✅ 호스트 실행 | `run-host.mjs` 3행 |
| CPU 2·4 / RAM 4·8 GiB **진짜 cgroup 한도** | ✅ 호스트 실행 | `systemd-run --user --scope -p MemoryMax -p CPUQuota`, 결과 cpu=2 ram=4G 등 |
| NVIDIA 4/8/24 GiB, 오래된 드라이버, `nvidia-smi` 없음 | ⚠️ 가짜 주입(탐지 로직 실검증) | PATH 스텁. 실제 가속은 아님 |
| AMD(sysfs) 16 GiB | ⚠️ 가짜 주입 | `LLAMACLI_DRM_ROOT` 가짜 트리 |
| Intel Arc(vulkaninfo) / 소프트웨어 Vulkan(llvmpipe) | ⚠️ 가짜 주입 | `vulkaninfo` 스텁. llvmpipe 는 GPU 로 오인하지 않음 |
| 터미널/홈 변형 7종 (baseline, `LANG=C`+`TERM=dumb`/`xterm`, 읽기 전용 HOME, HOME 미설정, 없는 HOME, 마우스 끔) | ✅ 호스트 실행 (진짜 CLI, pty) | `tui-smoke.py`: 7/7 TUI 기동·무크래시 |
| 다운로드: 중단→재개(서명이 바뀌는 CDN), 해시 판정, 같은 크기·다른 바이트 | ✅ 호스트 실행 | `download-scenario.mjs` 6/6; **이전 빌드(d5aa50c)로 돌리면 2개 FAIL** — 회귀를 실제로 잡음 |
| 단일 서버 정책(종료·교체·foreign·다중) | ✅ 호스트 실행 | `scripts/live_single_server_check.ts` (이전 작업) |
| Debian/Ubuntu/Fedora/Arch/Alpine(musl) 컨테이너, root/일반/sudo 없음 | ✅ 컨테이너 실행 | §0 |
| `/models`·`/server` 슬래시 명령의 환경별 화면 | ❌ 미검증 | 환경별 pty 시나리오는 baseline 기동까지만 |
| Windows PowerShell/cmd/Git-Bash, macOS, WSL | ❌ 미검증 | 컨테이너 불가 → CI 러너 필요(문서 §8). 워크플로 초안도 아직 없음 |

## 2. 가설(H1~H8) 판정

| # | 판정 | 증거·조치 |
|---|---|---|
| H1 cgroup 한도 무시 | **확인됨 → 수정** | 진짜 cgroup(4G/2코어) 안에서 `os.totalmem()`=30.6 GiB, `os.cpus()`=12 가 그대로 나옴. `readCgroupLimits`/`applyCgroupLimits`(v2·v1·슬라이스 경로, 가장 엄격한 값) 추가 + 단위 테스트 6개. 수정 후 probe: cpu=2 ram=4G |
| H1 파생: CPU 전용에서 가중치를 빼지 않고 KV 예산 | **확인됨 → 수정** | `cpu2-ram4` 가 5.1 GiB 모델에 컨텍스트 98,304 를 줌 → RAM − 가중치×1.15 − 1 GiB 로 제한(45,056 로). 단위 테스트 + 격자 불변식 추가. (직전에 올린 상한 98,304 가 드러낸 결함) |
| H2 musl(Alpine) | **확인됨 → 수정** | §0: 사전빌드 제시 중단, 소스 빌드로 |
| H3 `TERM=dumb`/비UTF-8 | **아님(증거)** | `LANG=C`+`TERM=dumb|xterm` 에서 ASCII 폴백(`-----`, `.....`, `HARNESS`) 으로 정상 기동 |
| H4 읽기 전용 HOME | **아님(증거)** | 읽기 전용/없는/미설정 HOME 모두 크래시 없이 TUI 기동 |
| H5 WSL 미분류 | **미확인** | 컨테이너/가짜 `/proc/version` 필요. 현재 linux 로 취급됨(코드 확인) |
| H6 소프트웨어 Vulkan 오인 | **아님(증거)** | `vulkaninfo` 스텁(`PHYSICAL_DEVICE_TYPE_CPU`/llvmpipe) → `gpuBackend: none` |
| H7 dash/비대화형 | **아님(증거)** | dash·busybox sh 로 `-c` 실행해 같은 JSON |
| H8 작은 루트 FS | **미확인** | 컨테이너 행 미작성(디스크 부족 단위 테스트는 기존 `disk.test.ts`) |

## 3. 하네스를 돌리다 발견한 **환경과 무관한 결함**

**시작 시 건강 확인이 바쁜 서버 뒤에서 대기**: 스모크 변형들이 갑자기 23~28 초씩 걸렸다. 원인은 단일 슬롯 서버(`-np 1`)가 사용자의 긴 요청(29k 토큰 프롬프트)을 처리 중일 때,
`probeBackendHealth` 가 완성 요청을 보내 그 뒤에 줄을 서는 것(`/slots` 의 `is_processing:true` 로 확인). 수정: `/slots` 가 "전부 처리 중"이면 확인을 건너뛰고(`unknown`),
`/slots` 가 없는 서버는 8 초 상한 후 `unknown` 으로 넘어간다(바쁜 서버 ≠ 고장 난 서버). 수정 후 시작 0.6~2.3 초. 단위 테스트 4개.

## 4. 이번에 바뀐 동작 (seam 포함, 기본값 불변)

- `LLAMACLI_HF_ENDPOINT`, `LLAMACLI_RELEASES_URL`, `LLAMACLI_DRM_ROOT`: 미설정이면 기존과 동일(테스트로 고정).
- `/models` 머리의 RAM 표시는 `os.totalmem()` 대신 감지된(cgroup 반영) 값.

## 5. 아직 남은 일

1. **컨테이너 런타임이 있는 곳에서 `npm run build && node test/containers/run-containers.mjs`** 를 실행해 `os_rows` 와 `where: container` 행을 증명할 것. (podman 설치에 sudo 가 필요합니다.)
2. Windows/macOS CI 워크플로 초안, WSL 가짜 주입 seam.
3. 환경별 `/server`·`/models`·`/reset` 화면 단언 pty 시나리오(현재는 기동 스모크까지).
4. `mock-hub` 를 쓰는 부트스트랩 end-to-end(카탈로그→다운로드→설정) 시나리오 — 지금은 다운로드 함수 단위까지만.

## 6. Windows 워크플로 (`.github/workflows/windows.yml`) — GitHub 러너에서 **실제로 실행됨**

러너: Windows NT 10.0.26100, 4코어, RAM 16 GiB, 가상 그래픽(Hyper-V, GPU 없음), PowerShell 7.6, Node 22.23, winget 있음. 배포 타르볼(`bin/llamacli-dist.tar.gz`)을 풀어서 검증(빌드 스크립트는 POSIX 도구를 써서 Windows 기본 쉘에서 안 돌아감).

| 항목 | 결과 (run 37133397194) |
|---|---|
| 탐지 프로브: pwsh / Windows PowerShell / **cmd** / Git-Bash | ✅ 4/4: cpu=4 ram=16G, GPU 없음(Hyper-V 가상 그래픽을 GPU 로 오인하지 않음), 사다리 cpu, 빌드 도구 관리자 winget, 9B |
| 다운로드 시나리오(재서명 CDN 재개, 해시 판정, 같은 크기·다른 바이트) | ✅ 6/6 (Windows 파일 의미) |
| **클립보드 왕복** (한글+이모지+개행 41자) | ✅ `powershell` 이 정확히 복사(도구 순서 powershell > pwsh > clip) |
| 단위 테스트(`npm test`, 정보용) | 1265 중 **1190 통과 / 75 실패** — 분류는 아래 |

워크플로가 처음 두 번 실패한 원인은 모두 **하네스** 쪽: (1) GNU tar 가 `D:\…` 의 `D:` 를 원격 호스트로 해석 → POSIX 경로로 풀기, (2) cmd.exe 인자 따옴표를 Node 가 이중으로 감쌈 → `windowsVerbatimArguments`.

### Windows 단위 테스트 실패 분류 (1265 중 75 → 두 번째 실행 71 실패)

두 번째 Windows 실행(`37133814937`)의 71개를 분류했다. **제품 결함 1종(경로 구분자), 나머지는 테스트의 POSIX 가정.**

| 분류 | 개수 | 조치 |
|---|---|---|
| **제품 결함: 경로를 `split("/")` 로 자름** — Windows 경로 `C:\models\x.gguf` 에서 파일명이 전체 경로로 나옴 (`/server`·`/models` 표시, 재시작 전 diff, 설정과 파일명 비교(`configuredModelPath`, `existingModelFilename`), `.sha256` 사이드카, 체크섬 오류 문구, 모델 재사용 매칭) | 22곳 | `src/util/path.ts` (`baseName`/`lastSegments`) 로 교체, `isAbsolute` 로 절대경로 판별. 단위 테스트 3개 |
| 테스트 헬퍼가 시스템 `tar` 에 **절대 경로 `C:\…` 아카이브명**을 넘김 → Git 의 GNU tar 가 `C` 호스트로 해석(`selfUpdate` 11 + `selfUpdateStages` 6 + `tarGz` 2). 제품은 순수 JS 추출이라 무관 | 19 | cwd + 상대 아카이브명, `rm` → `rmSync` |
| 실행 권한 비트·심볼릭 링크(Windows 에는 실행 비트 없음 — 666 이 정상) | 3 | win32 skip (이유 명시) |
| 테스트가 `/proc/version/nope.txt` 처럼 Linux 에서만 실패하는 경로를 사용 / JSON 이스케이프된 경로 비교 / POSIX 쉘 문법 (`pwd`, `>&2`) | 4 | 플랫폼 중립으로 수정(`afile/nope.txt`, 이스케이프 비교, `cd`/`1>&2`) |
| **POSIX 픽스처**: `#!/bin/sh` 가짜 llama-server(.exe 없음), posix 경로 리터럴, `/media`·`/mnt` 마운트 (`llamaCpp` 14, `bootstrap` 8, `buildLlamaCpp` 5, `disk` 3, `stockRuntime` 3, `ggufMeta` 3, `remaining` 2, `bootstrap.config` 2, `resolve` 1) | 41 | win32 에서 **skip** (이유 문자열 명시). **이 부분은 Windows 에서 테스트되지 않는다** — Windows 용 픽스처(.cmd/.exe) 필요. 실제 Windows 동작은 `test/windows/run.mjs` 가 일부(탐지·다운로드·클립보드)만 덮는다 |
| 내가 추가한 클립보드 테스트의 비밀폐 | 4 | (이전 커밋에서 수정) |

솔직한 상태: **skip 한 41개는 "통과"가 아니라 "Windows 에서는 검증 안 함"** 이다. 그 영역(엔진 탐색 `findLlamaServer`, 빌드 산출물 위치, 설치된 사전빌드 재사용, 부트스트랩 흐름)에서 Windows 고유 결함이 숨어 있을 수 있다.
**여전히 미검증:** GPU 가 있는 Windows, `winget` 설치 실행, 실제 `llama-server` 기동, Windows Terminal/conhost 의 대화형 TUI(마우스·OSC 52), macOS.

## 7. 검증 수단 총정리 (이 저장소에서 `npm run matrix:all` + CI 3종)

| 수단 | 무엇을 검증 | 실행 위치 | 상태 |
|---|---|---|---|
| 단위 테스트 (`npm test`, 1271) | 로직 전반 + Windows 형태 경로(`src/windowsPaths.test.ts`: 드라이브 문자·역슬래시) | 로컬 / Linux CI / Windows CI(정보용) / macOS CI(정보용) | Linux 로컬 전부 통과 |
| 호스트 모드 매트릭스 (`run-host.mjs`) | 쉘 3종, 진짜 cgroup 한도, 가짜 GPU, 터미널·HOME 변형 | 로컬 (systemd --user 없으면 cgroup 행 SKIP 표시) | 통과 |
| 컨테이너 매트릭스 (`run-containers.mjs`) | Debian/Ubuntu/Fedora/Arch/Alpine(musl), root·일반·sudo 없음, 한도·가짜 GPU | 로컬 podman / Linux CI(docker) | 로컬 21/21 |
| TUI 스모크 (`tui-smoke.py`) | 실제 CLI 를 pty 로: `LANG=C`, `TERM=dumb`, 읽기 전용/없는 HOME | 로컬 / Linux CI | 7/7 |
| 다운로드 시나리오 | 재서명 CDN 재개, 해시 판정, 같은 크기·다른 바이트 | 로컬, 컨테이너 4종, Windows CI | 통과 |
| 클립보드 왕복 (`test/clipboard-check.mjs`) | 한글+이모지+개행: Windows `powershell`, macOS `pbcopy`, Linux `wl-copy`/`xclip` | 로컬(Wayland) / Windows·macOS·Linux CI | 로컬 Wayland ✅ 실제 클립보드, Windows CI ✅ |
| 실제 TUI 드래그 → Wayland 클립보드 | Shift 없는 드래그가 `wl-paste` 로 읽힘 | 로컬 (`wl-clipboard` 설치 후) | ✅ (사용자 클립보드는 저장·복원) |
| Windows 러너 (`windows.yml`) | pwsh/PowerShell/cmd/Git-Bash 프로브, 다운로드, 클립보드, 단위 테스트 | GitHub Actions | 프로브·다운로드·클립보드 ✅, 단위 테스트 1220 통과 / 4 실패(수정함) / 44 skip |
| macOS 러너 (`macos.yml`) | zsh/bash/sh 프로브(Metal), 다운로드, pbcopy 왕복 | GitHub Actions | **작성만, 아직 실행 전** |
| Linux 러너 (`linux.yml`) | tsc, 테스트, 빌드, 호스트·컨테이너 매트릭스, Xvfb+xclip 클립보드 | GitHub Actions | **작성만, 아직 실행 전** |
| Wine (`test/windows/wine-check.sh`) | win32 프로브(Windows 용 node.exe) | 로컬 (wine 설치 필요) | **미실행**(wine 없음) |

이번 라운드에서 시뮬레이션 테스트로 드러난 제품 결함: `pickFamilyMatch` 가 `f.path.endsWith("/"+name)` 로 파일을 찾아 **Windows 경로에서는 같은 모델의 다른 양자화를 재사용하지 못했다**(다운로드 낭비) → 파일명 비교로 수정.

여전히 미검증: GPU 가 있는 Windows, 실제 `llama-server` 기동(Windows/macOS), Windows Terminal·conhost·Terminal.app 의 대화형 TUI, skip 한 POSIX 픽스처 테스트 44개의 Windows 대응.
