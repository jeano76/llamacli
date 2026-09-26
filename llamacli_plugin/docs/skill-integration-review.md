# 검토 요청: llamacli 스킬 — laya(System 1) + Ornith(System 2) 연동 설계안

## 배경

llamacli에 새 스킬을 추가하려고 합니다. 목표는 **기존 llamacli 코어는 수정하지 않고**,
지금 이 머신에 이미 떠 있는 두 로컬 모델을 스킬 레벨에서 조합해 실질적인 성능(응답
속도/정확도/자원 효율)을 개선하는 것입니다.

### 현재 가용 자원 (실측, 2026-09-25 기준)

| 역할 | 모델 | 위치 | 특성 |
|---|---|---|---|
| System 2 (느린 추론) | **Ornith-1.5-35B-A3B-Q4_K_M.gguf** | `http://127.0.0.1:8080` (llama-server, GPU, `--parallel 1`, `-c 24576`) | reasoning 모델. `<think>` 블록을 길게 생성한 뒤에야 답함 — 실측 수십 초~90초/요청(`max_tokens: 4096` 기준 eval time ~90초). GPU VRAM 7.4GB/8GB 거의 독점. 동시 슬롯 1개뿐이라 요청이 겹치면 순차 대기 |
| System 1 (빠른 typed-decision) | **laya** (`convaiinnovations/laya`, ModernBERT-large 421M, `english` 체크포인트) | `http://127.0.0.1:8000` (`llamacli_plugin/.venv`, `laya.serve`, **CPU 모드**) | reasoning 없음. `POST /v1/systemone`에 `{state, questions}`를 보내면 `choice`/`score`/`noul` 타입 질문에 대해 확률·신뢰도를 즉시 반환. 실측 응답시간 **0.55초**. RAM 약 2.4GB(체크포인트 1개 로드 기준) |

### 알아야 할 제약/사고 이력

- **오늘 실제로 시스템 OOM이 났습니다**: laya를 GPU 대신 CPU 모드로 띄웠을 때 RAM
  사용량이 늘면서 llama-server(Ornith)가 커널 OOM killer에 의해 강제 종료됨. 재시작은
  됐지만 laya 세션 하나는 `.llamacli/state/` 전체(checkpoint, notes)가 유실됐습니다.
  지금은 laya가 `english` 체크포인트 하나만 로드하도록 줄여서 완화된 상태(약 2.4GB)지만,
  **RAM/VRAM 예산이 타이트하다는 전제 자체는 여전히 유효합니다** (시스템 RAM 30GB, 스왑
  8GB는 이미 그 사고 이후로 계속 꽉 차 있음, GPU는 8GB 중 7.4GB가 Ornith 차지).
- laya는 인증 없는 localhost 전용 서비스입니다 (`LAYA_API_KEY` 미설정).
- `/v1/systemone`의 `questions` 스키마는 3가지 타입뿐입니다: `choice`(다지선다),
  `score`(등급/순서), `noul`(참/거짓 확률). 자유서술형 답변은 못 만듭니다 — Ornith가
  여전히 필요한 영역입니다.
- laya에는 `typed-decisions`라는 별도 체크포인트도 있습니다(현재는 미로드) — 4가지
  정형 업무 워크플로우(agent_trace_observability / customer_service /
  invoice_processing / security_incidents)에 특화 파인튜닝되어 있고, 일반 `english`
  체크포인트보다 해당 워크플로우에서 더 정확할 가능성이 있습니다.

## 요청 사항

**지금 코드를 작성하지 마세요.** 아래 질문에 대한 **검토와 비교**를 먼저 수행하고,
각 옵션의 장단점·리스크·예상 효과를 정리해서 보고해주세요. 실제 구현은 그 검토 결과를
보고 별도로 지시하겠습니다.

### 1. 스킬이 laya를 언제, 어떻게 호출할지

- (a) llamacli 턴 루프 진입 전에 laya로 먼저 빠른 판단(의도 분류, 긴급도, 위험도 등)을
  내리고 그 결과를 시스템 프롬프트/컨텍스트에 얹어서 Ornith 호출을 보강하는 방식
- (b) 명확히 laya만으로 결론낼 수 있는 케이스(예: 단순히 yes/no, 다지선다형 판단)는
  **Ornith 호출을 생략**하고 laya 응답만으로 끝내는 단축 경로(short-circuit) 방식
