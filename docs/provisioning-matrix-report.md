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

## 4. 합성으로만 검증했고 실환경에서는 하지 않은 것

- 위 시퀀스는 가짜 `switchServer`/`PortOwner` 주입 테스트다. **실제 llama-server 를 띄워 pty+pyte 로 `/server restart` → `confirm` 을 돌려보지 않았다.** (사용자의 8084 서버를 건드리지 않기 위해 별도 포트 테스트 서버가 필요하며, 이번 턴에서는 하지 않았다.)
- `/models <n>` 의 게이트 **배선**은 `index.tsx` 안에 인라인이라 명령 시퀀스 테스트(C2, C3, C8, C12, C13)가 없다. 게이트 함수 자체만 테스트됨.

## 5. 남은 일 (미완)

1. §5 의 24행 프로파일 중 `profiles.test.ts` 가 다루는 것은 기존 8행뿐 — 나머지 확장 안 함.
2. 시작 시(bootstrap) 실행 중 서버가 설정과 다른 모델일 때: 현재는 **그냥 연결(adopt)** 하고 차이를 알리지 않는다(R4.2 의 "다르면 확인" 미구현). `/server` 에서 불일치는 보이지만 시작 시 안내는 없다.
3. `/reset confirm` 은 적용 **후**에 diff 를 보여준다(사전 미리보기 없음). 서버는 건드리지 않으므로 안전하지만 R6 의 "diff 후 확인"과는 다르다.
4. R1(실행 검증 사다리, CUDA 불가 시 이유 안내), R2(최소 컨텍스트 경고), R3(바꿔치기 금지 표시), R5 는 전수 감사 미실시.
5. `/models` 로 서버를 교체하는 도중 실패 시 config 부분 기록(C15) 점검 안 함.
