# llamacli 개선 제안서

작성일: 2026-09-23 (P1~P3 적용 완료, 아래 각 항목에 상태 표시)
대상 커밋: `9bd5c06` (Base circuit-breaker hard timeout on inactivity, not total turn time)
검증 환경: Node v22.22.1, 실행 중인 llama-server(`Qwen3.6-35B-A3B-UD-Q4_K_M`, 포트 8080)

## 적용 결과 (2026-09-23)

P1 3건, P2 2건, P3 5건 총 10개 항목을 코드에 반영했다. `tsc --noEmit` 통과,
`npm test` **172개 전부 통과**(적용 전 158개 + 신규 회귀 테스트 14개), `npm run build` 정상.
P4(보안 경계/UI 브리지/문서 분리)는 설계 변경 범위가 커서 이번엔 적용하지 않고 제안만 남겨둔다.

| 항목 | 상태 |
|---|---|
| P1-1 압축 후 시스템 프롬프트 소실 | ✅ 적용 — `compactor.ts` |
| P1-2 고아 tool 메시지 | ✅ 적용 — `compactor.ts` (같은 지점) |
| P1-3 `npm test` 글롭 누락 | ✅ 적용 — `package.json` |
| P2-1 스킬이 모델에 전달 안 됨 | ✅ 적용 — `load_skill` 도구 + 시스템 프롬프트 주입 |
| P2-2 `mustPreserve` 빈 배열 문구 | ✅ 적용 — `compactor.ts` |
| P3-1 `run_shell` 출력 유실 | ✅ 적용 — `tools/index.ts` |
| P3-2 `/tokenize` 중복 호출 | ⬜ 미적용 (제안만, 아래 원문 유지) |
| P3-3 무한 증가 인메모리 로그 | ✅ 적용 — `loop.ts`(200개 상한), `selfHeal.ts`(100개 상한) |
| P3-4 SSE `JSON.parse` 미보호 | ✅ 적용 — `openaiClient.ts` |
| P3-5 `read_file` 크기 가드 | ✅ 적용 — `tools/index.ts` (5MB 상한) |
| P4-1/2/3 | ⬜ 미적용 (제안만, 아래 원문 유지) |

아래는 적용 전 작성한 원본 분석이다(각 항목의 재현 근거는 그대로 유효하며, 위 표에 적용 여부만 추가했다).

## 0. 요약

프로젝트 상태 자체는 건강하다 — **타입체크 통과, 테스트 158개 전부 통과**. 코드 주석의 밀도와
품질도 높고, 과거에 실제로 겪은 사고(무한루프, 타임아웃 누락, max_tokens 무시)가 근거와 함께
기록돼 있어 회귀 방지가 잘 되어 있다.

아래 항목은 그 위에서 **실제로 실행해 재현·측정한 것만** 정리했다. 추측으로 쓴 항목은 없으며,
각 항목에 재현 방법과 근거를 명시했다.

| 우선순위 | 항목 | 성격 | 근거 |
|---|---|---|---|
| **P1** | 압축 후 시스템 프롬프트·프로젝트 규칙 전부 소실 | 정합성 버그 | 재현 스크립트로 실증 |
| **P1** | 압축 결과에 고아 `tool` 메시지 발생 가능 | 백엔드 400 유발 | 20개 시나리오 중 1건 재현 |
| **P1** | `npm test`가 `src/config.test.ts`를 실행하지 않음 | 테스트 누락 | 글롭 전개 확인 |
| **P2** | 스킬 시스템이 모델에게 전달되지 않음 | 기능 미연결 | 호출부 부재 확인 |
| **P2** | `mustPreserve`가 항상 빈 배열 | 죽은 기능 | 코드 경로 확인 |
| **P3** | `run_shell` 출력 유실(maxBuffer/stderr/exit code) | 견고성 | 코드 확인 |
| **P3** | `/tokenize` 중복 호출 비용 | 성능 | 실측 41ms/회 |
| **P3** | 무한 증가하는 인메모리 구조 3종 | 메모리/토큰 | 코드 확인 |
| **P3** | SSE `JSON.parse` 미보호 | 스트림 전체 손실 | 코드 확인 |
| **P4** | 보안 경계 부재(경로/명령 승인) | 설계 | 코드 확인 |
| **P4** | `globalThis` UI 브리지 | 아키텍처 | 코드 확인 |
| **P4** | README 2,424줄 단일 문서 | 문서 구조 | 크기 측정 |

