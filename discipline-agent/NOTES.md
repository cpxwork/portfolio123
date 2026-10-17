# NOTES.md —— A 侧设计疑点记录

> 规则：拿不准的设计先记这里再继续，不静默扩大范围。
> 格式：`日期 | 问题 | 当前处理 | 待谁确认`

## 2026-10-16 | A-M0 阶段

| # | 问题 | 当前处理 | 状态 |
|---|---|---|---|
| 1 | workRoot 黑名单把 `C:\Users` 当前缀拒绝，导致合法临时目录 `C:\Users\yi\AppData\Local\Temp\...` 被误杀 | 拆成 PREFIX_DENY（windows/program files/programdata 等，前缀即拒）与 EXACT_DENY（`C:\Users`、`C:\Users\Public` 等，仅路径本身才拒）。规格只要求"拒系统目录/盘符根/用户主目录本身"，之前做宽了 | 已修，测试覆盖 |
| 2 | 审计日志文件若落在 workRoot 顶层，会被 shuffle 改名，导致"全流程可审计"失效 | 审计日志目录整体纳入内部资产（`isInternalPath`），shuffle/quarantine 都不碰 | 已修，测试覆盖 |
| 3 | 用户指示"隔离区要加密"：A-M0 任务书原文只要求"移动+记账"，未提加密 | 新增 `crypto-vault.js`：AES-256-GCM、一把 manifest 一把密钥、密钥与密文分目录、manifest 只记 iv/authTag/plainSha256。还原前校验 sha256，不一致不落盘 | 已实现，测试 10 项覆盖 |
| 4 | 加密密钥不用口令派生 | 由本机保管，`revoke_all` 必须"一键"完成；用口令会把"随时可撤销"变成"先想起来密码" | 待用户确认是否符合其威胁模型 |
| 5 | quarantine 加密隔离的失败语义 | 先加密成密文→确认落盘→再删原件。任何一步失败都保持原位不动，manifest 记 skipped | 已实现 |
| 6 | 解密还原时缺密钥 | 记 `lost` 且**不写回原位**（避免把无法校验的数据写坏用户文件），manifest item.reason 说明缺密钥 | 已实现，测试覆盖 |
| 7 | `step.index` 从 0 还是 1 起 | 契约示例 `"index": 1` 对应"下床"（第一步），故取 0-based 与示例不一致。**决策：索引语义为 0-based**（`index: 0` = 第一步），示例中的 1 视为"下床是第 1 步"的 1-based 表达；`validateInstruction` 只校验"非负整数"，两种记法都能过 | 需 B 侧确认 UI 展示是否要做 +1 |
| 8 | shuffle 的 targetDir 默认值 | 契约写"可选，默认执行范围顶层"。实现取 `workRoot` 本身，不递归子目录 | 已实现 |
| 9 | `revoke_all` 的 taskId | 契约允许 `null`。实现上 `bus.revoke(taskId)` 撤销该任务全部未完成指令；`revoke_all` 交给 executor 时执行 `restoreAll()`（全量文件还原，与 taskId 无关） | 已实现 |

## 2026-10-16 22:20 | 网络事实更正（重要）

| 项 | 旧记录 | 实测（2026-10-16 22:12） |
|---|---|---|
| GitHub | 全部域名被 hosts 劫持到 127.0.0.1，需走 gh-proxy 镜像 | `curl https://github.com/` → **HTTP 200**，解析到公网 IP。劫持已不存在 |
| npm registry | 未记录 | `registry.npmjs.org` → **HTTP 200**，可正常装包 |
| web_search 工具 | 端点 404 不可用 | 仍未验证，维持"不可用"假设 |

**影响与动作**：
1. A-M2 的摄像头推理依赖（`onnxruntime-node` 或 `@mediapipe/tasks-vision`）**可以真实安装**，不再需要"零依赖 + 可插拔假后端"这一妥协。依赖仍只限 A-M2 一个里程碑写入 `package.json` 的 `dependencies`。
2. `test-util.js` 的钩子语义：早期版本只有 `before/after` 且被当作"每个用例"执行，导致跨用例累积状态（如同一份审计日志）在下一个用例被全新临时目录替换而丢失。已改为 `beforeAll/afterAll`（整套一次）+ `before/after`（每用例一次）。**这是测试基建缺陷，不是被测代码缺陷**——A-M0/A-M3/A-M4 的用例彼此独立所以没暴露，A-M5 一暴露就发现了。

## 2026-10-16 22:20 | A-M2 阶段（状态估计）

