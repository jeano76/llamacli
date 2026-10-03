# 구동 매트릭스 / 단일 서버 정책 — 감사·구현 보고 (1차)

기준 문서: `docs/provisioning-matrix-and-single-server-prompt.md`. 이 보고서는 **R4(단일 서버·확인)와 R6(명령 연계)** 를 먼저 처리한 1차 결과이며, R1~R3·R5 의 전수 감사와 §5 의 24행 프로파일 확장은 **아직 하지 않았다**(아래 "남은 일").

## 1. 감사로 찾은 결함 (코드 근거)

| # | 결함 | 근거 | 조치 |
|---|---|---|---|
| D1 | `/server restart` 가 확인 없이 실행 중 서버를 종료·재기동 | 구 `src/index.tsx` `case "server"` → `switchModelAndServer` 직행 | `serverPolicy.gateServerReplacement` + `/server restart confirm` 2단계 |
| D2 | `/models <n>` 이 다운로드만 `confirm` 을 요구하고, 서버 교체는 확인 없이 종료 | `case "models"` 의 `confirmed` 는 `!presentOnDisk` 에만 사용 | 서버가 떠 있으면(ours) `confirm` 필수; 선택은 config 에 기록 |
| D3 | 서버가 2개 이상이어도 첫 번째만 대상으로 동작 | `resolveLiveServerPort` 가 `servers[0]` 선택 | 정책이 목록 표시 후 거부(자동 정리 금지); `ServerReport.servers` 추가 |
| D4 | `/reset confirm` 이 `/models` 로 고른 모델을 하드웨어 기본값으로 덮어씀 | `bootstrap.ts` 의 `force` 가 `keepUserOwnedKeys` 로 model 을 버림 | `keepSelectedModelOnReset`: 파일이 있고 구동 가능하면 유지, 못 돌리면 버리고 diff 로 드러남 |
| D5 | `/reset` 안내문에 오타 문자(`获取`)·"llamacli 를 재시작" 안내가 서버 정책과 어긋남 | `index.tsx` | 문구 수정: 서버는 건드리지 않고 `/server` → `/server restart` |

## 2. 구현 (이번 변경)

- `src/setup/serverPolicy.ts` — 서버 교체 허용 여부의 **단일 판정점**: 다중 서버 거부 / foreign·systemd·unknown 불가침 / 빈 포트는 즉시 시작 / ours 는 `confirm` 필요. `diffServer` 로 변경 내용(모델·빌드·컨텍스트·`--n-cpu-moe` 등) 표시.
- `src/setup/serverCommand.ts` — `/server restart [confirm]` 을 TUI 밖에서 테스트 가능한 함수로 추출.
- `index.tsx` — `/server`, `/models` 가 같은 게이트를 사용. 명령 쪽에 포트 판별·프로세스 종료 로직 없음(`grep`: `process.kill`/`pgrep` 0건, `findOwnLlamaServerPids` 는 VRAM 추정 용도만).
- 확인 방식: Y/N 대화상자 대신 **명시적 `confirm` 단어**(`/reset confirm` 과 같은 이유 — 우발적 Enter 로 발동 불가, 새 UI 불필요). 비대화형에서도 자연히 "미확정=무변경" 이다.

## 3. 테스트 (신규 17개, 전체 1152 통과)

- `serverPolicy.test.ts` (6): 빈 포트 / ours 무확인·확인 / foreign·systemd·unknown(confirm 이어도 불가) / 다중 서버 / diff.
- `serverCommand.test.ts` (8): C4(확인 없으면 `stop` 0), C5(확인 시 switch→record→sync 한 번, 라이브 포트), 빈 포트 무확인 시작, C10(foreign), C14(다중), C11(못 읽는 빌드), 모델 없음, 시작 실패 시 record/sync 생략.
- `bootstrap.test.ts` (3): `/reset` 이 선택 모델을 유지 / 파일 없으면 폐기 / 구동 불가 카탈로그 모델 폐기.

## 4. 2차 구현 (남은 일 처리)

