# llamacli 컴팩션 지연시간 최소화 연구 프롬프트

> 이 문서는 **에이전트에게 주는 실행 지시문**입니다. 그대로 넘기면 됩니다.
> 대상 저장소: `/home/jeano/llamacli` (또는 동급 clone)
> 작성 기준일: 2026-10-02 · llama.cpp `633733d`

---

## 0. 이 문서의 목적

llamacli의 **메모리 컴팩션이 사용자에게 보여주는 대기시간**을 최소화하는 방법을
연구한다. 백엔드는 llama.cpp (`llama-server`) 와 vLLM 양쪽을 모두 대상으로 한다.

여기서 "지연시간"의 정의는 명확해야 한다.

> **사용자가 "[compaction] ..." 상태줄을 본 뒤 다음 입력 가능해질 때까지의 시간.**
> 백엔드 내부 처리 시간만이 아니라, 그 시간 동안 UI 가 얼마나 빨리 다음
> 입력을 받는지도 포함한다.

이 구분이 왜 중요하��지는 §1.4 에서 다룬다. 결론부터 말하면, **"백엔드가 빨리
끝내라"와 "사용자가 기다리지 마라"는 서로 다른 문제이고, 해법도 다르다.**

---

## 1. 이미 측정된 사실 — 이것을 다시 측정하지 마라

아래는 2026-10-02 에 이 머신에서 실측한 값이다. 재현 스크립트는
`/tmp/opencode/compact_bench.ts`, `/tmp/opencode/compact_io_bench.ts` 에 남아 있다.
**가설을 세우기 전에 반드시 이 숫자들과 대조하라.**

### 1.1 지연시간의 구성 (28,820 토큰 히스토리, 라이브 서버 대조)

| 구간 | 소스 | 실측 |
|---|---|---|
| `selectKeptTail` | `compaction/compactor.ts:349` | **0.11 ms** |
| `sanitizeForSummary` | `compaction/compactor.ts:271` | **0.13 ms** |
| 요약 크기 산정 + 입력 트리밍 | `compaction/compactor.ts:498-514` | **0.25 ms** |
| `messageText()` 전체 재구축 | `compaction/compactor.ts:58` | **0.01 ms** |
| `postCompactionBudget` — `POST /apply-template` | `agent/loop.ts:1533` | **3.3 ms** |
| `postCompactionBudget` — `POST /tokenize` | 동일 | **1.2 ms** |
| `writeCheckpoint` × 2 (8.1 KiB) | `compaction/checkpoint.ts` | **0.2 ms** |
| **`backend.chat()` 요약 생성** | **`compaction/compactor.ts:568`** | **~27,000 ms** |

**async로 겹칠 수 있는 작업량의 총합은 5.6 ms / 27,000 ms = 0.02% 다.**

→ **계산 최적화·I/O 병렬화·비동기화로 얻을 수 있는 상한이 0.02% 임이 증명되었다.**
이 방향으로 시간을 쓰지 마라. 대신 §4 의 트랙을 따라라.

### 1.2 decode 가 전부다

`compaction/compactor.ts:448-462` 에 이미 실측치가 있다.

```
prefill   334 tok/s   decode  38 tok/s
메인 턴      7,244 프롬프트 토큰   75.9 s
컴팩션          22 프롬프트 토큰   40.8 s   <- prefill 은 prompt cache 로 ~0.3 s
```

요청 22 토큰에 40.8 초. 요약 프롬프트는 직전 턴의 **verbatim prefix** 라
llama-server의 prompt cache 가 전부 서빙한다 (`compactor.ts:531-534` 의 캐시 prefix
수정이 그 이유다). **prefill 은 이미 사실상 0 이고, 지연은 100% decode다.**

→ **prefill 관련 최적화(prefix cache, APC, 템플릿 경량화)는 지연시간을 줄이지 못한다.**
vLLM 문서도 APC 에 대해 "only reduces the time of processing the queries (the
prefilling phase) and does not reduce the time of generating new tokens" 라
명확히 단언한다. 이건 후면 지지다.

### 1.3 llama.cpp `-np` / 컨텍스트의 실제 의미 (소스 검증됨)

```
src/llama-context.cpp:294   cparams.n_ctx_seq = cparams.n_ctx / cparams.n_seq_max;
common/common.cpp:1722      cparams.n_seq_max  = params.n_parallel;
common/common.h:573         bool kv_unified = false;        // ← 기본값
tools/server/server-context.cpp:4027  n_ctx_slot() = llama_n_ctx_seq(ctx_tgt)
tools/server/server-context.cpp:4606  {"n_ctx", meta.slot_n_ctx}   // ← /props 는 per-slot
```

- `-c` 는 **슬롯 전체 합계**다. `-np 2 -c 40960` → 슬롯당 20480.
- `/props` 의 `default_generation_settings.n_ctx` 는 **per-slot** 값이라
  `openaiClient.ts` 의 `getContextSize()` 는 자동으로 따라간다. (버그 아님)
- 라이브 서버 로그 실증: `load_model: initializing, n_slots = 1, n_ctx_slot = 40960, kv_unified = 'false'`

**KV 캐시 용량:**
```
src/llama-model.cpp:2600   /* attn_kv_size */ cparams.n_ctx_seq
```
KV 는 `n_ctx_seq`(=`n_ctx / n_parallel`) 로 **한 번** 할당된다. 따라서
**기본값(`kv_unified=false`)에서 슬롯을 늘리면 KV 가 *축소*된다.** 곱해지는 것은
`--kv-unified` 를 켰을 때뿐이다.

→ **`src/setup/tuning.ts:307-314` 의 근거는 소스와 사실이 다르다.**
```
"Every extra slot multiplies the KV cache and the batch buffer ... would silently
 quadruple the memory a config-sized context actually costs"
```
이 문장은 현재 llama.cpp 에서 성립하지 않는다. `tuning.test.ts:62` 와
`bootstrap.test.ts:298` 도 이 잘못된 전제를 단언한다. **이 문서에서 T7 을 다룬다.**

### 1.4 동시성 구조

```
src/agent/loop.ts:583-592
private enqueue(task) { const result = this.taskChain.then(task); ... }
```

`send()` · `runUntilIdle()` · `compact()` · `warmCompactIfNeeded()` 가 **전부 이 큐에
직렬화**되어 있다. **겹치는 HTTP 요청을 보내는 코드 경로가 존재하지 않는다.**

→ `--parallel 2` 로 바꿔도 슬롯 2 는 영원히 idle 이다. 효과 0.

단, 선행 최적화는 이미 존재한다:

- `warmCompactIfNeeded()` (`loop.ts:538`, 호출부 `index.tsx:894`) — 턴 종료 후
  유휴 시간에 컴팩션을 선행 실행. fire-and-forget.
- `lastEstimate` 메모 (`compactor.ts:162-210`) — 턴당 2회 왕복이던
  `estimateTokens` 를 1회로.

**이 둘은 지연시간 문제가 아니라 "사용자가 언제 기다리는가"의 문제다.** §4 의 T6 이
이 축을 다룬다.

### 1.5 지연시간과 별개인 실측 장애 (latency 아님, 참고)

`loop.ts:1613-1624` 에 기록된 실제 장애: 단일 슬롯 서버를 여러 llamacli 프로세스가
공유하면서 하루종일 "compact timed out after 120000ms" 가 **37회** 재발.
이는 latency 문제가 아니라 **선점(preemption) 문제**이며 T7 과 무관하게 별개 트랙이다.

---

## 2. 절대 하지 말 것

1. **사용자의 살아있는 세션을 건드리지 마라.**
   현재 이 머신에 실제 실행 중인 것들:
   - `llama-server` 포트 **8084** (`-c 40960 -np 1`, 27B ternary)
   - `node .../llamacli` 세션 1개 (활성)
   - `~/.llamacli/config.yaml` 는 `baseUrl: http://127.0.0.1:8081`, `contextSize: 4096`
     으로 **살아있는 서버와 어긋나 있다**. 이 불일치를 "고치겠다"고 건드리면 안 된다.

   실험은 **전용 포트(8090+) 와 전용 모델 경로**에서만 한다. 추론을 8084 로 보내지 마라.

2. **`npm test` 를 중간에 통과시킨 척 하지 마라.** 기존 테스트는 현재 동작을
   고정한다. §4 의 트랙 중 테스트 변경이 필요한 것이 있으면 그 변경을 명시하라.

3. **추측을 사실로 쓰지 마라.** 아래의 "확인 필요" 항목은 llama.cpp / vLLM 의
   현재 문서와 로컬 소스를 직접 읽고 확인한 뒤에만 단언하라.

4. **사용자 설정 파일을 되돌리지 마라.** `~/.llamacli/config.yaml` 은 사용자의
   것이고, 실험용으로 복사본을 만들어 쓴다.

---

## 3. 측정 규약

이 연구의 결과는 전부 **숫자로** 제출한다. "더 빨라졌다"는 답이 아니다.

### 3.1 반드시 함께 기록할 지표

단일 `wall_clock` 값만으로는 판단할 수 없다. 매 실험마다 아래를 모두 남긴다.

| 지표 | 측정법 | 왜 필요한가 |
|---|---|---|
| 요약 wall clock | `compaction/loop.ts:1650` 이 이미 로그한다 (`[compaction] X.Xs`) | 1차 지표 |
| 생성 토큰 수 | 응답의 `completion_tokens` 또는 클라이언트 카운터 | wall clock 이 줄었는지 *진짜* 줄었는지 |
| **요약 길이 분포** | 컴팩션마다 생성 토큰 수의 min/median/max | 측정됨: 140~446 토큰, 3배 편차. baseline 이 4.3~13.6 s 로 흔들리므로 단일 측정으로는 어떤 개선도 판정 불가 |
| **상한 발화 비율** | `summaryDeadlineMs` 설정 시, 실제로 잘린 컴팩션의 비율 | 측정됨: 10 s 상한에서 `truncated=false` — 모델이 스스로 짧게 쓰면 상한이 걸리지 않는다. 설정했는데 거의 안 걸리면 사용자는 "무효" 를 경험한다 |
| 실효 tok/s | 생성 토큰 ÷ decode 구간 시간 | **슬롯 유휴 확인 후** 측정. 경합 시 `-np 1` 이 슬롯을 공유해 수치가 흔들린다 (측정됨: 14~81 tok/s, 중앙값 19.8). 서버 로그의 `tg = ... t/s` 와 대조할 것 |
| accept rate (추측 디코딩) | vLLM 의 `mean accepted length` / llama.cpp 대응값 | 추측이 실제로 맞는지 |
| **요약 품질** | §3.3 의 절차 | 없으면 개선이 아님 |
| 컴팩션 발동 빈도 | 세션당 `compact()` 호출 횟수 | 요약을 줄여 자주 컴팩션하게 되면 역효과 |
| 턴 지연 회귀 | 메인 턴의 p50 / p95 | 컴팩션이 빨라져도 턴이 느려지면 실패 |

### 3.2 단일 측정 금지

- 최소 **5회 반복 후 중앙값**.
- **측정 직전 슬롯이 유휴인지 확인하고 기록할 것** (`GET /slots` 의
  `is_processing`, 그리고 `id_task` 증가분이 본인 요청뿐인지). `-np 1` 에서는 슬롯이
  하나뿐이라 다른 세션과 공유되며, 경합은 중앙값도 오염시킨다 — 반복으로 잡히지
  않는다. 실측 근거는 §5.6.
