"""Fictional RPG numerical design exercise. Standard library only.

All input values are assumed, not measured player data. Run this script first,
then verify.py. CSVs are deterministic simulation outputs, not live spreadsheets.
"""
import csv
import json
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_config():
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def round_to_five(value):
    """Nearest multiple of five; exact halfway values round upward."""
    return int((Decimal(str(value)) / 5).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) * 5


def scaled_cost(base, multiplier):
    return round_to_five(Decimal(base) * Decimal(str(multiplier)))


def build_levels(c):
    rows, cumulative = [], 0
    for level in range(1, c["max_level"] + 1):
        n = level - 1
        capped = level == c["max_level"]
        xp = 0 if capped else c["xp_base"] + c["xp_linear"] * n + c["xp_quadratic"] * n * n
        cost = 0 if capped else round_to_five(Decimal(c["cost_base"]) + c["cost_linear"] * n + Decimal(str(c["cost_quadratic"])) * n * n)
        reward = 0 if level == 1 else c["reward_base"] + c["reward_linear"] * (level - 2) + (c["milestone_gold"] if level in c["milestone_levels"] else 0)
        rows.append({"level": level, "xp_to_next": xp, "cumulative_xp_to_reach": cumulative,
                     "upgrade_cost_to_next": cost, "gold_reward_on_reach": reward,
                     "milestone": int(level in c["milestone_levels"])})
        cumulative += xp
    return rows


def settle_upgrades(state, levels, cost_multiplier=1.0):
    """Cost is paid before receiving the destination level's one-time reward."""
    gains, cost_total, xp_used, count = 0, 0, 0, 0
    while state["level"] < len(levels):
        current = levels[state["level"] - 1]
        cost = scaled_cost(current["upgrade_cost_to_next"], cost_multiplier)
        if state["xp"] < current["xp_to_next"] or state["gold"] < cost:
            break
        state["xp"] -= current["xp_to_next"]
        state["gold"] -= cost
        state["level"] += 1
        reward = levels[state["level"] - 1]["gold_reward_on_reach"]
        state["gold"] += reward
        gains += reward
        cost_total += cost
        xp_used += current["xp_to_next"]
        count += 1
    overflow = 0
    if state["level"] == len(levels):
        overflow = state["xp"]
        state["xp"] = 0
        state["overflow_xp"] += overflow
    return {"level_rewards": gains, "upgrade_cost": cost_total, "xp_spent": xp_used,
            "upgrades": count, "xp_overflow_added": overflow}


def simulate(c, scenario, levels, xp_multiplier=1.0, cost_multiplier=1.0):
    state = {"level": 1, "xp": 0, "gold": c["start_gold"], "overflow_xp": 0}
    days, attempts_total, first_reached = [], 0, {1: 0}
    rate = Fraction(str(scenario["success_rate"]))
    planned = scenario["minutes_per_day"] // c["run_minutes"]
    for day in range(1, c["simulation_days"] + 1):
        opening = dict(state)
        success, failure, fees, rewards, xp_raw, attempts = 0, 0, 0, 0, 0, 0
        for _ in range(planned):
            if state["gold"] < c["run_fee"]:
                break
            state["gold"] -= c["run_fee"]
            fees += c["run_fee"]
            before_wins = (attempts_total * rate.numerator) // rate.denominator
            attempts_total += 1
            after_wins = (attempts_total * rate.numerator) // rate.denominator
            won = after_wins > before_wins
            success += int(won)
            failure += int(not won)
            attempts += 1
            xp_raw += c["xp_success"] if won else c["xp_failure"]
            gold = c["gold_success"] if won else c["gold_failure"]
            rewards += gold
            state["gold"] += gold
        quest_done = attempts >= c["quest_min_runs"]
        quest_gold = c["quest_gold"] if quest_done else 0
        xp_raw += c["quest_xp"] if quest_done else 0
        state["gold"] += quest_gold
        xp_gained = int(Fraction(xp_raw) * Fraction(str(xp_multiplier)))
        state["xp"] += xp_gained
        settlement = settle_upgrades(state, levels, cost_multiplier)
        for level in range(opening["level"] + 1, state["level"] + 1):
            first_reached[level] = day
        blocked = int(state["level"] < c["max_level"] and state["xp"] >= levels[state["level"] - 1]["xp_to_next"] and state["gold"] < scaled_cost(levels[state["level"] - 1]["upgrade_cost_to_next"], cost_multiplier))
        days.append({"scenario_id": scenario["id"], "day": day, "planned_runs": planned,
                     "completed_runs": attempts, "successes": success, "failures": failure,
                     "opening_level": opening["level"], "ending_level": state["level"],
                     "opening_xp": opening["xp"], "xp_gained": xp_gained,
                     "xp_spent": settlement["xp_spent"], "ending_xp": state["xp"],
                     "xp_overflow_added": settlement["xp_overflow_added"],
                     "opening_gold": opening["gold"], "run_gold_rewards": rewards,
                     "quest_gold": quest_gold, "run_fees": fees,
                     "level_gold_rewards": settlement["level_rewards"],
                     "upgrade_gold_cost": settlement["upgrade_cost"],
                     "ending_gold": state["gold"], "gold_blocked": blocked})
    summary = {"scenario_id": scenario["id"], "scenario_name": scenario["name"],
               "minutes_per_day": scenario["minutes_per_day"], "success_rate_assumed": scenario["success_rate"],
               "xp_multiplier": xp_multiplier, "cost_multiplier": cost_multiplier,
               "day_to_level_5": first_reached.get(5, "not_reached"),
               "day_to_level_10": first_reached.get(10, "not_reached"),
               "day_to_level_15": first_reached.get(15, "not_reached"),
               "day_to_level_20": first_reached.get(20, "not_reached"),
               "level_on_day_30": days[29]["ending_level"],
               "gold_on_day_30": days[29]["ending_gold"],
               "gold_on_day_90": days[-1]["ending_gold"],
               "blocked_days": sum(r["gold_blocked"] for r in days),
               "unplayed_runs_due_to_gold": sum(r["planned_runs"] - r["completed_runs"] for r in days),
               "overflow_xp_day_90": state["overflow_xp"]}
    return days, summary


