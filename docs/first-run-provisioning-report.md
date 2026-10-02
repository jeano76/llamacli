# 초기 구동 환경 자동 구축 — 구현 보고서

> 대상: `docs/first-run-provisioning-prompt.md` · 작성 기준일: 2026-10-02
> **검증한 것과 검증하지 못한 것을 구분해서 적었습니다.** "미검증"은 실행해보지 않았다는 뜻입니다.

## 1. 공백별 결과

| # | 공백 | 상태 | 커밋 |
|---|---|---|---|
| G1 | NVIDIA 전용 GPU 탐지 | **완료** — AMD(sysfs), Apple Silicon(통합 메모리), Vulkan, Windows `where` 탐색 | `4194476` |
| G2 | stock llama.cpp 사전빌드 경로 없음 | **완료** — 가속기 → Vulkan → CPU → 소스 사다리, 칸마다 실행 검증 | `0feb3fb` |
| G3 | apt+sudo 하드코딩 | **대부분 완료** — 아래 "남은 것" 참고 | `4b509b2` |
| G4 | CMake 플래그 단일 경로 | **부분 완료** — CUDA(아키텍처 한정)·Vulkan·Metal·CPU. **ROCm 소스빌드 없음** | `4b509b2` |
| G5 | 소스빌드 사전점검 | **부분 완료** — 디스크·RAM 기반 `-j`·`-j1` 재시도. **네트워크 사전점검 없음** | `4b509b2` |
| G6 | 엔진→모델 순서 비대칭 | **완료** — 엔진 획득을 실행 중 서버 확인·모델 결정 뒤로 이동 | `0feb3fb` |
| G7 | 단일 머신 기준 임계값 | **부분 완료** — 4GB RAM 머신에 5.4 GiB 9B를 주던 버그 수정. **임계값 재측정은 못 함** | `10e36f4` |
| G8 | 다중 GPU | **범위 제외** (Step 0 결정: 기존대로 free VRAM 최대 1개) | — |
| G9 | 빌드 진행 표시 | **부분 완료** — 10% 단위 + 1분 하트비트. **다운로드/빌드 병렬화는 하지 않음** | `23e6ad8` |
| G10 | vLLM | **범위 제외** (Step 0 결정: 외부 서버 채택만) | — |

## 2. 실제로 확인한 것

- **GitHub 릴리스 자산 이름**: `ggml-org/llama.cpp` 릴리스 API(`b11344`)에서 직접 읽은 목록으로 패턴을 정했습니다. 자산명에 커밋 태그가 들어가고 CUDA 버전 집합이 릴리스마다 달라서, 코드는 이름을 하드코딩하지 않고 릴리스의 자산 목록에서 고릅니다.
- **압축 구조**: Linux/macOS 아카이브가 `llama-<tag>/` 아래에 중첩되고, CUDA 런타임 번들은 `cudart-llama-…/` 라는 다른 최상위 이름을 쓴다는 것을 `tar -tz` 로 확인했습니다 (둘 다 strip 1 로 같은 디렉토리에 풀어야 함).
- **CPU 사전빌드**: 이 머신에서 실제로 내려받고 풀어서 `verifyLlamaServer` 를 통과했습니다.
- **CUDA 12.8 사전빌드(+cudart 번들, 약 765 MB)**: 이 머신(RTX 2070 SUPER)에서 실제로 내려받고 풀어서 검증을 통과했습니다. 검증에는 `--list-devices` 로 가속기 초기화 확인이 포함됩니다.
- **하드웨어 탐지**: 이 머신에서 `cuda` / `NVIDIA GeForce RTX 2070 SUPER` / x64 로 올바르게 탐지됨.
- **테스트**: `npm test` 998/998, `npm run typecheck`, 하니스 4종(`bare_env_check`, `persona_usability_check`, `project_persona_check`, `tui_simulation_check`) 모두 통과. 새 테스트 약 80개(하드웨어 탐지·빌드 환경·사다리·부트스트랩 순서·프로파일·진행 표시).
  - 한 번 `scenario.test.ts`("many concurrent long-running…") 가 60초 제한에 걸려 실패했으나, 단독 실행 및 이후 전체 실행 2회에서는 통과했습니다. 저는 그 파일을 건드리지 않았고, 당시 약 765 MB 다운로드와 다른 작업이 동시에 돌고 있었습니다. 부하 의존 불안정으로 추정하지만 원인을 확정하지는 않았습니다.