- 같은 모델을 **다른 시드로 한 번 더** 돌려 재현성 확인 (로딩 상태·thermal 영향).
- vLLM 과 llama.cpp 을 비교할 때는 **같은 모델 파일·같은 양자화**로. 다르면 비교
  자체가 무의미하다.
- vLLM 의 APC / prefix cache 를 켠 상태와 끈 상태를 **반드시** 따로 측정하라
  (추측 디코딩 과의 상호작용이 있다).
- **요약 품질 측정에는 temperature 0 또는 고정 시드가 필요하다.** `runCompaction` 은
  temperature 를 지정하지 않고, 그 서버의 기본값은 1.0 이다(실측: `/props` 의
  `default_generation_settings.sampling.temperature`). 즉 같은 입력을 넣어도 요약
  출력이 매번 달라진다. **반복 5회** 는 지연에는 충분하지만, 4~5개 사실짜리
  코퍼서스의 retention 을 랭킹하기에는 **부족**하다.
  → 반복 횟수를 높이거나, 판정 대신 "노이즈 범위 안이면 무승부" 로 처리하라.
  실측 근거: 예산 2배인데 retention 이 떨어진 표가 나왔는데, 원인은 예산이 아니라
  표본 잡음이었다 (§5.8).
- **prefill 캐시 상태를 통제하거나 기록할 것.** 컴팩션 요약 요청은 *직전 턴의
  verbatim prefix* 라 프로덕션에서 prefill 이 ~0.3 s 다 — 컴팩션 설계가 그렇게
  만든 것이다. 그러나 테스트가 `runCompaction` 을 직접 부르면 그 이점이 사라지고
  매 픽스처마다 **콜드 prefill 이 한 번씩** 들어가서, 측정값이 요약 예산이 아니라
  캐시 상태를 읽는다. 워밍업 후 측정하거나 캐시 상태를 표에 함께 남겨라 (§5.8).
  > retention 이 예산에 대해 **단조 비감소하지 않으면** 그건 신호가 아니라
  > 측정 잡음이다. 예산을 늘려서 요약이 나빠질 수는 없다.

### 3.3 요약 품질 측정 — 생략하면 결과는 무효

속도를 올리면서 요약이 무의미해지면 그건 개선이 아니라 손해다. 컴팩션의 목적은
히스토리를 잃지 않는 것이다 (`PROMPT.md` §2).

1. **고정 픽스처**를 만들어라: 실제 세션 로그에서 컴팩션이 발동한 시점의
   `toSummarize` 슬라이스 10개를 골라 `fixtures/` 에 고정한다.
2. 각 요약 산출물을 LLM 판정 또는 사람이 읽고 아래를 채점한다 (0-5):
   - 사용자 명시적 제약 (`mustPreserve` 후보) 이 보존되었는가
   - 결정·약속이 남아 있는가
   - 아직 진행 중인 작업의 상태가 남아 있는가
   - 불가능/오류 사실이 지어내지지 않았는가
3. **속도 개선 요약이 기준 점수에서 1점이라도 떨어지면 그 개선은 실패로 분류한다.**

### 3.3.1 픽스처가 실제로 뭔가를 측정하고 있는지 확인 (2026-10-02 추가)

§5 T0-5 를 실제로 구현하면서, **측정이 조용히 무의미해지는** 경우가 네 번
발생했습니다(§5.7 에 상세). 모두 "문제는 없는데 숫자가 이상하다" 의 형태였으므로,
점수만 보고는 구분할 수 없습니다. 채점 직전에 아래 세 가지를 반드시 확인하세요.

1. **요약 요청이 비어 있지 않은가.** `toSummarize` 가 0 이면 요약할 대상이 없고,
   모델이 "요약할 대화가 없습니다" 라고 정답을 말하는 것이고 retention 은 당연히
   0% 다. **모든 설정에서 0% 가 나오면 이것을 의심할 것.**
2. **평가 대상 사실이 요약 대상 영역 안에 있는가.** 사실이 `keepTail` 안에 있으면
   요약이 무엇을 했든 100% 로 나온다. 그때 측정되는 것은 tail 보존이며 요약 품질이
   아니다. 100% 가 나오면 이것을 의심할 것.
3. **요약 요청이 실제로 창 안에 들어가는가.** 문자 기반 토큰 추정은 서버의 실제
   토크나이저보다 **약 20% 낮다**(실측: 추정 55k → 실제 65,946). 추정만 보고
   "창을 채웠다"고 판단하면 실제로는 창을 넘겨 400으로 죽는다.

**기준 용도 코퍼서스**가 `src/compaction/fixtures/` 에 있다
(`compaction_bench.ts` 로 측정 가능). 1·2번은 회귀 테스트로 고정되어 있으니,
새 픽스처를 추가할 때도 같은 검증을 붙여야 한다.

### 3.4 p50 과 p99 를 따로 보고

컴팩션은 드물게 일어나지만 사용자가 체감하는 것은 p99 다. 10회 중 1회가 2분 걸리면
그 세션은 "버벅거리는 CLI" 다. **p99 를 별도로 보고하라.**

---

## 4. 조사 트랙

아래 8개 트랙을 **기대효과순**으로 배열했다. 앞의 트랙이 막히면 뒤로 넘어가고,
**막힌 근거를 반드시 기록**하라. 추측으로 건너뛰지 마라.

---

## 4.5 착수 이후의 발견 — 즉시 반영 완료분 (2026-10-02)

§4 의 트랙 착수 과정에서, 지연시간에 직접 영향을 주면서 §4 목록에 없던 발견이
나왔다. 이 둘은 **완료되어 테스트로 고정되어 있다** (`npm run check` 999 tests pass,
하네스 4종 전부 PASS).

### D1 — `compaction.summaryMaxTokens` 가 죽은 코드였다 (T3 의 선행 조건)

스키마에 선언돼 있고 세 곳에서 문서화돼 있었고, AgentLoop 이 실제로 읽는데
(`loop.ts` 의 `this.opts.thresholds.summaryMaxTokens`), **`index.tsx` 가 그 값을
`thresholds` 객체로 복사한 적이 없었다.** 그래서 값은 항상 `undefined` 였고
`?? DEFAULT_SUMMARY_MAX_TOKENS` 폴백이 항상 이겼고, config.yaml 에 넣은 사용자는
**오류 메시지 없이** 기본값을 그대로 받았다.

즉 앞서 "유일하게 확실한 개선"으로 권고했던 그 레버가 실제로는 존재하지 않았다.
배선 완료 (`src/index.tsx`). 회귀 테스트 추가 (`src/config.test.ts`).

**이것만으로 T3 의 전제조건이 성립한다.** T3 의 질문이 "기본값을 낮출 가치가 있는가"
에서 "이제서야 실제로 작동하는 이 값을 어떻게 정할 것인가"로 바뀐다.

### D2 — 시간 예산 상한 (`summaryDeadlineMs`) 신규 구현 (T2 의 핵심)

T2 의 설계를 그대로 구현했다. **wall clock 으로 지연을 직접 상한내는** 방식이다.
`summaryMaxTokens` 는 머신의 tok/s 를 알아야 시간으로 환산되는데, 지원 하드웨어
전체에서 그 값이 약 8배 차이 나므로, 토큰 예산만으로는 "얼마나 기다려야 하는가"를
어떤 머신에서도 상한을 걸 수 없다.

- 설정: `compaction.summaryDeadlineMs` (미설정 시 기존 동작 그대로, opt-in)
- 클라이언트: `chat()` 의 `opts.deadlineMs` — 스트리밍 경로에서만 작동
- 잘린 요약은 `trimPartialSummary` 로 문단/문장 경계에서 자른 뒤 **사용한다**
  (컴팩션 자체를 실패시키지 않는다)
- 잘렸는지 여부는 새 `deadlineHit` 플래그로 구별한다. `finish_reason: "length"` 는
  deadline · 클라이언트 측 `max_tokens` 캡 · 서버 자체 중단이 **모두 같은 값**이라
  구별할 수 없다

### 실측 (라이브 서버 :8084, 실제 대화 기준)

```
로컬 CPU (selectKeptTail + 전체 토큰 추정)         0.26 ms
HTTP 왕복 (/apply-template)                          6.0 ms
────────────────────────────────────────────
요약 생성 (1024 토큰 예산)                       31,165 ms   ~603 토큰 실측
```

**async 상한 0.020%.** §1.1 의 0.02% 가 합성 히스토리가 아니라 실제 대화로
재확인되었다. 비동기화·계산 최적화 방향은 여전히 배제.

상한 기능 자체의 동작 확인 (무한 SSE 서버 + 라이브 서버):

```
  deadline  500ms ->   546ms 반환  (99 토큰 보존, deadlineHit=true)
  deadline 1500ms ->  1513ms 반환  (289 토큰 보존, deadlineHit=true)
  deadline 3000ms ->  3010ms 반환  (567 토큰 보존, deadlineHit=true)
초과 시간 10~46 ms — 체감 가능한 오버런 없음
```

### 구현 중 드러난 함정 하나 (참고)

`deadlineTruncated` 플래그를 처음에 "요약 문자열이 실제로 잘렸는가"로 계산했는데
**잘못이었다.** 실측에서 300ms 상한 시 모델이 8자("There is")만 냈고, 이 문자열은
문단 경계도 문장 종결도 없어 `trimPartialSummary` 가 올바르게 자르기를 거부했다.
결과적으로 플래그가 `false` 가 되어, **99% 빠진 요약에 대해 "잘리지 않음"으로
보고**되었다. 플래그는 지금 문자열 변화가 아니라 **"무엇이 생성을 끝냈는가"** 를
보고한다. 회귀 테스트로 고정 (`compactor.test.ts`).

---

### T1 — 요약 생성에 추측 디코딩 적용 ★최우선★

**가설.** 컴팩션 지연의 100%는 decode다. decode 를 가속하는 유일한 실용적 수단이
추측 디코딩이며, 요약은 반복성이 높은 텍스트라 수락률이 높을 것이다.

**왜 기대되는가.**
- vLLM 프로젝트의 자체 벤치마크 노트는 n-gram 대비 suffix decoding 이 대체로
  우월하며, 특히 **"agent loops, code editing"** 같은 반복 패턴 워크로드에서 실사용
  병렬에서 더 큰 이득을 봤다고 기술한다.
- AMD GPU 대상 vLLM 블로그도 후속 벤치마크 대상으로 "n-gram speculation and suffix
  decoding, particularly for workloads with repeated token patterns such as code
  editing and agentic loops" 를 명시한다.
- llama.cpp 도 서버에서 쓸 수 있는 lookup decoding 이 존재한다.

**llama.cpp 측 후보 플래그** (로컬 소스 `common/arg.cpp` 에서 확인된 것. **사용 전
`--help` 로 실제 유효성을 재확인하라**):

```
--spec-draft-n-max N        # ngram-model 기반 초안 토큰 수 상한 (arg.cpp:4144)
--spec-draft-n-min N        # 하한 (arg.cpp:4151)
--spec-ngram-mod-n-max N    # ngram-mod 상한 (arg.cpp:4265)
--spec-ngram-mod-n-min N    # ngram-mod 하한 (arg.cpp:4255)
-lcs, --lookup-cache-static FNAME    # 정적 lookup 캐시 (arg.cpp:1622)
-lcd, --lookup-cache-dynamic FNAME   # 동적 lookup 캐시 — 생성으로 갱신됨 (arg.cpp:1629)
```

