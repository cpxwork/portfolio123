# A-M4 里程碑报告：强制措施（升级状态机 + 执行联动）

> 按《交接提示词.md》第 9 节格式。里程碑实际完成于 2026-10-16；2026-10-16 用户架构指示后升级决策改为 strategist 模型 + 物理闸门，2026-10-17 物理删除规则残留与自动定时器链。本报告按当前代码现状补写核对。

## 1. 新增/修改的文件

| 文件 | 一句话说明 |
|---|---|
| `escalation.js` | `escalateWithLlm`（strategist 模型）为唯一决策入口，输出 `{level, suspend, revoke, reason}`；`escalate()` 为纯执行器（签发 + 物理闸门 + runLocal + 快照），`tick()`=`escalate()` 仅供测试/联调手动推进；`start` 签发 L0、`revoke` 发 `revoke_all`、`completeStep` 完成即撤销；`getState`/`getHistory` 每轮输出 level/status/reason 全程可解释 |
| `escalation.test.js` | 11 用例（假时钟手动推进；含"时间流逝不会自己升级"反回归用例） |
| `escalation-llm.test.js` | 15 用例（桩 strategist，覆盖模型决策与闸门交互） |
| `demo.js` | 完整闭环演示（本里程碑交付；双模式：桩 LLM 全链路 / `--llm` 真实 API） |

**五条物理闸门（硬性设计约定，模型不可绕过）**：
1. 级间隔：L0→2min→L1→3min→L2→5min→L3→5min→L4（`GAP_MINUTES`）；
2. 单日强制（L2+）上限 4 次，达到当天封顶 L1（`forcedByDate` 可注入共享 Map，跨任务生效）；
3. L4 需 `authorizeL4`，未授权封顶 L3；
4. 模型只选 `level`，永远不选 `action`（action 由 `LEVEL_ACTION` 确定性映射）；
5. L4 `targets` 只来自 `options.l4Targets` 白名单。

另：`revoke_all` 任何情况不可拦截；步骤完成信号优先于模型（不问模型直接撤销）。

## 2. 测试怎么跑、结果

```
node run-tests.js
escalation.test.js: 11/11 通过
escalation-llm.test.js: 15/15 通过
node demo.js        → exit 0（全链路闭环，sha256 逐字节还原）
node demo.js --llm  → 无 env 时 exit 2 显式报错（不静默回退）
```

验收对应覆盖：逐级触发且每级真实间隔（假时钟推进验证）；同刻重复 tick 被拦；单日 3 次后封顶 L1（4 台实例共享 Map 验证跨任务）；L4 未授权封顶 L3（不产生隔离 manifest）；L4 授权后真隔离且 revoke 100% 还原（restored:3 lost:0）；每轮输出 level/status/reason 可解释；审计 issue/ack/complete/revoke 与 manifest 关联。

## 3. 与第 6 节契约有无偏差

- **"纯规则状态机"→"strategist 模型决策 + 物理闸门"**：按用户 2026-10-16 架构指示（"纯规则全部改成靠大模型……纯模型，删掉兜底"）执行，规则升级链、自动定时器链、`present`/`setPresent` 已于 2026-10-17 物理删除。属显式架构变更（NOTES 2026-10-16 22:50、2026-10-17 01:15）。
- `present=false` 只影响 L0→L1 的原语义随 `present` 变量一并删除，等价语义由模型输出 `suspend`（SUSPENDED，等人回来）承担。
- 时序间隔、单日上限、L4 授权三条规格**不变**，现以物理闸门形式固化（`GAP_MINUTES` / `DAILY_FORCED_CAP` / `capLevel`）。
- 6.1 指令契约、"先写 manifest 再动手"、`revoke_all`→`restoreAll` 联动全部不变。

## 4. 记入 NOTES.md 的疑点

- `escalateWithLlm` 实现要点必读：5 闸门、成功双快照（第 2 条不含 instructionId，判定成功看 `currentLevel === wantLevel`）、跳级被拦恢复语义、理由融合、快照新字段 `modelDecision`/`strategistReason`/`gateBlocked`/`blockedTarget`——NOTES 2026-10-17 00:45 条目及 01:15 勘误。
- L4 `capped` 措辞已优化（NOTES #20，2026-10-17 02:20 关闭）：`capped` 明确区分"封顶未升级"与"L4 已执行、无下一级可升"。

## 自查（进入下一里程碑前）

- [x] 上一级测试全绿（escalation 11 + escalation-llm 15）+ demo 双模式
- [x] 契约偏差已显式记录（规则→模型系用户指示）
- [x] 没有新增隐私/合规章节
- [x] 没有碰 `portfolio123` 之外的文件