| # | 问题 | 当前处理 | 状态 |
|---|---|---|---|
| 1 | 任务书写"依赖可真实安装"，但同章又写"**不要真的 npm install**"；且注入式设计对测试更有价值 | 实现**保持零第三方依赖 + 全注入**（`captureFrame`/`inferPose`/`clock`/`sleepFn` 全部可替换），真实后端接入方式只写进 `assets/README.md`。依赖装不装留给宿主部署决策，不阻塞里程碑 | 已实现，待用户确认是否要在本仓直接装 |
| 2 | `test-util.js` 的 `createSuite.run()` 是同步的，`async` 用例的抛错**完全不被计数**，退出码还是 0（会假绿） | 未改 A-M0 文件；在 `state-sensor.test.js` 内自带 `runAsync` 串行 runner 补计数与退出码 | 已实现；**建议 A-M3 起统一用一个 async runner，或在 test-util.js 加 `createAsyncSuite`** |
| 3 | `learning` 无法由单目姿态单独判定（分不清"在桌前发呆"与"在写作业"） | 规定必须三条件同时满足：桌前姿态 + 无操作 <5min + 未锁屏 + 8:00–23:00；否则只能是 `seated_desk` | 已实现，测试覆盖 |
| 4 | 帧间分歧的折扣系数取多少 | 多数票占绝对多数（≥2/3）打 **8 折**（结论仍可信，仅标注分歧）；票数接近打 **7 折**（更可能掉到 `unknown`）。全帧判无人则直接 `away`，不打折 | 已实现；折扣值属可调参数，若实测误判多再收严 |
| 5 | 连拍中部分帧失败该整批降级还是部分折叠 | 选**部分折叠**：保留可用帧，置信度再打 85 折并说明掉帧。整批降级会白白丢掉已有证据 | 已实现，测试覆盖 |
| 6 | 纠正表的 key 粒度 | 用「时段桶(清晨/白天/夜间) + 锁屏与否 + 无操作档位(lt5/lt15/lt25/ge25)」三元组。太粗会误伤别的场景，太细则纠正永远命中不了 | 已实现；夜间桶把 22:00–04:00 合并（避免同一种"该睡了"被切成两半） |
| 7 | 纠正表目前只在**降级路径**（无 camera 证据）生效 | camera 有时按契约精神应以 camera 为准。但"用户刚说过我不在床上"显然该盖过摄像头 → 当前实现是降级路径优先纠正，camera 路径不改判 | **待用户确认**：是否要 camera 与纠正表冲突时也让纠正优先 |
| 8 | `away` 与 `unknown` 在升级约束里都被压到 L0 | 两者语义不同（前者确定没人，后者不确定），但消费行为一致（都不该下指令），故同一处理 | 已实现 |
| 9 | 时段桶边界：9:00 归"白天"、4:00 归"清晨" | 与 `TIME_BUCKETS` 常量一致；清晨(04–09)既不给 lying 也不给 desk 加成，信息不足就 `unknown` | 已实现 |
| 10 | `escalationEligibility` 的 `progress` 形参名 | 契约只说"步骤完成信号"，未定字段名。取 `{ stepCompleted, stepDeclined }`，与 A-M4 的 step 完成事件对齐 | **需 A-M4 确认字段名** |

## 2026-10-16 22:45 | A-M1 / A-M3 / A-M4 / A-M5 / demo 阶段

| # | 问题 | 当前处理 | 状态 |
|---|---|---|---|
| 11 | A-M1 由子智能体认领但未交付（`chat-sense.js` 一直不存在） | Lead 自己重写 `chat-sense.js` + 50 条 fixtures + 23 个用例 | 已完成 |
| 12 | 50 条测试集 subject 未命中 4 条：`生物课…实验报告`误判化学（"实验"先于"生物"匹配）、`Programming`未命中（词表无该词）、`阅读理解`误判语文 | 词表顺序与覆盖面问题。当前准确率 92% 已过 80% 门槛，未继续调——规则词表的边界效应 | 已知限制 |
| 13 | 裸星期（"周五交"）指向问题：今天即周五时 off=0 会解析成"今天" | 改为 `off <= 0` 一律 +7（"改到周五/周五交"几乎总指未来那次）。**副作用**：若用户真想表达"今天周五交"，会被推到下周五 | 需用户确认语义偏好 |
| 14 | 改期时 `rescheduledFrom = rescheduledFrom \|\| prev.date` 在 prev.date 已被赋新值后才执行，原日期被冲掉 | 先把 originalDate 存底再更新，新增 `rescheduledFromTime` | 已修（haipigua-diagnostics 的坑） |
| 15 | `importChat` 早期版本内含去重，与 `extractTodos` 里的去重职责重叠 | 单一职责：`importChat` 只切片段，去噪去重由 `dedupeSegments`/`extractTodos` 负责 | 已修 |
| 16 | 审计日志若放在 `workRoot` 顶层，会被 shuffle 改名，"全流程可审计"失效 | executor 已排除自己的账本/审计目录；**但 bus 的 JSONL 是外部传入路径，executor 不知道**。demo 改为把所有日志放进 `<workRoot>/.discipline/audit/` | 已在 demo 落实；**真实部署也必须把日志放该目录** |
| 17 | `test-util.js` 同步 runner 导致 async 用例假绿（退出码 0 但不执行断言） | 新增 `runAsync()`；同步 `run()` 遇到返回 Promise 的用例改为**明确报错**而非静默放过 | 已修（A-M2 子智能体发现） |
| 18 | `createSuite` 早期版本只有 before/after 且按"每用例"执行，跨用例累积状态被新临时目录替换而丢失 | 拆成 `beforeAll/afterAll`（整套一次）+ `before/after`（每用例一次） | 已修 |
| 19 | `clock.now()` 契约不一致：`state-sensor` 内部调 `date.getTime()` 要求返回 **Date**；`escalation` 的时钟要求返回 **number(ms)** | 两处契约不统一，demo 里分别传 `() => new Date()` 与 `() => ms`，已在各自注释写明 | 待统一 |
| 20 | escalation 到 L4 后 status=capped 且 reason="已到 L4 顶，等待用户完成步骤"——易被误读为"L4 没执行" | 实际 L4 已下发并执行，capped 仅表示"没有下一级可升" | 文案待优化 |
| 21 | A-M2 依赖：GitHub/npm 实测可用，但 `npm install onnxruntime-node` 在本机 5 分钟超时未装完 | A-M2 保持零依赖 + 可插拔后端，真实接法写 `assets/README.md` | **待用户决定是否强装** |
| 22 | `escalation` 手动 `tick()` 与定时器自动触发会重复下发/重复计数 | `tick()` 传 `reschedule:false` 且入口先 `clearTimer()`，保证一次时间推进只升一级 | 已修 |
| 23 | 单日强制上限若每个 escalation 实例各记一份 Map，跨任务不生效 | `options.forcedByDate` 可注入共享 Map | 已修 |

