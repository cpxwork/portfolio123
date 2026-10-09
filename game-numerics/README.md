# 游戏成长数值设计练习

本目录是 **2026-10-08 本轮新生成的 AI 辅助设计练习**。虚构游戏名为“星灯远征”，所有数值为自定假设，未开展玩家验证、引擎开发或上线运营。它提供可运行的数学模型、可检查的配置和策划说明。它不能证明用户既有的游戏时长、商业游戏策划或独立开发经历。

先阅读 [策划案.md](策划案.md)，再按下面的顺序运行。脚本使用 Python 标准库，无需安装包。

```powershell
python simulate.py
python verify.py
```

运行目录可以任意选择，脚本始终在自身所在目录读写。请使用本机安装的 Python 3。

## 文件与刷新关系

| 文件 | 用途 |
|---|---|
| [config.json](config.json) | 自定参数唯一入口，包含来源说明、情景和倍率 |
| [simulate.py](simulate.py) | 生成 1–20 级配置、90 日仿真、敏感度结果和策划案 |
| [verify.py](verify.py) | 运行 8 条可执行检查；需先运行 simulate.py |
| [策划案.md](策划案.md) | 目标、循环、公式、配置、结果、风险和迭代假设 |
| [level_config.csv](level_config.csv) | 20 行角色等级与奖励配置 |
| [baseline_daily.csv](baseline_daily.csv) | 三种情景各 90 天，合计 270 行逐日账 |
| [scenarios_summary.csv](scenarios_summary.csv) | 3 行基准情景摘要 |
| [sensitivity.csv](sensitivity.csv) | 3 情景 × 3 经验倍率 × 3 成本倍率，27 行比较 |
| [test_cases.csv](test_cases.csv) | 8 条测试的动作、预期和实际状态 |
| [verification.json](verification.json) | 测试结果机器可读记录 |

CSV 使用 UTF-8 BOM，便于 Excel 打开中文。数字字段保存未格式化数字；它们是静态输出，修改 CSV 不会自动重新计算。修改 [config.json](config.json) 后需重新运行两个脚本。测试中的 20 级、90 天和累计经验 28975 是本版冻结基线；改这些规则时应同步审查测试预期，而不是让旧 PASS 代表新规则已验证。

## 字段口径

- `level`：角色当前等级。`xp_to_next`：到下一等级的 XP；20 级的 0 表示封顶不适用。
- `cumulative_xp_to_reach`：从 1 级到达当前等级消耗的累计 XP，不含封顶后溢出。
- `upgrade_cost_to_next`：升级到下一等级的基础金币费用。`gold_reward_on_reach`：到达本级一次性金币奖励。
- `day_to_level_*`：首次达到该等级的仿真日序号。`not_reached` 表示 90 天内未达到。
- `success_rate_assumed`：情景自定成功率，0.85 即 85%，不是实际玩家成功率。
- `xp_multiplier`：经验产出倍率；`cost_multiplier`：升级金币成本倍率，两者不改变金币产出。
- `gold_blocked` / `blocked_days`：日结算后经验够但金币不足的状态 / 日数。
- `unplayed_runs_due_to_gold`：金币不足以支付整备费造成的计划远征未完成次数。
- `opening_*` / `ending_*`：当日期初 / 期末状态。金币单位为游戏金币，经验单位为 XP，投入单位为分钟。
- `xp_overflow_added` / `overflow_xp_day_90`：到 20 级后当日 / 截至第 90 日未用于升级的 XP，仅记录不兑换。

## 学习与面试准备

1. 不看脚本，手算 1 级到 2 级的经验、金币与奖励，解释为什么需先支付升级费用。
2. 修改一个参数，如每日任务 XP 从 200 改为 150，重跑并记录结果差异与原因。
3. 解释确定性成功比例与真实随机胜败的差别，以及为什么三情景比较不是单因素因果实验。
4. 为第 20 级后的金币增加设计一个可选消耗，并补充配置、仿真与验证，不只改文案。
5. 记录自己实际完成的调整和解释，再据实描述个人贡献。

目前准确的作品描述：**“AI 辅助生成的 RPG 成长数值练习：包含 1–20 级经验与金币配置、三种投入情景的 90 日确定性仿真、27 组参数敏感度比较及 8 条可执行检查；参数为自定假设，未经玩家验证。”** 用户学习前不要直接写成独立负责的项目或已掌握的技能。
