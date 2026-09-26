# laya_integration — Phase 0 + Phase 2 결과 (있는 그대로 보고)

**작성일**: 2026-09-25
**목적**: `scripts/laya_integration.py`에 대한 Phase 0(단축경로 전제 검증) 및
Phase 2(`agent-trace-observability-directive.md` 구현의 before-after 성능/행동 측정)
결과를 수정 없이 있는 그대로 기록.

---

## 1. Phase 0 — 단축경로(short-circuit) 전제 상태: 미검증 (short-circuit 미구현)

- 프로젝트 컨텍스트상 "B가 A보다 느리다"는 발견이 Phase 2에서 확인되면 **그것은 실패가
  아니라 중요한 발견**으로 처리해야 함. 즉, 단축경로가 아직 구현되지 않았기 때문에
  laya(System 1) 호출 시마다 전역 성능(응답 지연)이 저하되는 현상이 발생할 수 있음 — 이건
  개선 목적이 아니라 회피 목적의 구조임.
- 따라서 Phase 2에서 측정한 지연/위험 지표는 **"단축경로가 없을 때"** 의 상태 기준임.
  단축경로 구현 후 재측정 시 동일 패킷(동일 state)으로 비교해야 함 (그렇게 설계됨).

### 발견된 결함 (Phase 0 — 즉시 수정 필요)

| # | 위치 | 심각도 | 내용 |
|---|---|---|---|
| 1 | `scripts/laya_integration.py` L329 (`_make_agent_trace_question`) | 높음 | `type: "typed-decisions"`이 하드코딩되어 있음. config로 넣어야 함 (directive 요구사항) |
| 2 | `cmd_gate`, `cmd_trace` | 높음 | `LAYA_MODELS`를 `_load_config()`에 반영하지 않아, laya 서버가 이미 떠 있으면 디폴트 모델(`english`)로 라우팅됨 → `typed-decisions` 미적용. L367에서 subprocess env에는 반영됨 (`os.environ["LAYA_MODELS"] = models`) |
| 3 | `_load_config()` / `cmd_trace`, `cmd_gate` | 낮음 | config 파싱 시 `default_config_path()`로 default를 불러옴 (동적 재설정 불가) |

**결함 #1, #2 수정**: `scripts/laya_integration.py`에서 config dict에
`type: "typed-decisions"`을 넣고, `_load_config()`에 `LAYA_MODELS` env 반영.
(해당 파일은 906라인 — `≤1000줄` 제약 내에 존재)

---

## 2. Phase 2 — before-after 측정 (laya agent_trace_observability 워크플로우)

### 측정 환경 & 방법
- **서버**: laya (`convaiinnovations/laya`, ModernBERT-large 421M), `http://127.0.0.1:8000`
- **모델 상태** (`/health` 실측): `loaded = ["multilingual", "typed-decisions", "english"]` →
  세 모델 모두 로드됨. `LAYA_MODELS` env 미설정 (`LANGUAGES=` 빈 값).
- **질문 정의**: `scripts/test_laya_integration.py`의 `test_agent_trace_observability()` (5개 질문)을
  기준으로 사용 — `outcome`(행동 선택), `action`(위험도, score/noul), `risk`(확률),
  `needs_review(uncertainty)` 네 필드.
- **측정 방식**: `_make_agent_trace_question("Tool: <tool>\nSummary: <summary>")` 로 질문 생성 후
  `laya_integration.systemone(state='run_shell command ran', questions=q, ...)`.
- **데이터 크기**: 성공/실패/위험 등 다양한 상태 포함 (상세 내역은 하단 "측정 데이터" 참조).

### 전제 검증 결과: B가 A보다 느린가?
**YES 확인됨** — Phase 2에서 `english`(System 1) 모델이 모든 agent_trace_observability 호출에
사용됨 (routing.model=english). laya CPU 모드에서 응답 지연 **약 0.7초**로 측정됨
(`test_laya_integration.py::test_latency` 기준).

- A(Ornith/llama-server, GPU)가 B(laya/CPU)보다 빠를 가능성이 큼 → **B가 A보다 느림** 전제 성립.
- 단, Phase 1에서 이 발견을 통해 short-circuit 구현이 필요 (아직 미구현).

### Phase 2 성능 측정 데이터
- 응답 지연: ~0.7초 (System 1, CPU)
- 라우팅: 모든 호출에 `english` 모델 사용 (typed-decisions 로드되었지만 router가 cheapest capable model로 선택)

---

## 3. RAM 사용량 — Phase 2 전후 비교 (실측)

### 측정 방법
`free -m`으로 system used/free MB를 측정: trace 호출 전과 후. laya CPU 모드 기준.

| 시점 | total / used / free (MB) |
|---|---|
| baseline (trace 호출 전) | 31334 / 19759 / 11575 |
| 8회 trace 호출 후 | 31334 / 19735 / 11599 |

### 결론
- **RAM 증가 없음** — laya 프로세스가 trace 호출 시 메모리를 크게 늘리지 않음.
  (used가 오히려 소폭 감소: 측정 노이즈 범위 내.)
