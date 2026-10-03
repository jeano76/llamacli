# 컨테이너 매트릭스 검증 보고서 (1차: 호스트 모드 → 2차: podman 컨테이너 실행)

기준 문서: `docs/container-matrix-validation-prompt.md`. 하네스: `test/containers/`.

## 0. 2차: podman(rootless 5.7, cgroup v2) 설치 후 컨테이너를 실제로 실행했다

사용자가 podman 을 설치한 뒤 `node test/containers/run-containers.mjs` 를 실행했다. **전체 27행 통과** (OS 7 + 쉘 3 + CPU/RAM 3 + GPU 14 계열).

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