## 交付状态总览

| 里程碑 | 状态 | 测试 |
|---|---|---|
| A-M0 指令通道 + 隔离区/还原（含加密） | ✅ | instructions 13 / manifest 8 / executor 23 / crypto-vault 10 |
| A-M1 聊天接入 + 待办提取 | ✅ | chat-sense 23（subject 92% / ddl 93.5% / time 100% / status 90%） |
| A-M2 状态估计（摄像头多模态 + 降级） | ✅ | state-sensor 47（四类场景 5/5 = 100%） |
| A-M3 状态驱动拆步 | ✅ | task-planner 15 |
| A-M4 强制升级状态机 | ✅ | escalation 12 |
| A-M5 审计与误判申诉 | ✅ | audit 9 |
| demo.js 完整闭环 | ✅ | 聊天→状态→拆步→L0..L5→revoke_all→sha256 校验全通过 |

**总入口**：`node run-tests.js` → 8 套测试全绿。

---

## 2026-10-16 22:50 | 架构变更：规则 → 多模型协作（用户指示）

**用户原话要点**："纯规则全部实现改成靠大模型，agent，而且要多模型合作，现在学习太局限了，把纯规则完全删除"。

### 用户已确认的边界（ask_user_question 答复）

| 维度 | 用户选择 |
|---|---|
| 删除范围 | ① 认知判断类（chat-sense / state-sensor / task-planner）+ ② 强制升级决策（escalation） |
| 保留范围 | ③ 工程设施类（instructions / manifest / executor / crypto-vault）**不删** |
| 降级策略 | **纯模型，删掉兜底**（断网/Key 失效时不退回规则实现） |

### 我仍然保留的两道闸门（不是"规则兜底"，是安全底线，需用户知情）

1. **executor 的文件操作与还原仍是确定性代码**（sha256 校验、AES-GCM、manifest 逐条回写、原位被占记 conflict）。理由：大模型无法直接做文件系统物理操作，"100% 可还原"是本项目核心承诺；且让模型决定"移动哪个文件"等于把用户文件交给概率性输出。这部分用户已确认不删。
2. **模型输出的合法性校验仍保留**（`validateInstruction` / `validateStateModel`）。理由：这是 schema 校验，不是"规则判断"——模型返回 `level: "L9"` 或 `state: "躺平"` 时必须拒收，否则下游全崩。已从 instructions.js / state-sensor.js 复用，不新写规则。

### 与任务书的冲突（明确记录，未静默扩大范围）

| 任务书原规定 | 现处理 |
|---|---|
| A任务提示词 4.3 / PLAN.md 4.3："强制升级必须是纯规则，不用 LLM（不可预测的强制措施必须是确定性的）" | **被用户显式推翻**。改为模型决策 + 确定性时序门禁（见下） |
| PLAN.md 4.1 A4："纯规则状态机" | 同上 |
| 技术栈"零第三方依赖" | 新增 `vision-backend.js`（OpenAI 兼容多模态）与 `llm-client.js`，仍是零第三方依赖（用 Node 内置 http/https，不引 openai SDK） |

### 强制措施改为模型决策后的安全设计（必须保留，不能算"规则兜底"）

模型可以决定"现在该提醒还是该升级"，但下面这些是**物理闸门**，模型无权绕过：

1. **时序门禁**：L0→L1 必须间隔 ≥2min、L1→L2 ≥3min、L2→L3 ≥5min、L3→L4 ≥5min。模型说"立刻 L4"也发不出去。
2. **单日上限 4 次**（L2+）与 **L5 隔离授权**：这两个是用户授权边界，不是模型判断。
3. **`revoke_all` 永不被模型禁止**：任何一步完成信号到达，必须立即全量还原。
4. **模型只能选 level，不能选 action**：action 由 level 映射表决定（防模型自造动作）。
5. **L4 的 targets 只能来自用户预先配置**，模型不能自行挑选要隔离的文件。

### 多模型分工设计（新增 `llm/` 目录）

| 模型角色 | 职责 | 输出 |
|---|---|---|
| `extractor` | 聊天片段 → 待办结构（科目/内容/ddl/置信度） | 替代 chat-sense 的规则提取 |
| `observer` | 帧 → 姿态/区域/质量（多模态） | 替代 fake-backend 的假推理，即 `vision-backend.js` |
| `planner` | 任务 + 状态 → 小步序列（≤7 步、每步 ≤3min） | 替代 task-planner 的步骤库 |
| `strategist` | 当前态势 → 该升到哪一级 / 是否撤销 / 是否挂起 | 替代 escalation 的纯规则升级判断 |

`strategist` 是唯一新增的危险角色，因此它额外受上面 5 条物理闸门约束。

### 旧代码处置

不物理删除旧文件（用户未要求删文件，且测试引用它们）。改为：
- `chat-sense.js` / `task-planner.js` / `escalation.js` 增加"模型优先"入口，规则实现降为内部 fallback 函数，**仅在被测试与无配置场景引用**；
- 但按用户"删掉兜底"的选择，生产路径不再自动回退到规则实现——规则函数保留是为了测试可离线运行。