def write_csv(filename, rows):
    with (ROOT / filename).open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def design_document(c, levels, summaries, sensitivity):
    scenario_lines = "\n".join(f"| {s['scenario_name']} | {s['minutes_per_day']} | {s['success_rate_assumed']:.0%} | {s['day_to_level_10']} | {s['day_to_level_20']} | {s['level_on_day_30']} | {s['gold_on_day_90']} |" for s in summaries)
    level_lines = "\n".join(f"| {r['level']} | {r['xp_to_next']} | {r['cumulative_xp_to_reach']} | {r['upgrade_cost_to_next']} | {r['gold_reward_on_reach']} |" for r in levels)
    standard = [s for s in sensitivity if s["scenario_id"] == "standard"]
    sensitivity_lines = "\n".join(f"| {s['xp_multiplier']:.1f} | {s['cost_multiplier']:.1f} | {s['day_to_level_20']} | {s['gold_on_day_90']} | {s['blocked_days']} |" for s in standard)
    xp_comparison = [s["day_to_level_20"] for s in standard if s["cost_multiplier"] == 1.0]
    return f"""# 星灯远征：角色成长数值设计练习

**作品性质**：{c['origin']}

这是一款虚构单人 RPG 的成长系统纸面原型。程序仿真用于检验经验节奏和金币流转，未制作可玩的游戏客户端，也未开展 Unity 开发、真实玩家测试或上线运营。作者归属应写“AI 辅助练习”，用户理解、调整并复现后再讨论个人贡献。

## 1. 设计目标与范围

- 建立 1–20 级连续成长与 5/10/15/20 级节点奖励，让前期升级较快、后期所需投入递增。
- 假设标准玩家每天投入 30 分钟、战斗成功率 85%，节奏目标为约 7 天到 10 级、40–50 天到 20 级。这是本练习设定的设计目标，不是用户留存指标。
- 用三种投入情景检查轻度玩家是否持续成长、高投入玩家是否过早触顶，以及金币是否阻断升级。
- 仅包含经验、金币、升级和每日任务。战力、装备、付费、掉落随机性、社交、体力限制及关卡难度均不在本轮模型中，不能由本模型推定留存或付费表现。

## 2. 核心循环与状态规则

选择远征 → 支付 15 金币整备费 → 进行 5 分钟远征 → 获得胜败奖励 → 每日完成至少 3 次远征领取一次任务奖励 → 按等级依次结算升级 → 获得节点奖励 → 下一日继续。

每日模拟先结算全部远征和每日任务，再尝试自动升级。单次整备费在战斗开始前支付，余额不足则当天剩余远征停止；升级需同时满足经验和金币，金币成本先支付、升后奖励后到账。经验够而金币不够时，保留经验和等级，后续补足金币再升级。一次可连升多级，每级奖励仅领取一次。达到 20 级后不再升级；新增经验记录为 `overflow_xp`，不转化为金币，避免凭空引入资源来源。

## 3. 公式、奖励与取整

令当前等级为 L、n=L−1，L∈[1,19]：

- 下一等级所需经验：E(L)=100+35n+10n²。
- 基础升级金币：U(L)=round5(50+8n+1.5n²)。`round5` 为四舍五入到最接近的 5，恰好居中向上取。
- 到达等级 T≥2 的一次性金币奖励：R(T)=20+5(T−2)+100×I(T∈{{5,10,15,20}})。1 级不重复发升级奖励。
- 敏感度升级成本：U'(L)=round5(U(L)×成本倍率)。经验产出为 floor(当日基础经验×经验倍率)，基础经验包含远征及每日任务。
- 20 级 `xp_to_next` 和 `upgrade_cost_to_next` 记 0，语义为封顶不适用，不是可无限免费升级。累计到达经验始终从前一等级推算。

| 来源或消耗 | 成功 | 失败 | 条件与次数 |
|---|---:|---:|---|
| 单次远征经验 | 90 | 30 | 每次 5 分钟 |
| 单次远征金币 | 40 | 10 | 完成远征后到账 |
| 单次远征整备费 | −15 | −15 | 开始前支付 |
| 每日任务经验 | 200 | 200 | 当日完成至少 3 次远征，只领一次 |
| 每日任务金币 | 60 | 60 | 同上 |
| 升级消耗 | 按配置 | 按配置 | 先扣金币与经验，再发升后金币奖励 |

初始金币 300。没有付费入口、交易转移、无限重置或离线收益。金币余额按“期初 + 远征奖励 + 每日任务奖励 + 等级奖励 − 整备费 − 升级成本”核对。

## 4. 1–20 级配置表

| 当前等级 | 升至下一级经验 | 到达本级累计经验 | 升至下一级金币 | 到达本级金币奖励 |
|---:|---:|---:|---:|---:|
{level_lines}

详见 `level_config.csv`。金币单位为游戏金币、经验单位为 XP。所有参数的唯一编辑入口是 `config.json`，配置表及结果由脚本重新生成；CSV 是静态计算结果，手动编辑 CSV 不会更新仿真。

## 5. 三种情景与计算方法

仿真持续 90 天。成功序列是确定性的：累计第 N 次尝试的成功总数为 floor(N×假设成功率)，与上次累计成功数相减得到本次胜败。它控制整体比例以便复现，不模拟真实随机波动、不同玩家分布或连续失败概率。情景同时改变投入时间与假设成功率；它们不是只改变时长的因果实验。

| 情景 | 每日分钟 | 假设成功率 | 到 10 级天数 | 到 20 级天数 | 第 30 日等级 | 第 90 日金币 |
|---|---:|---:|---:|---:|---:|---:|
{scenario_lines}

达到等级的天数为首次达到该等级的自然日序号，开始日记第 1 天，初始化记第 0 天。CSV `not_reached` 表示 90 天内未达到，不能当作 0。结果是本套假设下的精确程序输出，不是任何真实游戏的玩家行为。

## 6. 敏感度对比

三种情景分别计算经验产出倍率 0.8/1.0/1.2 × 升级金币倍率 0.8/1.0/1.2，共 27 组；成功率、时间和其余条件保持各自情景的固定值。完整结果见 `sensitivity.csv`。下表展示标准投入的九组：

| 经验倍率 | 升级金币倍率 | 到 20 级天数 | 第 90 日金币 | 经验够但金币不足的日数 |
|---:|---:|---:|---:|---:|
{sensitivity_lines}

这里的 `blocked_days` 只记录当日全部收入结算后，经验满足而金币不足的状态；不衡量当天途中一度缺钱的时长。`unplayed_runs_due_to_gold` 单独记录因整备费不足而停止的次数。两者不可混为同一个卡点指标。

计算结果表明：标准投入、固定基础升级费用时，经验倍率 0.8/1.0/1.2 的封顶时间分别为 {xp_comparison[0]}/{xp_comparison[1]}/{xp_comparison[2]} 天。本轮 27 组均没有日结金币卡点，升级费用在 ±20% 区间内只改变余额，没有改变对应的封顶时间，因此在这些假设下金币门槛较宽松。固定成本倍率时，第 90 日余额不随经验倍率改变：每组届时均已封顶，累计远征收入、任务收入、全部升级费用和等级奖励都一致，而封顶后的金币消耗没有新增。这是模型规则导致的结果，需要下一轮增补消耗或低收益压力情景后再评价经济平衡。

## 7. 资源风险与优先级

1. **封顶后的金币积累**：封顶后升级消耗归零，远征与任务仍产币。需先设计可选外观或营地消耗并测算，再决定是否调整奖励；不直接把玩家金币清零。
2. **时间和成功率被绑在一起**：高投入组默认战斗更熟练，缩短成长时间的来源不止时长。下一轮先固定 85% 成功率，只改变时间。
3. **每日任务门槛**：15 分钟恰好达到 3 次，10 分钟玩家完全拿不到任务，可能出现收益断崖。应测试分阶段任务奖励。
4. **金币升级卡点**：经验与金币是双重门槛，低成功率、低初始金币或高升级费用可能造成循环中断。必须同时观察可开战余额与待升级状态。
5. **平滑成功序列弱化运气风险**：确定性比例不能证明连续失败时体验良好。下一轮用多个固定随机种子检验下分位数。
6. **体验反馈尚缺**：经验曲线递增只证明数学关系，不能证明重复战斗有趣。需要灰盒试玩，观察单次远征时长和升级时机是否被注意到。
7. **无战力反馈**：角色等级没有改变成功率、时长或掉落，缺少成长带来的能力提升。本轮仅验证资源账，不得据此声称形成完整 RPG 数值体系。
8. **宏观指标不可推定**：模型没有流失、支付、用户样本或实验分组，不应将计算结果写成留存、付费或营收提升。

## 8. 可执行测试与迭代假设

`verify.py` 实现 8 条测试，并生成 `test_cases.csv` 和 `verification.json`：配置递增与一致性、经验阈值、单次连升、金币不足与恢复、封顶与奖励幂等、每日资源账、情景排序、敏感度与复现一致性。每条包含测试动作、预期结果和执行状态。

下一轮迭代采用以下可证伪假设，均未被本轮验证：

| 假设 | 修改 / 验证方法 | 观察指标与停止条件 |
|---|---|---|
| 分阶段每日任务能减轻 10 分钟玩家的收益断崖 | 把 3 次领奖改为 1/2/3 次分段，并固定成功率比较 | 10/15/30 分钟到 10 级天数；若 15 分钟以上组奖励被重复领取，停止合入 |
| 升级费用提高 20% 可以减少过量金币而不阻断标准成长 | 本轮敏感度作为初筛，再加入 50% 成功率与连续失败测试 | 90 日余额、卡点日数、无法开战次数；若无法开战则重新设计保底来源 |
| 高投入玩家需要封顶后的独立目标 | 增加一次性可选营地升级，避免重复扣同一笔钱 | 单独列产出/消耗与完成时间；不能挪用本轮结果当真实参与率 |
| 等级提升能带来可感知能力收益 | 灰盒加入一个战力因素，记录试玩者反馈 | 每 5 级的战斗时长、失败次数、反馈；至少先记录真实样本与口径 |

## 9. 使用边界

用户可学习公式、复跑脚本、解释上述取舍，并记录自己的参数调整与理由。个人简历最多描述自己实际完成并能解释的部分；本轮默认归属为 AI 辅助生成练习，不补充不存在的游戏时长、商业策划经历或用户验证成果。
"""


def main():
    c = load_config()
    levels = build_levels(c)
    baseline_rows, summaries, sensitivity = [], [], []
    for scenario in c["scenarios"]:
        rows, summary = simulate(c, scenario, levels)
        baseline_rows.extend(rows)
        summaries.append(summary)
        for xp in c["xp_multipliers"]:
            for cost in c["upgrade_cost_multipliers"]:
                _, result = simulate(c, scenario, levels, xp, cost)
                sensitivity.append(result)
    write_csv("level_config.csv", levels)
    write_csv("baseline_daily.csv", baseline_rows)
    write_csv("scenarios_summary.csv", summaries)
    write_csv("sensitivity.csv", sensitivity)
    (ROOT / "策划案.md").write_text(design_document(c, levels, summaries, sensitivity), encoding="utf-8")
    print(json.dumps({"level_rows": len(levels), "baseline_daily_rows": len(baseline_rows),
                      "baseline_scenarios": len(summaries), "sensitivity_combinations": len(sensitivity),
                      "summaries": summaries}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
