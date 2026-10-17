# A 侧任务提示词（完整版）

> 项目：自律助手（Agent 驱动 · 强制措施版）
> 你的角色：**A 侧** —— 后端 + Agent 决策层 + 客户端本地层
> 版本：v1（2026-10-16）
> 用途：本文件是自包含任务书。执行者无需其他上下文，按第七节里程碑顺序推进即可。

---

## 一、你是谁，要做什么

你是自律助手项目的 A 侧开发。项目目标：

> 从日常聊天记录里判断出"用户该学习了／该做某项作业了"→ 结合**当前状态**把任务拆成能立刻完成的小步 → 用户不动就**逐级升级强制措施**（提醒 → 弹窗 → 满屏虫子 → 打乱桌面 → 隔离指定文件）→ 全部效果**可撤销**。

A 侧负责"判断"与"执行"两部分：状态感知、待办提取、任务拆解、升级决策、文件操作、还原、审计。前端表现（虫子动画、弹窗、页面）由搭档 B 负责，你只下发指令与数据。

**执行规则（硬性）**：
1. **不委派**。所有事你自己写，不要派生子智能体。
2. **不执行 git 操作**（commit/push 由用户自己完成）。
3. 拿不准的设计先记录到 `NOTES.md` 再继续，**不要静默扩大范围**。
4. 每个里程碑必须配可运行测试，全部通过才算完成。

---

## 二、项目背景（必读）

用户场景：学生／自律困难者。Agent 观察聊天记录推断待办与时机；把"写数学作业"这类任务拆成"下床 → 坐到书桌 → 打开作业本 → 做第 1 题"这种**每一步 ≤3 分钟**的小步；第一步必须从用户**当下真实状态**出发；用户不动则强制升级；用户完成任一步立即撤销全部强制效果。

强制措施分级（L0→L5）：

| 级别 | 动作 | 说明 | 归属 |
|---|---|---|---|
| L0 | `notify` | 轻提醒（角标/提示音） | 前端 |
| L1 | `popup_countdown` | 弹窗 + 倒计时 + "开始"按钮 | 前端 |
| L2 | `spawn_bugs` | 满屏幕虫子（带关闭倒计时） | 前端 |
| L3 | `shuffle_desktop` | 打乱桌面文件（记 manifest） | **你** |
| L4 | `quarantine_files` | 移动用户指定的无关紧要文件到隔离区 | **你** |

时序：L0 → +2min → L1 → +3min → L2 → +5min → L3 → +5min → L4。任何一步完成 → 立即 `revoke_all` 并停止。

**摄像头是本项目的重要增量**：用本地多模态检测判断用户当前状态（躺床／在书桌前／离开／学习中），让"分步"真正从现状出发。没有可靠状态，拆步就是空话。

---

## 三、分工与边界

- **A（你）**：后端 + Agent 决策 + 客户端本地层。你是**状态与任务的唯一权威**。
- **B（前端）**：页面、动画、弹窗、设置 UI。只读展示你给的数据。

遇到没定过的功能，按这三条判归属：
1. 会写/删/移动文件、会决定"现在该不该动" → **你**
2. 只是让用户看见、听见、点一下 → B
3. 判断"该不该做、什么时候做" → 你；且**强制类判定必须是纯规则，不许用 LLM**

你与 B 之间**只有两份接口**（见第六节），不许私加第三份。

---

## 四、现有资产与代码基线