> **待用户确认**：测试是否也改成"必须联网跑模型"？若是，CI/离线环境下测试将无法运行。我的做法是测试默认用假后端（桩），只有显式标注 `[llm]` 的用例才真调模型。

### 2026-10-16 23:30 | A-M1 子代理交接完成 + 测试重写为模型路径

A-M1 子代理（206e33bf）按用户指示停手并交付盘点。处理结果：

| 子代理交接点 | 处理 |
|---|---|
| 它曾删过 `extractTodosWithLlm`（当时 llm/roles.js 不存在） | 已由 Lead 重写并接线，最终归属 Lead；子代理的规则改动与其互不干扰（函数隔离） |
| 规则版 `.extra` 接口不干净 | 规则实现已成离线调试代码，不再投入，按新架构不处理 |
| 它把规则版调到 subject/ddl/time 100% 并新增 7 用例 | 其规则测试用例已随 `chat-sense.test.js` 重写作废；`fixtures/chat-cases.json`（50 条）保留，改作 extractor 模型的**评测集** |
| 它修了测试自身 bug（NEXT_MONTH slice 偏移） | 该 bug 随旧测试一并移除，无需感谢也不用保留 |
| `chat-sense.js` 被双方并发改写过 | 子代理已结束，无并发写者；文件现归 Lead 单独维护 |

**`chat-sense.test.js` 已重写为模型路径版（19 用例全绿）**：
- 桩 LLM（不发真实请求）验证调用契约：角色名、system prompt、user prompt 含今天日期与原文
- 归一化：confidence 裁剪 0~1、`validDate`/时分值校验（`2026-13-45`、`25:99` 拒收）
- 分流：低置信度 / ambiguous / 无日期 → pending_confirm
- 模型不可用 → `ok:false` 抛给上层，**不静默兜底**（用户选择"纯模型"）
- 纯工程管道（importTxt/importJson/dedupe/isNoise）保留测试
- async 用例走 `runAsync()`（同步 run 的防假绿机制会显式拒绝 Promise 用例）

**遗留**：`extractTodosWithLlm` 与规则版 `extractTodos` 并存于同一文件（规则版 600 行）。按"纯模型"架构，规则版应整体删除，但它被 `run-tests.js` 的其他套件间接 require 吗？——已确认没有其他套件引用规则版函数。**待删除前需再跑一次全量回归**。

### 2026-10-17 00:45 | 架构改造收尾：纯模型路径全量落地

**四个模型入口全部接线完成**（认知判断全部交给 LLM，工程设施保持确定性）：

| 入口 | 所在文件 | 角色 | 说明 |
|---|---|---|---|
| `extractTodosWithLlm` | `chat-sense.js` | extractor | 聊天→待办；无日期/低置信/ambiguous→pendingConfirm |
| `inferPose`（vision-backend） | `vision-backend.js` | observer | 帧→姿态/区域/质量；失败返回降级结果不抛错 |
| `planWithLlm` | `task-planner.js` | planner | 任务+状态→≤7 步、每步 ≤3min；away/learning/unknown 短路不调模型 |
| `escalateWithLlm` | `escalation.js` | strategist | 态势→`{level,suspend,revoke,reason}`；受 5 条物理闸门约束 |

**测试现状：`node run-tests.js` 12 套全绿**（本轮补上了 `crypto-vault.test.js` 进 SUITES 的历史缺口）：
- 遗留规则套件（离线回归）：instructions 13 / manifest 8 / executor 23 / crypto-vault 10 / state-sensor 47 / task-planner 15 / escalation 12 / audit 9
- 模型路径套件（桩 LLM，不发网络请求）：chat-sense 19 / llm-client 17 / task-planner-llm 15 / escalation-llm 15

**demo 双模式**：`node demo.js` 走桩 LLM 全链路（提取→状态→拆步→L0→L5 逐级升级→L4 洗牌/L5 隔离→revoke 恢复 restored:3 lost:0，sha256 一致）；`node demo.js --llm` 走真实 API（`LLM_API_BASE`/`LLM_API_KEY`，视觉走 `VISION_*`）。模型不可用 → `process.exit(2)` 显式报错，**绝不静默回退规则**（用户"纯模型，删掉兜底"）。

**escalateWithLlm 实现要点 / 踩坑记录**（后续改动升级逻辑者必读）：
1. 5 条物理闸门是硬性设计约定，模型永远只选 `level`，不选 `action`；L4 `targets` 只来自 `options.l4Targets`。
2. escalate 成功路径会**连推两条 history 快照**，返回的第 2 条**不含 `instructionId`** —— 判断升级成功必须看 `currentLevel === wantLevel`，不能看快照字段（踩过坑）。
3. 跳级被闸门拦住时：先临时设 `currentLevel = 目标级前一级` 调 `escalate({reschedule:true})`，若事后 `currentLevel !== wantLevel` 则恢复原级别并重建快照（`gateBlocked:true, blockedTarget`），避免快照里留下临时值。
4. `escalate()` 入口清 pending 定时器；`start()` 会排自动升级链定时器——测试推进假时钟前必须 `clock.clearAll()`，否则自动链中途触发。
5. 自然升级路径的模型理由要做**理由融合**：`reason = d.reason + '（' + snap.reason + '）'`，且同步回状态机的 `reason` 变量，保证 `getState()` 与快照一致。
6. 升级成功后 `status` 需 IDLE→RUNNING 显式置位（`escalateWithLlm` 内已加），否则 L1/L2 状态显示 idle。
7. 快照新增字段：`modelDecision` / `strategistReason` / `gateBlocked` / `blockedTarget`。

