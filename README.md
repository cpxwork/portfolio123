# 陈鹏旭｜产品与 AI 作品集

从产品体验、方案设计到评测与数据分析，按问题、决策和证据组织作品。

## 最新入口

[产品作品集 PDF（12 页）](docs/product-portfolio.pdf) · [嗨皮瓜需求与验收样例](docs/haipigua-delivery-case.md) · [Product Evaluation Lab](product-eval-lab/README.md) · [验证记录](docs/validation-record.md)

| 作品 | 展示重点 | 查看入口 |
|---|---|---|
| 嗨皮瓜 | 四角色协作、自然语言行动建议、反馈与记忆、模型与规则分工 | [腾讯云演示](https://frost-guard-d3gw4cry5916d32c4-1503361620.tcloudbaseapp.com/haipigua/) · [需求验收](docs/haipigua-delivery-case.md) · [源码](haipigua/README.md) |
| Product Evaluation Lab | ReAct 工具编排、检索版本对照、A/B 分析、逐条轨迹与边界检查 | [运行说明](product-eval-lab/README.md) |
| 会员转化实验方案 | 信息组织、ITT 指标、退款护栏、埋点与预注册决策 | [方案](membership-conversion-ab/README.md) |
| SQL 用户行为分析 | 去重、订单快照、退款、成熟队列与指标口径 | [分析报告](sql-analysis/分析报告.md) |

实验室默认使用固定脚本决策和合成文档，不把执行器检查作为模型准确率；检索报告保留表现下降的配置。模型接口需要单独显式开启。作品集中的个人职责、团队公开成果和模拟分析按案例分别标明。

---

## 既有学习与专项作品

围绕具体问题提供可玩原型、PRD、数据口径、源码和可复跑验证。新增咖啡经营 Demo、任务型助手评测、嗨皮瓜诊断与结构化输出核验；既有指标管理平台、SQL 和游戏数值资料继续保留。

## 会员转化与 A/B 实验方案（新增）

[在线阅读完整方案](membership-conversion-ab/README.md) · [查看／下载两页 PDF](membership-conversion-ab/membership-conversion-ab.pdf)

针对假设订阅工具的权益表达问题，提供页面方案、用户级随机分流、7 日支付转化、14 日退款护栏、严格漏斗与停止规则。当前为 AI 辅助产品设计练习，未开展真实线上实验，不宣称转化提升。

## 先看这三个入口

1. **[在线试玩：街角咖啡经营实验室](https://frost-guard-d3gw4cry5916d32c4-1503361620.tcloudbaseapp.com/coffee-lab/)**：14 天经营，查看客流损失、成本和账本；腾讯云测试域名首次可能需要点击“确定访问”。
2. **[任务型助手评测与失败案例](agent-evaluation/README.md)**：36 个人工样例，分层评测、Prompt / Skill、规则迭代和执行 trace。
3. **[指标管理平台 PRD](product-design/PRD.md)**：同名指标口径、依赖关系、异常分支与验收设计。

## 作品与解决的问题

| 作品 | 发现的问题 | 可以查看的交付与验证 |
|---|---|---|
| [会员转化与 A/B 实验方案](membership-conversion-ab/README.md) | 权益信息如何呈现、如何验证付费变化 | 两页 PDF、PRD 流程、ITT 指标、护栏、埋点与预注册设计；尚未上线实验 |
| [街角咖啡经营实验室](coffee-lab/README.md) | 只看利润难以定位经营损失 | 可玩 Demo、互斥客流与账本、PRD；20 项检查 / 600 参数组合，3 策略 × 10 种子 |
| [任务型助手评测](agent-evaluation/README.md) | 路由正确、调用工具、交付合规需要分层核验 | 36 样例、参考约束、结果 CSV、trace、Prompt 与 Skill；保留失败 H11 |
| [嗨皮瓜任务诊断](haipigua-diagnostics/README.md) | 改时间却丢失原任务日期 | 公网复现、源码定位、修复提案和 5 个回归样例；修复尚未上线 |
| [结构化输出质量核验](structured-output-checker/README.md) | 输出格式、数量和来源可能不满足约束 | Python 检查器、8 样例和字段级结果，区分结构通过与事实正确 |
| [指标管理平台](product-design/README.md) | 同名付费指标的人群和窗口不同 | PRD、8 项指标字典、交互原型、12 条验收用例与逻辑检查 |
| [SQL 用户行为分析](sql-analysis/README.md) | 重复事件、订单状态和未成熟队列造成误判 | 1,200 模拟用户、8 组 SQL、结果 CSV、16 项交叉校验 |
| [RPG 游戏数值练习](game-numerics/README.md) | 成长资源与封顶状态需要检查 | 成长规则、3 情景、27 组敏感度组合、8 项可执行检查 |

## 复跑新增作品

下载完整仓库后，在根目录执行：

```bash
node coffee-lab/tests.js
node coffee-lab/experiments.js
node agent-evaluation/evaluate.js
node haipigua-diagnostics/diagnose-date.cjs
python structured-output-checker/evaluator.py
```

Node.js 18+ / Python 3.10+，不需要 API Key 或第三方依赖。离线咖啡可直接打开 `coffee-lab/index.html`。指标原型需下载 HTML 与 model.js 后在浏览器打开；GitHub 文件页展示的是源码。

## 既有 PDF 阅读资料

[HR 速览 PDF（3 页）](docs/portfolio-summary.pdf) · [完整文档 PDF（24 页）](docs/portfolio-full.pdf)

这两份旧 PDF 覆盖指标平台、SQL 和 RPG 三套既有作品；本次新增作品请查看上方目录与在线 Demo。

## 证据范围

本仓库是 AI 辅助学习作品，模拟数据与规则实验不代表真实业务增长。咖啡 Demo 已做公网静态部署与浏览器检查；任务评测仍为离线规则和本地工具，未调用真实模型。人工保留集不是独立业务盲测；软件检查、输出约束通过和小样本回归各有具体范围，详细说明与未解决案例保留在各目录。