| 资产 | 位置 | 怎么用 |
|---|---|---|
| 作品集仓库 | `C:\Users\yi\laisgo\portfolio123` | 你的全部新代码放这里（见第五节） |
| 总体/A 侧计划 | `PLAN.md`、`PLAN-A.md`（已随仓库上库） | 背景参考；与本提示词冲突时以本提示词为准 |
| 嗨皮瓜已部署源码 | `C:\Users\yi\laisgo\嗨皮瓜-src\site\` | `ramble.js`（topic 正则 + 中文数字/日期/时间解析 + 跨句上下文 + 歧义反问）、`engine.js`（按 beginner/some/advanced 三档各拆 3 步）——可作**确定性兜底**移植进 `chat-sense.js` / `task-planner.js`，不要照单全抄 |
| 嗨皮瓜诊断 | `portfolio123/haipigua-diagnostics/` | 含"改时间丢失原任务日期"的复现、定位与修复提案；A-M1 移植规则时对照 |
| 咖啡 Demo | `portfolio123/coffee-lab/` | 参考其测试组织方式（node 直跑、零依赖） |

**判断**：不重写 ramble/engine，把它们变成"确定性兜底"，LLM 只做搞不定的部分（且要不要上 LLM 由用户在 A-M1 后决定，你先按规则版实现）。

---

## 五、目录与技术约定（硬规则）

```
C:\Users\yi\laisgo\portfolio123\discipline-agent\   ← 你的全部代码目录
```

| 规则 | 要求 |
|---|---|
| 运行时 | Node.js 18+，**零第三方依赖**，CommonJS（`.js` + `require`）。例外：A-M2 允许引入本地推理库（见 7.A-M2） |
| 测试 | 只用 `fs.mkdtempSync(os.tmpdir())` 造临时目录；**严禁碰真实桌面、真实用户文件、系统目录** |
| 文件放置 | 一律进 `discipline-agent/`，不要散落到仓库根目录 |
| git | 不 commit、不 push（用户自行同步；remote 指向 gh-proxy 镜像） |
| 文档 | **不写隐私/合规章节**（默认关闭、指示灯、帧不落盘等一律不写——用户明确说"用户同意即可，系统都有"） |
| 平台 | Windows；注意路径大小写、反斜杠、`fs.renameSync` 跨盘回退 |
| 风格 | 中文注释，函数短小，每个源文件配同名 `*.test.js` |

当前进度：**全部未开始**，本提示词是该目录第一个文件。

---

## 六、接口契约（先定死，变更须显式记录）

### 6.1 指令 JSON（你 ↔ B 的唯一指令契约）

```json
{
  "id": "ins_01",
  "level": "L2",
  "action": "spawn_bugs",
  "taskId": "task_math_01",
  "step": { "index": 1, "label": "下床", "stateAtPlan": "躺床" },
  "issuedAt": "2026-10-16T20:30:00+08:00",
  "expiresAt": "2026-10-16T20:35:00+08:00",
  "reversible": true,
  "manifestId": null
}
```

- `action` 枚举：`notify` / `popup_countdown` / `spawn_bugs` / `shuffle_desktop` / `quarantine_files` / `revoke_all`
- `level` 与 `action` 对应：L0=notify，L1=popup_countdown，L2=spawn_bugs，L3=shuffle_desktop，L4=quarantine_files；`revoke_all` 任意时刻可下发，`level` 可为 `null`
- 扩展字段 `payload`：`quarantine_files` → `{ "targets": ["路径..."] }`；`shuffle_desktop` → `{ "targetDir": "可选，默认执行范围顶层" }`
- 校验必做：id/level/action/时间戳/step.index/布尔字段；不合法直接抛错（带 errors 数组）

### 6.2 状态模型（你 → B 的唯二契约）

```json
{
  "state": "lying_bed | seated_desk | standing_or_moving | away | learning | unknown",
  "confidence": 0.86,
  "evidence": "camera:卧姿·床区域 | inactive:18min | time:07:42",
  "capturedAt": "2026-10-16T07:42:11+08:00",
  "source": "camera_local | time_rules | manual",
  "explain": "摄像头判定为床区域卧姿，且已 18 分钟无操作"
}
```

- `explain`/`evidence` **必须可读**：B 靠它把指令还原成人话（"因为你已经坐在书桌前，所以第一步是打开作业本"）
- `unknown` 是合法且常用的状态：**宁可 unknown 也不瞎猜**；低置信度时不拆激进小步、不进强制升级
- `source=manual` 表示用户手动纠正过的状态，权重最高

### 6.3 模块职责与文件清单

| 文件 | 职责 | 里程碑 |
|---|---|---|
| `instructions.js` | 指令 schema 校验 + 指令总线（issue/ack/complete/revoke，JSONL 审计日志） | A-M0 |
| `manifest.js` | 可逆账本：原路径 ↔ 新路径，先写后做、逐条回写 | A-M0 |
| `executor.js` | 本地执行：quarantine_files / shuffle_desktop / restore / restoreAll | A-M0 |
| `chat-sense.js` | 聊天记录接入 + 待办提取（移植 ramble 规则兜底） | A-M1 |
| `state-sensor.js` | 摄像头多模态 + 时间规则 → 状态模型 | A-M2 |
| `task-planner.js` | 状态驱动任务拆小步 + 重排 | A-M3 |
| `escalation.js` | L0→L5 升级规则状态机 + 与 bus/executor 联动 | A-M4 |
| `audit.js` | 审计查询、用户纠正、误判申诉 | A-M5 |
| `test-util.js` | 测试辅助（临时目录/断言/sha256/汇总退出码） | A-M0 |
| `demo-m0.js` → `demo.js` | 闭环演示脚本（联调用） | A-M0 起 |
| `NOTES.md` | 设计疑点记录 | 随时 |

---

## 七、里程碑任务书（按序执行）

### A-M0 指令通道 + 隔离区/还原

**目标**：指令能下发、文件操作可 100% 还原、账本崩溃安全。

**交付**：`instructions.js`、`manifest.js`、`executor.js`、`test-util.js`、三套测试、`demo-m0.js`

**行为规格**：
- `executor` 由 `createExecutor({ workRoot })` 创建；`workRoot` 拒绝系统目录/盘符根/用户主目录本身（抛错）
- `quarantine_files`：把每个 target 移入 `workRoot/.quarantine/<manifestId>/`；**先写 manifest 再动手，每完成一条立即回写 manifest**；target 缺失或不在 workRoot 内 → 记 `skipped`（含 reason），不中断
- `shuffle_desktop`：对执行范围顶层**普通文件**随机重命名（保留扩展名），跳过目录/点开头文件；同样先写 manifest
- `restore(manifestId)`：按 manifest 反向还原，**幂等**；原位已被占用 → 记 `conflict`，**绝不覆盖用户文件**；返回 `{ok, restored, lost, conflicts}`
- `restoreAll()`：按 manifest 时间倒序全部还原
- `revoke_all` 指令到达 executor → 执行 `restoreAll()`
- `notify`/`popup_countdown`/`spawn_bugs` 是前端动作，executor 原样返回"非本地动作"
- 总线：`issue`（幂等去重）/`ack`/`complete`/`revoke(taskId)`；每次流转追加 JSONL 审计行

**验收**：
1. 移动 3 个测试文件 → restore 后逐字节一致（sha256 相同）
2. manifest 含完整 原路径↔新路径、instructionId、createdAt
3. 重复 restore 不报错、不重复还原
4. 原位被占 → conflict 且原文件未被覆盖
5. 拒绝 `C:\`、`C:\Windows`、用户主目录作为 workRoot
6. 审计日志包含 issue→ack→complete/revoke 全链路

### A-M1 聊天接入 + 待办提取

**目标**：从聊天记录导出中提取结构化待办。

**交付**：`chat-sense.js` + 测试 + 50 条自建测试集（放 `fixtures/`）

**行为规格**：
- 导入常见导出格式（txt/json），切片段，去空去重
- 提取：`ramble.js` 规则兜底（topic 正则、中文数字/日期/时间解析、跨句上下文、歧义反问"你说明天十二点还是后天？"）
- 输出 `{ subject, content, ddl, source, confidence }`；`confidence` 低 → 状态 `pending_confirm`，不直接进计划
- 保留用户原话引用，供事后核对

**验收**：50 条测试集提取准确率 ≥80%（subject/ddl/time 分别计）；歧义样例必须进入待确认而非瞎猜。

### A-M2 状态估计（摄像头多模态）★重点

**目标**：本地判断 5 类状态，喂给拆步与升级。

**交付**：`state-sensor.js` + 测试 + `assets/`（模型文件）

**行为规格**：
- 采集：**不连续录像**；常规每 60s 抓 1 帧；提醒发出后 30s 补抓 1 次；必要时取 2–3 帧/间隔 1s（区分"躺着不动"与"人已离开"）
- 推理（v1 本地）：ONNX Runtime（`onnxruntime-node`）跑 YOLOv8n-pose，或 `@mediapipe/tasks-vision` 的 Pose Landmarker → 关键点/区域 → 映射 5 类状态
  - **本里程碑是唯一的依赖例外**，写进 `package.json` 的 `dependencies`；其余里程碑保持零依赖
- 融合：camera 证据 + 时间/活跃度规则（锁屏、无操作时长、时段）→ `confidence`
- 降级：无摄像头/权限拒/遮挡/光线差 → 退时间规则，`confidence` 标低，`source=time_rules`
- 消费约束：状态**只用于**分步起点选择 + 是否有人；**绝不单独触发 L2 及以上强制**
- 用户纠正（`source=manual`）优先，并作为规则修正依据回流

**验收**：四类场景（躺床/在书桌前/离开/学习中）判定正确率达标（用录制的短视频/序列帧做 fixtures）；拔摄像头或拒权限后全流程可跑通仅降置信；无摄像头证据时不会进入 L2+。

### A-M3 状态驱动任务拆步

**目标**：同一任务在不同状态下拆出不同的第一步。

**交付**：`task-planner.js` + 测试

**行为规格**：
- 内容层移植 `engine.js` 三档（beginner/some/advanced）步骤库
- 状态层决定**起点与裁剪**（映射表见 8.1）
- 硬约束：≤7 步；单步 ≤3 分钟；**第一步必须从当前状态出发**；每步有明确完成信号
- `replan(task, newState, doneSteps)`：状态与计划时不一致 → 立即重拆，已完成步直接划掉
- 超 7 步 → 判拆错，回退重拆

**验收**：五类状态各产出的第一步全部正确（躺着≠坐着）；状态变化能自动重排；无"一步到底"。

### A-M4 强制措施（升级状态机 + 执行联动）

**目标**：L0→L5 全自动、可撤销、防误伤。

**交付**：`escalation.js` + 联动测试 + `demo.js`（完整闭环）

**行为规格**：
- 纯规则状态机；时钟/定时器**可注入**（测试用假时钟手动触发）
- 时序：L0→2min→L1→3min→L2→5min→L3→5min→L4
- `present=false` 只影响 **L0→L1**（不在场则挂起，回到场再继续）；L2 以后只看步骤完成信号，不看画面
- 单日强制（L2+）上限 **3 次**，达到后当天封顶 L1
- L4 需 `authorizeL4`，未授权封顶 L3
- 任一步完成 → `revoke_all` + 清定时器 + 停状态机
- 每次 L3/L4 执行**先写 manifest 再动手**；`revoke_all` 触发 `restoreAll`

**验收**：全链可按序触发且每级有真实间隔；单日上限生效；未授权不上 L4；完成即撤销且文件 100% 还原；状态机可解释（每轮输出当前 level/status/原因）。

### A-M5 审计与误判申诉

**交付**：audit.js` + 测试