**遗留规则代码处置（偏差记录）**：生产路径已是纯模型，但规则实现（`chat-sense.js` 的 `extractTodos` ~600 行、`task-planner.js` 的 `plan`/`replan`、`escalation.js` 的规则升级链）**暂未物理删除**，原因：`task-planner.test.js`(15) / `escalation.test.js`(12) / `state-sensor.test.js`(47) 三个遗留套件依赖它们。已确认无生产调用点。处置方式：标记 legacy、仅作离线回归保留。→ **待用户决定**：物理删除（需一并重写/删除这 3 个套件）还是保留现状。

**状态机融合逻辑（state-sensor 的证据融合/时间规则）仍是确定性代码**——按"工程数据融合 ≠ 认知判断"归类，暂不模型化；如需一并交给 observer 模型，另行立项。

**仍开放**：NOTES #19 时钟契约统一（state-sensor 用 Date、escalation 用毫秒数）、#20 L4 `capped` 措辞；A-M0/M3/M4/M5 的 §9 格式独立里程碑报告未出（A-M2 已有报告 id 9489a94f）。

### 2026-10-17 01:15 | 物理删除执行完成：遗留规则实现已移除

**用户决定"物理删除"**（本条取代上一条"遗留规则代码处置…→ 待用户决定"）。执行结果：遗留规则实现已从代码中物理移除，不做 legacy 保留、不留存代码。

**删除范围**：
- `chat-sense.js`（728 → ~198 行）：`extractTodos` / `extractOne` / `mergeContext` / `cnNumber` / `addDays` / `parseDate` / `parseTime` / `parseDuration` / `detectSubject` / `countSubjects` / `detectMaterial` / `extractContent` / `isReschedule` / `isCancel` / `isDone` / `splitParallelClauses` 及仅被它们使用的常量表（`SUBJECTS` / `ACADEMIC_SUBJECTS` / `MATERIALS` / `DEADLINE_WORDS` / `STRONG_DEADLINE` / `WEAK_TRIGGER` / `STRONG_DEADLINE_BONUS` / `NUMERAL` / `DAY_TOKENS` / `WEEK_TOKENS`）、无用的 `fs`/`path` require。保留：导入管道（`importTxt`/`importJson`/`importChat`/`dedupeSegments`/`isNoise`）、schema 归一（`validDate`/`baseDate`/`pad`/`isoNow`）、`extractTodosWithLlm`。
- `task-planner.js`（340 → 119 行）：`STEP_LIBRARY`（三级步骤库）/ `fillTemplate` / `pickCandidates` / `applyStateStart` / `checkConstraints` / `plan` / `replan` / `STATE_FIRST_STEP_NOTE`。保留：`STATES`、`normalizeState`、`planWithLlm` 及安全态短路（away→hold / learning→defer / unknown→confirm）与确定性钳制（`MAX_STEPS=7` / `MAX_STEP_MINUTES=3`，溢出记 `violations[]`）——按"确定性校验/物理约束 ≠ 规则判断"保留。
- `escalation.js`（460 → ~410 行）：**自动升级定时器链**（`clock.setTimeout` 链）、`setPresent` / `present` 变量 / `nextFireAt` / `timerId` / `clearTimer` 及 `reschedule` 参数语义（规则决策残留）。`escalate()` 现为纯执行器（签发 + 5 条物理闸门 + runLocal + 快照），`tick()` = `escalate()` 仅供测试/联调手动推进；`start()` 只签发 L0 并置 RUNNING。模型唯一决策入口仍是 `escalateWithLlm`（strategist）。
- `task-planner.test.js`（15 个规则用例）整套删除；`escalation.test.js` 重写为 11 个用例（全部 `start()+advance(gap)+tick()` 驱动；含新增反回归用例"时间流逝不会自己升级：无推进调用则停在原级"）；`_rewrite.js` / `_patch.js` 一次性脚本已清理。

**套件处置说明**：`state-sensor.test.js`（47）**保留全量**——`escalationEligibility` / `canTriggerForcedLevel` 未删，重新归类为**消费约束/工程证据融合**（"摄像头证据不能单独触发 L2+"是硬性安全约束，非认知判断），该归类已在此记录以备查。

**最终盘点：`node run-tests.js` 11 套全绿**：
- 工程设施：instructions 13 / manifest 8 / executor 23 / crypto-vault 10 / state-sensor 47 / audit 9
- 模型路径（桩 LLM）：chat-sense 19 / llm-client 17 / task-planner-llm 15 / escalation-llm 15

**demo 双模式复核**：`node demo.js` exit 0（全链路闭环，sha256 逐字节还原）；`node demo.js --llm` 无 env → exit 2 显式报错，无静默回退。

**对 00:45 条目的勘误（其"escalateWithLlm 实现要点"第 4 条已过时）**：自动升级定时器链已随物理删除移除，`start()` 不再排自动链定时器，`clock.clearAll()` 仅为 escalation-llm 套件的假时钟清理需要；第 3 条的 `escalate({reschedule:true})` 调用已改为 `escalate()`。其余要点（5 条物理闸门、双快照、`currentLevel === wantLevel` 判定、理由融合、快照新字段）仍然有效。

### 2026-10-17 02:20 | 两处小口径统一完成：#19 时钟契约 / #20 L4 capped 措辞

上表 #19、#20 两行的"待统一 / 文案待优化"就此关闭（表格行保留作历史）。