주의: `--draft` / `--draft-max` / `--draft-min` 은 **제거되었다**
(`arg.cpp:4383-4396` 에서 `arg_removed`). 구형 문서를 읽지 마라.

**vLLM 측 후보** (`--speculative-config`):
```
{"method": "suffix", "num_speculative_tokens": 12, "suffix_decoding_max_cached_requests": 1000}
{"method": "ngram",  "prompt_lookup_min": 3, "prompt_lookup_max": 5}
{"method": "eagle3"|"mtp"|"dflash", ...}    # draft 체크포인트 필요 — 확보 가능성 확인
```

**llamacli 측 통합 지점.**
`runCompaction` 의 `backend.chat()` 호출 (`compactor.ts:568-574`) 은 이미
`llamaServer.ts:buildServerArgs()` 를 통해 서버 플래그를 통제한다. 추측 디코딩은
서버 기동 플래그이므로 **llamacli 코드 변경 없이** 적용 가능하다. 이것이 이 트랙의
가장 큰 장점이다. 단 `--lookup-cache-dynamic` 는 **경로를 인자로 받는 상태ful
파일**이므로 lifecycle 을 확인하라 (프로세스 종료 시 flush 되는가).

**성공 기준.** 요약 decode 구간 실효 tok/s 가 38 대비 **1.5배 이상**, 그리고 §3.3
품질 점수 하락 0.

**실패 시.** 수락률이 낮다면(요약이 생각보다 고엔트로피) T2 로 넘어간다.

---

### T2 — 시간 예산 기반 요약 조기 종료

**가설.** 요약은 "완벽"할 필요가 없다. 27 초를 10 초로 잘라도, 압축률 14배면
메모리 확보 목적은 이미 달성된다. 그러면 **지연 상한을 토큰 수가 아니라 시간으로
두는** 편이 낫다.

**기반.**
- `compactor.ts:558-562` 에 이미 클라이언트 측 streaming cap 이 존재한다고
  기록돼 있다. 즉 "중간에 멈추는" 메커니즘은 코드에 존재한다.
- `openaiClient.ts` 도 스트리밍 상한을 이미 갖고 있다.

**llamacli 측 통합 지점.** `compactor.ts:568` 의 `stream: false` 호출을 스트리밍으로
바꾸고, **경과 시간 상한**(`compaction.summaryDeadlineMs`)에 도달하면 스트림을
버리고 지금까지 받은 텍스트를 요약으로 쓴다.

**반드시 함께 검증할 것.**
- 중간 절단된 요약은 문장이 끊기고 `# Comp` 같은 마크다운 헤더만 남아 있을 수 있다.
  §3.3 품질 측정이 이 시나리오에서 가장 크게 떨어질 가능성이 있다.
- 하드 절단이 반복되면 §3.1 의 "컴팩션 발동 빈도"가 올라가 **총 시간은 오히려
  늘어날 수 있다.** 반드시 세션 전체 wall clock로 검증하라.
- 트러블슈팅: `loop.ts:1674-1682` 가 실패를 삼키고 진행하는 경로가 있으니,
  조기 종료가 오류로 오인되지 않는지 확인.

**성공 기준.** p50 지연 50% 감소 **이면서** §3.1 의 총 세션 wall clock 감소.
둘 다 아니면 실패다.

---

### T3 — 요약 예산 정책의 실측 재조정

**가설.** `DEFAULT_SUMMARY_MAX_TOKENS = 1024` (`compactor.ts:333`) 와
`SUMMARY_COMPRESSION_RATIO = 0.35` (`compactor.ts:499`) 는 2026-09-28 시점의
단일 측정(38 tok/s)에 맞춘 값이다. 27B ternary 모델로 다시 측정하면 최적점이
다를 수 있다.

**해야 할 것.** 압축률 × 품질 점수의 트레이드오프 곡선을 실제로 그려라.

```
요약 예산:  256 / 384 / 512 / 768 / 1024 / 1536 / 2048 토큰
측정:      wall clock, 압축률(요약 토큰 / 원본 토큰), §3.3 품질 점수
```

**주의 — 이미 있는 자동 축소를 놓치지 마라.** `compactor.ts:500` 이 이미
`min(windowBasedCap, ceil(summaryInputTokens * 0.35))` 를 적용한다. 조용한 세션은
이미 자동으로 짧은 요약을 쓴다. **문제는 "큰 히스토리를 요약할 때" 뿐**이며,
그때 1024 가 발휘된다. 표를 그릴 때는 `toSummarize` 가 큰 픽스처만 추출하라.

**주의 — 왜 1024 로 내렸는가.** `compactor.ts:462-475` 에 4096 → 1024 로 내린
이유가 남아 있다: 38 tok/s 에서 4096 은 107 초였다. 그 Trade가 지금도 옳은지
재검증하는 것이지, 되돌리라는 것이 아니다.

**성공 기준.** 1024 보다 낮은 예산에서 품질 하락 없이 wall clock 이 줄어드는 구간
이 존재하면 그 값으로 기본값을 낮춘다.

---

### T4 — 요약 전용 소형 모델 라우팅

**가설.** 압축은 간단한 작업이다. 27B/35B 를 쓸 이유가 없다. 요약 요청만 별도의
소형 모델(또는 별도 llama-server 인스턴스)로 보내면 decode 속도가 수십 배다.

**이것이 이론적으로는 가장 클 수 있는 레버다.** §1.2 를 보면 지연이 100% decode
이므로, decode 를 5배 빠르게 하면 지연은 그대로 5배 줄어든다.

**검증해야 할 것 (추측 금지).**
- **요약 품질이 실제로 유지되는가.** 소형 모델이 사용자 제약과 미완결 작업을
  놓친다면 컴팩션 후 세션이 산만해진다. §3.3 이 이 트랙의 생존 조건이다.
- 소형 모델의 **tool-call grammar 은 필요 없다.** `sanitizeForSummary`
  (`compactor.ts:271`) 가 이미 tool_calls 를 평문으로 변환하므로, 도구 호출 능력
  이 없는 모델도 후보가 된다. 이게 소형 모델을 쓸 수 있게 하는 근거다.
- 2개 모델을 동시에 VRAM 에 올릴 수 있는가. 이 머신은 8 GB VRAM 이고 이미
  27B 가 상주한다. **작동하지 않을 가능성이 높으므로 먼저 VRAM 산술을 하고
  그 다음에 빌드를 시도하라.**
- `--n-cpu-moe` 를 쓰면 활성 파라미터만 GPU 에 남는다. 이 경로가 2모델 구성을
  가능하게 하는지 계산하라 (`tuning.ts:265-305`).

**성공 기준.** 품질 하락 0, 그리고 컴팩션 지연 3배 이상 감소.

**실패 시.** VRAM 이 부족하면 T1+T2+T3 조합으로 확정하고 이 트랙을 폐기한다.
추측으로 "될 것이다" 하고 끝내지 마라.

---

### T5 — backend 교체: llama.cpp vs vLLM 전체 비교

**가설.** vLLM 의 continuous batching 과 paged attention 이 llama.cpp 대비
decode 지연을 낮출 수 있다. 그리고 `--parallel` 과 prefix cache 가 **llamacli 코드
변경 없이** 서버 측에서 동작한다.

**반드시 통제할 것.**
- **같은 모델 파일·같은 양자화**로 비교하라. 다른 모델로의 비교는 무의미하다.
- 이 머신은 8 GB VRAM + MoE CPU 오프로드 구조다. vLLM 은 MoE CPU 오프로드
  (`--n-cpu-moe` 와 유사 개념)의 지원 상황이 llama.cpp 와 다를 수 있다.
  **T4 의 사전 산술을 먼저 돌릴 것.**
- vLLM 의 기본 APC 를 켠 상태로 측정하라 (vLLM 이라서 켜져 있다). §1.2 때문에
  요약 지연에는 기여하지 않을 거지만, **메인 턴 지연**에는 기여할 수 있다.
  두 지표를 분리해서 보고하라.

**llamacli 측 통합 지점.** `openaiClient.ts` 는 이미 OpenAI 호환 엔드포인트를
탄다. `LlamaServerManager.attachExisting()` (`llamaServer.ts:193`) 로 vLLM 을
붙일 수 있다. 다만 `getContextSize()` 가 `/props` → `default_generation_settings.n_ctx`
를 읽는데(`openaiClient.ts` 참조), **vLLM 은 그 경로가 있는지 T0 로 먼저 확인하라.**
없으면 임계값이 어긋나 컴팩션이 잘못된 시점에 발동한다. 이는 §1.5 의 latency 와
는 별개의 **정확성** 위험이므로 성공 기준에 포함하라.

---

### T6 — 임계값 사다리: 예측형 컴팩션

**가설.** 현재 컴팩션은 70% 도달 시 **_interrupt 로서** 발동한다
(`config.ts:134`, `loop.ts:1435`). 사용자가 그 27 초를 그대로 본다.
발동 시점을 앞당겨 **유휴 시간에 끝내도록** 만들면 사용자는 기다리지 않는다.

**기반.** `warmCompactIfNeeded()` (`loop.ts:538`) 가 이미 "턴 종료 후 유휴 시간에
선행 실행"을 한다. 이 트랙은 그 아이디어를 두 단계로 확장한다.

```
현재:   [70%] → interrupt → 27초 대기 → 턴
제안:   [40%] → 유휴 시간에 선행 실행 → [70%] 에서는 이미 컴팩션 완료
```

**주의 — 총 시간은 줄어들지 않는다.** §1.1 에서 증명했듯이 유휴 시간에 돌린
비용은 사라지는 게 아니라 **위치만 바뀐다.** 이 트랙의 목표는 p99 체감 지연이지
총 처리량 개선이 아니다. **최종 보고서에 이 구분을 명확히 적어라.**

**반드시 함께 검증할 것.**
- 조기 컴팩션은 더 자주 트리거된다. §3.1 의 "발동 빈도"를 반드시 같이 보라.
- 컴팩션 후 tail 이 줄어들기 때문에, premature compaction 이 **정보 손실**을
  유발할 수 있다. 한 세션이 컴팩션 3회 vs 1회를 겪는 상황을 §3.3 으로 검증하라.
- `warmCompactIfNeeded` 가 이미 enqueue 로 직렬화되어 있으므로 (§1.4),
  이 트랙은 동시성 코드를 건드리지 않는다. **그래도** 겹치는 케이스가 생기면
  `this.messages` 동시 쓰기가 된다. 확인하라.

**성공 기준.** p99 체감 지연 감소, 총 세션 wall clock **비증가**, 품질 손실 0.

---

### T7 — `tuning.ts` 의 잘못된 전제 정정

**가설.** §1.3 이 증명했듯 `--parallel 1` 하드코딩의 근거("슬롯이 KV 를 곱한다")는
현재 llama.cpp 에서 성립하지 않는다. 지금은 슬롯을 늘릴 이유가 없다는 판단도,
늘리면 OOM 된다는 판단도 근거가 없다.