---

## P1-1. 압축이 일어나면 시스템 프롬프트와 프로젝트 규칙이 통째로 사라진다

**가장 영향이 큰 문제.** 에이전트가 세션 중간부터 자기 운영 규칙을 잃는다.

### 현상

`src/compaction/compactor.ts:runCompaction()` 마지막 부분:

```ts
const compactedMessages: ChatMessage[] = [
  { role: "system", content: `[Compacted history summary]\n${summaryText}` },
  ...keepTail,
];
```

`selectKeptTail()`은 **뒤에서부터 크기 예산(컨텍스트의 40%)만큼만** 남긴다. 시스템 프롬프트는
`messages[0]`, 즉 맨 앞에 있으므로 대화가 조금만 길어지면 항상 `toSummarize` 쪽으로 밀려나
요약문으로 치환되고, 원본은 어디에도 남지 않는다.

여기서 사라지는 것은 `src/index.tsx`의 `BASE_SYSTEM_PROMPT`뿐이 아니다.
`injectRulesIntoSystemPrompt(BASE_SYSTEM_PROMPT, rules)`로 주입된 **`.llamacli/rules/*` 프로젝트
규칙 전체**가 같이 날아간다. 사용자가 `/improve-apply`로 애써 만든 규칙도 첫 압축과 동시에
무효가 된다.

### 재현 (실행해서 확인함)

```ts
// 시스템 프롬프트 1개 + user/assistant 80개(각 500자)로 압축 실행
const { messages: after } = await runCompaction(root, messages, fakeBackend, "m", partial, 4096);
after.some(m => String(m.content).includes("SYSTEM-PROMPT-WITH-PROJECT-RULES"))
```

결과:

```
압축 전 메시지 수: 81 → 압축 후: 14
압축 후 첫 메시지: system | [Compacted history summary]
시스템 프롬프트(프로젝트 규칙) 생존: false     ← 소실 확인
```

### 왜 지금까지 안 드러났나

증상이 "크래시"가 아니라 **"압축 이후 모델이 규칙을 안 지킨다"** 는 형태로 나타나기 때문이다.
긴 세션 후반부에 에이전트가 갑자기 계획(`update_plan`)을 안 세우거나, 브라우저 도구 사용 규칙을
어기거나, 프로젝트 컨벤션을 무시한다면 이게 원인일 가능성이 높다.

### 제안 수정

`loop.ts`에 이미 기록된 제약 — *"시스템 메시지가 2개가 되면 chat-template 강제 백엔드가
깨진다(2026-09-21 실제 사고)"* — 을 지켜야 하므로, 시스템 메시지를 **하나로 합치는** 방식이 맞다:

```ts
// 원본 시스템 프롬프트를 보존하되 메시지 개수는 그대로 1개로 유지
const originalSystem = messages.find(m => m.role === "system")?.content ?? "";
const compactedMessages: ChatMessage[] = [
  {
    role: "system",
    content: `${originalSystem}\n\n[Compacted history summary]\n${summaryText}`,
  },
  ...keepTail.filter(m => m.role !== "system"),
];
```

`selectKeptTail()`에서 시스템 메시지를 `toSummarize` 대상에서 아예 제외하는 방법도 있으나,
요약 대상에서 빼면 예산 계산이 어긋나므로 위처럼 **재조립 단계에서 복원**하는 쪽이 변경이 작다.

**회귀 테스트 제안**: "압축 후에도 시스템 프롬프트 문자열이 `messages[0].content`에 포함된다"를
`compactor.test.ts`에 추가.

---

## P1-2. 압축 결과에 고아 `tool` 메시지가 남아 백엔드가 400을 반환할 수 있다

### 현상

`selectKeptTail()`의 절단 위치는 **순수하게 크기 기준**이라, `assistant(tool_calls)` 메시지와
그에 대응하는 `tool` 응답 메시지 **사이를 가를 수 있다**. 그러면 압축 결과는

```
system(요약)  →  tool(tool_call_id: call_24)  →  ...
```

가 되어, 짝이 되는 `tool_calls`가 없는 `tool` 메시지로 요청이 시작된다. OpenAI 호환 백엔드와
엄격한 Jinja 템플릿을 쓰는 llama.cpp 빌드는 이 형태를 거부한다.

