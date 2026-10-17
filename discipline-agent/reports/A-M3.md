# A-M3 里程碑报告：状态驱动任务拆步

> 按《交接提示词.md》第 9 节格式。里程碑实际完成于 2026-10-16；2026-10-16 用户架构指示（"纯规则全部改成靠大模型……把纯规则完全删除"）后，本模块于 2026-10-17 完成纯模型化改造与规则物理删除。本报告按当前代码现状补写核对。

## 1. 新增/修改的文件

| 文件 | 一句话说明 |
|---|---|
| `task-planner.js` | `planWithLlm(task, state, opts.llm)`（planner 模型）：任务+状态 → ≤7 步、每步 ≤3 分钟、每步带完成信号；`normalizeState` 状态归一（置信度 <0.6 → `unknown`）；安全态短路：`away`→hold、`learning`→defer、`unknown`→confirm（`llmSkipped`）；确定性钳制 `MAX_STEPS=7` / `MAX_STEP_MINUTES=3`，溢出步夹紧并记 `violations[]`；默认步时长 2 分钟、`doneSignal` 缺省自动补 |
| `task-planner-llm.test.js` | 15 用例（桩 LLM，不发网络请求） |
| ~~`task-planner.test.js`~~ | 原 15 个规则用例，随规则实现于 2026-10-17 物理删除 |

**架构变更记录**：原"内容层移植 `engine.js` 三档步骤库"的规则实现（`STEP_LIBRARY` / `fillTemplate` / `pickCandidates` / `applyStateStart` / `checkConstraints` / `plan` / `replan`）已按用户指示**物理删除**，不留 legacy。8.1 状态→起步映射（`lying_bed`→坐起来→下床、`seated_desk`→直接打开作业本、`standing_or_moving`→走到书桌前、`away`→不拆步、`learning`→不打扰、`unknown`→只发一次确认）作为 planner 角色的 prompt 约束保留。重排语义：状态变化后带新状态重调 `planWithLlm`（已完成步由调用方携带并从输出排除），确定性钳制保证每次输出合规。

## 2. 测试怎么跑、结果

```
node run-tests.js
task-planner-llm.test.js: 15/15 通过
```

覆盖：七步上限与超限记违规、3 分钟钳制、默认时长/完成信号补齐、`away`/`learning`/`unknown` 三安全态短路且不调模型、空或非法输出 → confirm 模式、`normalizeState` 低置信归一等。

## 3. 与第 6 节契约有无偏差

- 6.3 职责"状态驱动拆步 + 重排"不变；行为规格中"移植 `engine.js` 三档步骤库"一项按用户 2026-10-16 架构指示改为 planner 模型生成，属**显式架构变更**（见 NOTES 2026-10-16 22:50、2026-10-17 01:15 条目），非擅自改动。
- 硬约束不变：≤7 步、单步 ≤3 分钟、第一步从当前状态出发、每步有明确完成信号——由确定性钳制兜底，模型输出无法突破。
- 模型不可用 → `ok:false` 显式报错交上层，**不回退规则**（用户"纯模型，删掉兜底"）。

## 4. 记入 NOTES.md 的疑点

- planner 无独立量化评估集（`fixtures/chat-cases.json` 50 条是 extractor 的评估基线）；如需 planner 准确率验收另立测试集。
- 规则步骤库删除的完整清单见 NOTES 2026-10-17 01:15 条目。

## 自查（进入下一里程碑前）

- [x] 上一级测试全绿（task-planner-llm 15/15）
- [x] 契约偏差已显式记录（规则→模型系用户指示）
- [x] 没有新增隐私/合规章节
- [x] 没有碰 `portfolio123` 之外的文件