- (c) 둘 다 아니고, 별도 명시적 스킬 커맨드(`/fastcheck` 같은)로 사용자가 직접 호출할
  때만 laya를 쓰는 방식(자동 개입 없음)

세 가지 중 어느 방향이 나은지, 혹은 조합이 가능한지 검토해주세요. 특히 (b)는 속도
이득이 가장 크지만 "언제 laya만으로 충분한지"를 잘못 판단하면 품질이 떨어질 위험이
있습니다 — 이 트레이드오프를 구체적으로 짚어주세요.

### 2. 자원(메모리) 관리 전략

- laya를 **항상 상시 기동**해둘지, 아니면 **필요할 때만 지연 기동(lazy start)**하고
  일정 시간 미사용 시 내릴지
- `LAYA_MODELS`를 `english` 하나로 계속 제한할지, 필요시 `typed-decisions`를 추가로
  로드할지 (로드할 경우 예상 추가 RAM은 약 2~2.5GB로 추정 — 실측 확인 필요)
- Ornith(GPU)와 laya(CPU)가 동시에 떠 있는 오늘 같은 OOM이 재발하지 않도록, 스킬
  실행 전에 걸어야 할 안전장치(예: 기동 전 여유 RAM 체크, 실패 시 laya 스킵하고
  Ornith로만 진행)가 필요한지

### 3. 장애/성능 저하 대응

- laya 서버가 죽어 있거나 응답이 없을 때 스킬이 어떻게 degrade해야 하는지 (Ornith로만
  진행 vs 스킬 전체 실패)
- laya 응답의 `confidence`가 낮게 나온 애매한 케이스를 Ornith로 보강 확인시킬지, 아니면
  laya 결과를 그대로 신뢰할지 — 임계값을 어떻게 정할지

### 4. 구체적 적용처 후보

llamacli 내부에서 laya가 실제로 유용할 만한 지점을 3~5개 구체적으로 찾아서 제시해
주세요. 예시(검증 필요, 그대로 채택하라는 뜻 아님):
- 도구 호출(tool call) 결과가 성공/실패/재시도 필요 중 무엇인지 빠르게 1차 분류
- 사용자 입력이 긴급/일반인지 판단해서 우선순위 조정
- 커밋 메시지나 diff 요약이 필요한 변경인지 아닌지 사소한 변경 필터링
- 그 외 이 프로젝트(llamacli_plugin, laya 통합) 자체의 맥락에서 떠오르는 것

### 5. 기능 on/off 스위치

laya 연동을 llamacli 설정으로 켜고 끌 수 있어야 합니다 (기본값은 검토해서 제안).

- 위치/형식을 어디로 할지 (`.llamacli/config.yaml`에 `laya: { enabled: true|false, ... }`
  같은 새 섹션을 추가하는 안이 기존 config 구조와 가장 자연스러워 보이는데, 다른 대안이
  있다면 함께 검토해주세요)
- off일 때는 스킬이 완전히 개입하지 않아야 함 — laya 서버로의 헬스체크조차 시도하지
  않는 수준으로 확실히 꺼져야 하는지, 아니면 "꺼져 있어도 상태만 조용히 확인"하는 정도는
  허용할지
- 런타임 중 토글이 필요한지(재시작 없이), 아니면 시작 시 1회 읽는 것으로 충분한지

### 6. 실행 환경에 laya가 없을 때 — 자동 설치/구동

llamacli가 laya 연동 스킬을 쓰려 하는데, 그 환경(다른 머신/ 다른 프로젝트 디렉토리)에
laya가 아예 설치되어 있지 않은 경우를 대비해야 합니다. 이번 `llamacli_plugin`에서
겪은 실제 설치 과정(uv pip install, venv, HuggingFace 체크포인트 다운로드에 수 분
소요, 최초 실행 시 GPU 메모리 부족으로 CPU 폴백)을 참고해서 다음을 검토해주세요.

- **감지**: "이 환경에 laya가 없다"를 어떻게 판단할지 (예: 지정된 venv 경로 존재
  여부, `http://127.0.0.1:8000/health` 응답 여부, 둘 다 확인)