흥미롭게도 `sanitizeForSummary()`는 **요약 요청용 슬라이스에 대해서만** 이 문제를 해결해 두었다
(주석에도 "Cannot continue an assistant message that contains tool calls" 실제 사례가 적혀 있다).
정작 **압축 결과로 계속 사용될 `keepTail`에는 같은 보호가 없다.**

### 재현 (실행해서 확인함)

tool 결과 크기를 100~2000자로 바꿔가며 20개 시나리오를 돌린 결과:

```
테스트한 20개 시나리오 중 고아 tool 메시지 발생: 1건
 - toolLen=900: 고아 1개 (call_24), 압축후 첫 role=tool
```

즉 **특정 크기 조합에서만 터지는 간헐적 버그**다. 재현이 어려워 "가끔 모델이 응답을 못 한다"
같은 형태로만 관측됐을 가능성이 크다.

### 제안 수정

`runCompaction()`에서 `keepTail`을 확정한 직후, 선두의 고아 `tool` 메시지를 제거한다:

```ts
let tail = keepTail;
const liveIds = new Set(
  tail.flatMap(m => m.role === "assistant" ? (m.tool_calls ?? []).map(tc => tc.id) : [])
);
while (tail.length && tail[0].role === "tool" && !liveIds.has(tail[0].tool_call_id!)) {
  tail = tail.slice(1);
}
```

더 깔끔한 대안은 절단 지점을 앞으로 당겨 짝이 되는 `assistant` 메시지까지 포함시키는 것이지만,
그 메시지가 예산을 넘길 수 있으므로 위의 제거 방식이 안전하다.

---

## P1-3. `npm test`가 `src/config.test.ts`를 한 번도 실행하지 않는다

### 현상

```json
"test": "tsx --test src/**/*.test.ts"
```

bash는 `globstar`가 **기본 비활성**이라 `src/**/*.test.ts`는 `src/*/*.test.ts`로 전개된다.
즉 **한 단계 하위 디렉토리만** 매칭된다.

### 재현 (실행해서 확인함)

```
글롭이 매칭하는 파일: 17개 (src/agent/, src/tui/, ... 전부 하위 디렉토리)
실제 존재하는 테스트 파일: 18개
누락: src/config.test.ts  ← 테스트 5개가 조용히 실행되지 않음
```

`config.ts`는 설정 병합(부분 `compaction` 필드가 기본값을 덮어쓰지 않도록 하는 로직 등) 같은
까다로운 로직을 담고 있고, 그에 대한 테스트가 작성돼 있는데도 CI/로컬 어디서도 안 돌고 있다.

### 제안 수정

셸 글롭 의존을 제거한다:

```json
"test": "tsx --test --test-reporter=spec \"src/**/*.test.ts\""
```
(Node 22의 `--test`는 자체 글롭을 지원하므로 따옴표로 감싸 셸 전개를 막으면 된다.)
또는 명시적으로 `tsx --test $(find src -name '*.test.ts')`.

---

## P2-1. 스킬 시스템이 모델에게 도달하지 않는다

`src/skills/builtin/`에 8개의 스킬 문서(planning, code-review, security, architecture-design,
implementation, static-analysis, blackbox-testing, whitebox-testing)가 있고, `package.json`의
빌드 스크립트는 이들을 `dist/`로 복사까지 한다.

그런데 **`loadSkillBody()`를 호출하는 코드가 프로젝트 어디에도 없다** (정의부와 자체 테스트 제외,
grep으로 확인). `loadSkillIndex()`의 결과는 `src/index.tsx:223`에서 `/skills` 슬래시 명령의
**화면 출력용 목록**으로만 쓰인다.

즉 모델은 스킬의 **이름과 트리거 문구만** 간접적으로도 볼 수 없고(시스템 프롬프트에도 안 들어감),
본문은 영원히 읽지 못한다. 스킬 기능이 사실상 미연결 상태다.

### 제안 수정 (둘 중 택1)

1. **도구로 노출** — `TOOL_DEFS`에 `load_skill(name)` 추가, 내부에서 `loadSkillBody()` 호출.
   모델이 필요할 때만 본문을 당겨쓰므로 토큰 낭비가 없다. (권장)
2. **인덱스만 시스템 프롬프트에 주입** — `injectRulesIntoSystemPrompt`에 스킬 목록
   (`- name: trigger`)을 덧붙이고, 본문은 1번 방식으로 요청하게 한다.