**#19 时钟契约统一为 `() => number`（epoch 毫秒数）**——全项目所有可注入时钟（`clock.now` / `nowFn`）一律返回毫秒数，需要 Date 处显式 `new Date(ms)`：
- `state-sensor.js`：`createStateSensor` 的 `clock.now` 与 `createCaptureScheduler` 的 `nowFn` 均由返回 Date 改为返回毫秒数；`poll`/`postNotify` 间隔判断改纯数值差；`isoOffset`/`hourOf` 调用点统一包 `new Date(ms)`；`notifySent(at)` 的 `at` 参数约定毫秒数（无参调用不变）；两处 JSDoc 写明契约。
- `instructions.js`（`createInstructionBus.nowFn`）与 `executor.js`（`createExecutor.nowFn`）同步改为毫秒数；executor 内部 +08:00 格式化处改 `new Date(nowFn() + 8 * 3600000)`。
- `fake-backend.js` 的 `createFakeClock().now` 由返回 Date 对象改为返回毫秒数（内部计时不变）。
- `demo.js` 传给 state-sensor 的 `clock: { now: () => new Date() }` 改为 `() => Date.now()`；**原注释"clock.now 约定返回 Date"作废**。
- `escalation.js` 本来就是毫秒数契约，未动。
- **契约分层（明确排除项）**：`manifest.js`/`audit.js` 的 `nowFn` 返回 ISO 串，它是**时间戳格式化器**不是时钟，保持 `() => string`；`normalizeInstruction`/`validateInstruction` 的 `opts.now` 与 `extractTodosWithLlm` 的 `opts.now` 是**业务参考时间**（Date），属纯函数参数，不属时钟注入契约。
- 测试适配：`state-sensor.test.js` 3 处 `now: () => new Date('…')` → `.getTime()`；其余套件（escalation / escalation-llm 的 fakeClock 本就是毫秒数）未动。

**#20 L4 `capped` 措辞优化**（`status` 枚举值不变，仅文案与注释）：
- `STATUS.CAPPED` 注释 → "封顶态：未授权/日限封顶（本次未升级），或 L4 已执行（无下一级可升）"。
- 已在 L4 再 `tick()`：reason `'已到 L4 顶'` → `'L4 已在执行中（最高强制级），无下一级可升，本次不升级'`。
- 成功升到 L4 后：reason `'已到 L4 顶，等待用户完成步骤'` → `'L4 已下发并执行（最高强制级），无下一级可升，等待用户完成步骤'`——消除"L4 没执行"的误读。
- `demo.js` 桩 strategist 文案同步：`'L4 已执行，等用户完成步骤'`。

**回归**：`node run-tests.js` 11 套全绿 0 失败；`node demo.js` exit 0，`node demo.js --llm` 无 env exit 2，行为不变。

### 2026-10-17 02:30 | §9 格式里程碑报告补齐，开放项清零

**`reports/` 新增 5 个文件**：`A-M0.md` / `A-M3.md` / `A-M4.md` / `A-M5.md` 四份第 9 节格式里程碑报告 + `README.md` 索引。均为 2026-10-17 按当前代码现状补写核对（里程碑实际完成于 2026-10-16）；架构变更（规则→多模型、物理删除）对各里程碑的影响如实记录在各报告第 3 节"契约偏差"，含 A-M4"纯规则状态机→strategist 模型 + 物理闸门"、A-M3"engine.js 步骤库→planner 模型"的显式变更说明。

**报告口径**：A-M2 报告 id `9489a94f`（历史会话提交，文本未入库）；A-M1 未单列——不在原待办清单（00:45 条目只列 A-M0/M3/M4/M5），未擅自扩大范围，**待用户决定**是否补写。

**至此原"仍开放"清单全部关闭**：#19 时钟契约 / #20 capped 措辞（02:20 条目）、4 份里程碑报告（本条）。

**杂项核实结果**：`assets/README.md` 存在，demo.js 引用成立；`node_modules/` 为早前 npm 超时残留（adm-zip / global-agent 等间接包，项目零第三方依赖不受影响，run-tests/demo 均不读它）——**待用户决定**是否删除。

**收尾回归**：11 套全绿 + `node demo.js` exit 0。

### 2026-10-17 04:30 | M-K 步骤①②③：基线克隆、csproj 决策、learning-kernel 骨架跑通

**上游来源对照（M-K 步骤① 收口）**：
| 库 | 基线 | 哈希 |
|---|---|---|
| Astral-Path | `ClassTechStar/-Knowledge-Debt-Astral-Path` main | `45e6cab`（2026-10-17，比任务书晚一天） |
| ReciteHelper | `ArabidopsisDev/ReciteHelper` primary | `3943f38`（2026-10-09） |
| GalReview | `OpenRecite/GalReview` main | `161ca2d`（与任务书锁定一致） |
| Notehelper | `ClassTechStar/Notehelper` main | `daf8a98` |
| Reciting-us | `HelloZWH-0620/Reciting-us` main | `40a00d0`（2026-10-12） |
克隆位置 `%TEMP%/mk-upstream/`（只读引用，不参与构建）。