- **자동 설치 트리거 시점**: laya 기능이 켜졌는데 미설치 상태를 감지했을 때, (a)
  사용자에게 물어보고 동의 시 설치 (b) 조용히 백그라운드에서 자동 설치 후 준비되면
  활성화 (c) 그냥 laya 없이 동작하고 안내 메시지만 표시 — 이 중 무엇이 맞을지. 특히
  (b)는 사용자 모르게 venv 생성 + pip/uv install + 수 GB 다운로드가 일어나는 것이므로,
  **사전 동의 없는 자동 설치가 적절한지 신중히 검토**해주세요 (디스크/네트워크 사용량이
  결코 작지 않습니다 — 오늘 설치 로그 기준으로도 실측 필요). 기본값은 안전한 쪽(설치
  여부를 사용자에게 명시적으로 묻거나 최소한 최초 1회는 확인받는 방향)을 우선 검토 후보로
  삼아주세요.
- **설치 위치**: 프로젝트별(`<project>/.llamacli/laya-venv/`)로 매번 새로 설치할지,
  아니면 `~/.llamacli/laya-venv/` 같은 공유 위치에 한 번만 설치해서 모든 프로젝트가 재사용할지 — 후자가 디스크/다운로드 낭비를 줄이지만 버전 충돌 관리가 필요합니다
- **설치 실패 시**: 네트워크 불가, 디스크 부족, Python 버전 불일치 등으로 설치가 실패하면 llamacli 본체 동작에 영향 없이 laya 기능만 조용히 비활성화되고 원인을 로그/상태 메시지로 남겨야 함 — 이 실패 격리를 어느 계층에서 보장할지
- **기동 관리**: 설치 후 서버 프로세스를 llamacli 프로CESS 생명주기에 묶을지(llamacli 종료 시 laya도 같이 종료) 아니면 독립적으로 계속 있게 둘지(오늘처럼 systemd 서비스화하거나 수단 관리) — 각각의 장단점

### 7. GPU / CPU 구동 모드 설정

- 설정으로 `gpu` / `cpu`(기본값) / `auto`(가용 여부에 따라 자동 판단) 세 가지 정도를
  선택할 수 있게 하는 안을 검토해주세요. 기본값을 **CPU로 못박은 이유**가 오늘 사고
  때문인지 확인하고, 그 근거가 맞다면 문서화까지 해주세요.
- `auto`를 만든다면판단 기준이 필요합니다 — 오늘 실측한 것처럼 GPU 여유 VRAM이
  laya 체크포인트(약 400MB급)를 올리기에 부족한 경우(예: Ornith가 이미 7GB+ 점유)
  CPU로 안전하게 폴백하는 로직. `run-server.sh`가 이미 이런 "동적 계산 + 재시도
  폴백" 패턴을 갖고 있으니 그 설계를 재사용/참고할 수 있는지 봐주세요.
- **GPU 모드 선택 시의 리스크**: 오늘 사고가 CPU 모드에서 RAM으로 난 것이지만, GPU
  모드는 VRAM 경합(Ornith와 laya가 같은 8GB를 나눠 써야 함)이라는 별도 리스크가 있습니다. GPU 모드를 켜서 Ornith 쪽 컨텍스트(`-c 24576`)가 VRAM 부족으로 다시 축소되는 연쇄가 재현되지 않는지도 검토 항목에 넣어주세요.
- 이 설정도 6번과 마찬가지로 `.llamacli/config.yaml`의 laya 섹션에 같이 둘지 검토.

### 8. 최종 권고

위 검토(1~7) 전체를 바탕으로, 지금 바로 착수할 만한 **최소 범위(MVP) 1안**을
추천해주세요 — 구현 난이도가 낮고, 실패해도 기존 llamacli 동작에 영향이 없고
(안전하게 없어도 그만인 add-on), 효과를 빠르게 검증할 수 있는 것으로. on/off
스위치와 CPU 기본값 정도는 MVP에 포함하되, 자동 설치(6번)처럼 리스크가 큰 항목은
MVP 이후로 미뤄도 되는지도 함께 판단해주세요.
---

## 부록 A: 실측 수치 (검토 근거)

실제 관측은 문서 서술과 다릅니다. 진짜 제약은 RAM이 아니라 VRAM입니다.

