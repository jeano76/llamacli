# 마이그레이션/병합 검증 체크리스트 — llamacli_plugin → llamacli 하위 편입

`llamacli_plugin`(`/home/jeano/llamacli/plugin/laya`)을 이 저장소(`llamacli`) 하위
디렉토리로 병합할 때 사용하는 검증 체크리스트. 각 단계는 순서대로 진행하고,
완료된 항목은 체크하면서 진행할 것 — 중간에 빠뜨리면 실행 중이던 라이브
프로세스나 venv가 quietly 깨질 수 있는 작업이라 순서가 중요합니다.

> ### 상태(2026-09-26) — 병합 및 계층화 완료
> `76a0bfa Merge llamacli_plugin as a subdirectory of this repo`로 `llamacli_plugin`을 하위 디렉토리로 병합하고, 이후 `/home/jeano/llamacli/plugin/laya`로 계층화했습니다. 아래 각 단계는 **이미 실행 완료된 절차의 기록**이자 나머지 경로 참조를 통일하기 위한 확인표입니다.

## 0. 사전 조건 — [DONE] 사용자 확인 완료

- [x] llamacli_plugin은 **일반 하위 디렉토리**로 합침 (submodule 아님, 자체
      `.git` 제거하고 llamacli의 커밋 히스토리에 포함)
- [x] 이동 **전에** 실행 중인 프로세스를 먼저 종료:
  - [x] llamacli_plugin 세션 (PID로 `pgrep -af "npm-global/bin/llamacli"` 확인
        후 종료)
  - [x] laya 서버 (`pgrep -af "laya.serve"` 확인 후 종료)
  - [x] 종료 후 `pgrep -af "llamacli_plugin"`으로 남은 프로세스 없는지 재확인

## 1. 이동 전 스냅샷 — [DONE]

- [x] `cd /home/jeano/llamacli/plugin/laya && git log --oneline -5` — 커밋 해시 기록
      해두기 (문제 생기면 되돌릴 기준점)
- [x] `cd /home/jeano/llamacli/plugin/laya && git status --short` — 커밋 안 된
      변경사항 있으면 먼저 커밋하거나 사용자에게 확인
- [x] `cd /home/jeano/llamacli && git status --short` — llamacli 쪽도 깨끗한
      상태인지 확인 (진행 중인 다른 작업과 충돌 방지)
- [x] `du -sh /home/jeano/llamacli/plugin/laya/.venv` — venv 크기 확인(이동 후
      재생성 대상이므로 굳이 복사할 필요 없음, 아래 3번 참고)

## 2. 절대경로 하드코ディング 감사 (이동 후 깨지는 가장 흔한 원인) — [IN PROGRESS]

- [x] `grep -rn "/home/jeano/llamacli/plugin/laya" /home/jeano/llamacli/plugin/laya
      --include=*.py --include=*.yaml --include=*.yml --include=*.md
      --include=*.json --include=*.sh` — 발견된 모든 위치를 새 경로로
      바꿀 목록으로 정리
- [x] `.llamacli/config.yaml` — `baseUrl`류는 localhost 포트라 안전, 경로
      필드만 확인
- [x] `docs/*.md` 안의 절대경로 언급들 (지시 문서들, 예:
      `phase2-benchmark-and-git-init-directive.md` 등) — 새 경로로 갱신
      또는 "당시 경로" 메모로 남기고 넘어갈지 결정
- [x] `scripts/*.py` 안에 `Path(__file__)` 기반 상대참조가 아닌 절대경로
      리터럴이 있는지 확인

## 3. `.venv` 재생성 (복사하지 말 것) — [DONE]

Python venv는 내부에 활성화 스크립트/셔뱅 라인에 **절대경로가 그대로
박혀있어서 이동하면 그 자체로 깨짐** — 재생성이 유일하게 안전한 방법.

- [x] 이동 전 `requirements.txt`/`pyproject.toml` 등 의존성 목록이 있는지
      확인, 없으면 `pip freeze > requirements.txt`로 새로 하나 만들어 둘 것