**해야 할 것.**
1. `src/setup/tuning.ts:307-314` 의 근거 문장을 소스 근거로 교정하라.
2. `src/setup/tuning.test.ts:62` 와 `src/setup/bootstrap.test.ts:298` 이 그 잘못된
   전제를 단언한다. **이 테스트들은 통과해야만 하는 옛 것이 아니라 지금 옳은
   것을 단언해야 하므로 함께 고쳐라.** 단언만 바꾸는 것이 아니라 로직도.
3. `parallel` 을 설정 가능하게 하되, **per-slot 의미로 정하라.** 사용자가
   `parallel: 2` 를 주면 `-c` 는 `perSlotContext × 2` 로 계산되어야 한다
   (`-c` 가 합계라는 §1.3 의 사실 때문). 이게 빠지면 §1.3 의 고전적 실패
   (조용히 절반으로 줄어드는 컨텍스트) 가 재발한다.
4. `--kv-unified` 를 켤 경우의 동작이 반대(곱해짐)로 바뀐다는 점을 문서화하라.

**성공 기준.** `npm run check` 통과, 그리고 `-np 2` 에서 per-slot 컨텍스트가 의도한
값임을 로그로 확인할 수 있을 것.

**주의.** 이것은 지연시간을 줄이지 않는다. **정확성과 미래의 선택지를 위한
정정**이며, 그렇게 보고하라.

---

### T8 — 선점(preemption) 문제 (지연이 아님, 별도 트랙)

**가설.** `loop.ts:1613-1624` 의 37회 타임아웃은 latency 가 아니라 **단일 슬롯을
여러 프로세스가 공유할 때의 starvation** 이다.

**해야 할 것.** T7 의 `--parallel` 옵션을 **이** 용도로 쓸 수 있는지 검증하라.
`parallel: 2` + `-c 2배` 로 두 번째 프로세스가 자기 슬롯을 받으면 120 초 타임아웃이
사라지는가?

**성공 기준.** 동시 프로세스 2개에서 타임아웃 재발 0.

---

## 4.6 T0 사전 확인 결과 (2026-10-02, 실측)

### T0-1 — `-c` 의 의미: **확인됨. per-slot 이 맞다.**

소스 + 라이브 서버 대조로 확정. 라이브 서버는 `-c 40960 -np 1` 이고
`/props` 의 `default_generation_settings.n_ctx = 40960`, `total_slots = 1`.
`/props` 는 `slot_n_ctx`(기동 로그의 `n_ctx_slot` 와 같은 값)를 준다.

**중요한 예외를 하나 더 찾아냈다.** `-np` 를 기본값(auto)으로 두면
`tools/server/server.cpp:156-160` 이 `n_parallel = 4` 와 `kv_unified = true` 를
**함께** 설정한다. `kv_unified` 하에서는 `n_ctx_seq = n_ctx`
(`llama-context.cpp:292`) 이므로 KV 풀이 공유되어 **곱해진다.**

즉 `tuning.ts:307-314` 의 논거가 틀린 범위는 "항상" 이 아니라 **"명시적 `-np`
일 때"** 이며, llamacli 가 항상 명시적 `-np` 를 넘기므로 **그 우리에게 해당한다.**
정정 범위는 "KV 가 절대 곱해지지 않는다" 가 아니라 "명시적 `-np` 에서는
곱해지지 않는다" 로 narrower 해야 한다.

### T0-4 — 추측 디코딩 플래그: **존재 확인. 문서화된 이름이 실제와 다르다**

로컬 빌드(`llama-server --help`) 실측. §4 T1 에 적어둔 이름이 부정확했다.

```
--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,
            ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache
--spec-draft-n-max N     (default: 3)
--spec-ngram-mod-n-min N (default: 48)   /  --spec-ngram-mod-n-max N (default: 64)
--spec-ngram-mod-n-match N (default: 24)
-lcs / -lcd  lookup cache (server 사용 가능)
```

**T1 은 draft 모델이 필요 없다.** `ngram-simple` / `ngram-mod` / `ngram-cache`
는 초안 모델 없이 동작하며(`common.h:370-386` — draft 는 `mparams` 를 가진
메서드들에만 필요), 단독 llama-server 에 바로 붙는다. draft 체크포인트가 필요한
`eagle3`/`mtp`/`dspark` 는 T1 을 이 머신에서 **불가능하게** 만든다.

→ **T1 을 narrow 하라:** "사전학습 draft 없이 되는 ngram 계열만" 으로.

### T1 실행 불가 — 이유와 남은 가치

두 번째 서버가 필요한 실험인데, 8 GB VRAM 에 27B 가 이미 상주해 있어 **불가능**.
대신 상한을 측정했다. 실측 baseline:

```
run 1: 8,289 ms  ~212 tok
run 2: 13,639 ms ~446 tok
run 3:  4,287 ms ~140 tok
```

**요약 길이가 140~446 토큰으로 3배 variability** — baseline 이 4.3s~13.6s 로
흔들린다. 추측 디코딩의 이득은 이 variability 위로 더해질 뿐이다.

T1 의 이론적 상한(절반 단축, 도달 불가능한 낙관적 하한) ≈ 2,144 ms.

### D2 시간 상한의 실측 — 그리고 새로 드러난 한계

```
no ceiling            4,287 ms   (분포상 4.3~13.6 s)
ceiling  5s           5,034 ms   ~69 tok 보존 (20%)  truncated=true
ceiling 10s           5,395 ms  ~167 tok 보존 (48%)  truncated=false
ceiling 15s          12,611 ms  ~292 tok 보존 (84%)  truncated=false
```

**새로 드러난 함정:** 모델이 스스로 짧은 요약을 쓰는 경우(140 토큰)에는 10s 나
15s 상한이 **전혀 걸리지 않는다** (`truncated=false`). 상한은 모델이 길게 쓰려 할
때만 작동한다. 즉 상한의 실효성은 "상한 값" 이 아니라 **"그 세션의 요약 길이
분포"** 가 결정한다.

→ §3.1 이 요구한 "발동 빈도" 와 짝을 이룰 항목이 하나 더 필요하다:
**"상한이 실제로 발화한 비율"**. 상한을 설정했는데 90% 의 컴팩션에서 걸리지
않으면 사용자는 "설정한 시 ineffective" 을 경험한다. 이 수치를 리포트에
반드시 포함할 것.

## 5. T0 — 착수 전 필수 확인 (건너뛰면 나머지 전부 무효)

**이것을 먼저 하지 말고 T1~T8 을 시작하지 마라.**

| # | 확인할 것 | 방법 | 실패 시 |
|---|---|---|---|
| T0-1 | `/slots` 의 per-slot `n_ctx` 가 실제로 `-c / n_parallel` 인가 | 전용 포트에 소형 모델로 `-np 1` / `-np 2` 를 각각 띄우고 `/slots` 비교 | §1.3 이 틀리면 T5·T6·T7 전부 재검토 |
| T0-2 | **VRAM 산술** — 소형 모델을 2개 올릴 여지가 있는가 | `nvidia-smi` + 모델 크기 + KV 계산. §1.3 의 KV 공식 사용 | T4 가 성립 불가. 계산 결과를 문서에 남기고 T4 폐기 |
| T0-3 | vLLM 이 `/props` 의 `default_generation_settings.n_ctx` 를 제공하는가 | vLLM 기동 후 `curl localhost:<port>/props` | 없으면 `getContextSize()` 가 실패한다. T5 는 통합 전에 먼저 이 문제를 해결해야 한다 |
| T0-4 | 추측 디코딩 플래그가 현재 빌드에서 유효한가 | `llama-server --help` 에서 플래그 존재 확인 (§4 T1 의 주의 참조) | 플래그명이 바뀌었을 수 있다. 소스가 아니라 `--help` 를 믿어라 |
| T0-5 | 고정 픽스처 10개 확보 | 실제 세션 로그에서 컴팩션 발동 지점의 `toSummarize` 추출 | 픽스처 없으면 §3.3 품질 측정이 불가능해져 **전체 연구가 무효** |

**소형 모델이 없다.** 이 머신에 1 GB 미만 GGUF 가 없다 (`models/` 의 최소는
17 GB). T0-1, T0-2, T0-4 에 필요한 소형 모델을 먼저 확보하라. 다운로드가
필요하면 허락을 구하라.

---

## 5.5 T0-2 / T5 / T7 결과 및 T7 구현 (2026-10-02)

### T0-2 — VRAM 산술: **T4 폐기 확정**

전량 실측. 이 머신의 카드 상태:

```
GPU            : NVIDIA GeForce RTX 2070 SUPER
VRAM total     : 8.00 GiB
VRAM used      : 7.44 GiB
VRAM free      : 0.16 GiB          <- 2번째 모델이 들어가야 할 공간

compute apps:
  pid 128976   7.18 GiB   llama-server (Ternary-Bonsai-2-27B-PTQ1_0, 5.54 GiB 파일)
  나머지 3개    0.02~0.03 GiB  nautilus / gnome-text-editor / resources
```

라이브 모델의 오버헤드: 파일 5.54 GiB → 상주 7.18 GiB = **KV + compute buffer
+ CUDA context 1.64 GiB**. `tuning.ts` 의 자체 리저브(1 GiB)를 빼면 **가용
-0.84 GiB**.

```
1.5B Q4   1.0 + 0.15 + 0.6 = 1.75 GiB  -> 들어가지 않음
3B   Q4   2.0 + 0.15 + 0.6 = 2.75 GiB  -> 들어가지 않음
7-8B Q4   5.0 + 0.15 + 0.6 = 5.75 GiB  -> 들어가지 않음
```

**T4(요약 전용 소형 모델 라우팅)는 이 머신에서 실행 불가.** 재확보하려면 살아있는
세션을 멈춰야 하는데, 이는 §2 가 명시적으로 금지한다. T4 폐기.

### T5 — vLLM: **실행 불가 + 정합성 전제 조건 발견**

```
vllm            : 미설치
python3         : /usr/bin/python3
VRAM free       : 0.16 GiB  -> vLLM 도 기동 불가
```

**그래도 확인된 것 — 통합에 실제 전제 조건이 있다.** `getContextSize()`
(`openaiClient.ts:204-208`) 가 읽는 경로는 두 개뿐이다:

```
1. /config -> model_info.n_ctx
2. /props  -> default_generation_settings.n_ctx
```

vLLM 은 OpenAI 호환 표면에 `n_ctx` 를 노출하지 않고 `max_model_len` 을 기동 시에만
알린다. 즉 T5 는 "baseUrl 만 vLLM 으로 바꾸는" 작업이 아니며, **`getContextSize()`
에 세 번째 경로(또는 vLLM 전용 adapter)가 필요**하다.

다행한 것: 두 엔드포인트가 모두 없으면 **throw** 하고 0/undefined 를 반환하지 않는다.
죽은 엔드포인트로도 throw 함을 확인했다. 따라서 잘못된 vLLM 통합은
"조용히 config.yaml 값으로 컴팩션" 하는 실패가 아니라 **기동 시 명백한 실패**다.
(그 실패가 이미 한 번 실재했음은 `openaiClient.test.ts:28-38` 참조.)

### T7 — 구현 완료: `-np` / `-c` 배선 정정

지연시간을 줄이지는 않지만, **지금 틀린 근거 위에 서 있던 코드**를 바로잡았다.

