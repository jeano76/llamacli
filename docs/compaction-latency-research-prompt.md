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
| 실효 tok/s | 생성 토큰 ÷ decode 구간 시간 | 38 tok/s 대비 개선폭 |
| accept rate (추측 디코딩) | vLLM 의 `mean accepted length` / llama.cpp 대응값 | 추측이 실제로 맞는지 |
| **요약 품질** | §3.3 의 절차 | 없으면 개선이 아님 |
| 컴팩션 발동 빈도 | 세션당 `compact()` 호출 횟수 | 요약을 줄여 자주 컴팩션하게 되면 역효과 |
| 턴 지연 회귀 | 메인 턴의 p50 / p95 | 컴팩션이 빨라져도 턴이 느려지면 실패 |

### 3.2 단일 측정 금지

- 최소 **5회 반복 후 중앙값**.
- 같은 모델을 **다른 시드로 한 번 더** 돌려 재현성 확인 (로딩 상태·thermal 영향).
- vLLM 과 llama.cpp 을 비교할 때는 **같은 모델 파일·같은 양자화**로. 다르면 비교
  자체가 무의미하다.
- vLLM 의 APC / prefix cache 를 켠 상태와 끈 상태를 **반드시** 따로 측정하라
  (추측 디코딩 과의 상호작용이 있다).

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
| 실측 스크립트 | `/tmp/opencode/compact_bench.ts`, `/tmp/opencode/compact_io_bench.ts` |

**시작 전에 `PROMPT.md` §2 를 읽어라.** 컴팩션이 왜 이 모양인지(체크포인트 선기록,
요약, tail 보존, resume)의 설계 의도를 무시한 최적화는 되돌릴 수 없다.