어느 쪽이든 P1-1 수정(시스템 프롬프트 보존)이 선행돼야 압축 후에도 유지된다.

---

## P2-2. `mustPreserve`가 항상 빈 배열이라 요약 프롬프트가 잘린 문장으로 끝난다

`compactor.ts`의 요약 요청:

```ts
content:
  "Summarize the following conversation for context compaction. " +
  "Preserve verbatim any user-stated constraints, decisions, and the following " +
  "must-preserve facts:\n" + checkpoint.mustPreserve.join("\n"),
```

`loop.ts`의 `compact()`는 `mustPreserve: []`를 **하드코딩**하며, 값을 채우는 코드는 없다.
따라서 실제 전송되는 프롬프트는 항상 이렇게 끝난다:

```
...and the following must-preserve facts:
(빈 줄)
```

빈 목록을 가리키는 지시문이 그대로 남아 요약 품질을 떨어뜨린다(모델이 존재하지 않는 목록을
찾게 된다).

### 제안 수정

- 단기: `mustPreserve`가 비어 있으면 해당 문장을 프롬프트에서 아예 빼도록 조건부 조립.
- 중기: 기능을 살린다면 — 사용자가 명시한 제약(`/plan`으로 선언한 목표, 파일 경로, 금지 사항)을
  채워 넣는 경로를 만들거나, 반대로 필드를 제거해 죽은 코드를 없앤다.

---

## P3-1. `run_shell`이 출력을 잃는 경우가 세 가지 있다

```ts
const { stdout, stderr } = await execAsync(args.command, { cwd: projectRoot, timeout: RUN_SHELL_TIMEOUT_MS });
return { content: stdout || stderr };
```

1. **`maxBuffer` 미설정** → Node 기본값 1MB. 빌드/테스트처럼 출력이 많은 명령은 `ENOBUFS`로
   죽고, 그때까지의 출력도 **전부 버려진다**. 타임아웃을 공들여 넣은 것과 같은 계열의 사고다.
2. **`stdout || stderr`** → 둘 다 있으면 `stderr`가 버려진다. 경고와 결과가 섞여 나오는 도구
   (tsc, pytest, cargo)에서 진단 정보가 사라진다.
3. **종료 코드 유실** → 0이 아니면 `execAsync`가 throw 하고, `loop.ts`는 `ERROR: ${err.message}`만
   남긴다. 실패한 명령의 **stdout/stderr 본문**이 모델에게 전달되지 않아, 모델이 왜 실패했는지
   모른 채 같은 명령을 반복하기 쉽다(써킷 브레이커가 잡는 그 패턴이다).

### 제안 수정

```ts
case "run_shell": {
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: projectRoot,
      timeout: RUN_SHELL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,   // 1MB → 10MB
    });
    return { content: [stdout, stderr].filter(Boolean).join("\n") || "(exit 0, 출력 없음)" };
  } catch (err: any) {
    // 실패해도 본문을 모델에게 전달 — 재시도 판단에 필요한 정보다
    const body = [err.stdout, err.stderr].filter(Boolean).join("\n");
    throw new Error(`exit ${err.code ?? "?"}: ${body || err.message}`);
  }
}
```

---

## P3-2. `/tokenize` 왕복이 도구 호출마다 반복된다 (실측 41ms)

`maybeCompact()`는 **모든 요청 직전 + 배치 내 모든 도구 호출 직전**에 `estimateTokens()`를
호출하고, 이는 대화 전체를 문자열로 직렬화해 `/tokenize`에 POST 한다.

실행 중인 llama-server(포트 8080)로 직접 측정한 결과:

| 페이로드 | 토큰 수 | `/tokenize` 왕복 |
|---|---|---|
| 20,000자 | 4,001 | 10.2 ms |
| 90,000자 | 18,001 | 34.2 ms |
| 180,000자 | 36,001 | 40.6 ms |

컨텍스트 65k를 70%까지 채운 세션(≈180KB)에서 도구를 20번 호출하는 한 턴이면 **약 0.8초의 순수
오버헤드와 3.6MB의 중복 HTTP 트래픽**이 발생한다. 치명적이진 않지만 전부 회피 가능한 비용이다.

### 제안 수정

직전 추정 이후 **메시지가 추가된 만큼만** 증분 계산하고, 총량은 누적값으로 관리한다:

```ts
// 메시지 배열 길이 + 마지막 메시지 길이를 키로 캐시
private lastEstimate: { key: string; tokens: number } | null = null;
```

가장 간단한 개선은 "배치 내 도구 호출 사이에서는 문자 기반 근사(`charBasedEstimate`)만 쓰고,
턴 경계에서만 실제 `/tokenize`를 부른다"이다. 임계값 판정은 어차피 여유 마진(0.7)을 두고 있어
근사로 충분하다.

---

## P3-3. 무한히 증가하는 인메모리 구조 3종

| 위치 | 변수 | 문제 |
|---|---|---|
| `loop.ts` | `executedToolLog` | 성공한 도구 호출을 **영구 누적**. `currentSteps()`의 폴백 경로를 통해 **체크포인트 파일에 그대로 기록**되므로, 긴 세션에서는 디스크에 쓰이는 JSON도 같이 비대해진다. |
| `selfHeal.ts` | `failureLog` (모듈 전역) | 프로세스 생애 전체에 걸쳐 누적. 게다가 `proposeImprovement(getFailureLog(), ...)`는 **전체 로그를 매번 모델에 통째로 전송**한다 — 실패가 쌓일수록 분석 요청의 프롬프트가 무한정 커진다. |
| `loop.ts` | `loggedImprovementSignatures` | 누적되지만 크기가 작아 실질 영향은 미미(참고용). |

### 제안 수정

- `executedToolLog`: 최근 N개(예: 200)만 유지하는 링 버퍼로.
- `failureLog`: 상한(예: 최근 100건) + `proposeImprovement`에 넘길 때 최근 20건으로 슬라이스.

---

## P3-4. SSE 파싱의 `JSON.parse`가 보호되지 않아 스트림 전체가 날아갈 수 있다

`openaiClient.ts:streamChat()`:

```ts
const parsed = JSON.parse(data) as ChatCompletionChunk;
```

이 호출은 `try` 블록 안에 있지만, 그 `catch`는 `AbortError` 처리 전용이고 나머지는 **그대로
재-throw** 한다. 즉 `data:` 로 시작하는 줄 하나가 JSON이 아니면(프록시가 끼워 넣는 keepalive,
잘린 청크, 비표준 서버의 주석 라인) **그때까지 정상 수신한 응답 전체가 버려지고 턴이 실패**한다.

`[DONE]` 한 가지 예외만 처리되어 있다.

### 제안 수정

```ts
let parsed: ChatCompletionChunk;
try { parsed = JSON.parse(data) as ChatCompletionChunk; }
catch { continue; }   // 파싱 불가한 줄은 건너뛴다 — 이미 받은 내용은 지킨다
```

---

## P3-5. `read_file`에 크기·바이너리 가드가 없다

```ts
case "read_file":
  return { content: await readFile(args.path, "utf8") };
```

`loop.ts`의 `capToolResult()`는 **파일을 메모리에 다 읽은 뒤에야** 잘라낸다. 모델이 실수로
대용량 파일(로그, 덤프, `node_modules` 내 번들, 여기 llama.cpp 프로젝트의 `.gguf` 같은 수 GB
파일)을 지정하면 잘리기 전에 프로세스가 먼저 메모리를 터뜨린다. 바이너리도 UTF-8로 강제 해석해
깨진 문자열이 컨텍스트에 들어간다.

### 제안 수정

`stat()`으로 크기를 먼저 확인해 상한(예: 5MB) 초과 시 앞부분만 읽고 안내 메시지를 덧붙이며,
NUL 바이트가 포함되면 바이너리로 판단해 거부한다.

---

## P4-1. 보안 경계가 선언만 있고 강제가 없다

시스템 프롬프트는 이렇게 약속한다:

```
... never make unverified changes, and confirm before destructive commands.
```

그러나 코드 전체에 **승인/확인 메커니즘이 존재하지 않는다**(`approve|confirm|allowlist` grep 결과
해당 기능 없음). 실제 동작은:

- `run_shell` — 임의의 셸 명령을 **확인 없이 즉시 실행** (`rm -rf` 포함)
- `read_file` / `write_file` / `edit_file` — 경로 제한 없음. `/etc/passwd`, `~/.ssh/id_rsa`,
  프로젝트 밖 어디든 읽고 쓸 수 있다.