**行为规格**：
- 判定与执行记录可查询（按 task / 时间段），含 `explain` 原文
- 用户可**纠正判定**（写回 `source=manual` 状态）与**登记误判申诉**
- 纠正记录作为 `state-sensor` 规则修正依据（提供读取接口）

**验收**：任意一次强制的"依据 → 指令 → 执行 → 还原"四段可查；纠正后同一场景再次判定正确。

---

## 八、跨里程碑关键规格

### 8.1 状态 → 分步映射（A-M3 核心表）

| 当前状态 | 第 1 步示例（任务：数学作业） | 说明 |
|---|---|---|
| `lying_bed` | 坐起来 → 下床 | 不许直接给"打开作业" |
| `seated_desk` | 打开数学作业本 | 跳过"下床" |
| `standing_or_moving` | 走到书桌前坐下 | 捕捉过渡动作 |
| `away` | **不拆步** | 先找人提醒，人回来再拆 |
| `learning` | **不打扰** | 顺延本次任务 |
| `unknown`（低置信度） | 只发一次确认："你现在在哪？" | 不启动强制升级 |

### 8.2 executor 安全边界

1. 只操作 `workRoot` 之内；`workRoot` 拒绝系统目录/盘符根/用户主目录本身
2. **永不删除**：quarantine=移动，shuffle=重命名，全部记 manifest
3. 先写 manifest 再动手，逐条回写（崩溃也可还原）
4. restore 幂等；原位被占记 conflict，不覆盖
5. 跳过符号链接；shuffle 跳过目录与点开头文件