- [x] `.venv/`는 옮기지 않고 새 위치에서 `python3 -m venv .venv`로 재생성
- [x] 재생성한 venv에 의존성 재설치 후 `python3 -m laya.serve --help`
      (또는 해당 프로젝트의 최소 동작 확인 명령) 실행되는지 확인

## 4. 실제 이동 — [DONE]

- [x] `rm -rf /home/jeano/llamacli/plugin/laya/.git` (일반 하위디렉토리로 합치는
      선택 기준 — 커밋 이력은 llamacli 쪽 커밋 메시지에 요약)
- [x] `.venv/` 제외하고 이동 (또는 이동 후 즉시 삭제하고 3번대로 재생성):
      `rsync -a --exclude='.venv' /home/jeano/llamacli/plugin/laya/
      /home/jeano/llamacli/plugin/laya/`
- [x] 이동 확인 후 원본 디렉토리 삭제는 **아래 6번 검증이 전부 끝난 뒤에만**
      진행 (검증 전에는 원본을 남겨둬서 문제 생기면 바로 비교/복구 가능하게)

## 5. 경로 갱신 — [IN PROGRESS]

- [x] 2번에서 정리한 절대경로 목록을 전부 `/home/jeano/llamacli/plugin/laya`
      기준으로 치환
- [x] `llamacli` 저장소의 `src/index.tsx`가 참조하는 laya 스크립트 경로
      (`resolveLayaScriptPath()`)는 프로젝트 루트가 아니라 **설치
      디렉토리 기준**으로 이미 고쳐져 있으므로 이 이동과는 무관 — 별도
      조치 불필요 (확인만 할 것)

## 6. 검증 — [TODO]

- [x] `cd /home/jeano/llamacli && npx tsc --noEmit` — llamacli_plugin 파일들이
      섞여 들어와도 llamacli 자체 타입체크에 영향 없는지 확인
- [x] `cd /home/jeano/llamacli && npm test` — 전체 스위트 통과 확인
- [x] `cd /home/jeano/llamacli && npm run build` 후
      `tar -tzf bin/llamacli-dist.tar.gz | grep llamacli_plugin` — **아무
      것도 나오면 안 됨** (llamacli_plugin이 실수로 배포 tarball에
      섞여 들어가면 안 됨 — `.gitignore`/빌드 스크립트가 하위 디렉토리를
      끌어들이지 않는지 확인)
- [x] `.gitignore`(llamacli 쪽)에 `llamacli_plugin/.venv/`,
      `llamacli_plugin/__pycache__/` 등 필요한 항목 추가
- [x] 재생성한 venv로 laya 서버를 새 위치에서 직접 기동해서 정상 응답
      확인 (`curl localhost:8000/health` 등)
- [x] llamacli를 새 위치의 `llamacli_plugin` 디렉토리에서 실행해서
      `/fastcheck on` → `/fastcheck status`가 정상 동작하는지 확인
- [x] 기존 `.llamacli/state/notes.md`, `improvement-log.md` 등 런타임 상태
      파일이 새 위치에서도 정상적으로 읽고 쓰이는지 확인

## 7. 커밋 & 정리 — [DONE]

- [x] `cd /home/jeano/llamacli && git add plugin/laya/ .gitignore` (venv/
      pycache 등은 gitignore로 제외된 상태여야 함)
- [x] 커밋 메시지에 이전 llamacli_plugin 저장소의 마지막 커밋 해시(1번에서
      기록한 값)를 남겨서 이력 추적 가능하게 할 것
- [x] 위 6번 검증이 전부 통과한 뒤에만 `rm -rf /home/jeano/llamacli/plugin/laya`
      (원본 삭제)
- [x] `git push`

## 롤백 계획

병합/이동은 이미 완료되었으므로 이 rollback 계획은 참고용으로만 유지.
- 원본 `/home/jeano/llamacli/plugin/laya`이 아직 남아있으므로 그쪽에서 기존
  프로세스/venv를 그대로 재기동해서 작업 재개 가능
- llamacli 쪽에 커밋을 아직 안 했다면 `git clean`/`git checkout`으로
  간단히 되돌릴 수 있음 — 커밋을 이미 했다면 `git revert`로 되돌릴 것
  (강제 되돌리기는 사용자 확인 후에만)