| 지표 | 문서 서술 | **실측 (2026-09-25 22:11, `free -h`)** | 평가 |
|---|---|---|---|
| 시스템 RAM | "타이트 / OOM 재발 위험" | 총계 ~30GB, **사용 14GB, 가용 ~16.9GB** | 여유 충분 (과장) |
| Swap | 8G 꽉 참 | 8G 중 **7.85G 사용**(여유 192M, `si` 273M/s) | 정확이나 지난 사고 잔재 + 지속 스왑 압박 신호 |
| GPU VRAM | 8GB 대부분 Ornith | **7452MB 사용 / 8192MB** | 진짜 제약. laya CPU로 두어도 Ornith의 VRAM은 건드리지 않음 |

**결론:** 리스킬 게이트는 RAM이 아니라 **SwapFree 기준**으로 잡아야 합니다(과거 OOM이
swap 포화 + CPU 모델의 식으로 나타났기 때문).

## 부록 B: 검토 결과 (1~7항)

> 검토만 수행한 상태이며 아직 코드는 작성하지 않았습니다. 아래는 1~7에 대한 정리입니다.

### 1. 호출 시점·방식 — a / b / c 단계별 조합이 정답

단일 선택이 아니라 **층별(단계별) 조합**을 권합니다.

| 옵션 | 평가 | 권고 |
|---|---|---|
| (a) 턴 전 merge | ✅ 핵심. 의도/긴급도/위험도 빠르게 판단 → Ornith 호출 컨텍스트에 얹음. 실패해도 Ornith가 최종 판단 → **기존 동작 손상 없음** | MVP 주축 |
| (b) short-circuit | ⚠️ 기본 off. "언제 laya만으로 충분한지" 오류가 품질 붕괴로 직결(문서가 지적한 핵심 위험). `choice`/`score`/`noul` 확률·신뢰도가 **명확(high confidence)**일 때만 허용 | off-by-default (allow-list) |
| (c) 명시 커맨드 `/fastcheck` | ✅ 사용자 통제망. 자동 개입 두려운 사람이 직접 호출 | 도입 장벽 낮춤 |

**결론:** `a` 주축, `b`는 allow-list(신뢰도 임계값 충족 시만), `c`는 사용자 선픿제.

### 2. 자원 관리 — 지연 기동 + swap 게이트 + timeout

- **지연 기동 (lazy):** GPU VRAM이 진짜 제약, laya CPU가 Ornith를 직접 깎진 않지만
  **swap 포화상태에서 laya RAM 식→즉시 스왑 압박**(지난 OOM 시나리오 유사). 필요할 때만
  올리고 첫 응답은 동기 "배치"로 상쇄.
- **LAYA_MODELS:** MVP는 **`english` 단독** 유지. `typed-decisions` (~2GB) 추가는 swap
  압박을 키우고, 문서의 4가지 워크플로우가 llamacli 맥락과 항상 일치하지 않음. 검증 후
  점진적 검토.
- **안전장치(필수):** 스킬 실행 전 **SwapFree 체크**(RAM이 아니라!). 부족하면 laya skip +
  Ornith 진행. plus: laya 호출에 **데드라인(timeout)** — 응답 지연 시 Ornith로 우회 (3번과 연계).

### 3. 대응 — degrade-to-Ornith + low-confidence log-only

- **laya 다운/타임아웃:** ✅ **Ornith로만 진행하고 laya 스킵** (스킬 실패 금지 — 문서 철학 일치).
  health probe → fail → graceful skip(laya 없어도 완전 동작).
- **low-confidence:** ✅ 문서의 두 임계값(half/whole) 접근이 정확. high confidence → laya 채택;
  `between`(중간/애매)은 **log-only** + Ornith에게 "신뢰도 낮음, 확인 필요" 힌트만 제공. 초기는 log_only로 시작 → 데이터로 임계값 조정.

### 4. 적용처 후보 (llamacli 맥락 특화)

1. **툴 호출 전 위험도 분류** — 도구 실행 빠르게 판단, 높으면 Ornith에게 extra caution 프롬프트
2. **긴급우 우선순위** — 입력 긴급한지(데이터 손실 관련) 일반인지 1차 분류 → 응답 순서/노출 반영
3. **커밋 메시지/diff "사소 변경 필터"** — 문서 예시 항목, 실용적 (문서: "검증 필요"). 사소한 변경은 laya가 판단해 Ornith 긴 생성 줄임
4. **(신선한 아이디어) 응답 형식 예측** — 질문이 `choice`/`score`/`noul` 중 어떤 타입에 가까우면 → laya로 미리 "정답이 이미 결정 됐나?" 확인, 미결정이면 Ornith에게 길게 추론 유도
5. (검증 필요) **의도 분류** — 시스템 프롬프트 인젝션/모호한 지시 감지로 Ornith 보안 주입 강화