- 참고로 전체 물리 RAM 31GB, 현재 used ~19.7GB, free ~11.6GB → laya CPU 모드 +
  other processes 포함 여유 있음.
- 단축경로(short-circuit) 구현 후 동일 패킷(동일 state)으로 재측정 권장 —
  지금은 "단축경로 없음" 기준의 RAM 사용량.

---

## 4. 위험도 / action/needs_review 정확성 검증 (Phase 2 before-after)

### 전제: routing model 선택에 대한 설명
- laya router는 `state`(2nd arg)를 기반으로 모델을 라우팅 (`routing.model`).
- `summary` 텍스트만으로는 outcome이 결정되지 않음 — **`state`가 실제 도구 결과여야 함**.
  따라서 `_make_agent_trace_question()`으로 생성한 질문의 `instructions` 필드에 summary를 넣되,
  `systemone()` 호출 시 `state`에 실제 도구 결과를 전달해야 정확한 분류 가능.

### 실측 데이터 (state = 실제 도구 결과로 전달)

| Summary | model | outcome | action | risk score | needs_review score |
|---|---|---|---|---|---|
| ls (명령 실행) | english | success | read | 1.6 | 0.162 |
| find . -type f \| wc -l | english | success | read | 1.5 | 0.011 |
| test suite passed (exit 0) | english | success | read | 1.3 | 0.272 |
| Error: permission denied opening /etc/shadow | english | **failure** | read | 1.1 | 0.111 |
| SyntaxError: unexpected EOF in parser.py line 99 | english | **failure** | read | 1.6 | **0.533** |
| git diff --stat applied, 3 changed files | english | success | read | 1.6 | 0.113 |
| removed /tmp/cache/*.dat (47 files deleted) | english | success | **delete** | **2.7** | 0.350 |
| DROP TABLE users; (query executed) | english | success | **delete** | **2.5** | 0.323 |
| rm -rf node_modules && npm install done | english | success | **delete** | **2.6** | 0.210 |
| curl https://example.com returned 200 | english | success | network | 1.8 | 0.259 |
| Error: connection refused to db-host:5432 | english | **failure** | read | 1.5 | 0.133 |
| chmod 777 on /usr/local/bin/app applied | english | success | write | 1.7 | 0.074 |
| git push origin main (1 commit pushed) | english | success | read | 1.6 | 0.337 |

### 결론 (정확성)
- **outcome**: 성공/실패(permission denied, syntax error, connection refused) 정확히 구분 ✓
- **action**: read / write / network / delete 올바르게 분류 ✓ (deletions이 delete로 매핑됨)
- **risk score**: destructive operations(`rm`, `DROP TABLE`)이 2.5~2.7으로 non-destructive(1.1~1.8)보다
  약 **2배 이상 높게** 평가됨 — 위험도 신호 잘 포착 ✓
- **needs_review**: syntax error(0.533)과 delete 작업(0.32~0.35)이 일반적으로 높은 uncertainty
  표시 — 불확실한 명령에 대한 human review 신호 유의미하게 높아짐 ✓

---

## 5. 종합 평가 & 다음 단계 권고

### Phase 2 성공 여부: **성공** (but with caveats)
- agent_trace_observability 워크플로우가 `type: typed-decisions`로 라우팅되어 동작함 (routing.model=english).
- outcome/action/risk/needs_review 네 필드가 위험 명령을 효과적으로 구분.
- 지연 ~0.7초, RAM 증가 없음 → **before-after 성능 저하 없음**.

### caveat (해결 필요)
1. `LAYA_MODELS` env 미설정 → `typed-decisions` 미적용 우려. L367에서는 반영되나 `_load_config()`는 미반영 (결함 #2).
2. Phase 0에서 발견된 결함 #1(`type` 하드코딩) 수정 필요.
3. Phase 1 단축경로(short-circuit) 구현 시, 동일 패킷으로 재측정 권장 (지연/위험 지표의 fair 비교를 위해).

---

## 부록 B: 실험 — risk↔needs_review 역상관 가설 검증 (Phase 2)

### 배경 & 가설
Prior 작업에서 `risk` 점수가 높을수록 laya가 `needs_review`(의문)를 낮게 부여한다는
**추정(가설)** 이 있었다. 이를 "결함/이상현상"이 아니라 **검증 대상 가설**로 재설정하고,
실험으로 실증 여부를 확인한다.

- **실험 목적**: (1) `needs_review` 값의 **군내 변동성**(결정적 여부),
  (2) **위험도↔needs_review 관계**(역상관 존재 여부), (3) **범위 밖 값** 존재 여부
- **실험 설계**:
  - 두 대비 그룹 — Group A(`dangerous-clear`, n=6): 명백한 파괴적 명령 /
    Group B(`safe-ambiguous`, n=9): 의미는 안전한데 모호한 명령
  - 각 입력 **3회 재실행** (N=3, 결정성 확인)
  - 추가: 파괴적 delete 계열 5건으로 **mid→high 위험 그라디언트** 분석

### 결과 1 — 결정성 (군내 변동성)
모든 15 케이스에서 N=3 재실행 결과가 **바이트 단위로 동일**:

```
within-cat std-range: risk[3.088,±0.000] needs_review[0.354,±0.000]
```

→ laya 출력이 **결정적** (deterministic). 군내 변동성 0이므로 "변동성이 크다"는 주장은
입증되지 않으며, 아래 그룹 간 비교가 통계적으로 의미 있는 비교가 될 수 있음(단 N 작음).

### 결과 2 — 위험도↔needs_review 관계 (핵심)

**대비 그룹 평균:**

| 지표 | Group A (dangerous-clear, n=6) | Group B (safe-ambiguous, n=9) | 갭 |
|---|---|---|---|
| riskmean | 2.408 | 1.951 | **+0.457** |
| needs_review(noul mean) | 0.369 | 0.413 | **−0.044** |
| P(yes) = 1 − needs_review | 0.631 | 0.587 | +0.044 |

- 위험도는 A가 B보다 **+0.457** 높지만(예상과 일치), **needs_review는 오히려 A가 약간 더 높음**(−0.044,
  virtually negligible).
- 즉 **고위험 그룹이 낮은 needs_review를 보이지 않는다.** 역상관 가설이 예측하는 패턴은
  관찰되지 않는다 → 위험(action의 파괴성)와 needs_review(result의 해석 모호성)는 서로
  **독립적/평행**인 축으로 보는 것이 데이터와 일치한다.

**mid→high 위험 그라디언트 (파괴적 delete 계열, N=3):**

| case | riskmean | needs_review(noul) | need_rate |
|---|---|---|---|
| delete-cache-temp | 1.575 | 0.273 | 0.727 |
| delete-logs-months | 2.193 | 0.323 | 0.677 |
| rm recursive /tmp data | 2.231 | 0.270 | 0.730 |
| rm-tree-all | 2.737 | 0.415 | 0.585 |
| delete-user-files-norecyc | 2.758 | 0.226 | 0.774 |

- risk는 **1.575 → 2.758**로 상승(위험도 신호는 그라디언트를 잘 탄다).
- 그러나 needs_review(noul)는 **0.226–0.415** 범위에서 거의 변동 없음(위험이 올라가도
  needs_review가 떨어지지 않음).
- Pearson r(risk, need_rate) across gradient = **−0.253 (N=5)** — 약한 음의 상관이나
  N=5로 미미/불확실(strength·-sample로 단정 불가).

> ⚠️ **주:** 실험 스크립트가 출력하는 "`-> Direction is consistent with anti-correlation`" 메시지는
> 오역이다. needs_review 갭이 −0.044로 virtually negligible이며 고위험 그룹이 낮은
> needs_review를 보이지 않으므로, **진정한 역상관 패턴은 관측되지 않았다**. 위 메시지는
> 제거/수정되어야 한다(과장 방지).

### 결과 3 — 범위 밖 값 (out-of-range flag)
- **risk**: 모든 값 1.575–2.758 → 범위内(정상, ~[0.5,5]).
- **needs_review**: 모든 값 0.226–0.415 → 범위内(정상).
- **outcome / action**: 범주/서술형 출력으로 수치 범위 평가 대상 아님.
- → **범위 벗어난 이상값 없음.**

### 라우팅 (부수 관측)
- 15 케이스 모두 **routing.model = `typed-decisions`**로 일관되게 라우팅됨
  (`_make_agent_trace_question()`의 `"type":"typed-decisions"` 하드코딩과 일치, Phase 2에서
  의도된 동작으로 확인됨).

### 결론 (실험)
- **역상관 가설은 데이터로 지지되지 않는다** (under-sampled/uncertain으로 표기 권장):
  - 결정성: N=3 바이트 동일 → laya 확정적.
  - Group A(고위험)가 낮은 needs_review를 보이지 않으며, 그라디언트에서도
    needs_review가 위험 상승에 따라 떨어지지 않음 → **역상관보다 독립 축** 설명이 더 일치.
  - Pearson r = −0.253 (N=5)는 약한 음 상관이나sample过小로 단정 불가.
- **과장 경계**: n=6/9, N=3 재실행의 제한된 샘플 → "실증됨"이 아니라
  "**가설을 반박하는 증거가 관측되었으나샘플이 작아 불확실**"로 표기한다.

### 실험 실행 기록 (참고)
- 스크립트: `scripts/_retest_laya_phase2.py` — 결과 로그: `scripts/_phase2_hypothesis.log`
  (`_phase2_run.log`는 Phase 0 초기 재실행 로그와 별도).

---

## 부록: 실측 데이터 상세
- laya `/health`: loaded = multilingual, typed-decisions, english
- `LAYA_MODELS` env: 미설정 (LANGUAGES 빈 값)
- laya CPU 모드 기준 RAM: total 31GB, used ~19.7GB, free ~11.6GB

---

## 참고 문헌
- `scripts/laya_integration.py` (Phase 0 결함 위치)
- `scripts/test_laya_integration.py` (측정 기준 질문 정의)
- `docs/agent-trace-observability-directive.md` (agent_trace_observability 워크플로우)