**수정 1 — `tuning.ts` 의 근거 교정.** "슬롯을 늘리면 KV 캐시가 곱해진다" 는
명시적 `-np` 에서 거짓이다. 다만 오류 범위는 "항상"이 아니라 **"`-np` 를 생략하면"**
으로 narrower 해야 한다:

```
tools/server/server.cpp:156-160
    if (n_parallel < 0) { n_parallel = 4; kv_unified = true; }
```

`-np` 를 auto 로 두면 슬롯 4개 **와** `kv_unified=true` 가 함께 켜지고,
`kv_unified` 하에서는 `n_ctx_seq = n_ctx`(`llama-context.cpp:292`) 라 KV 풀이
공유되어 **실제로 곱해진다.** 즉 옛 주장이 경고하던 상황은 `-np` 를 **올리는**
경우가 아니라 **떼는** 경우였다. 명시적 `-np` 는 `kv_unified` 를 끄는 쪽 분기로
가므로(`llama-context.cpp:290-292`) 이 플래그는 여전히 load-bearing 이고,
근거만 바뀌었다.

**수정 2 — `-c` 를 슬롯 수만큼 곱한다** (`buildServerArgs`). `-c` 는 슬롯 전체
합계이므로, 그대로 넘기면 `parallel: 2` 설정 시 사용자의 **작업 메모리가 조용히
절반으로 줄어든다.** `contextSize` 는 이 프로젝트 내내 per-slot 의미
(config.yaml, tuning.ts 의 VRAM 예산, 컴팩션 임계값 전부) 이므로, llama.cpp 과
의미가 달라지는 **이 경계에서만** 곱한다. `-no-kvu` 도 명시적으로 추가했다.

**수정 3 — `/reset` diff 라벨.** "슬롯 수" → "슬롯 수 (컨텍스트는 슬롯당 값)".
contextSize 가 per-slot 이므로, 슬롯을 2로 올리면 diff 가 "컨텍스트 절반으로 감소"
처럼 보여야 한다.

테스트: `-c` 곱셈 3건, kv_unified 명시 1건, rationale 교정 2건 추가.
`npm run check` **1023 tests pass**, 하네스 4종 PASS.

---

## 5.6 T6 / T1 구현 완료 + 측정값 오염 발견 (2026-10-02)

### ⚠ 가장 중요: 앞선 모든 지연시간 수치는 신뢰할 수 없다

마지막에 슬롯 경합을 확인하는 측정기를 만들었고, **앞서 기록한 수치들이 대부분
오염되어 있음이 드러났다.**

```
서버 로그가 보고하는 사용자 라이브 세션의 실제 디코드: 22.67 t/s
제 이전 벤치마크가 보고한 값                      : 13 ~ 81 tok/s  (6배 편차)
```

`-np 1` 이므로 디코드 슬롯은 **하나**이고, 두 클라이언트가 이를 공유한다. 살아있는
세션과 내 요청이 번갈아 큐를 서면서 서로를 방해했다.

중요한 건 편차의 **원인이 확인되었다**는 점이다 — 측정기마다 컴팩션 프롬프트의 요약
출력이 **19~446 토큰**으로 wildly 달랐는데, 이는 모델의 자유도가 아니라
**몇 초가 더 배정되었는지**의 함수였다. 짧은 출력을 받은 회차의 "tok/s" 가 높게
계산됐다.

→ **`npm run check` 외의 이 문서에 있는 모든 wall clock 수치는 유휴 슬롯에서
다시 측정해야 한다.** §3.1 의 "5회 반복 중앙값" 은 이 함정을 못 잡는다 —
중앙값이 조용히 오염된다. §3.2 에 슬롯 유휴 확인을 필수 항목으로 추가할 것.

실측(슬롯 유휴 확인 포함, 4회):

```
run 1: 5,628 ms  ~120 tok  21.3 tok/s
run 2: 2,273 ms   ~45 tok  19.8 tok/s
run 3: 1,350 ms   ~19 tok  14.1 tok/s
run 4: 1,097 ms   ~19 tok  17.3 tok/s
median 19.8 tok/s (min 14.1, max 21.3)
```

즉 **이 머신의 실제 디코드는 ~20 tok/s** 이며, 1024 토큰 요약은 **순수 디코드로
~51 초**다. 앞서 "27~31 초"로 기록한 값은 과소평가였고, D2 시간 상한의 상대적
가치는 그만큼 더 크다.

### T6 — 유휴 시간 컴팩션 구현 완료

`compaction.warmTriggerRatio` (미설정 시 비활성, opt-in).

설계상 핵심은 "임계값을 낮추는 것"이 **아니라** 라는 점이다:

- 턴 중간(`maybeCompact`, 도구 호출 사이)의 판정은 **여전히 `autoTriggerRatio`**.
  이것을 낮추면 조기 발동은 늘어도 차단은 그대로고, 전체 발동 빈도만 늘어납니다.
- 새 경로(`maybeWarmCompact`)는 **`warmCompactIfNeeded` 로서만** 도달됩니다.
  즉 UI 가 턴 종료 시 딱 한 번 부르는 자리에서만, 임계값 **아래에서** 먼저 돌 수
  있습니다. 턴 도중에는 절대 새 경로가 발동하지 않습니다.

`warmTriggerRatio >= autoTriggerRatio` 인 설정은 무의미하므로 일반 경로로 위임합니다.
그렇게 해야 "임계값보다 높게 설정했는데 조기 발동"이라는 모순이 생기지 않습니다.

트레이드(숨기지 않음): 더 일찍 컴팩션하면 **더 짧은 대화**를 요약하므로 요약 품질이
내려가고 다음 컴팩션이 sooner에 옵니다. 그래서 config knob 이고 기본값이 비활성입니다.
"무료 승리"가 아닙니다.

테스트 4건: 미설정 시 기존 동작 유지, 임계값 이상 시 위임, 상한 초과 시 중복 발동
없음, 유휴 경로가 실제로 측정 후 판정.

### T1 — 좁혀진 범위로 배선 완료 (플래그), 효과는 미측정

`llama.speculativeTypes` / `llama.speculativeDraftNMax` → `--spec-type` /
`--spec-draft-n-max`. draft 모델이 필요 없는 `ngram-mod` / `ngram-simple` 계열.

**기본값 비활성** — 이득이 워크로드 의존적이고 실측이 필요하므로, 코드 리뷰만으로
디폴트를 켜는 것은 §6.3 이 금지한다. 효과는 VRAM 여유가 없어 여전히 미측정이다.

---

## 5.7 T0-5 — 고정 픽스처 코퍼서스 구축, 그리고 그 과정에서 잡은 함정 3개 (2026-10-02)

§5 T0-5 의 "픽스처 없으면 §3.3 품질 측정이 불가능해져 **전체 연구가 무효**" 를
해소했다. `src/compaction/fixtures/compaction-fixtures.ts` + 측정기
`scripts/compaction_bench.ts`.

### 코퍼서스 구성

| 픽스처 | 잡아야 하는 실패 모드 |
|---|---|
| `tool-heavy-shell-failures` | 도구 호출이 많은 실제 세션의 표준 형태 |
| `user-constraints-and-decisions` | 명시적 제약 — 예산을 줄였을 때 **가장 먼저** 사라지는 것 |
| `unfinished-task-in-flight` | "완료"와 "진행 중"의 구분. 이걸 잃으면 다음 턴이 하지 않은 일을 완료했다고 보고한다 |
| `low-value-bulk` | 압축해도 손해가 없는 대량 잡음. 이것이 없으면 스윕이 "많을수록 좋다"만 결론 낼 수 있다 |

각 픽스처는 요약이 **반드시 보존해야 할 사실**을 담고, 점수는 그 사실의 유지율로
자동 산출된다(`scoreSummary`). 사람의 주관 채점을 배제하기 위함이다 — 그래야 예산
설정 사이에 "품질"의 정의가 조용히 바뀌지 않는다.

### 함정 1 — 전 픽스처 retention 0%

첫 실행 결과가 이랬다:

```
tool-heavy-shell-failures      retention   0%   lost: npm test / src/parse.ts:42 / ...
user-constraints-and-decisions retention   0%   lost: 전부
...
```

모델이 사실을 잃은 게 아니었다. 실제 요약 내용은 이랬다:

```
"There is no prior conversation provided to summarize."
```

원인: **`toSummarize` 가 비어 있었다.** `selectKeptTail` 은 크기 예산만큼 tail 을
통째로 남기는데, 8메시지짜리 픽스처는 수백 토큰이라 100% tail 에 들어가고 요약
대상인 `[system] + 빈 배열` 만 남았다. **측정 대상이 하나도 없는 상태였다.**

이게 §3.3 이 존재하는 이유 그 자체다. 픽스처가 조용히 "요약할 것이 없는" 상태가
되면, 그건 픽스처가 없는 것보다 **나쁘다** — 모든 설정에서 0% 가 나오면
"요약은 항상 사실을 잃는다" 처럼 읽히고, 거기서 **어떤 결론이든** 도출할 수
있기 때문이다.

### 함정 2 — 창(window) 크기에 따라 코퍼서스가 다시 비었다

패딩을 추가해 해결한 뒤, 40960 창에서 다시 `toSummarize` 가 0 이 되었다.

```
window 16384  ->  toSummarize  6~7 msgs   OK
window 40960  ->  toSummarize  0 msgs     다시 무효
```

tail 예산이 창에 비례해서(0.4 × 75%) 커지기 때문. **16k 기준으로 맞춘 패딩은
40960 에서 전부 tail 에 들어간다.**

→ 패딩을 **가장 큰 창** 기준으로 다시 잡고, 회귀 테스트로 고정:
`every fixture has something to summarize at every plausible window size`.

### 함정 3 — 사실이 tail 에 남으면 100% 로 헛점수

여기서 더 나쁜 함정이 있었습니다. `toSummarize` 가 비어 있는 것은 실패가 명확한데,
반대 경우는 조용합니다. 평가해야 할 사실이 **kept tail 안에 있으면** 요약이 뭘
했든 100% 로 나옵니다. tail 보존을 측정하게 되는 셈입니다.

→ 회귀 테스트로 고정:
`each fixture's mustPreserve facts actually fall inside the summarized region`.
이를 위해 패딩을 의미 있는 턴의 **앞뒤 양쪽**에 배치했습니다(중간 배치). 끝에만
붙이면 tail 이 그대로 삼켜버립니다.

### 함정 4 — 측정을 돌릴 수 없게 만드는 크기

마지막으로, 채워우느라 과하게 크게 만들었다가 벤치가 아예 **실행 불가**가 됐습니다:

```
Error: chat stream failed: 400 request (65946 tokens) exceeds the available context
size (40960 tokens)
```

`runCompaction` 의 입력 트리밍 루프(`compactor.ts`)는 문자 기반 추정으로 예산을
계산하는데, 그 추정이 서버 실제 토크나이저보다 **약 20% 낮다** (실측: 추정 ~55k →
실제 65,946). 즉 "창을 꽉 채우는" 크기의 코퍼서스는 실제로는 창을 넘고, 잘못된 수치를
보고하는 대신 **아예 죽는다.**

→ 하한(넘어야 함)과 **상한(돌아서 안 됨)** 을 둘 다 명시하고 테스트로 고정.

이 함정들은 전부 "측정이 조용히 무의미해지는" 종류라서, §3.3 의 채점 절차에
다음 확인을 추가할 것을 권고한다:

