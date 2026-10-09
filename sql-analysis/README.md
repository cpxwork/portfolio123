# 模拟用户行为 SQL 学习作品

**这套作品由 AI 辅助创建于 2026-10-08。所有数据为模拟数据，没有真实企业或用户信息，没有真实收入或广告投放效果，也不是此前完成的实习经历。**

练习场景：为一个虚构AI工具产品梳理用户、行为与订单数据，分析注册、活跃、付费、退款和注册队列D7留存。观察期2026-09-01至2026-10-07，时区Asia/Shanghai。随机种子固定为20261008。

## 如何阅读

下载仓库后，在本地浏览器打开 [分析报告.html](分析报告.html)：离线可用，两幅图已嵌入页面。完整口径和限制见 [分析报告.md](分析报告.md)。随后对照 [analysis.sql](analysis.sql) 与 [results/](results/) 的8份结果CSV。CSV为UTF-8 BOM，可用Excel或文本编辑器打开；数值列是未附百分号的数值，例如0.123456表示12.3456%。

[simulation.sqlite](simulation.sqlite) 是可直接查询的SQLite数据库。所有原始数据还导出在 [data/](data/) 中，供独立复核。[validation.json](validation.json) 保存16项数值校验、固定参数与每份CSV的SHA-256。

初次交付已完整运行两次，11份CSV的SHA-256全部一致；交付时复现记录见[reproducibility_check.json](reproducibility_check.json)，该记录对应默认种子和参数，后续修改后需重新验证。

## 运行

Python 3.10及以上，SQLite 3.25及以上；数据生成、查询和CSV导出只用Python标准库。图像导出使用 Pillow，可用 `python -m pip install Pillow` 安装。脚本优先使用Windows微软雅黑字体，其他系统需将`font_path`改为本机中文字体。

在本目录运行：

```powershell
python .\generate_and_analyze.py
```

脚本会在自身目录重新生成数据库、数据CSV、结果CSV、两幅PNG图、报告和校验JSON；固定SEED和默认参数保持CSV结果一致。它会覆盖这些派生产物，请将个人修改存到另一文件名后再运行。`README.md`和[analysis.sql](analysis.sql)不会被脚本改写。

在DB Browser for SQLite或其他SQLite客户端中打开数据库，可以单独执行 [analysis.sql](analysis.sql) 中的SELECT。完整文件的SETUP区先创建清洗视图，再执行各查询。

## 数据表

| 表 | 粒度与字段 | 生成来源 |
| --- | --- | --- |
| users | 每名模拟注册用户一行；user_id、signup_at、channel、is_test | 1,200用户，分布在37日；每50名中一名测试用户，共24名 |
| events_raw | 每个上报记录一行；raw_id、event_uuid、user_id、event_name、event_at、ingest_at | 包含重传、同日重复启动、越界时间和不存在用户 |
| orders_raw | 每份订单状态快照一行；order_id、金额分、退款分、状态与更新时间 | 包含待支付→已支付/失败、快照重复与后续退款 |
| calendar | 每个观察日一行 | 37个自然日，保证日均指标分母完整 |

`raw_id`是导入行号，`event_uuid`/`order_id`才是业务去重键。不存在用户事件是故意放入的质量练习，因此原始事件表没有外键强制约束。所有金额以整数“分”保存，查询输出除以100为“元”。所有渠道是模拟分类，不代表真实渠道投放。

## 查询覆盖

| 查询 | 输出 | 要点 |
| --- | --- | --- |
| 01_overview | 总览、不同分母付费率、ARPU/ARPPU、退款与净额 | 标量子查询、NULLIF、去重用户和订单 |
| 02_daily_metrics | 37日日活/注册/付费/净额、7日均值、累计净额 | 窗口AVG/SUM、完整日历、前6日滚动值为空 |
| 03_channel_metrics | 渠道样本与付费 | 用户粒度先聚合后JOIN，防止事件×订单重复计额 |
| 04_retention_cohorts | 注册日队列D7 | LEFT JOIN、GROUP BY、成熟窗口、用户日去重 |
| 05_retention_channels | 渠道D7 | EXISTS关联子查询、注册日+7当天活跃 |
| 06_behavior_coverage | 期间行为覆盖 | MAX用户标志、UNION ALL；不施加时序，不是严格漏斗 |
| 07_top_payers | 模拟付费用户排名 | DENSE_RANK；并列排名可能超过10行 |
| 08_data_quality | 原始/清洗规模、退款类型、未成熟用户 | 范围边界、测试账户、异常数据诊断 |

SETUP中的`ROW_NUMBER`按业务键及更新时间处理重传和订单最新状态；截止日之后的订单退款快照不参与此次as-of结果。

SETUP还将去重后的用户日启动记录物化到`user_activity_cache`，并建立唯一索引，供日活与D7关联查询复用。修改raw数据后需要重新执行SETUP刷新此缓存。

## 学习与面试使用

可以把它作为**模拟数据学习作品**。阅读结果、解释口径、自己修改查询并成功复现后，再按本人实际完成部分描述。创建来源应保留AI辅助，不能写为独立做完的历史项目、真实企业实习或客户业务成果。

建议亲自完成以下步骤，并保留修改记录：

1. 不参考结果手算一名用户的事件去重、退款金额和D7归属。
2. 解释为什么“付费人数/所有注册”和“付费人数/活跃用户”不能混用。
3. 将D7改为D1，并重新确定成熟用户范围；确认未成熟用户不当成流失。
4. 添加注册后7日付费转化，区分当前全观察期付费覆盖；设计并实现严格时序漏斗。
5. 更换seed，检查结果变化，以及渠道差异为什么不能得出因果结论。

**使用边界**：不得把模拟样本或计算结果描述成真实企业实习、真实客户分析、付费增长或 A/B 实验结论。