### 5. 스위치 — 위치: config.yaml, off는 완전 종료

- **위치:** 제안 그대로 `.llamacli/config.yaml` `laya:` 새 섹선이 자연스러움. 기존 구조와 호환.
- **off일 때 동작:** ⚠️ **"상태만 조용히 확인"조차 off일 때는 금지**. 완전 종료 시 laya로 헬스체크까지 하지 않도록 strict하게 — 문서가 요구한 "완전히 꺼져야 함" 방향채용. off 상태에서도 health probe는 CPU/메모리 오버헤드 + log noise.
- **토글:** ✅ **시작 시 1회 읽기 충분**. 런타임 토글은 불필요한 복잡도(add-on 철학에 반함).

### 6. absence — (a) 사전 동의 + 프로젝트별 venv + 격리 + 독립 기동

| 항목 | 권고 | 근거 |
|---|---|---|
| 감지 | **venv 경로 + `/health` 둘 다 확인** | 단일 신호는 신뢰 낮음 |
| 설치 트리거 | ✅ **(a) 사용자에게 물어보 동의 시 설치** | b는 "사용자 모르게 venv+pip+수GB 다운로드". 사전 동의 필수 |
| 설치 위치 | ⚠️ **프로젝트별(`<project>/.llamacli/laya-venv/`)로 시작**, 나중에.shared 검토 | 버전 충돌 관리 쉬움. shared는 이후 최적화 |
| 실패 시 격리 | ✅ layA 기능만 조용히 inactive + 원인 로그 | llamacli 본체 무손상 (철학) |
| 기동 관리 | ⚠️ **독립 프로세스 권장**(systemd/detached). llamacli 생명주기에 묶이면 재시작마다 overhead | 오늘의 systemd 경험 참조 |

### 6-1. 신규 검토: 온보딩 메뉴 + 업그레이드 경로 (laya 미설치 환경용)

초기 사용자는 laya 바이너리/venv/체크포인트가 없으므로, 감지→설치 트리거를 **"사용자 친화적 설치 플로우"**로 구체화합니다.

**감지 (3단계 점진적):**

| 순서 | 체크 항목 | 판단 기준 |
|---|---|---|
| 1 | **venv 경로** 존재 여부 (`<project>/.llamacli/laya-venv/bin/python` or `~/.llamacli/laya-venv/bin/python`) | 없으면 다음 단계 |
| 2 | `/health` 응답 (venv 있어도 서버 안 떠 있을 수 있음) | 실패하면 C(구동)으로 |
| 3 | **prerequisites** (Python ≥3.10, `uv` 존재, disk 여유, HuggingFace 접근성) | 부족이면 D(설치 실패 격리)로 |

**온보딩 플로우:**

```
[1] 감지: laya 없음 → "laya(System1 고속판단)를 설치하시겠습니까?" (기본 N / off default와 일관)
      동의 시
[2] 전제 표시: Python 버전, uv 존재, 예상 스페이스(~수GB), 체크포인트 다운로드
      - "GPU VRAM 8GB 중 Ornith가 7.4GB 독점 → laya는 CPU 권장" 안내
      동의 후
[3] 설치: 프로젝트별 venv 생성 → `uv pip install laya[serve]` → HuggingFace 체크포인트(english) 다운로드
      - 백그라운드 실행 (진행률 표시, 프론트엔드 블로킹 금지)
[4] 기동: laya serve CPU 모드로 시작 → /health 확인 → active화
```

**메뉴 선택지** = 6항의 (a)(b)(c)를 UI로: **(A)** 설치+자동활성화(추천), **(B)** 설치만하고 수단 켜기(off 유지), **(C)** 취소. 이 메뉴가 **6항 "(a) 사전 동의"의 사용자 선택 UI** 구현입니다.

**설치 실패 시 격리:**

| 실패 유형 | 대응 |
|---|---|
| Python 버전 불일치 (<3.10) | "Python X 필요" 안내 후 설치중지 (사용자 재선택 가능) |
| disk 부족 | "약 XGB 필요" 표시, 사용자 확인 후 진행/중지 |
| 네트워크 불가 (HuggingFace 접속 실패) | 체크포인트 다운로드 실패 → laya inactive 유지 + 원인 로그 |
| uv 미설치 | 자동 설치 시도 or 수단 안내 |