- 요약 요청이 실제로 **비어 있지 않은가**
- 평가 대상 사실이 **요약 대상 영역 안에 있는가** (tail 안에 있으면 100% 헛점수)
- 요약 요청이 **창 안에 들어가는가** (실측 토크나이저로 확인, 추정으로 판단 금지)

---

## 5.8 T3 첫 실행 결과 — 측정 자체가 성립하지 않음을 확인 (2026-10-02)

픽스처 코퍼서스로 요약 예산 스윕(256 / 512 / 1024)을 돌렸고, **결과가 물리적으로
불가능한 모양**이라 원인을 추적했습니다.

```
budget   fixture                       median ms   retention
   256   tool-heavy-shell-failures       72718         33%
   256   user-constraints-and-decisions    78292        100%
   256   unfinished-task-in-flight       80832          0%
   256   low-value-bulk                  92347        100%
   512   tool-heavy-shell-failures        9648         67%
   512   user-constraints-and-decisions     6077         50%
  1024   user-constraints-and-decisions     5033         25%     <- 예산이 늘었는데?!
  1024   unfinished-task-in-flight       47698          0%
```

**예산을 2배로 늘렸는데 retention 이 떨어졌다.** 요약 품질이 예산에 반비례할 수는
없습니다. 원인을 추적한 결과 **두 가지Measurement 결함**이었습니다.

### 함정 5a — wall clock 이 "요약 예산" 이 아니라 "프롬프트 캐시 상태" 를 측정

256 토큰 구간이 **72~92 초**, 1024 토큰 구간이 **5 초** 라는 게 요약 예산과 정반대
입니다. 이유: 각 픽스처의 요약 요청은 **약 19k 토큰의 prefill** 을 필요로 하는데, 이것이
픽스처별로 **처음 한 번만 콜드**로 돌아가고 이후는 llama-server의 prompt cache 가
서빙합니다.

```
256 토큰: 72.7s / 78.3s / 80.8s / 92.3s   <- 전부 각 픽스처의 첫 실행(콜드 prefill)
512 토큰:  9.6s /  6.1s / 26.4s /  7.9s   <- 전부 캐시 적중
1024 토큰: 9.4s /  5.0s / 47.7s / 19.1s   <- 대부분 캐시 적중, 단 47.7s 는 또 콜드
```

즉 표의 ms 열은 **요약 생성 시간이 아니라 prefill 캐시 상태**를 읽고 있습니다.

이것이 문서 §1.2 의 "지연은 100% decode 다" 와 모순처럼 보이지만 모순이 아닙니다.
§1.2 의 전제는 **"직전 턴이 끝난 직후"** 이고, 그때는 요약 요청의 prefix 가
**방금 처리한 턴의 verbatim prefix** 라 캐시가 맞습니다. §1.2 가 이미 그렇게
설명합니다:

> The summary request's [system] + toSummarize is a VERBATIM PREFIX of the turn
> that just ran, so llama-server's prompt cache serves essentially all of it

즉 **프로덕션에서 prefill 가 ~0 인 것은 컴팩션의 설계(같은 prefix 재사용) 덕분**이지,
본질이 아닙니다. 벤치가 그 설계를 우회하니 prefill 가 지배적이 됩니다.

→ **벤치 수정을 요구:** 모든 측정에서 캐시 상태(콜드/웜)를 명시하고, 콜드 prefill 이
포함된 값은 decode 비교에 쓸 수 없다.

### 함정 5b — n=1 이고 샘플링이 켜져 있다

`runCompaction` 은 temperature 를 지정하지 않고, 이 서버의 기본값은 1.0 입니다
(`/props` 의 `default_generation_settings.sampling.temperature` 로 실측). 4개 사실짜리
코퍼서스를 **1회**만 돌렸으므로, 1024의 25% 와 512의 50% 차이는 그냥 표본 잡음입니다.

§3.2 의 "5회 반복 후 중앙값" 은 여기에 더해, **temperature 0 또는 고정 시드** 없이는
요약 품질을 측정할 수 없다는 조건이 필요합니다.

### 결론: T3 는 아직 판정 불가

이번 실행으로 판정할 수 있는 것은 **"1024 토큰이 기본값으로 정당하다"** 도
**"512 로 낮춰라"** 도 **아니다**. 필요한 조건:

1. 캐시 상태를 통제하거나 기록 (같은 픽스처를 워밍업한 뒤 측정)
2. 반복 횟수 증가 + temperature 0 또는 시드 고정
3. §3.3.1 의 세 가지 검증 통과 (구현 완료)

이 조건이 갖춰지면 스윕은 **처음으로** 의미 있는 데이터를 낸다. 그전까지는
어떤 결론도 근거가 없다.

---

## 5.9 T3 재실행 (워밍 + 2회 반복) — 그리고 **앞서 준 권고가 틀렸음이 확인됨** (2026-10-02)

측정기 결함(§5.8)을 고치고 재실행: 콜드 prefill 을 워밍업으로 버리고, 슬롯 유휴를
확인하고, 픽스처당 2회 반복.

```
budget   fixture                       ms med   retention samples
    256   tool-heavy-shell-failures       14015             [33, 33]
    256   user-constraints-and-decisions   14086             [75, 50]
    256   unfinished-task-in-flight        13931               [0,  0]
    256   low-value-bulk                   12170            [100,  0]
    512   tool-heavy-shell-failures        8550             [33, 33]
    512   user-constraints-and-decisions   13240           [100, 100]
    512   unfinished-task-in-flight        12975               [0,  0]
    512   low-value-bulk                   12810               [0,  0]
   1024   tool-heavy-shell-failures       13794             [33, 67]
   1024   user-constraints-and-decisions   13430             [25, 25]
   1024   unfinished-task-in-flight        21045               [0,  0]
   1024   low-value-bulk                   29052            [100,  0]
```

### ⚠ 가장 중요한 발견: 요약 예산은 지연시간을 지배하지 않는다

**wall clock 이 예산에 따라 변하지 않는다.**

```
user-constraints:  256 tok -> 14,086 ms
                   512 tok -> 13,240 ms
                  1024 tok -> 13,430 ms
```

예산을 4배로 늘려도 시간은 같다. 이유는 명확하다 — **모델이 예산을 채우지 않는다.**
요약은 모델이 쓰고 싶은 만큼 쓰고 끝낸다. `summaryMaxTokens` 는 **상한이지 목표가
아니며**, 실제로는 거의 걸리지 않는다.

**이는 이 프로젝트가 앞에서 내린 권고가 틀렸다는 뜻이다.** "요약 예산을 512 로
내리면 27초 → 13.5초" 라는 계산은, 예산이 **발생량** 을 결정한다는 전제였는데
**상한일 뿐** 이었다. 실측상 예산 축소는 지연을 줄이지 못한다.

앞으로 이 값을 근거로 삼는 사람이 있을 수 있으므로 여기에 명시한다:

> ❌ "summaryMaxTokens 를 512 로 낮추면 컴팩션 지연이 절반이 된다"
> ✅ "summaryMaxTokens 는 지연의 상한이며, 현재 이 모델은 그 상한에 도달하지 않는다.
>    지연을 줄이려면 **생성되는 토큰 수** 를 줄여야 하고, 그 수를 결정하는 것은
>    예산이 아니라 **요약 프롬프트** 다."

즉 T3 이 "기본값 1024 가 맞느냐" 라는 질문이 아니게 된 이유가 이것이고, 다음
질문으로 바뀐다: **요약 프롬프트가 왜 그만큼 쓰게 하는가** (길이, 형식 지시,
`mustPreserve` 절 포함 여부, thinking 여부).

### 두 번째 발견: retention 은 예산에 대해 단조롭지 않다

```
user-constraints:  512 tok -> 100%, 100%
                   1024 tok ->  25%,  25%
```

예산을 늘렸는데 verbatim 유지율이 떨어졌다. `tool-heavy` 도 33/33 → 33/67 로 흔들린다.

후보 설명은 셋이며, **이 데이터로는 구분되지 않는다**:

1. 표본 잡음 (temperature 1.0, n=2)
2. 긴 예산에서 모델이 **요약 앞에 일반 설명을 먼저 붙이고** 사실이 뒤로 밀림
3. 요약 형식이 달라지며 scorer 가 못 찾는 문장으로 전환

§3.2 의 단조성 규칙("예산을 늘려 요약이 나빠질 수 없다")이 이렇게 깨진 이상,
**n=2 로는 예산 랭킹 자체가 불가능** 하다. `REPEATS=5` + temperature 0 없이는
어떤 순위도 근거가 없다.

### 세 번째 발견: scorer 의 근시안 — 0% 가 "손실" 인지 "각색" 인지 구분되지 않는다

`unfinished-task-in-flight` 는 **6/6 전부 0%** 로, 예산과 무관하게 완전히 일관된다.
이것은 표본 잡음이 아니라 **구조적**이다.

그런데 `scoreSummary` 는 **정확히 일치하는 부분 문자열** 만 찾는다. 모델이

```
"3번째 파일은 아직 수정되지 않았다"
```

라고 쓰면 `"아직 수정 안 됨"` 과 일치하지 않아 0% 로 계수된다. 즉 **6/6 일관된 0%
는 "요약이 사실을 잃는다" 와 "요약이 사실을 각색했다" 를 구분할 수 없다.**

코퍼서스가 자동 채점인 장점(예산 간 판정 기준 불변)이 이 한계와 맞물린다.
→ **다음 단계에서 반드시 할 일:** `unfinished-task-in-flight` 의 실제 요약 텍스트를
읽어 0% 가 각색인지 손실인지 판정. 손실이면 T6(유휴 컴팩션, 더 이른 압축)의 위험이
실제로 더 커지므로 구현 결정을 재검토해야 한다.

### T3 최종 판정

**여전히 판정 불가.** 이번 실행이 산출한 것은 판정보다 **잘못된 전제 하나**
(예산이 지연을 지배한다)와 **하네스의 한계 하나**(각색을 손실로 계수)다.

이미 확정되어 있는 것:
- 요약 예산은 현재 지연의 **결정 변수**가 아니다 (실측)
- 비동기화·계산 최적화는 0.02% (§4.6, 확정)
- 시간 상한(D2)과 유휴 선행(T6)만 실제로 시간을 건드린다 (구현됨)

## 5.10 T1 검토 결과 — vLLM 주장이 요약에 **전환되지 않는다** (2026-10-02)

### 검증한 것

vLLM PR #25784(suffix decoding)의 원문:

> "In practice, we have seen larger speedups for real user interactions and
>  agentic requests, since they tend to exhibit more output repetition than
>  these benchmark datasets."

여기서 "출력 반복"은 **반복 tool call·유사 코드**를 뜻합니다. 요약은 다른 모양입니다.
모델이 **자기 입력을 압축**하므로, 요약에 존재할 수 있는 반복은 "입력 인용"뿐입니다.

그리고 llama.cpp 의 n-gram 추측이 실제로 무엇을 매칭하는지는 소스로 확인했다:

```
common/speculative.cpp:1925-1926   begin()      : 프롬프트 전체 n-gram 을 해시 테이블에 색인
common/speculative.cpp:1972       draft_one()  : 마지막 n토큰으로 조회, 그 뒤에 온 것들을 제안
common.h:352-356                  n_match=24 (토큰), n_max=64
```