| 항목 | 처리 |
|---|---|
| 시작 시 서버/설정 모델 불일치 (R4.2) | `bootstrap.ts` 연결(adopt) 분기에서 모델이 다르면 서버는 건드리지 않고 `서버/설정 불일치` 단계로 알림 (`/server`→`/server restart` 안내). 테스트 2개 |
| `/reset` 사전 미리보기 (R6) | `resetPreview.ts`: 같은 `tuneForHardware`+`describeReset` 로 **적용 전** 바뀔 항목을 표시(아무것도 쓰지 않음). 테스트 2개 |
| `/reset` 이 직접 키운 컨텍스트를 32,768 로 깎는 문제 (미리보기로 발견) | 이 머신 KV 예산이 지원하면 이전 컨텍스트 유지, 못 버티면 줄이고 이유 표시 (`reapplyContext`). 테스트 3개. 사용자 머신(8 GiB, Ornith) 계산: 기본 상한 32,768 vs KV 예산 ≈ 471k |
| `/models` 게이트 배선 테스트 | `gateModelSwitch` 를 `serverCommand.ts` 로 추출 → C2·C3·C4·C5(선택→불일치→미확정 무변경→확정 반영) 시퀀스 테스트, C15(쓰기 실패 전파) |
| §5 프로파일 확장 | `profiles.test.ts` +8행(4GB, 24GB/RAM 8, AMD 16, Intel Arc(vulkaninfo), Windows CPU, Windows 8GB, Mac 16, sudo 없음) — 총 16행. `matrix.test.ts`: VRAM{0,4,6,8,12,16,24,48}×RAM{4,8,16,32,64} 40셀 불변식(밀집엔 `--n-cpu-moe` 없음, 35B 는 RAM≥24, GPU 없으면 CPU, 컨텍스트 4096~32768, 큰 모델엔 경고) |
| R1: 가속 빌드가 실행 안 될 때 이유 안내 | 사다리 중간 실패를 **그 시점에** 로그(전부 실패할 때만 나오던 것을 수정). 테스트 1개 |
| R2: 컨텍스트 하한 경고 | 8192 미만이면 `⚠` 사유 추가. 테스트 1개 |
| 실환경 검증 | `scripts/live_single_server_check.ts`: 실제 프로세스(가짜 llama-server, argv0=llama-server)로 미확정 재시작=pid 유지 / 확정=같은 포트에서 새 pid·새 모델·옛 pid 종료 / foreign 리스너는 확정에도 생존. **통과** (사용자의 8080 서버는 목록에 넣지 않았고 그대로임을 확인) |

발견된 사실: Intel Arc 는 sysfs VRAM 카운터가 없어 `vulkaninfo` 로만 발견되며 VRAM 을 모른다(0) — 그래서 모델은 9B 로 보수적으로 고른다. 현재 동작을 프로파일 행으로 고정했다.

## 5. 아직 하지 않은 것 (정직하게)

1. **실제 llama.cpp 바이너리 + 실제 GPU 모델로 한 end-to-end 는 안 했다.** 실환경 검증은 가짜 llama-server 로 프로세스 정책(종료·교체·포트·foreign)만 확인했다. 사용자 8080 서버가 8 GiB GPU 를 쓰고 있어 실제 모델을 별도로 띄울 수 없었다.
2. **TUI(pty+pyte) 에서 슬래시 명령을 직접 친 검증은 안 했다.** 명령 로직은 함수로 추출해 테스트했지만 `index.tsx` 의 연결부(문자열 파싱 `restart confirm`, 출력)는 타입 검사와 코드 리뷰로만 확인했다.
3. §5 의 24행 중 Windows/WSL **쉘(PowerShell/cmd/Git-Bash/WSL) 구분** 은 `platform` 수준만 검증 — 쉘별 경로·따옴표 처리는 이 머신에서 실행할 수 없어 합성 근거도 약하다. WSL 은 별도 분류가 없다(linux 로 취급).
4. 디스크 부족/해시 불일치/이어받기(§5 #20~22)는 기존 `disk`·`downloadVerify`·`downloadResume` 테스트가 다루며 이번에 새로 감사하지 않았다.
5. ~~첫 설치 컨텍스트 상한 32,768~~ → **처리함**: 헤더에서 KV 를 정확히 읽을 수 있으면 상한 98,304(측정된 값; 학습 컨텍스트가 더 작으면 그 값), 못 읽으면 32,768 유지. 상한을 올리자 드러난 두 결함도 함께 수정: (a) 밀집 모델은 가중치 몫을 먼저 예약, (b) VRAM 보다 큰 밀집 모델이 `-ngl 999` 를 받던 문제 → 층 수 부분 오프로드. 실제 Ornith-1.5-35B-A3B 헤더로 확인: 학습 컨텍스트 262,144, 이 머신(8 GiB) 계산값 98,304 / `--n-cpu-moe` 32.