## 3. 검증하지 못한 것 (미검증)

| 항목 | 이유 |
|---|---|
| **소스 빌드 end-to-end** (실제 `cmake` 컴파일) | 10~40분. 단위 테스트는 가짜 `run` 으로 플래그·재시도·사전점검만 확인 |
| **깨끗한 컨테이너/VM 첫 실행** | 이 머신에 docker/podman 없음. `bare_env_check` 는 통과했으나 그것은 합성 환경 |
| **Windows 전 구간** (winget ID, zip 추출, `where`, 비플랫 zip 구조) | Windows 실행 환경 없음. winget ID(`Git.Git`, `Kitware.CMake`, `Microsoft.VisualStudio.2022.BuildTools`)와 VC 워크로드 `--override` 인자는 **기억에 의존**했고 실행해보지 못함. ggml-org Windows zip 이 평평한지도 미확인 |
| **macOS** (Metal 자산, brew) | 맥 없음. 자산 이름과 `llama-<tag>/` 중첩은 Linux 와 같다고 목록·구조로 확인했으나 실행은 못 함 |
| **AMD ROCm/Vulkan 사전빌드 실행** | AMD GPU 없음. sysfs 파일명(`mem_info_vram_total` 등)은 amdgpu 커널 인터페이스에 대한 지식이며 AMD 장비로 확인하지 못함 |
| **dnf / pacman / apk / zypper 패키지 이름** | 해당 배포판의 인덱스를 조회하지 않음. 틀리면 설치가 실패하고 리포트에 남음(사전빌드가 먼저 시도되므로 대부분 영향 없음) |
| **Vulkan 사전빌드 실행** (NVIDIA 위에서) | 이 머신의 Vulkan 런타임으로 시도하지 않음 |

## 4. 모델 선택 — baseline 과 변경

실제 HuggingFace 후보 목록(2026-10-02)으로 `chooseModel` 을 돌린 결과.

| 프로파일 | 변경 전 | 변경 후 |
|---|---|---|
| nvidia 8GB / RAM 30 | Bonsai-2-27B PTQ1_0 (5.5 GiB) | 동일 |
| nvidia 24GB / RAM 64 | Bonsai-2-27B PTQ1_0 | 동일 |
| nvidia 12GB / RAM 32 | Bonsai-2-27B PTQ1_0 | 동일 |
| nvidia 6GB / RAM 16 | Bonsai-8B PQ2_0 | 동일 |
| CPU 전용 / RAM 16, 32 | Ornith-9B Q4_K_M (5.4 GiB) | 동일 |
| CPU 전용 / RAM 8 | Ornith-9B Q4_K_M | 동일 (5.4×1.4=7.6 ≤ 8) |
| **CPU 전용 / RAM 4** | **Ornith-9B (5.4 GiB — 상주 불가)** | **Bonsai-8B PQ2_0 (2.0 GiB)** |
| AMD 20GB / RAM 32 | Bonsai-2-27B | 동일 |
| Apple 24GB (GPU 예산 16.1) | Bonsai-2-27B | 동일 |
| Apple 8GB (GPU 예산 5.4) | Bonsai-8B | 동일 |

**열린 질문 (제가 바꾸지 않았습니다)**: Bonsai 27B(5.5 GiB, 1-bit)는 VRAM ≥ 6.5 GiB 인 **모든** 머신에서 Ornith 35B-A3B Q4(21 GiB)보다 먼저 선택됩니다. 24 GB RTX 4090 이나 64 GB 맥에서도 그렇습니다. 원래 8 GB 머신 한 대에서 정해진 우선순위라서, 큰 머신에서 어느 쪽이 품질/속도가 나은지는 **측정 없이는 판단할 수 없어** 그대로 두었습니다. CPU 전용 머신에서 9B Q4 와 Bonsai 8B 중 어느 쪽이 실용 tok/s 인지도 같은 이유로 미측정입니다.