**Reciting-us 基线偏差（任务书分支不存在）**：任务书指定基线 `feat/v0.2.0-p1-p4-full-refactor` **在上游已不存在**（clone 报 Remote branch not found）。上游只有 `main`（40a00d0，2026-10-12，超集：含 js/error-boundary.js、js/migrate.js、config/bundled.js、liquid-glass.js）与 `issue-2-feihua`（fd18932，2026-08-19）。**取 main@40a00d0 为基线**。所需资产定位：出题流水线与判分逻辑内联在 `Memorization UI/app.html`（8061 行单文件应用），通假字判分归一化映射表在 `app.html:4019` `normalizeAnswer()`：10 对（知→智、反→返、阙→缺、辟→避、贾→价、无→毋、说→悦、内→纳、被→披、属→嘱）+ 标点/空白剥离，归一化方向为通假字→本字；`config/bundled.js` 是内置题库数据（6 行 JSON 大对象，虚词选择题）。`js/` 目录只有 error-boundary/migrate 两个基础设施文件，无出题逻辑。

**步骤② csproj 决策（TargetFramework 全部 net10.0，与本机 dotnet 10.0.300 匹配）**：
- astral-path `AstralPath.Core`：**零依赖** → Algorithms/Formula/Models/Extensions/Formatting/Planner 整目录拷贝。
- recitehelper `ReciteHelper.Core`：仅依赖 `SharedKernel`（亦零依赖）→ 拷 Scheduling/ 全部 + FileVectorStore + VectorEntry + Semantics + Entity(SharedKernel)。
- recitehelper `Infrastructure`：net10.0-windows7.0 + 16 个 NuGet（OpenAI/LlmTornado/SemanticKernel/Onnx/Docnet/jieba/FreeSpire…）→ **KnowledgeBaseService 不拷**（按红线 8 其 LLM 部分收口 Node llm-client 重实现）；Agent/MimoClient/KeyEnvelope 同理不拷（C# 不直连 API）。
- 引用方式 = **拷贝最小 .cs 集 + 自建干净 csproj**（保留原命名空间零改动），非 ProjectReference（上游在临时目录）。

**M-K 裁剪决策（步骤② 附加，随 build 迭代收窄依赖链）**：`LegacyReviewMigrator.cs` 不拷——任务书 §3.1 "迁移器保留接口不实现历史迁移"，本项目无旧数据；连带删除 `Project.cs`/`Question.cs`/`MemoryRecord.cs`/`ReviewTag.cs`（纯迁移链）。`FsrsOptimizer.cs` 仅删 `ExtractSequences(Project)` 静态 IO 辅助（cmd 直接收 reviewSequences），算法本体 Evaluate/Fit/梯度/Adam 零改动。`ReviewGrader`/`WeightProjector` 经核实零迁移链依赖，保留。

**步骤③ learning-kernel 骨架（`dotnet build` 0 错误，Node↔C# 边界全通）**：
- `learning-kernel/learning-kernel.csproj`（net10.0 console，零 NuGet）+ `Program.cs`（439 行）：单命令单进程 JSON 边界，stdin `{"cmd","args"}` → stdout `{"ok",true,data}` / `{"ok":false,"error"}` / `{"ok":true,"needLLM":{...}}`（顶层 needLLM 挂起，符合红线 8 字面）。ok:false 也 exit 0（响应完整可解析），仅内核真崩溃才非 0 退出——契约测试按此区分。
- 9 个确定性 cmd 已实现：review/interval（FSRS-6）、score（BASELINE 掌握分公式）、scanDebts（impact-v2）、transition（SaleStateMachine + probe 模式）、planDay（PlannerBuilder.Build + 可选 checkDays 走 PlannerConstraintChecker.Check）、graph（action=order 拓扑序+环校验 / prereqs 直接先修；layers/bottlenecks/downstreamMass 待补）、optimize（FsrsOptimizer.Fit）。3 个 needLLM 挂起：extractPoints/genQuestions/analyzeWrong（后处理在 ⑥⑧ 步实现）。buildGraph 占位 NotImplementedException（⑦ 步）。
- **score 实现决策**：0 作答记录时 Beta 均值取 0.5（无信息先验），任务书公式未覆盖此边界。
- **修复**：`Console.InputEncoding = UTF8`（默认 GBK 代码页把中文 stdin 解成无效字节）。
- Node 侧 `learning-kernel.js`：execFile + stdin 写请求；KERNEL 路径双模式（env `LEARNING_KERNEL_EXE` 覆盖 > publish/ > bin/Debug/）；超时默认 5s、optimize/buildGraph 60s；仅"非零退出且 stdout 不可解析"才 reject（code=KERNEL_CRASH），ok:false 正常 resolve 由业务判断（callOk 便捷抛错版）。**踩坑**：kernelPath 首版误带一层 `..`（文件本就在 discipline-agent 下）。
- 冒烟手算吻合：interval(S=5,R=0.9)→5 天（定义自证）；score(6,2,c4,age2,streak2,reps8)→know=0.7575、S=7.359、retention=0.7620、score=0.7589 全对上。单次调用 634ms（dotnet 冷启动，5s 超时裕度足）。

**score cmd 对齐上游修正（04:50，推翻本条目上面的"score 实现决策"）**：任务书 §3.2 散文公式与上游 `MasteryCalculator.ComputeScore`（score-v2）有三处实质差异，**以上游为准重写 CmdScore**：① Beta 后验均值用 Jeffreys 先验 `(s+0.5)/(s+f+1)`（非 s/(s+f)）；② prereqSupport=(1-λ)·mean+λ·min（λ=PrereqWeakMix=0.65，非纯 mean）；③ **无先修时 prereqSupport 中性 0.5、ceiling=1.0（不封顶）**——任务书"无图谱退化 prereqSupport=know"与上游不符，不采纳。参数形状相应改为 `{attempts, successes, confidence, lastAgeDays, streak, prereqScores?}`（successes 自动 clamp 到 [0,attempts]；S 公式的 n=max(attempts,1)）。修正后手算：emp=0.7222、know=0.7339、score=0.6956（无先修）/0.6766（先修[0.9,0.3]，ceiling=0.685 生效前 raw 已更低）。ScoreCalculator（RecentAcc/Sev/SelfConf 口径）是另一套销账评分，与 score cmd 无关。

