# 지시: B안 진행 — `resource_gate_ok()`가 스왑만 보고 막는 문제 수정

## 결정

A/B 중 **B안으로 진행**합니다. 이유: 지금 게이트는 `minSwapKb`/`minRamKb` 둘 다
**AND**로 요구합니다 — 스왑이든 RAM이든 하나라도 기준 미달이면 무조건 스킵. 이 머신은
스왑이 (오늘 낮 OOM 사고 이후) 만성적으로 거의 바닥(40KB)인데 RAM은 11GB 넘게
넉넉한 상태라, **RAM이 충분한데도 스왑 하나 때문에 laya가 영원히 스킵**됩니다. 이대로
Phase 2를 측정하면 "항상 스킵함"이라는, 이 머신의 일시적 스왑 상태만 반영하는 결과가
나와서 측정 의미가 없습니다. 이건 새 기능이 아니라 **오늘 측정 도중 발견한 버그
수정**이라 `before-after-validation.md`의 "발견한 버그는 고치고 넘어가라" 원칙에
해당합니다.

## 고칠 부분

`scripts/laya_integration.py`의 `resource_gate_ok()` (241번째 줄):

```python
def resource_gate_ok(cfg: dict) -> tuple[bool, str]:
    min_swap_kb = int(cfg.get("minSwapKb", 2_000_000))
    min_ram_kb = int(cfg.get("minRamKb", 1_000_000))

    free_swap = swap_free_bytes()
    if free_swap < min_swap_kb * 1024:
        return False, f"free swap {free_swap // 1024}kB below required {min_swap_kb}kB"

    free_ram = ram_free_bytes()
    if free_ram < min_ram_kb * 1024:
        return False, f"free RAM {free_ram // 1024}kB below required {min_ram_kb}kB"

    return True, ""
```

## 방향

**진짜 위험한 상황은 "RAM도 부족한데 여차하면 흡수할 스왑 여유도 없는" 경우**입니다.
RAM이 넉넉하면 스왑을 아예 안 건드릴 가능성이 높으니, 스왑 부족 하나만으로 막을
이유가 없습니다. 즉 AND(현재: 둘 중 하나라도 부족하면 차단)를 **"RAM과 스왑 둘 다
동시에 부족할 때만 차단"**으로 바꾸세요 — 대략 이런 형태:

```python
def resource_gate_ok(cfg: dict) -> tuple[bool, str]:
    min_swap_kb = int(cfg.get("minSwapKb", 2_000_000))
    min_ram_kb = int(cfg.get("minRamKb", 1_000_000))

    free_swap = swap_free_bytes()
    free_ram = ram_free_bytes()

    swap_short = free_swap < min_swap_kb * 1024
    ram_short = free_ram < min_ram_kb * 1024

    # RAM 자체가 넉넉하면 스왑을 건드릴 일이 없으므로, 스왑 부족 단독으로는
    # 막지 않는다 — 진짜 위험한 건 "RAM도 부족한데 흡수할 스왑 여유도 없는" 상황.
    if ram_short and swap_short:
        return False, f"free RAM {free_ram // 1024}kB and free swap {free_swap // 1024}kB both below required thresholds"

    return True, ""
```

정확한 임계값/문구는 재량껏 다듬어도 되지만, **핵심은 "스왑만 부족해도 무조건
차단"에서 "RAM·스왑 둘 다 부족할 때만 차단"으로 바꾸는 것**입니다. RAM만 부족하고
스왑은 여유 있는 경우(반대 케이스)도 지금처럼 계속 차단하는 게 맞습니다 — 그건 실제로
위험한 상황입니다.

## 검증

1. 코드 수정 후 `python3 scripts/laya_integration.py status`로 `swapFreeKb`/`ramFreeKb`
   확인하고, 이 머신 조건(스왑 부족, RAM 여유)에서 `trace`/`fastcheck`가 **더 이상
   스킵되지 않고 실제로 laya를 호출하는지** 직접 재현해서 확인하세요.
2. 기존 유닛테스트(`scripts/test_laya_integration.py`)에 이 게이트 로직 테스트가
   있다면 새 조건에 맞게 갱신하고, 없다면 새로 추가하세요 — 최소 4가지 케이스:
   (RAM 충분/스왑 충분 → 통과), (RAM 부족/스왑 충분 → 차단), (RAM 충분/스왑 부족 →
   **이제 통과**), (RAM 부족/스왑 부족 → 차단).
3. 수정 확인되면 `before-after-validation.md`의 Phase 2(trace)부터 실제로 측정
   진행하세요.