**핵심:** 모든 실패는 **layA 기능 계층에서 격리** → llamacli 기본 대화/Ornith 동작 항상 정상.

**업그레이드 경로 (신규 반영):** laya의 두 가지 "업그레이드"는 분리되어 있습니다.

| 대상 | 위치 / 버전 | 업그레이드 방법 |
|---|---|---|
| **코드** | PyPI `laya` 패키지 (`laya.serve`) | `uv pip install --upgrade laya[serve]` (또는 `pip install -U`) |
| **모델 가중치** | 체크포인트 `.safetensors`, 출처: **HuggingFace Hub — `convaiinnovations/laya`** | 패키지 최초 실행 시 `huggingface_hub`로 자동 다운로드 → 로컬 캐시 `~/.cache/huggingface/`. 코드 버전이 다른 체크포인트를 요구하면 **HuggingFace 리포에서 자동으로 새로 받아옴**(오늘의 "Fetching 5 files..."가 이 경로). 수단으로 체크포인트만 최신화하고 싶어도 동일 HuggingFace 리포에서 받습니다 |

> 참고: 컴포넌트별 정리 — 모델 가중치 (`english`/`multilingual`/`typed-decisions` 체크포인트, `.safetensors`, 버전 —), 코드 업그레이드는 PyPI에서, 모델(체크포인트) 업그레이드는 HuggingFace Hub `convaiinnovations/laya` 리포에서 자동으로.

### 7. GPU/CPU — 세 모도 기본 CPU + VRAM 게이트 auto

- **세 가지(gpu/cpu/auto):** ✅ 유효. 기본값 **CPU**는 오늘 사고 때문. 정확한 이유는
  "GPU VRAM이 얇아(8GB) laya를 올리면 Ornith와 다툴 위험" — 문서가 CPU모드 실패를 OOM으로만 서술했지만 실제 원인은 VRAM 경합 가능성도 있음 (부록 A에서 RAM 과장 확인).
- **`auto`:** ✅ 가치 있음. 판단 기준: **가용 GPU VRAM이 laya 체크포인트(~400MB) + 여유 > X GiB**이면 GPU, 아니면 CPU 폴백. `run-server.sh`의 동적 재시도 패턴 재사용.
- **GPU 모드 리스크:** ⚠️ 문서가 지적한 항목 정확. **Ornith 컨텍스트(`-c 24576`) 축소 연쇄** — laya가 GPU VRAM 식이면 Ornith가 VRAM부족으로 context 축소. 재필 검토 항목.
- 설정 위치: ✅ 6번과 동일하게 `.llamacli/config.yaml` laya 섹션에 통합.

### 8. 최종 권고 (MVP)

**추진 MVP: "laya gate — merge-style, c→a sequentially, b off-by-default"**

| 포함 (MVP) | 미루기 (post-MVP) |
|---|---|
| ✅ `config.yaml`에 `laya.enabled` switch (off default or opt-in) | ❌ gpu/auto 초기 검증 (7번) |
| ✅ CPU 기본값 + `gpu/auto` 추후 | ❌ typed-decisions 추가 로드 |
| ✅ **(a) merge-style gate** — 턴 전 판단, 실패→Ornith degrade | ❌ (b) short-circuit (allow-list로 추후) |
| ✅ swap-free 게이트 + timeout → fail-to-Ornith | ❌ 런타임 토글 |
| ✅ `/fastcheck` 명시 커맨드 (c) — 사용자 통제망 | ❌ shared venv 최적화 |
| ✅ low-confidence는 `between`=log-only, Ornith에 힌트만 | ❌ GPU 모드 |

**온보딩 메뉴 포함 (신규):** laya 미설치 환경을 위한 **감지→동의→설치->기동 플로우**(위 6-1항)를 MVP에포함. 난도 다소 높지만 사용자 컨트롤 가능 → 6항의 "사전 동의 없는 자동 설치"는 배제하고 메뉴로 대체.

**MVP의 안전성:** merge gate는 **실패가 전부 Ornith로 우회**되므로 기존 llamacli 손상 가능성이 0에 가깝습니다 — 문서 철학 완벽 준수. 가장 낮은 난도 + 즉각적 효과(판단 결과가 Ornith 응답 품질을 보강).