### 8.3 联调约定

- B 需要假指令源时，用 `demo.js` 导出的指令序列（JSONL）做 fixture
- 你的每个"本地动作"指令都要能单独被执行与还原（B 不参与文件操作）

---

## 九、环境注意事项（本机实况）

| 事项 | 实况与对策 |
|---|---|
| `web_search` | 端点 404 **不可用**；检索一律用 `web_fetch`。`cn.bing.com` 对**精确专名**有效（如具体模型名），模糊中文长查询会被降级成字典词条 |
| GitHub | 全部 GitHub 域名被 hosts 劫持到 127.0.0.1；git 操作用 `https://gh-proxy.com/github.com/<owner>/<repo>.git` 镜像（`git -c http.sslBackend=openssl -c http.sslVerify=false clone ...`）；`raw.githubusercontent.com` 用 `https://gh-proxy.com/raw.githubusercontent.com/...` 取。**你不要 push** |
| 工作目录 | `C:\Users\yi\laisgo`；代码进 `portfolio123\discipline-agent\` |
| node/python | Node 18+、Python 3.10+ 可用；仓库内工具均为 node 直跑、零依赖 |

---

## 十、汇报与自查要求

每个里程碑完成时汇报：
1. 新增/修改了哪些文件（逐个一句话）
2. 测试怎么跑、结果如何（贴关键输出）
3. 与第六节契约有无偏差，为什么
4. 记入 `NOTES.md` 的疑点

进入下一里程碑前自查：上一级测试全绿、契约未擅改、没有新增隐私/合章节、没有碰 portfolio123 之外的文件。

---

## 十一、v1 验收总清单

1. 能从一段日常聊天中提取待办（科目+截止时间），低置信度进入待确认
2. 任务能按当前状态拆成 ≤7 步、每步 ≤3 分钟，第一步从当前状态出发；状态变化能重排
3. 状态估计四类场景判定正确，降级路径可用，摄像头证据不能单独触发 L2+
4. 提醒未响应按 L0→L5 逐级升级，每级有真实间隔，完成即撤销
5. 打乱/隔离的文件 100% 可还原；单日强制上限生效；L4 未授权不上
6. 全流程可审计：读了什么、依据什么、下了什么指令、执行/还原了什么
7. 用户可随时纠正判定
