"""Eight executable checks for the fictional numerical design exercise."""
import csv
import json
from pathlib import Path
from simulate import build_levels, load_config, scaled_cost, settle_upgrades, simulate, write_csv

ROOT = Path(__file__).resolve().parent


def read_csv(filename):
    with (ROOT / filename).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def state(level=1, xp=0, gold=0):
    return {"level": level, "xp": xp, "gold": gold, "overflow_xp": 0}


def check_config(c, levels):
    saved = read_csv("level_config.csv")
    assert len(saved) == len(levels) == 20
    assert [int(r["level"]) for r in saved] == list(range(1, 21))
    for actual, expected in zip(saved, levels):
        assert {k: int(v) for k, v in actual.items()} == expected
    exp = [r["xp_to_next"] for r in levels[:-1]]
    assert all(b > a > 0 for a, b in zip(exp, exp[1:]))
    assert levels[-1]["xp_to_next"] == levels[-1]["upgrade_cost_to_next"] == 0
    cumulative = 0
    for r in levels:
        assert r["cumulative_xp_to_reach"] == cumulative
        cumulative += r["xp_to_next"]
    assert levels[-1]["cumulative_xp_to_reach"] == 28975


def check_threshold(c, levels):
    a = state(xp=99, gold=50)
    result = settle_upgrades(a, levels)
    assert a == state(xp=99, gold=50) and result["upgrades"] == 0
    b = state(xp=100, gold=50)
    settle_upgrades(b, levels)
    assert b == state(level=2, xp=0, gold=20)


def check_multilevel(c, levels):
    xp = sum(r["xp_to_next"] for r in levels[:4])
    cost = sum(r["upgrade_cost_to_next"] for r in levels[:4])
    reward = sum(r["gold_reward_on_reach"] for r in levels[1:5])
    a = state(xp=xp, gold=cost)
    result = settle_upgrades(a, levels)
    assert a == state(level=5, gold=reward)
    assert result["upgrades"] == 4 and result["xp_spent"] == xp
    assert result["upgrade_cost"] == cost and result["level_rewards"] == reward


def check_gold_block(c, levels):
    a = state(xp=100, gold=49)
    before = dict(a)
    result = settle_upgrades(a, levels)
    assert a == before and result["upgrades"] == 0
    a["gold"] += 1
    settle_upgrades(a, levels)
    assert a == state(level=2, xp=0, gold=20)


def check_cap(c, levels):
    a = state(level=19, xp=levels[18]["xp_to_next"] + 77, gold=10000)
    first = settle_upgrades(a, levels)
    gold_after = a["gold"]
    assert a["level"] == 20 and a["xp"] == 0 and a["overflow_xp"] == 77
    assert first["upgrades"] == 1 and first["level_rewards"] == 210
    a["xp"] += 90
    second = settle_upgrades(a, levels)
    assert a["gold"] == gold_after and a["overflow_xp"] == 167
    assert second["upgrades"] == second["level_rewards"] == second["upgrade_cost"] == 0


def check_accounting(c, levels):
    all_rows = read_csv("baseline_daily.csv")
    assert len(all_rows) == 270
    previous = {}
    for raw in all_rows:
        sid = raw["scenario_id"]
        row = {k: (v if k == "scenario_id" else int(v)) for k, v in raw.items()}
        assert row["ending_gold"] == row["opening_gold"] + row["run_gold_rewards"] + row["quest_gold"] + row["level_gold_rewards"] - row["run_fees"] - row["upgrade_gold_cost"]
        assert row["ending_xp"] == row["opening_xp"] + row["xp_gained"] - row["xp_spent"] - row["xp_overflow_added"]
        assert row["completed_runs"] == row["successes"] + row["failures"]
        assert row["ending_gold"] >= 0 and row["ending_xp"] >= 0
        assert 1 <= row["ending_level"] <= 20
        if sid in previous:
            old = previous[sid]
            assert row["day"] == old["day"] + 1
            assert row["opening_gold"] == old["ending_gold"] and row["opening_xp"] == old["ending_xp"]
            assert row["opening_level"] == old["ending_level"]
        previous[sid] = row
    for scenario in c["scenarios"]:
        saved = [r for r in all_rows if r["scenario_id"] == scenario["id"]]
        recomputed, _ = simulate(c, scenario, levels)
        assert [{k: str(v) for k, v in r.items()} for r in recomputed] == saved


