# 정정: [03:20] 기록의 두 판단이 틀렸습니다 — 재확인부터 하세요

`before-after-validation.md` Phase 0/2를 시작하기 전에 먼저 두 가지를 바로잡습니다.
아래 두 주장 모두 **사실이 아님을 직접 확인**했습니다 — 이 전제로 "Phase 2는 no-op"
같은 결론을 내리지 말고, 재확인 후 실제 측정으로 넘어가세요.

## 1. `trace` 서브커맨드는 존재합니다

```
$ python3 scripts/laya_integration.py --help
{gate,fastcheck,onboard,status,enable,disable,trace} ...
    trace    evaluate a tool-call result after it runs
```

`cmd_trace`(766번째 줄), 파서 등록(`p_tr = sub.add_parser("trace", ...)`, 1007번째
줄) 둘 다 파일에 실제로 있고, `--help` 출력에도 정상적으로 나타납니다. 오늘 새벽에
완성·검증(테스트 20개, 크래시 2건 수정)했던 그 구현이 그대로 남아있습니다 — 유실되지
않았습니다.

`index.tsx`의 `runLayaTrace()`가 `["trace", "--tool", "run_shell", "--summary",
output]`으로 호출하는데, 이게 "exit 2로 실패한다"고 판단했다면 — 왜 그런 결과가
나왔는지(인자 순서, cwd, python 경로 등) 실제로 재현해서 다시 확인하세요. 명령 자체가
없는 게 아닙니다.

## 2. `config.yaml`에 `laya:` 블록이 있고, `enabled: true`입니다

```yaml
backend: openai-compatible
model: /media/jeano/nvme-usb/models/Ornith-1.5-35B-A3B-Q4_K_M.gguf
baseUrl: http://127.0.0.1:8080
laya:
  enabled: true
  baseUrl: http://127.0.0.1:8000
  minSwapKb: 1000
  minRamKb: 1000
```

(이건 오늘 세션에서 직접 세팅해둔 그대로입니다 — 8391/8000 이중 기동 정리, 백엔드
baseUrl 8081→8080 수정 등을 거친 최종 상태.) laya 서버(`:8000`)도 지금
`english`/`multilingual`/`typed-decisions` 세 체크포인트 전부 로드된 채로 살아있는
상태입니다.

## 추가 확인: "Phase 2가 no-op"이라는 관찰 자체는 맞았습니다 — 원인만 다릅니다

실제로 `trace`를 직접 실행해서 재현했습니다:

```
$ python3 scripts/laya_integration.py trace --tool run_shell --summary "exit=0, output: hello world"
[laya] skipped (free swap 196kB below required 1000kB)
$ echo $?
0
```

명령은 정상 존재하고 정상 종료(exit 0)합니다 — 하지만 **`resource_gate_ok()`의 스왑
여유 체크(`minSwapKb: 1000`)에 매번 걸려서 laya 호출 자체를 조용히 건너뜁니다.**
`status` 서브커맨드로도 확인됨:

```json
{"enabled": true, "installed": false, "running": true,
 "swapFreeKb": 204, "ramFreeKb": 11878744, ...}
```

**RAM은 11.8GB나 여유 있는데, 스왑만 204KB로 바닥**입니다 (오늘 낮 OOM 사고 이후 계속
회복이 안 되고 있는 그 상태 그대로). 즉 "trace가 no-op"이라는 결론 자체는 맞았는데,
원인이 "명령이 없어서"가 아니라 **"시스템 스왑이 만성적으로 꽉 차 있어서 안전장치가
매번 막는 것"**이었습니다.

### 이걸 어떻게 처리할지 판단이 필요합니다

- **A안**: 지금 이대로 Phase 2를 측정하면 "게이트가 항상 스킵함"이라는 결과 자체가
  유효한 측정치입니다 — `resource_gate_ok()`가 RAM은 안 보고 스왑만 보는 게 이 시스템
  환경(스왑은 상시 포화, RAM은 여유)에 안 맞을 수 있다는 걸 **있는 그대로 보고**하세요.
- **B안**: 스왑이 아니라 RAM도 같이(또는 RAM만) 기준으로 삼도록 `resource_gate_ok()`
  임계값 판단 로직을 조정한 뒤 측정 — 단, 이건 "측정" 범위를 넘어서는 코드 변경이니
  진행 전에 먼저 알려주세요.

둘 중 하나로 정하고, `before-after-validation.md`의 Phase 0/2를 마저 진행하세요.