즉 **"마지막 24토큰을 이전에 본 적이 있는가"** 라는 질문이므로, 표면 문자열 재사용률로
오프라인 상한을 계산할 수 있다 — 서버 재시작도, 두 번째 모델도 필요 없다.

### 측정 (control 100% = 프로브 정상, 실제 요약 4개)

```
  fixture                        summary   n=8   n=12   n=16   n=24   n=32
  tool-heavy-shell-failures         541ch   18%     8%     3%     0%     0%
  user-constraints-and-decisions   1010ch   12%     7%     5%     2%     1%
  unfinished-task-in-flight        2039ch    7%     5%     4%     2%     1%
  low-value-bulk                    388ch    2%     1%     0%     0%     0%
```

**판정: T1 근거 없음.** 가장 짧은 창(8자)에서도 2~18%이고, n=24에서 0~2%다.
llama.cpp 의 `n_match=24` 는 **토큰** 이므로 영문에서 100자 이상이고, 커버리지는
그 훨씬 전에 이미 0 이다. 즉 이 측정 구간 자체가 **낙관적**이며 실제 동작 지점에서는 0.

**이전의 "narrowed 로 플래그만 배선했다"는 결정은 유지하되 근거를 이 것으로 교체한다.**
vLLM 의 주장은 agentic *출력* 반복에 관한 것이고, 압축-인용에는 해당하지 않는다.

### 단, 이 측정이 못 덮는 것 (공정한 한계)

- **`ngram-map-k` 계열은 측정하지 않았다.** 이쪽은 `min_hits` 기반 빈도 맵이라
  vLLM 의 suffix decoding(접미사 트리 + 빈도) 에 **더 가깝다.** 위 측치는
  정확한 창 일치(llama.cpp `ngram-mod`) 만 상한으로 구한 것이므로
  **suffix 계열을 반박하지 않는다.** 남는 질문.
- 실측이 아니라 **상한 계산**이다. llama.cpp 가 실제로 이 상한을 달성하는지는
  별개이며, 두 번째 서버가 필요해 이 머신에서 못 했다.

---

## 5.11 ★ 부수 발견: 6/6 이던 `unfinished-task-in-flight` 0% 는 **측정 오류였다**

§5.9 에서 "구조적이며 각색인지 손실인지 판별 못 한다"고 남겨둔 항목. 요약 본문을
직접 읽어서 판별했다.

픽스처의 보존 대상 사실과 모델의 실제 요약:

```
픽스처 mustPreserve        모델이 실제로 쓴 요약
──────────────────         ─────────────────────────────
"아직 수정 안 됨"      →   "File 3 was unmodified",
                           "It has not actually modified the code yet."
"3번 파일에서 중단"      →   "work was interrupted after File 3"
"다음 단계는 프로파일링"   →   "the next step is to re-run profiling"
```

**세 사실이 모두 의미론적으로 보존되어 있다.** `scoreSummary` 가 0% 를 낸 이유는
scorer 가 **정확히 일치하는 부분 문자열** 만 찾기 때문이고, 모델이 **한국어를 영어로
의역** 해서 쓴 것이다. 도구 결과는 무관, 컴팩션 요약은 성공이었고 **6/6 0% 는
scorer 가 언어를 구분 못 해서 낸 것이었다.**

**§5.9 가 경고한 "피처 간 단조성 깨짐"의 실제 원인은 이거였을 가능성이 높다.**
영어 의역 요약이 한국어 원문과 매칭되지 않으면, 예산을 늘린 행이 우연히 한국어를
더 많이 인용했기 때문에 retention 이 "올랐다" 것처럼 보인다. 즉 그 표의 변동은
품질 신호가 아니라 **언어 불일치**였다.

### 이것이 실제로 바꾸는 것

1. **T6 의 위험도는 낮다.** §5.9 에서 "진행 중 상태가 사라지면 일찍 압축할수록
   손실이 커진다"고 적었으나, 실측상 진행 중 상태는 요약에 살아 있다.
   `warmTriggerRatio` 는 기본 비활성인 채로 두되, 근거가 "품질 위험"이 아니라
   "빈번한 압축" 쪽으로 옮겨 간다.
2. **scorer 의 한계가 더 크게 문제가 되었다.** 한국어 픽스처 + 영어 요약 조합에서
   verbatim 점수는 사실상 **언어 감지기**가 된다. 코퍼서스가 "요약이 무엇을 담고
   있는가"를 재는 도구로는 쓸 수 없다는 뜻이다.

### §3.3 에 추가해야 할 조건

> **채점 언어와 픽스처 언어가 다르면 verbatim 점수는 무의미하다.** 요약 모델이
> 입력 언어를 의역/번역하는지 먼저 확인하고, 그렇다면 (a) 점수를 무효화하거나
> (b) 요약에 **언어 고정 지시**를 넣고 재측정한다. 이것은 요약 프롬프트의 개선
> 후보이기도 하다 — 사용자가 한국어로 말하는데 요약이 영어면 다음 턴이 영어로
> 이어받는다.

**이것이 지금 남아 있는 가장 실행 가치 높은 후속 작업이다.** 추측 디코딩(T1)과
달리 서버·모델 추가 없이, 프롬프트 수정 + 재측정만으로 검증 가능하다.

## 5.12 요약 언어 고정 — 구현 및 실측 (§5.11 의 후속) (2026-10-02)

`SUMMARY_INSTRUCTION` 에 언어 규칙을 추가했다. 캐시 prefix 속성은 안전하다 — 이
문장은 **뒤쪽 user 메시지** 안이고 system message 를 건드리지 않으므로, 컴팩션의
prefill 절약(§1.2 의 ~0.3 s) 이 그대로 유지된다.

```
"Write the summary in the same language the conversation above is written in" +
(hasConversationLanguage ? "" : ", or in your own output language if the conversation has none") +
". Keep any quoted user text in its original language."
```

두 가지 규칙을 분리한 이유: **의역 언어는 대화 언어**를 따르고, **인용문은 원어 그대로**
여야 한다. 번역된 제약은 누구도 말하지 않은 제약이다. 이미 모델이
`"한국어로만 응답해. (Respond only in Korean.)"` 형태로 정확히 하고 있었으니,
언어 규칙이 "번역해도 된다"는 신호로 읽히지 않게 한 것이다.

`hasConversationLanguage` 은 **요약 대상 구간의 user 턴** 만 본다 — 언어를 고르는
것은 사용자이지 도구 출력이 아니므로.

### 실측 (라이브 서버, 4개 한국어 픽스처)

```
  fixture                         hangul%   chars      ms   verbatim retention
  tool-heavy-shell-failures           21%    1085   23297   33%
  user-constraints-and-decisions      79%     205    7866   50%
  unfinished-task-in-flight           78%     469   15841   33%
  low-value-bulk                      10%     815   16080   100%
```

변경 전 hangul 비율은 사실상 0 이었다(요약 전문이 영어였으므로). 이제 대화 언어를
따른다. `tool-heavy` / `low-value-bulk` 가 10~21% 인 것은 **의도된 동작**이다 —
두 픽스처는 대화의 대부분이 도구 로그이고 사용자 발화는 한국어 몇 줄뿐이라,
요약이 그 한국어 구절만 원어로 인용하고 나머지는 영어로 서술한다.

`unfinished-task-in-flight` 요약이 이제 **"아직 수정 안 됨"** 을 그대로 포함한다.
§5.11 에서 6/6 이던 0% 가 채점 문제였음이 여기서 재확인된다.

### ⚠ 지연시간에 대한 영향은 **없다** (정직하게)

```
변경 전 요약 길이(chars):  541 / 1010 / 2039 / 388
변경 후 요약 길이(chars): 1085 /  205 /  469 / 815
```

길이가 엇갈린다. §5.9 에서 확정한 "지연의 유일한 결정 변수는 **생성 토큰 수**" 라는
사실과 합치면, 이 변경은 **지연에 대한 개선이 아니다.** 품질/일관성 개선이다.

n=2 표본으로는 판단할 수 없지만, 어느 방향도 "일관된 감소" 가 아니다. 이 문서를
읽는 사람이 이걸 지연 개선으로 오해하지 않도록 여기에 명시한다.

---

## 5.13 T3 준비 과정에서 발견한 프로덕션 버그 1건 + scorer 개선 (2026-10-02)

### 버그: 컴팩션 요약 요청에 `repeat_penalty` 가 없었다

메인 턴 요청은 보낸다:

```
src/agent/loop.ts:824     repeat_penalty: this.opts.repeatPenalty ?? 1.1
src/backend/types.ts:47    "a bare launch of llama-server defaults this to 1.0 (off)
                            — confirmed live via GET /slots — which lets a degenerate
                            loop repeat the same phrase verbatim until max_tokens
                            cuts it off instead of self-correcting."
```

**컴팩션 요약 요청은 아무것도 보내지 않았다.** 동일한 노출에 보호 없음.

메인 턴에서 이게 왜 무거운지는 문서가 잘 설명하는데, **요약에서는 더 무겁다**:

- 반복 루프에 빠지면 **요약 예산 전체를** 같은 문장 반복에 쓴다
- 그 반복은 `trimPartialSummary` 에 "문단"처럼 들어가고, 문단 경계로 자르면
  반복문 하나가 요약 전체가 된다
- 요약은 **버린 히스토리를 대체**하므로, 내용이 없는 요약은 압축 실패가 아니라
  **압축이 없는 것**과 같다

추측 디코딩 쪽에도 같은 이유가 있다 — llama.cpp 의 `ngram_mod` 은 점유율이 0.25 를
넘으면 테이블을 리셋하는 방어를 두는데(`common/speculative.cpp:1934-1938`), 그 방어
대상은 바로 이런 퇴화적 반복이다.

→ `runCompaction` 이 `repeatPenalty` 를 받아 요청에 싣도록 수정. 기본값은 메인 턴과
같은 1.1 (`DEFAULT_REPEAT_PENALTY`), `loop.ts` 가 자신의 설정값을 그대로 넘긴다.

**이건 벤치마크 때문에 찾은 게 아니라, 벤치마크를 준비하다 발견한 프로덕션 버그다.**

### scorer 개선: 한국어 굴절

언어 고정(§5.12)으로구패모어 문제해결 후 남은 것은 **같은 언어 안의 굴절**이었다:

```
픽스처:  "3번 파일에서 중단"
모델:    "3번째 파일에서 중단"      -> 이전엔 손실로 계수
```

`mustPreserve` 를 `string | string[]` 로 바꿔 **동치인 표현을 명시적으로 선언**하게
했다. 자동으로 "알아듣지" 않게 한 이유: 변형 추가는 감사가 필요한 결정이어야 하고,
판단이 느슨해지면 결국 모든 예산이 100% 가 된다. 세 가지 테스트로 고정:

- 선언한 변형 중 **하나라도** 나오면 통과
- 무관한 요약은 여전히 0%
- **bare string 은 엄격 유지** — 변형을 쓴 픽스처 옆에 있어도 관대해지지 않음

## 5.14 T3 최종 결론 — **판정 불가, 그리고 그것이 결론이다** (2026-10-02)

반복 3회, 워밍업, 스크러 언어 고정, 굴절 변형, `repeat_penalty` 수정까지 반영한
상태에서 예산 스윕을 다시 돌렸다.

**픽스처별 retention 샘플 (동일 예산 3회):**