def check_scenario_order(c, levels):
    saved = read_csv("scenarios_summary.csv")
    assert len(saved) == 3
    fresh = [simulate(c, s, levels)[1] for s in c["scenarios"]]
    assert [{k: str(v) for k, v in r.items()} for r in fresh] == saved
    light, standard, heavy = fresh
    assert heavy["day_to_level_20"] <= standard["day_to_level_20"] <= light["day_to_level_20"]
    assert heavy["level_on_day_30"] >= standard["level_on_day_30"] >= light["level_on_day_30"]
    assert all(r["blocked_days"] == r["unplayed_runs_due_to_gold"] == 0 for r in fresh)


def check_sensitivity(c, levels):
    saved = read_csv("sensitivity.csv")
    assert len(saved) == 27
    fresh = []
    for scenario in c["scenarios"]:
        for xp in c["xp_multipliers"]:
            for cost in c["upgrade_cost_multipliers"]:
                rows, result = simulate(c, scenario, levels, xp, cost)
                fresh.append(result)
                assert all(r["ending_gold"] >= 0 for r in rows)
    assert [{k: str(v) for k, v in r.items()} for r in fresh] == saved
    # Monotonicity is asserted for these delivered inputs, not all possible games.
    for scenario in c["scenarios"]:
        at_base_cost = [r for r in fresh if r["scenario_id"] == scenario["id"] and r["cost_multiplier"] == 1.0]
        days = [r["day_to_level_20"] for r in at_base_cost]
        comparable = [d if isinstance(d, int) else c["simulation_days"] + 1 for d in days]
        assert comparable[0] >= comparable[1] >= comparable[2]
    assert scaled_cost(55, 1.0) == 55 and scaled_cost(50, 1.2) == 60


TESTS = [
    ("T01", "配置递增与一致性", "读取 CSV 并复算 1–20 级累计经验与配置", "19 段经验严格递增；20 级封顶；累计到 20 级 28975 XP", check_config),
    ("T02", "经验阈值", "分别输入 99/100 XP 与 50 金币", "99 XP 不升；100 XP 升 2 级，余 20 金币", check_threshold),
    ("T03", "单次连升", "一次输入升至 5 级所需的累计 XP 与全部升级费用", "连续升 4 次；成本、经验与一次性奖励账一致", check_multilevel),
    ("T04", "金币不足与恢复", "100 XP 配 49 金币，随后补 1 金币", "先保留资源不升；补足后升 2 级", check_gold_block),
    ("T05", "封顶与奖励幂等", "19 级输入足量经验与 77 额外 XP，到 20 后再加 90 XP", "只发一次 20 级奖励；167 XP 进溢出记录，无第 21 级", check_cap),
    ("T06", "每日资源账", "核对 270 条逐日记录，重新运行并比较 CSV", "金币与经验守恒、余额非负、跨日状态一致、结果可复现", check_accounting),
    ("T07", "三情景排序", "复算轻度/标准/高投入情景与摘要", "高投入先封顶；三组无金币卡点或无法开战", check_scenario_order),
    ("T08", "敏感度与复现", "复算 27 组倍率组合并检查经验倍率方向", "CSV 完全一致、余额非负；固定基础成本时经验增加不延迟封顶", check_sensitivity),
]


def main():
    c, results = load_config(), []
    levels = build_levels(c)
    for test_id, title, action, expected, function in TESTS:
        try:
            function(c, levels)
            status, detail = "PASS", "所有断言通过"
        except Exception as error:
            status, detail = "FAIL", f"{type(error).__name__}: {error}"
        results.append({"test_id": test_id, "test_name": title, "action": action,
                        "expected": expected, "status": status, "detail": detail})
    write_csv("test_cases.csv", results)
    report = {"exercise_origin": c["origin"], "test_count": len(results),
              "passed": sum(r["status"] == "PASS" for r in results), "tests": results}
    (ROOT / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"test_count": report["test_count"], "passed": report["passed"],
                      "failed": [r["test_id"] for r in results if r["status"] == "FAIL"]}, ensure_ascii=False))
    if report["passed"] != report["test_count"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
