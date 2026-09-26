# `/fastcheck on` 설치/기동 자동화 — 완료 보고 검증 결과: 아직 버그 2개 남음

`scripts/laya_integration.py` + `scripts/_laya_install_helpers.py` +
`src/index.tsx`/`src/agent/loop.ts`를 검토하고 실제로 재현했습니다.
"완료됐다"고 하기엔 이른 상태입니다 — 아래 두 개는 실측으로 확인된 실제
버그입니다.

## 버그 1: `/fastcheck on`이 항상 실패함 (재현 확인)

`src/index.tsx`의 `/fastcheck on` 핸들러가:

```ts
await runLayaScript(["enable"]);
await runLayaScript(["fastcheck"]);   // <- --text 없이 호출
```

그런데 `scripts/laya_integration.py`의 `fastcheck` 서브커맨드는
`--text`가 **required**입니다:

```python
p_cmd.add_argument("--text", required=True, metavar='"user text"')
```

직접 실행해서 확인:

```
$ python3 scripts/laya_integration.py fastcheck
usage: fastcheck [-h] --text "user text" [--config CONFIG]
fastcheck: error: the following arguments are required: --text
exit: 2
```

즉 `/fastcheck on`을 실행하면 이 두 번째 호출이 **항상 exit 2로 즉시
실패**하고, index.tsx의 catch 블록이 `[laya error] laya script exited
with code 2`만 띄웁니다 — 의도했던 "설치/기동 진행상황 표시"는 이 경로로는
절대 도달하지 못합니다.

**수정 방향**: install/boot만 트리거하고 실제 판정은 필요 없는 이
호출에는 `--text`에 더미 텍스트(예: `"(startup check)"`)를 넘기거나,
`cmd_fastcheck`/`fastcheck` 서브커맨드에 `--text`를 옵션으로 바꾸고
없을 때는 install/boot만 하고 판정은 건너뛰도록 분기하세요.

## 버그 2: 설치/기동 진행상황이 실제로는 화면에 안 뜸

같은 핸들러에서 `runLayaScript(["fastcheck"])`의 반환값(`stdout`)을
**아예 안 받고 버립니다** — 변수에 담지도, `pushStatus`로 보내지도
않습니다:

```ts
await runLayaScript(["fastcheck"]);   // 반환값 무시
runtimeEnabled = true;
```

주석에는 "surfaces install/boot progress + success via pushStatus"라고
써있지만, 실제 코드에는 그 pushStatus 호출이 없습니다. 버그 1이 고쳐져서
이 호출이 성공하더라도, 지금 상태로는 설치/기동 로그가 사용자에게
전혀 안 보입니다.

**수정 방향**: `const { stdout } = await runLayaScript(["fastcheck"]);` 로
받아서 `ui?.pushStatus(stdout)` (또는 진행상황 라인만 골라서) 화면에
띄우세요.

## 요청

1. 위 두 버그를 고치세요.
2. 실제로 `/fastcheck on`을 라이브로 실행해서 (a) exit 2 에러가 안
   뜨는지, (b) 설치/기동 진행 라인이 화면에 실제로 보이는지 둘 다
   재현 검증하세요 — 이번엔 코드 리뷰만이 아니라 실제 실행 결과로
   확인해주세요.
3. 검증되면 다시 알려주세요 — 제가 typecheck/전체 테스트/빌드까지
   확인한 뒤 커밋하겠습니다.
