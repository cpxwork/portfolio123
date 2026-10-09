# 陈鹏旭 产品与数据学习作品集

产品经理与数据分析方向的作品资料。所有订阅业务数据和游戏参数均为模拟，三套作品均为 AI 辅助学习作品。

## 阅读入口

- [HR 速览 PDF（3 页）](docs/portfolio-summary.pdf)：产品指标口径、SQL 分析结果与游戏数值补充。
- [完整文档 PDF（24 页）](docs/portfolio-full.pdf)：详细 PRD、验证记录、SQL 报告与查询、游戏策划案和测试明细。

## 产品设计

[指标平台 PRD](product-design/PRD.md) · [验证记录](product-design/VALIDATION.md) · [原型使用说明](product-design/README.md)

包含 8 个指标的人群、观察时间与计算规则，3 类异常状态，12 条设计验收用例及本地模型规则检查。HTML 原型需要下载后在本地浏览器打开；GitHub 文件页面显示源码。

## SQL 数据分析

[分析报告](sql-analysis/分析报告.md) · [8 组 SQL](sql-analysis/analysis.sql) · [数据生成与复现步骤](sql-analysis/README.md)

模拟 1,200 名注册用户。展示事件去重、订单快照选择、先聚合再关联、不同付费分母和成熟队列 D7 留存；附 SQLite 数据、3 份原始数据 CSV、8 份查询结果 CSV、两幅图及 16 项对照校验。

## 游戏数值补充

[策划案](game-numerics/策划案.md) · [运行说明](game-numerics/README.md) · [验证结果](game-numerics/verification.json)

自定 RPG 1 至 20 级成长规则，3 种投入情景、90 天仿真、27 组敏感度组合与 8 条可执行检查。参数与成功序列均为设定，不代表真实玩家数据。

## 作品边界

这些资料不代表企业实习交付、真实产品上线或业务增长。模型检查不等同于完整浏览器验收，未开展真实用户测试。详细口径与局限请见各作品原文。