```
                          256                     512                     1024
tool-heavy          [33, 67,100]          [67, 67, 67]          [33, 67, 67]
                    med  67%              med  67%              med  67%

user-constraints   [50,100,100]          [50,100,100]          [50, 50, 50]
                    med 100%              med 100%              med  50%

unfinished-task      [0, 33, 67]          [ 0,  0, 67]          [33,100,100]
                    med  33%              med   0%              med 100%

low-value-bulk    [ 0,100,100]          [ 0,100,100]          [ 0,100,100]
                    med 100%              med 100%              med 100%
```

**동일 픽스처 · 동일 예산에서 retention 이 0% ~ 100% 를 오간다.** 위 표에서
`unfinished-task-in-flight` 는 256 예산에서 [0, 33, 67], 512 에서 [0, 0, 67],
`user-constraints` 는 1024 에서 [50, 50, 50] 인 반면 256/512 에서 [50, 100, 100].
같은 입력·같은 설정에서 저런 범위가 나온다.

이것이 의미하는 건 **랭크가 불가능하다** 는 것이다. 예산이 retention 에 미치는
효과크기가 **같은 예산 안의 표본 잡음보다 작다.** 예산이 무엇이든 retention 은
0~100% 범위를 돌아다니고, 그래서 어떤 두 예산을 비교해도 "이게 더 좋다"는
결론이 데이터에서 나올 수 없다.

참고로 중앙값만 보면 1024 가 가장 나아 보인다(가장 높은 중앙값 + 가장 좁은
분포). **하지만 이것으로 1024 를 "최적"으로 지목하지 않는다** — 1024 는 이미
기본값이므로, 거기에 대한 사전 편향과 n=3 표본이 겹친다. 1024 가 더 나아 보인다는
관측은 "1024 가 나쁘지 않다" 를 의미할 뿐, "1024 가 최적이다" 가 아니다.

### 그래서 남는 결론

**기본값 1024 를 그대로 둔다.** 바꿀 근거가 없고, "512 로 낮추면 요약 품질이
떨어진다"는 것도 보여주지 못했다. §5.9 에서 이미 확정했듯 예산은 지연의 결정
변수가 아니다(지연의 유일한 결정 변수는 생성 토큰 수). 그러므로 **기본값을
낮춰 얻을 지연 이득도 없다.** 양쪽 다 근거가 없다 → 움직이지 않는 것이 옳다.

이건 **"판정을 미뤘다"** 가 아니라 **"이 방법으로는 판정할 수 없다"** 라는
결론이다. 요약 예산은 이 머신·이 모델·이 설정에서 **측정 불가능한 변수**다.

### 왜 그런가 (측정 그 자체의 구조적 한계)

`runCompaction` 은 temperature 를 지정하지 않고 이 서버의 기본값은 **1.0** 이다.
즉 동일 입력에도 매번 다른 요약이 나온다. 4개 픽스처의 retention 은 각 25~100%
범위에서 움직이는 값이므로, 예산 차이를 드러내려면 표본 수가 예산 간 차이보다
**훨씬** 커야 한다. 그것은 실용적이지 않다.

확정하려면 다음이 필요하고, 어느 것도 "설정값 하나를 바꾸면 끝"이 아니다:

1. 요약 요청에 `temperature: 0` (또는 고정 시드) — 결정론 확보의 전제
2. 그 위에 충분히 큰 표본 수
3. 그리고 **여전히** 예산이 유일한 변수로 남아야 함 (생성량·언어·프롬프트는
   이미 고정되어 있음)

`temperature: 0` 은 컴팩션 요약에 **합리적으로** 보이는 선택이다 — 요약은 창작이
아니고 사실 압축이므로. 다만 이는 **제품 결정**이며 측정 편의를 위한 변경이
아니므로, 근거 없이 기본값으로 넣지 않았다. 여기서는 제안만 남긴다.

---

## 5.15 전체 조사 결과 요약 (2026-10-02, 조사 종료 시점)

| 트랙 | 결과 | 근거 |
|---|---|---|
| **T0-2** VRAM 산술 | T4 폐기 | 가용 -0.84 GiB. 살아있는 세션이 7.18 GiB 점유 |
| **T0-4** 추측 플래그 | 문서 이름 오류 정정 | `--draft` 는 제거됨. `ngram-mod` 계열은 draft 불필요 |
| **T1** 추측 디코딩 | **근거 없음** | 커버리지 n=24 에서 0~2% (control 100%). §5.10 |
| **T2** 시간 상한 | **구현 + 실측** | `summaryDeadlineMs` |
| **T3** 요약 예산 | **판정 불가** | 동일 예산에서 retention 0~100%. §5.14 |
| **T5** vLLM | 실행 불가 | `/props` 의 `n_ctx` 미제공 → `getContextSize()` 경로 필요 |
| **T6** 유휴 선행 | **구현 + 테스트** | `warmTriggerRatio` |
| **T7** -np/-c | **구현 + 테스트** | 근거 교정, per-slot `-c` 배선 |

부수 발견 (프로덕션 변경):

- **`compaction.summaryMaxTokens` 가 죽은 코드였다** (§4.5) — 배선 완료
- **요약 요청에 `repeat_penalty` 없었음** (§5.13) — 수정 완료
- **요약이 영어로 출력됨** (§5.11/5.12) — 언어 고정 완료
- **`tuning.ts` 의 `-np` 근거가 소스와 불일치** (§5.5) — 교정 완료

### 지연시간에 대해 확립된 것 (이게 핵심)

1. 지연은 **생성 시간**이다. 비차감 작업 합계 6.3 ms → **async 상한 0.02%**.
   병렬화·비동기화로는 개선 불가.
2. 요약 예산은 **지연의 결정 변수가 아니다.** 예산은 상한일 뿐이고 모델이
   채우지 않는다(256→1024 토큰에서 시간 동일).
3. **유일하게 시간을 건드리는 것**은 (a) 벽시계 상한, (b) 유휴 시간으로 이동.
4. 생성을 줄이려면 **요약 프롬프트**를 바꿔야 한다 — 아직 손대지 않음.
5. vLLM/llama.cpp 의 "agent loop 에 추측 디코딩" 주장은 **요약에 적용되지 않는다**
   (측정). 남는 예외는 `ngram-map-k` (빈도 맵, suffix 에 더 가까움) — 미측정.

## 6. 산출물 형식

### 6.1 최종 보고서 — `docs/compaction-latency-report.md`

```
## 1. 한 줄 결론
   (예: "T1 추측 디코딩으로 요약 지연 26.9s → 14.1s, 품질 하락 없음. T4 폐기.")

## 2. T0 사전 확인 결과
   표: T0-1 ~ T0-5 각각의 결과와, 실패한 항목이 어떤 트랙을 무효화했는지

## 3. 트랙별 결과
   각 트랙마다: 가설 / 실험 조건 / 측정 표 / §3.3 품질 점수 / 판정

## 4. 속도 vs 품질 트레이드오프 곡선
   (T3 필수. 가로축 = 요약 토큰 수, 세로축 = [지연, 압축률, 품질 점수])

## 5. 권고 안 — 등급별
   - 즉시 적용 가능 (설정 파일만)
   - 코드 변경 필요 (파일:라인 명시)
   - 채택하지 않음 — 근거

## 6. 배제한 가설과 그 근거
   (§1 의 측정값을 반복하지 말고, 각 트랙이 왜 실패했는지)

## 7. 재현 방법
   사용한 명령어·스크립트·모델·플래그를 그대로. 추측 금지.
```

### 6.2 채택 안의 조건

모든 수정은 다음을 만족해야 한다.

1. `npm run check` 통과 (typecheck + test + harness 4종)
2. **기존 테스트를 삭제해서 통과시키지 마라.** 실패한 테스트가 옳다면 테스트를
   고치고 그 근거를 보고서에 적어라.
3. 변경 위치는 `파일:라인`으로 명시
4. §3.1 의 지표를 **변경 전/후 양쪽**으로 기록
5. §3.3 품질 점수가 기준에서 떨어지지 않음
6. 주석과 커밋 메시지는 **왜 그 값인지**를 담을 것. 이미 이 저장소의 관례다
   (`compactor.ts` 의 실측 표기 참조)

### 6.3 금지

- 근거 없는 "최적화" 를 넣지 마라. §1.1 의 측정으로 0.02% 이하다.
- 설정 기본값을 근거 없이 바꾸지 마라. 바뀐다면 §3 의 수치가 붙어야 한다.
- **사용자의 살아있는 세션(포트 8084)과 `~/.llamacli/config.yaml` 을 건드리지 마라.**

---

## 7. 종료 조건

다음 중 하나가 성립하면 그 트랙은 종료하고 다음으로 넘어간다.

1. 성공 기준을 만족했다 → §6.2 에 따라 반영하고 보고서에 수치로 남긴다.
2. 실패를 **수치로 증명**했다 (§3.1 지표가 개선되지 않았다) → 폐기하고 근거를 남긴다.
3. 이 머신의 한계로 불가능하다 (VRAM, 모델 부재) → 산술과 함께 폐기 근거를 남긴다.

**"해봤는데 모르겠다"는 종료 조건이 아니다.** T4 가 그러면 T1+T2+T3 조합으로
승인을 확정하고, 무엇을 못 했는지 명확히 적어라.

---

## 8. 참고 위치

| 대상 | 경로 |
|---|---|
| 컴팩션 핵심 | `src/compaction/compactor.ts` |
| 체크포인트 | `src/compaction/checkpoint.ts` |
| 컴팩션 호출부 | `src/agent/loop.ts` (`enqueue:583`, `maybeCompact:1430`, `compact:1579`) |
| 토큰 추정 | `src/compaction/compactor.ts:162-257` |
| 하드웨어 튜닝 | `src/setup/tuning.ts` |
| 서버 기동 인자 | `src/backend/llamaServer.ts:79` (`buildServerArgs`) |
| OpenAI 호환 클라이언트 | `src/backend/openaiClient.ts` (`getContextSize`) |
| 설정 기본값 | `src/config.ts:134` |
| 설계 문서 | `PROMPT.md` §2 (컴팩션) |
| llama.cpp 소스 | `/home/jeano/llama.cpp` (`633733d`) |
| **품질 평가 코퍼서스** | **`src/compaction/fixtures/compaction-fixtures.ts`** |
| **예산 스윕 측정기** | **`scripts/compaction_bench.ts`** |
| 임시 실측 스크립트 | `/tmp/opencode/compact_bench.ts`, `compact_io_bench.ts`, `decode_contention.ts`, `t0_2_vram.ts` |

측정기 사용법:

```bash
# 슬롯 유휴 확인 + 워밍업 후 측정 (기본 1회 반복)
npx tsx scripts/compaction_bench.ts 256 512 1024

# retention 랭킹이 목적이면 반복을 늘릴 것 (§3.2: temperature 기본값 1.0)
REPEATS=5 npx tsx scripts/compaction_bench.ts 512 1024

LLAMA_URL=http://127.0.0.1:8080 npx tsx scripts/compaction_bench.ts 1024   # 다른 백엔드
```

**시작 전에 `PROMPT.md` §2 를 읽어라.** 컴팩션이 왜 이 모양인지(체크포인트 선기록,
요약, tail 보존, resume)의 설계 의도를 무시한 최적화는 되돌릴 수 없다.