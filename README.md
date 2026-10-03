# llamacli

로컬 **llama.cpp** 서버와 직접 대화하는 터미널 코딩 에이전트입니다. OpenAI Chat Completions API 와 호환되고, 모델 가중치·대화·에이전트가
읽은 파일이 모두 한 머신 안에 남습니다. 설계 배경과 요구사항은 [`PROMPT.md`](./PROMPT.md) 에 있습니다.

- **처음 실행해도 알아서 준비합니다.** llama.cpp 와 이 머신에 맞는 모델이 없으면 받고(또는 빌드하고), GPU·VRAM·RAM 에 맞춰 설정합니다.
- **서버는 하나, 포트도 하나.** 이미 도는 서버는 확인 없이 건드리지 않습니다.
- **긴 작업을 견딥니다.** 컨텍스트를 자동 압축하고, 도구 호출 사이마다 체크포인트를 남겨 다음 실행에서 이어갑니다.
- **Linux · macOS · Windows** (Windows/macOS 는 CI 로 검증, 한계는 [검증](#테스트와-검증) 참고).

## 목차

[빠른 시작](#빠른-시작) · [사용법](#사용법) · [구조](#구조) · [로컬 모델과 서버](#로컬-모델과-서버) · [컴팩션과 체크포인트](#컴팩션과-체크포인트) ·
[도구·스킬·규칙](#도구스킬규칙) · [설정](#설정) · [테스트와 검증](#테스트와-검증) · [제거된 기능](#제거된-기능) · [문서](#문서)

## 빠른 시작

```bash
git clone https://github.com/jeano76/llamacli && cd llamacli
npm install
npm run build        # dist/ 로 컴파일 (bin 이 dist 를 가리킴)
npm link             # 전역 `llamacli` 등록 — 어느 프로젝트 디렉토리에서든 실행
cd ~/my-project && llamacli
```

- **첫 실행**: 서버가 이미 떠 있으면 그것에 연결합니다. 없으면 llama.cpp(사전빌드 → Vulkan → CPU → 소스 빌드 순으로 *실행해 보며* 확인)와
  이 머신에서 구동 가능한 Ornith 모델(35B-A3B 또는 9B)을 받아 서버를 띄웁니다. 진행은 TUI 안의 한 줄 상태로 표시되고, 입력한 메시지는
  준비가 끝날 때까지 기다렸다가 실행됩니다.
- 프로젝트마다 `.llamacli/` (`config.yaml`, `rules/`, `skills/`, `state/`)를 갖습니다. 전역 명령은 진입점일 뿐입니다.
- **자체 업데이트**: 설치본(`dist/`)은 시작할 때 GitHub 의 해시 검증된 아카이브로 갱신하고 재시작합니다(진행률 표시).
  소스 체크아웃에서는 동작하지 않으며 `LLAMACLI_NO_UPDATE=1` 로 끌 수 있습니다.
- 개발: `npm run dev` · `npm test` · `npm run typecheck` · `npm run check` (타입 + 테스트 + 하네스).

## 사용법

### 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/help` · `/keys` | 도움말 · 키보드 단축키 |
| `/server` · `/server restart [confirm]` | 서버 상태 · 같은 포트에서 재시작 (확인 후) |
| `/models` · `/models <번호\|이름> [confirm]` | 이 머신에서 구동 가능한 모델 표 · 선택 |
| `/reset` · `/reset confirm` | 현재 하드웨어 기준으로 설정 재계산 (미리보기 → 적용) |
| `/compact` · `/queue` · `/plan-clear` | 지금 컴팩션 · 메시지 큐 · 멈춘 계획 표시 지우기 |
| `/skills` · `/rules` | 로드된 스킬/규칙 |
| `/copy` · `/mouse` · `/term` | 화면 로그 복사 · 마우스 켜기/끄기 · 감지된 터미널 능력 |
| `/quit` | 진행 중인 턴을 마치고 저장한 뒤 정상 종료 (Esc 는 즉시 종료, 체크포인트는 먼저 기록) |

### 화면과 입력

- 하단 고정 UI: 입력창, 상태바(`cwd │ 모델 … [컨텍스트 게이지] N%` — 70% 에서 노랑, 90% 에서 빨강), 스피너, 슬래시 팝업.
- 출력은 접이식 블록(diff, 긴 도구 결과)이며 클릭으로 펼칩니다. 추론/출력 끝에는 토큰 속도 `(40 t/s)` 가 붙습니다.
- **마우스는 기본 켜짐**: 휠 스크롤, 클릭으로 펼치기, **Shift 없이 드래그하면 선택·복사**. 한 화면보다 긴 구간은 버튼을 누른 채 휠로 스크롤합니다.
  Shift+드래그는 터미널 자체 선택을 쓰고, `/mouse` 로 끌 수 있습니다.
- **복사**는 OSC 52 와 OS 클립보드 도구를 함께 씁니다(Linux `wl-copy`/`xclip`/`xsel`, macOS `pbcopy`, Windows PowerShell `Set-Clipboard`).
  GNOME VTE 처럼 OSC 52 를 무시하는 터미널에서는 도구가 필요합니다 — 없으면 안내(`sudo apt install wl-clipboard`)가 나오고 텍스트는 항상
  `/tmp/llamacli-copy.txt`(Windows: 임시 폴더)에 저장됩니다.
- **터미널 능력 감지**: `src/tui/terminal.ts` 가 색 깊이, 유니코드, 대체 화면, SGR 마우스, 동기 출력, 멀티플렉서를 감지하고 모든 이스케이프 시퀀스를 그 기록을 거쳐
  만듭니다(미지원이면 빈 문자열). `LANG=C`/`TERM=dumb` 에서는 ASCII 로 대체됩니다. 환경변수: `LLAMACLI_ASCII`, `LLAMACLI_COLOR_DEPTH`, `LLAMACLI_NO_ANSI`,
  `LLAMACLI_FORCE_ANSI`, `LLAMACLI_MOUSE=0|1`, `LLAMACLI_ALT_SCREEN`, `LLAMACLI_NO_SMOOTH`.
  `CI=true`(dev 컨테이너·하네스에서도 설정됨)에서도 화면이 그려집니다 — Ink 는 CI 로 보이면 마지막 프레임만 출력하므로, 터미널일 때는 Ink 를 불러오기 전에 `CI=false` 로 두었다가 시작 후 원래 값을 되돌립니다(자식 프로세스에는 영향 없음).
- 화면 캡처는 모두 실제 바이너리를 pty 로 구동해 만든 것입니다(`scripts/capture_screens.py`, [`docs/screenshots/`](./docs/screenshots/)).

## 구조

```
keystroke → App.tsx (Ink) ─ 입력창 · 슬래시 메뉴 · 상태바
             └─ AgentLoop.send()
                  ├─ 컨텍스트 사용량 확인 ── 임계 초과 ─▶ compact() → 요약 + 체크포인트(.llamacli/state/)
                  ▼
              POST /v1/chat/completions ─▶ llama-server ─▶ tool_calls?
                  └─ 있으면 tools/ 로 실행 → 결과를 대화에 추가 → 반복
                  ▼
              스트리밍 텍스트 → 마크다운 렌더 → 로그
```

| 영역 | 위치 | 역할 |
|---|---|---|
| TUI | `src/tui/` | 입력·로그·스크롤·접기·커서, 터미널 능력(`terminal.ts`), 단축키(`keybindings.ts`), 선택/복사(`selection.ts`) |
| 에이전트 루프 | `src/agent/` | 턴 구동, 도구 디스패치, 컨텍스트 계산 |
| 컴팩션 | `src/compaction/` | 체크포인트 기록/재개, 요약, 노트 |
| 자가 치유 | `src/hermes/` | 회로 차단기(반복·정체 감지) |
| 백엔드 | `src/backend/` | 서버 탐색/채택/기동(`resolve.ts`), llama-server 프로세스, OpenAI 호환 클라이언트, 건강 확인 |
| 설치·설정 | `src/setup/` | 하드웨어 탐지, 엔진 확보, 모델 카탈로그/선택/다운로드, 튜너, 보정, 서버 정책, `/reset`·`/models`·`/server` 코어 |
| 도구 | `src/tools/` | 파일/셸/브라우저 도구, diff |
| 스킬·규칙 | `src/skills/` | 항상 켜진 규칙, 지연 로딩 스킬, 내장 스킬 |
| 갱신·충돌 | `src/selfUpdate.ts`, `src/crashHandler.ts` | 해시 검증 자체 업데이트, 동기 크래시 로그와 터미널 복구 |
| 공용 | `src/util/path.ts` | 두 구분자(`/`·`\`)를 다루는 경로 도우미 |

```
.llamacli/   config.yaml · rules/ · skills/ · state/ (체크포인트·노트·프롬프트 기록, git 무시)
test/        containers/ (환경 매트릭스 하네스) · windows/ · macos/ · clipboard-check.mjs
scripts/     capture_screens.py · live_single_server_check.ts · 모델 벤치/코딩 평가 · build/verify
docs/        벤치·평가·검증 보고서, 지시서(프롬프트), history/ (이전 README 보관본)
bin/         배포용 dist 타르볼 + manifest (자체 업데이트가 사용)
```

## 로컬 모델과 서버

### 확정 모델: Ornith-1.5-35B-A3B (`Q4_K_M`)

2026-10-03 사용자 결정. 하이브리드 MoE(256 experts, 활성 약 3B)라 KV 캐시가 거의 공짜입니다(토큰당 약 10.6 KB). 8 GB RTX 2070 SUPER 에서의 측정값:

| 항목 | 값 |
|---|---|
| 서버 | stock llama.cpp, `-c 98304 -np 1 -no-kvu -ngl 999 --n-cpu-moe 33 -fa on`, KV `q8_0`, `-t 6 -tb 11 -b 2048 -ub 512`, 포트 8080 |
| VRAM | 약 7.0 / 8.0 GiB |
| 생성 속도 (깊이 8k / 32k / 64k / 90k) | 39.7 / 36.4 / 30.9 / 28.5 t/s (프롬프트 처리 324 / 284 / 264 / 244 t/s) |
| 코딩 평가 52문제 | 48/52 (Qwen3.6 과 같음). 어려운 11문제는 전부 풀었고 토큰·시간은 Qwen 의 약 1/3.5 |
| 컴팩션 | 98,304 창에서 약 34,400 토큰마다, 1회 약 2분 (대신 20,480 일 때보다 약 4.8배 드묾) |

근거와 방법·한계는 [`docs/model-bench-2026-10-03.md`](./docs/model-bench-2026-10-03.md), [`docs/coding-eval-2026-10-03.md`](./docs/coding-eval-2026-10-03.md) 에 있습니다
(측정은 깊이당 1회라 노이즈가 있고, 코딩 평가는 12,000 토큰 상한 안에서 푸는 능력입니다). 다른 하드웨어에서는 같은 카탈로그의 9B(밀집) 등으로 자동 선택됩니다.

### 서버를 찾고, 포트를 정하고, 띄우는 순서 (`src/backend/resolve.ts`)

1. **이미 떠 있는 llama-server 가 있나?** 네트워크보다 먼저 확인하고, 있으면 그 엔드포인트에 **연결만** 합니다(두 번째 서버는 8 GB 카드에서 OOM).
   포트가 열렸지만 아직 응답하지 않으면 모델을 적재 중인 서버로 보고 기다립니다. 채택 전에 확인합니다 — `/props` 의 `build_info` 가 있으면 llama.cpp,
   없는 가짜 서버(디스크에 없는 `.gguf` 를 주장)는 **거부**하고 이유를 보여 줍니다. 응답은 하지만 출력이 무의미한(손상된 가중치) 서버는 알려 줍니다.
   서버가 단일 슬롯으로 바쁠 때는 건강 확인을 건너뜁니다(최대 8초 대기).
2. **설정에 서버가 있나?** 기록된 빌드로 기동합니다. 빌드가 모델의 양자화를 못 읽으면(`invalid ggml type`) 실행해 보고 읽을 수 있는 빌드를 찾습니다.
3. **없으면 준비합니다** (`src/setup/bootstrap.ts`): 하드웨어 → 엔진 → 모델 → 포트 → 튜닝 → 설정 기록. 이미 있는 엔진·모델은 다시 받지 않습니다.

### 하나의 서버, 하나의 포트 — `/server`·`/models`·`/reset` 의 연동

정책은 한 곳(`src/setup/serverPolicy.ts`)에서 정합니다. 포트 소유자는 `none`/`ours`/`foreign`/`systemd`/`unknown` 으로 분류하고, **외부·systemd·확인 불가 소유자는 절대 종료하지 않으며**
서버가 여러 개면 목록만 보여 줍니다. **우리 서버를 교체하려면 명시적 `confirm`** 이 필요합니다(없으면 바뀔 내용과 실행할 명령만 보이고 서버는 그대로).
확인은 Y/N 대화상자가 아니라 입력하는 단어라서 실수로 Enter 를 눌러도 발동하지 않습니다.

| 명령 | 동작 | 서버를 건드리나 |
|---|---|---|
| `/server` | 포트, pid, 소유자, 실행 중인 모델 vs 설정 모델, 빌드, 이 빌드가 모델을 읽는지 | 아니오 |
| `/server restart` → `/server restart confirm` | 바뀔 내용(모델·빌드·컨텍스트·`--n-cpu-moe`) 표시 후, 같은 포트에서 종료→기동→실제 실행값 기록 | `confirm` 후에만 |
| `/models` | 이 머신 기준 표. 서버가 떠 있으면 판정은 **교체 후** 기준(그 서버의 VRAM 을 돌려받는 것으로 계산, 머리 `판정(교체 시)`) | 아니오 |
| `/models <n>` → `/models <n> confirm` | 선택 기록(`model` 과 `llama.modelPath` 를 함께), 다른 디스크의 기존 복사본 재사용, 다운로드는 `confirm` 후. 새 모델을 읽을 수 있으면 **같은 llama.cpp 빌드**로 모델만 교체 | `confirm` 후에만 |
| `/reset` → `/reset confirm` | 하드웨어에서 정해지는 값이 어떻게 바뀔지 미리보기(쓰지 않음) 후 적용. `/models` 로 고른 모델(파일이 있고 구동 가능)과 KV 예산이 허용하는 이전 컨텍스트는 유지 | 아니오 (적용은 `/server restart`) |

시작할 때 실행 중인 서버의 모델이 설정과 다르면 서버는 그대로 두고 연결하며 불일치를 알려 줍니다.

### 튜닝 (`src/setup/tuning.ts`)

- **컨텍스트**: 모델 헤더에서 KV 비용을 읽을 수 있으면 상한 **98,304**(이 프로젝트가 끝까지 측정한 최대, 모델의 학습 컨텍스트가 더 작으면 그 값). 못 읽으면 크기로 추정해 보수적 **32,768**.
  8,192 미만이면 경고합니다. 설정에 기록된 더 큰 값은 유지합니다(같은 모델일 때).
- **MoE / 밀집**: `--n-cpu-moe` 는 헤더의 `expert_count` 로 MoE 를 판별해 MoE 에만 붙입니다. 밀집 모델은 가중치를 먼저 예약하고, 카드보다 크면 일부 층만 GPU 에 올립니다(`-ngl 999` 아님).
  Apple Silicon 통합 메모리는 별도 VRAM 이 없어 이 계산에서 제외됩니다. CPU 전용은 RAM − 가중치로 KV 를 잡습니다.
- **환경 한도**: 컨테이너/cgroup(`--memory`, `--cpus`, systemd 슬라이스)을 읽어 RAM·코어를 제한합니다(`os.totalmem()` 은 호스트 값).
- **구동 시 보정** (`src/setup/calibrate.ts`): 튜너 값은 산술 예측이라 서버를 띄울 때 실제 메모리로 검증합니다. (1) GPU OOM 이면 `--n-cpu-moe` 를 늘려 최대 3회 재시도,
  (2) 여유가 한 층 + 600 MiB 이상이면 모델·컨텍스트·GPU 당 한 번 층 수를 줄여 시도, (3) 여유가 600 MiB 미만으로 얇으면 늘려 시도 — 실패하면 직전 값으로 복구하고, 결과는
  `llama.cpuMoeLayers`/`llama.calibratedFor` 로 기록되어 튜너가 덮지 않습니다. `LLAMACLI_CALIBRATE=0` 로 (2)(3) 을 끕니다.
  실측(RTX 2070 SUPER, 35B, `-c 98304`): 36→33(하향), 33 유지, 32→33(여유 394→824 MiB), 31 은 OOM 후 재시도.

### 다운로드

- 임시 폴더(`.llamacli-tmp`)에 받아 **게시된 SHA-256 검증을 통과한 뒤에만** 최종 디렉토리로 옮깁니다. 멀티 연결 + 이어받기.
- **서명이 매번 바뀌는 CDN URL 에서도 이어받습니다**(URL 의 서명·만료를 뺀 부분으로 재개 상태를 식별).
- **이미 있는 파일은 크기가 아니라 해시로 판단**합니다 — 같으면 받지 않고, 다르면 새로 받아 검증한 뒤에 교체. 재개 기록이 없는 완전한 `.part` 는 해시로 승격합니다.
- 다른 디스크에 같은 모델이 있으면 그대로 재사용합니다. 공간이 부족하면 여유 있는 마운트를 제안합니다. 실패 시 이유(HTTP 상태, 체크섬, 공간 …)를 표시합니다.
- 진행은 스크롤되지 않는 **한 줄**로 갱신됩니다.

### 지원 환경

엔진은 `stock 사전빌드(CUDA→Vulkan→CPU) → 소스 빌드` 순이며 각 단계를 **실행해서 검증**합니다(실패 이유를 그 자리에서 알림). Linux(glibc; **musl/Alpine 은 사전빌드를 건너뛰고 소스 빌드**),
macOS(Metal, 통합 메모리), Windows(zip 자산 + CUDA 런타임, `winget` 빌드 계획). 빌드 도구 설치는 `apt/dnf/pacman/zypper/apk/brew/winget` 계획을 제시하며 sudo 가 없으면 명령만 출력합니다.
환경변수: `LLAMACLI_LLAMA_SERVER`/`LLAMA_SERVER_BIN`(엔진), `LLAMACLI_MODELS_DIR`, `LLAMACLI_TMP_DIR`, `MODEL_REPO_35B`/`MODEL_REPO_9B`, `LLAMACLI_CPU_MOE_LAYERS`.

## 컴팩션과 체크포인트

- 컨텍스트가 창의 **70%** 에 이르면 요약해 약 35% 수준으로 줄입니다. 70% 인 이유: 한 턴이 더하는 응답 최대 길이가 창의 25% 라서 `트리거 + 25% < 100%` 여야 초과 재시도에 기대지 않습니다
  (0.85 에서는 실제로 89% 까지 올랐습니다). 설정: `compaction.autoTriggerRatio`, `summaryMaxTokens`, `summaryDeadlineMs`(요약 시간 상한), `warmTriggerRatio`(응답을 읽는 유휴 시간에 미리 실행), `autoResume`.
- 도구 호출 사이마다 체크포인트를 `.llamacli/state/` 에 쓰고, 다음 실행에서 이어갑니다(`이전 작업이 있습니다 … 이어서 진행할까요?`). `note` 도구로 남긴 노트는 압축을 거쳐도 유지됩니다.
- 대화 템플릿이 사용자 메시지 없는 대화를 거부하는 모델(Ornith)도 처리합니다.

## 도구·스킬·규칙

- **도구**: `read_file`, `write_file`, `append_file`, `edit_file`, `run_shell`(Windows 에서는 cmd), `note`, `update_plan`, `load_skill`, 브라우저 `browser_list_tabs`/`navigate`/`eval`/`screenshot`.
  브라우저는 사용자가 `--remote-debugging-port` 로 띄운 Chrome 에 CDP 로 **붙기만** 합니다(프로세스를 직접 띄우지 않음, 설정 `browser:`).
- **규칙(항상 시스템 프롬프트에 주입)**: `.llamacli/rules/`, `.clinerules`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`, `.github/copilot-instructions.md` 를 있는 대로 전부 합칩니다
  (`MAX_RULE_PROMPT_CHARS` 32,000 자 예산, 초과분은 표시와 함께 생략). 하나도 없으면 `.llamacli/rules/00-core.md` 를 생성합니다.
- **스킬(트리거 시 지연 로딩)**: `.llamacli/skills/*.md`, `.claude/skills/<name>/SKILL.md`. 내장 스킬: `architecture-design`, `planning`, `implementation`, `code-review`,
  `whitebox-testing`, `blackbox-testing`, `static-analysis`, `security` (프로젝트 파일로 덮어쓸 수 있음).
- **자가 치유**: `src/hermes/selfHeal.ts` 의 회로 차단기가 최근 도구 호출의 거의 동일한 반복(읽기/수정 루프)이나 30분간 완료된 도구가 없는 정체를 감지해 턴을 끊습니다. 모델 호출이 필요 없는 안전망입니다.

## 설정

`.llamacli/config.yaml` (프로젝트별). 주요 키:

```yaml
backend: local-llama            # 또는 openai-compatible (baseUrl, apiKey)
model: /path/to/Ornith-1.5-35B-A3B-Q4_K_M.gguf
llama:
  binPath: ~/llama.cpp/build-opt/bin/llama-server
  modelPath: /path/to/Ornith-1.5-35B-A3B-Q4_K_M.gguf   # model 과 항상 함께 기록됨
  port: 8080
  contextSize: 98304
  threads: 6
  threadsBatch: 11
  gpuLayers: 999
  cpuMoeLayers: 33              # 기록된 값은 측정값으로 취급되어 튜너가 덮지 않음
  calibratedFor: <모델@컨텍스트@GPU>   # 구동 시 보정이 이미 수행됨
  batchSize: 2048
  ubatchSize: 512
  parallel: 1
  flashAttn: true
  cacheTypeK: q8_0
  cacheTypeV: q8_0
compaction: { autoTriggerRatio: 0.7, autoResume: true }
browser: { debugPort: 9222 }
```

`/reset` 은 하드웨어에서 정해지는 값만 다시 계산하고 `apiKey`·`verify`·`browser`·`compaction` 같은 직접 쓴 값은 유지합니다.
자체 업데이트 관련: `LLAMACLI_NO_UPDATE`, `LLAMACLI_FORCE_UPDATE`, `LLAMACLI_UPDATE_MANIFEST_URL`, `LLAMACLI_UPDATE_ARCHIVE_URL`. 테스트용 연결부(기본값 불변):
`LLAMACLI_HF_ENDPOINT`, `LLAMACLI_RELEASES_URL`, `LLAMACLI_DRM_ROOT`.

## 테스트와 검증

단위 테스트 **1,283개**(`npm test`, `node:test` + `tsx`, 추가 프레임워크 없음; Linux 전부 통과). 그 위에 환경별 검증을 얹었습니다. 아래 표의 결과는 **실제로 실행한 값**이고, 실행하지 못한 것은 따로 적었습니다.
`npm run matrix:all` 이 로컬에서 가능한 것을 한꺼번에 돌립니다.

| 방법 | 검증 대상 | 명령 | 결과 |
|---|---|---|---|
| 단위 테스트 | 튜너 불변식, VRAM×RAM 40칸 격자, 카탈로그, 다운로드(재개·해시), 서버 정책, 슬래시 명령 시퀀스, 보정, 클립보드, Windows 형태 경로, CI 환경 처리 | `npm test` | 1,277 / 1,277 |
| **깨끗한 컨테이너 단위 테스트** | llama.cpp·모델·`~/.llamacli` 가 없는 root 컨테이너에서 전체 스위트(내 머신에서만 통과하던 테스트 4개를 찾음) | `npm run matrix:clean-unit` | 1,270 통과, 2 건너뜀 (1,272개 시점) |
| 호스트 매트릭스 | 쉘(bash·dash·busybox), **진짜 cgroup 한도**, 가짜 NVIDIA 4/8/24 GiB·오래된 드라이버·없음, AMD sysfs, Intel(vulkaninfo), 소프트웨어 Vulkan | `node test/containers/run-host.mjs` | 14 / 14 |
| **컨테이너 매트릭스** (podman/docker) | Debian·Ubuntu(일반/sudo/root)·Fedora(zsh)·Arch(fish)·**Alpine(musl)**·dash, `--memory/--cpus`, 가짜 GPU | `npm run matrix:containers` | 21 / 21 |
| 다운로드 시나리오 | 서명이 바뀌는 CDN 모의 서버에서 중단→이어받기, 해시 판정, 같은 크기·다른 바이트 교체 (수정 전 빌드로 돌리면 실패함을 확인) | `node test/containers/download-scenario.mjs` | 6 / 6 (컨테이너 4종·Windows·macOS 에서도) |
| TUI 스모크 (pty) | 실제 CLI 를 `LANG=C`, `TERM=dumb`/`xterm`, 읽기 전용·없는·잘못된 `HOME`, 마우스 끔에서 기동. 8080 이 비어 있으면(깨끗한 머신) 가짜 서버를 띄워 첫 실행 다운로드를 피함. `SMOKE_FRESH=1` 이면 첫 실행 경로 2종 추가 | `python3 test/containers/tui-smoke.py` | 7 / 7 (로컬, **깨끗한 Debian 컨테이너에서도**) |
| 서버 정책, 실제 프로세스 | 미확정 재시작은 pid 유지, 확정은 같은 포트에서 교체, 외부 리스너 보존, 실제 CUDA-OOM 메시지로 보정 재시도 | `npx tsx scripts/live_single_server_check.ts` | 통과 |
| 클립보드 왕복 | 한글+이모지+개행을 앱의 복사 코드로 복사 후 다시 읽기 (개발 머신에서는 클립보드를 저장·복원) | `npm run matrix:clipboard` | Linux·macOS·Windows ✅ |
| 실제 TUI 드래그 | Shift 없는 드래그가 `wl-paste` 로 읽힘 | pty | ✅ |
| **실제 llama-server end-to-end** | Hub 의 1.1 MB GGUF(해시 검증) → GitHub 의 stock 사전빌드를 엔진 사다리로 받아 실행 검증 → 실제 llama-server 기동 → `/health` → 채팅 응답 → 종료·포트 해제 | `node test/e2e/real-server.mjs` | Linux(CPU) 7/7 (로컬·CI) · Windows(CPU) 7/7 · macOS(**Metal**) 7/7 (CI) |
| 실제 GPU·모델 | RTX 2070 SUPER + Ornith-35B, `-c 98304` 에서 보정(36→33, 33 유지, 32→33, 31 은 OOM 후 재시도) | 수동 | ✅ (사용자 서버를 허락받고 내렸다가 복구) |

### CI (GitHub Actions)

| 워크플로 | 러너 | 검증 | 최근 결과 |
|---|---|---|---|
| `windows.yml` | `windows-latest` (NT 10.0.26100, 4코어, 16 GiB) | 배포 `bin/` 을 pwsh·Windows PowerShell·cmd·Git-Bash 에서: GPU 없음, CPU 사다리, `winget`; 다운로드; PowerShell 클립보드; **실제 llama-server e2e**; **ConPTY 에서 실제 TUI 스모크 4/4**; 단위 테스트 | 프로브 4/4, 다운로드 6/6, 클립보드 ✅, 단위 **1,271 통과 / 6 건너뜀(Windows 에 해당 없음) / 0 실패** (총 1,277) |
| `macos.yml` | `macos-14` (Apple M1, 가상) | zsh·bash·sh 프로브 → **Metal**, `brew`, `-ngl > 0`; 다운로드; `pbcopy`; **실제 llama-server(Metal) e2e**; **pty 에서 실제 TUI 스모크 4/4**; 드래그 복사 | 프로브 3/3, 다운로드 6/6, `pbcopy` ✅ |
| `linux.yml` | `ubuntu-latest` | `tsc`, 단위 테스트, 빌드, 호스트·컨테이너 매트릭스, TUI 스모크(`CI=true` 변형 포함), Xvfb+`xclip` | **전 단계 통과** — 단위 1,277 / 1,277, 호스트 매트릭스, 다운로드, TUI 스모크, 컨테이너, X11 클립보드 |

CI 가 찾은 결함은 Linux 단위 테스트로는 볼 수 없던 것들입니다: `CI=true` 환경에서 TUI 가 아예 그려지지 않던 것(Ink 의 CI 모드), Windows 에서 모델 경로를 `/` 로만 잘라 이름이 전체 경로로 나오고 같은 모델의 다른 양자화 재사용이 실패했고,
Apple Silicon 이 `-ngl 0`(CPU 전용)으로 튜닝되고 있었습니다. 둘 다 수정했고 테스트가 있습니다.

### 검증하지 못한 것

- Windows 의 **GPU**(CUDA/Vulkan)와 로컬 한 장(RTX 2070 SUPER) 외의 실제 GPU. Windows·macOS 의 실제 llama-server 기동은 이제 CPU/Metal 빌드로 확인됨(위 표) — 큰 모델·GPU 오프로드는 아님.
- Windows Terminal·conhost·Terminal.app·iTerm2 **앱 자체**에서의 TUI(러너는 ConPTY/pty 로 구동하므로 그 아래층까지만), `winget` 설치.
- Windows 에서 건너뛰는 단위 테스트 6개는 해당 없는 동작입니다(`/media`·`/mnt` 마운트 2, POSIX 사용자 공간 cmake 1, 실행 권한 비트 2, 심볼릭 링크 1). 예전에 건너뛰던 44개는 이제 실행됩니다 — 경로·`.exe` 이름을 OS 에 맞게 정규화하고(`src/testSupport.ts`), Windows 에서도 실제로 실행되는 가짜 llama-server(Node 단일 실행 파일, `postject`)를 써서.
- 컨테이너 이미지에는 설정 모듈만 있고 TUI 의존성은 없습니다(TUI 는 호스트 pty 로만 검증). WSL, Wine(`test/windows/wine-check.sh` 는 있으나 미실행), 실제 Vulkan/ROCm 하드웨어.

## 제거된 기능

| 제거됨 | 무엇이었나 | 왜 |
|---|---|---|
| `/fastcheck` (laya 게이트) | 매 턴 전에 두 번째 모델로 추론 예산을 고르고 턴을 값싼 모드로 낮출 수 있었음 | 라벨된 프롬프트 집합에서 합의율 67%, 판정자가 피하려던 모델과 같은 모델 |
| `/improve`, `/improve-apply` | 실패 로그로 규칙 초안을 만들어 `.llamacli/rules/` 에 저장 | 시스템 메시지(압축으로 줄지 않음)가 무한히 커졌고, 실패마다 모델 호출 1회를 썼음. 대신 규칙 주입에 글자 예산을 둠 |
| Bonsai / PrismML fork | 삼항 양자화 모델 + fork 의 다운로드/컴파일 | 확정 모델이 stock llama.cpp 의 Ornith 라서 요청으로 제거. 실행으로 확인하는 호환 프로브와 stock 엔진 사다리는 유지, 측정 기록은 `docs/` 에 보존 |
| 드래그 가장자리 자동 스크롤 | 드래그를 로그 가장자리에 대면 로그가 스크롤 | 요청으로 제거. 드래그 선택·복사는 그대로, 긴 구간은 버튼을 누른 채 휠 |

## 문서

- [`PROMPT.md`](./PROMPT.md) 설계 배경 · [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) · [`MIGRATION_CHECKLIST.md`](./MIGRATION_CHECKLIST.md)
- 모델: [`docs/model-bench-2026-10-03.md`](./docs/model-bench-2026-10-03.md), [`docs/coding-eval-2026-10-03.md`](./docs/coding-eval-2026-10-03.md), [`docs/compaction-latency-research-prompt.md`](./docs/compaction-latency-research-prompt.md)
- 설치·서버 정책: [`docs/first-run-provisioning-prompt.md`](./docs/first-run-provisioning-prompt.md)·[`-report.md`](./docs/first-run-provisioning-report.md),
  [`docs/provisioning-matrix-and-single-server-prompt.md`](./docs/provisioning-matrix-and-single-server-prompt.md)·[`provisioning-matrix-report.md`](./docs/provisioning-matrix-report.md)
- 환경 검증: [`docs/container-matrix-validation-prompt.md`](./docs/container-matrix-validation-prompt.md), [`docs/container-matrix-report.md`](./docs/container-matrix-report.md), [`docs/multienv-acceptance-prompt.md`](./docs/multienv-acceptance-prompt.md)
- 이전 README(날짜별 구현 기록·페르소나/프로젝트 검증 로그 포함): [`docs/history/README-legacy-2026-10-03.md`](./docs/history/README-legacy-2026-10-03.md)