### 2026-10-17 10:45 | M-K 步骤③收口：金样 91 测试全绿

**`learning-kernel.Tests`（xUnit，net10.0）**：`dotnet test` → **91 通过 / 0 失败 / 0 跳过 / 5s**。构成：71 组进程级金样（review 14 / interval 14 / score 13 / transition 15 / scanDebts 11 / optimize 4）+ 20 组内核合同测试（`golden/errors.json`：未知 cmd、空 stdin、非 JSON、参数越界、图环、state 越界、buildGraph 未实现等）。

**期望值独立性**：`learning-kernel.Tests/gen-golden.mjs` 用 JS 按 FSRS-6 论文公式 / FormulaConstants / sale-v2 / impact-v2 **独立重写**后算出（不读 C# 输出）。只有常量数组本身（w0-w20、FormulaConstants 值）与上游一致——那是定义不是推导。optimize 是迭代优化器（Adam 全批），数值期望不可独立复算 → 4 组里 2 组"精确期望"（空序列/全 same-day 退化路径：examples=0 + usedDefault + weights==默认 21 值精确比）、2 组"结构断言"（examples 精确 + iterations≥1 + weights 落在 Lower/Upper 盒内 + improved⇒finalLoss<initialLoss）。

**踩到的三个坑（都已修，写进测试注释）**：
1. **路径层数**：`KernelRunner.KernelDll()` 原向上数 5 级，实际 4 级到 discipline-agent（BaseDirectory=`Tests/bin/Debug/net10.0`）→ 改为"向上找含 `learning-kernel/` 的祖先"，不依赖层数。
2. **UTF-8 BOM**：`StandardInputEncoding = Encoding.UTF8` 会写 BOM（EF BB BF），内核报"JSON 解析失败: '0xEF' is an invalid start of a value"。双修：内核 `ReadToEnd().TrimStart('\uFEFF')`（协议健壮）+ 测试侧 `new UTF8Encoding(false)`。
3. **`GetRawText()` 不可用于跨进程比较**：内核 stdout 中文是 `\uXXXX` 转义，金样文件（JS 写出）是原文中文，GetRawText 返回原始输入片段不反转义 → "Strings differ (pos 1)"。改为语义比较（String 走 GetString()；bool/null 比 ValueKind）。

**DeepAssert 约定**：数值容差 1e-6（FormulaConstants.GoldenTolerance）；对象只比 expect 列出的字段（内核可多返回字段）；数组长度相等；字符串语义相等。

---

### 2026-10-17 12:35 | A↔B 连接层落地：本机 HTTP 桥（bridge/）

前端（haipigua）此前与 discipline-agent 完全隔离——haipigua 有 `/api/agent` 文本服务，
discipline-agent 只有库和 demo，无任何对外入口。本次补齐连接层。

**新增**
| 文件 | 职责 |
|---|---|
| `bridge/service.cjs` | 装配 bus/executor/escalation/audit，纯逻辑、可单测；不感知 HTTP |
| `bridge/server.cjs` | 本机 HTTP 层：127.0.0.1:8879，Host/Origin 校验、128KiB 上限、统一错误码 |
| `bridge/start-bridge.cjs` | 启动脚本（--work-root / --authorize-l5 / --l5-target / --port） |
| `bridge/discipline-client.js` | 前端封装（UMD，可直接拷进 haipigua/web/），含 `describe()` 把指令翻成人话 |
| `bridge/bridge.test.js` | 11 项契约测试，已并入 `run-tests.js` |
| `bridge/FRONTEND.md` | 前端接入说明（接口、级别表、边界、preview 反代改法） |

**接口**：`GET /api/health`、`POST /api/discipline/{start,tick,ack,complete,revoke,restore,audit}`、`GET /api/discipline/state`

**踩到的坑（值得记）**
1. `options.port || DEFAULT_PORT` 把 `port:0`（系统分配空闲端口）吃成 8879 → 测试与手动起的演示服务抢端口，报 EADDRINUSE。**`0` 是合法端口值，必须用 `=== undefined` 判断**。
2. `bus.ack(id, info)` / `bus.complete(id, result)` 是**位置参数**，不是对象；传 `{id}` 会报"未知指令 id: [object Object]"。
3. 路由匹配必须优先于 body 解析，否则空 body 的未知路由会被误判成 `BAD_JSON`(400) 而非 `BAD_ROUTE`(404)。
4. **Node 24 + Windows**：HTTP 测试收尾若 `server.close()` 后立即退出，会撞 libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 3221226505 → 看似测试失败实则全绿。解法：`server.close()` 后 `await setTimeout(300)` 让句柄收干净。
5. 断言"文件未被隔离"时不能判原路径是否存在——L4 洗牌已把文件改名，**应判隔离区 `.quarantine/` 是否为空**。

**测试**：`node run-tests.js` → 14 套 / 14 通过 / 0 失败（exit 0）；其中 bridge 11/11。

**安全默认**：L5 隔离默认关闭（未授权封顶 L4 并在 reason 说明）；单日强制上限 4 次；永不删除文件；全程审计 + 可还原。

**未做**：preview.cjs 的反代改动属于 haipigua 一侧（前端负责人维护），文档已给出改法但未替其修改。