## 5. 남은 공백

1. **`pip --user cmake` 같은 사용자 영역 설치 경로 없음.** sudo 가 불가능한 환경에서는 사전빌드가 동작하면 문제없고, 소스 빌드가 필요하면 `manual` 안내와 함께 중단됩니다.
2. **CUDA 툴킷은 일부러 설치하지 않습니다.** 소스 빌드는 `nvcc` 가 이미 있을 때만 CUDA 를 겨냥하고, 아니면 Vulkan/CPU 로 갑니다. (이전 코드가 설치하려던 `cuda-toolkit-12-4` 는 NVIDIA apt 저장소가 등록되어 있지 않으면 존재하지 않는 패키지였습니다.) 기존 `installBuildPackages` 는 호환을 위해 export 로 남겼지만 더 이상 호출되지 않습니다.
3. **ROCm / SYCL 소스 빌드 없음.** AMD 는 ROCm 사전빌드 → Vulkan 사전빌드 → CPU 순입니다.
4. **빌드 전 네트워크 도달성 확인 없음.** `git clone` 이 실패하면 그 메시지가 리포트에 남습니다.
5. **다운로드와 빌드 병렬화 없음.** 순서 결정(G6)은 해결했지만 두 작업을 동시에 돌리지는 않았습니다.
6. **TUI 에서의 빌드 진행 표시는 줄 로그입니다.** 다운로드처럼 한 줄 재그리기(`setTransient`)로 바꾸려면 `index.tsx` 수정이 필요한데, 그 파일은 다른 작업이 진행 중이라 건드리지 않았습니다.
7. **Windows 의 비 NVIDIA GPU, Intel Mac** 은 CPU 로 판정됩니다.
8. **`bin/llamacli-dist.tar.gz` 는 재빌드하지 않았습니다.** 작업 트리에 다른 작업의 미커밋 변경(`loop.ts`, `compactor.ts`, `openaiClient.ts`, `config.ts`, `index.tsx` 등)이 있어, 지금 `npm run build` 를 하면 그 변경이 배포 tarball 에 섞입니다. 그 작업이 커밋된 뒤 `npm run build` 와 `chore(bin): rebuild dist tarball` 커밋을 하면 됩니다.

## 6. 합격 기준 대비

1. *8개 프로파일 모두 사용자 입력 0회 / 사유+수동 조치 리포트* — 합성 프로파일 8개(`profiles.test.ts`)는 엔진 사다리·빌드 계획·모델 선택이 기대대로 나옴. **실제 서버 기동까지의 end-to-end 는 이 머신(NVIDIA) 에서만, 그것도 엔진 획득 단계까지** 확인.
2. *두 번째 실행은 네트워크/빌드/sudo 0회* — 새 설치 위치(`~/.llamacli/llama.cpp-prebuilt`)를 `findLlamaServer` 가 찾도록 추가했고, `bootstrap.order.test.ts` 가 이미 "설정된 머신은 네트워크 0회"를 단언합니다. 새 위치에 대한 전용 재실행 테스트는 **추가하지 못함**.
3. *이미 서버가 있으면 두 번째 서버 금지* — 유지. 더해서 엔진 획득이 서버 확인 뒤로 가서, 서버가 떠 있는 머신은 엔진을 받지도 빌드하지도 않습니다 (`bootstrap.engine.test.ts`).
4. *사전빌드가 동작하는 환경에서 `cmake` 0회* — `stockRuntime.test.ts` 가 단언.
5. *`npm run check` 통과, 기존 테스트 약화 없음* — 통과. 기존 테스트는 지우거나 고치지 않았고(추가만), `installBuildPackages` 테스트도 그대로 통과합니다.
