# A-M5 里程碑报告：审计与误判申诉

> 按《交接提示词.md》第 9 节格式。里程碑实际完成于 2026-10-16；本报告于 2026-10-17 按当前代码现状补写核对。

## 1. 新增/修改的文件

| 文件 | 一句话说明 |
|---|---|
| `audit.js` | `createAuditLog({ path, sources, nowFn })`：判定/计划/纠正/申诉记录落 JSONL；`sources` 聚合多个只读日志源（指令总线 JSONL、执行账本 JSONL），四段链路跨文件一起查；查询按 task / 时间段，含 `explain` 原文；用户纠正写回 `source=manual` 并提供读取接口；误判申诉登记（filed）与处置（resolved）成对可查 |
| `audit.test.js` | 9 用例（按任务/时段查询、纠正写回与读取、申诉全周期、多源聚合、审计自身失败也留痕） |

## 2. 测试怎么跑、结果

```
node run-tests.js
audit.test.js: 9/9 通过
```

验收对应覆盖："依据 → 指令 → 执行 → 还原"四段可查（`sources` 聚合 state-sensor 快照 + bus JSONL + executor 账本）；用户纠正（`source=manual`）回流 state-sensor 纠正表后，同一场景再次判定正确（回流链路在 state-sensor 套件"用户纠正回流 3/3"验证，`escalationEligibility` 消费约束 6/6 同套件）。

## 3. 与第 6 节契约有无偏差

- **无偏差**。6.2 状态模型的 `explain`/`evidence` 可读性由产出侧保证，审计原样留存；纠正回流走 state-sensor 的 corrections 读取接口（`source=manual` 权重最高），与 6.2"source=manual 权重最高"一致。
- 补充说明（2026-10-17 02:20 契约分层，NOTES）：`audit` 的 `nowFn` 是时间戳格式化器（`() => string`，返回 ISO 串），与全项目时钟契约（`() => number` 毫秒）分属两层，不混用。

## 4. 记入 NOTES.md 的疑点

- 审计文件路径须位于 `<workRoot>/.discipline/audit/`（NOTES #16，与 A-M0 同源）。
- "纠正记录作为规则修正依据"的长期效果（修正表容量、衰减、生效范围）暂未定；未定前不静默扩大范围（硬性规则 6）。

## 自查（进入下一里程碑前）

- [x] 上一级测试全绿（audit 9/9）
- [x] 契约无偏差
- [x] 没有新增隐私/合规章节
- [x] 没有碰 `portfolio123` 之外的文件