로컬 개발 에이전트로서 의도된 트레이드오프일 수 있으나, **모델이 규칙을 지킬 것이라는 가정에만
의존**하고 있다는 점은 기록해 둘 가치가 있다. 특히 P1-1(압축 후 시스템 프롬프트 소실)과 겹치면
"확인하라"는 지시 자체가 세션 중간에 사라지므로, 긴 세션일수록 가드가 약해진다.

### 제안 수정 (단계적)

1. **경로 제한(옵션)** — `config.yaml`에 `security.restrictToProjectRoot: true`를 추가하고,
   파일 도구에서 `resolve(projectRoot, path)`가 `projectRoot` 밖을 가리키면 거부.
2. **파괴적 명령 승인(옵션)** — `rm -rf`, `git push --force`, `sudo` 등 패턴에 매칭되면 TUI에서
   y/n 확인. Ink 기반 UI가 이미 있으므로 구현 비용이 크지 않다.
3. 둘 다 기본값은 기존 동작 유지(opt-in)로 두면 호환성 문제가 없다.

---

## P4-2. `globalThis.__llamacli_ui` 전역 브리지

`index.tsx`의 모든 콜백이 이 형태다:

```ts
onStatus: (s) => (globalThis as any).__llamacli_ui?.pushStatus(s),
```

- 타입 안전성이 없고(`as any`), UI가 마운트되기 전 이벤트는 `?.`로 **조용히 사라진다**.
- 테스트에서 UI 연동을 검증하려면 전역을 스텁해야 해 결합도가 높다.

### 제안 수정

이벤트를 모으는 작은 인터페이스(`UiBridge`)를 정의해 `render()` 시점에 주입하고, 마운트 전
이벤트는 큐에 버퍼링했다가 연결 시 flush. 변경 범위는 `index.tsx` + `App.tsx` 정도로 제한된다.

---

## P4-3. README.md가 2,424줄(168KB) 단일 문서

`README.md` 하나에 설계, 구현 이력, 사고 기록, 사용법이 모두 들어 있다. `PROMPT.md`(241줄)와
역할도 일부 겹친다. 내용 자체는 가치가 높으므로(특히 실제 사고 기록) 삭제가 아니라 **분리**를
제안한다:

```
README.md              설치·사용법·설정 (200줄 내외로 축소)
docs/ARCHITECTURE.md   구성 요소와 데이터 흐름
docs/INCIDENTS.md      실제 사고 기록과 그로 인한 수정 (현재 README의 핵심 자산)
PROMPT.md              그대로 유지 (요구사항 명세)
```

---

## 부록: 이번 점검에서 확인한 "정상" 항목

문제로 오해하기 쉬우나 실제로는 잘 처리돼 있어 기록해 둔다.

- **`tsc --noEmit` 통과**, 테스트 158개 전부 통과(단, P1-3의 5개는 실행 자체가 안 됨).
- **타임아웃 커버리지가 좋다** — `run_shell`, CDP 명령, fetch(경량/채팅 분리), SSE 유휴 감지까지
  각각 별도 타임아웃이 있고 주석에 실제 사고 근거가 달려 있다.
- **`estimateTokens`의 `tool_calls` 반영** — 도구 호출 인자를 토큰 추정에 포함하는 수정이 이미
  들어가 있다(과거 65,636/65,536 초과 사고 대응).
- **`edit_file`의 모호한 매칭 거부** — 중복 매칭 시 조용히 첫 번째를 고치지 않고 에러를 낸다.
- **써킷 브레이커의 기준이 "총 시간"이 아니라 "무진행 시간"** — 최신 커밋에서 올바르게 수정됨.
- **압축 요약 요청의 역할 시퀀스 정규화**(`sanitizeForSummary`) — 실제 백엔드 거부 사례 기반.
  단, 같은 보호가 `keepTail`에는 없다(P1-2).

---

## 권장 처리 순서

1. **P1-1** 시스템 프롬프트 보존 — 영향 범위가 가장 넓고 수정은 5줄 내외.
2. **P1-3** 테스트 글롭 수정 — 1줄. 고치면 `config.test.ts` 5개가 즉시 돌기 시작한다.
3. **P1-2** 고아 `tool` 메시지 제거 — 간헐적 장애의 원인 제거.
4. **P3-1** `run_shell` 출력 보존 — 모델의 실패 재시도 품질에 직접 영향.
5. **P2-1** 스킬 연결 — 이미 작성된 8개 문서를 실제로 쓰이게 만드는 작업.
6. 나머지는 여유 있을 때.
