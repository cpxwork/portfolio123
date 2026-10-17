# ClassTechStar 仓库群分析（已完成）

> 2026-10-16 启动。5 个子代理并行分析（Notehelper、Reciting-us 成功，其余 3 个失败后由 Lead 直接核验），Lead 汇总并逐项交叉核对关键声明。**License 因素已排除**：用户（作者）确认同意使用全部仓库。

## 0. 已核实元数据（Lead 亲自拉取，非子代理转述）

| 仓库 | 语言 | 体积 | 默认分支 | 最近推送 | Stars/Forks | 开放 Issue | 归档 | fork→上游 |
|---|---|---|---|---|---|---|---|---|
| `-Knowledge-Debt-Astral-Path` | HTML | 37 MB | main | **2026-10-16** | 1 / 0 | 0 | 否 | 否（源仓库） |
| `ReciteHelper` | C# | 187 MB | primary | 2026-10-07 | 0 / 0 | 0 | 否 | **是→ArabidopsisDev/ReciteHelper（10-08 更新）** |
| `GalReview` | C# | 60 MB | main | 2026-09-30 | 0 / 0 | 0 | 否 | **是→OpenRecite/GalReview** |
| `Notehelper` | JavaScript | 6.6 MB | main | 2026-09-29 | 0 / 0 | 0 | 否 | 待复核 |
| `Reciting-us` | 未识别 | 13 MB | main | 2026-08-06 | 1 / 0 | 0 | 否 | **是→HelloZWH-0620/Reciting-us** |

官方描述（原文）：
- Astral-Path：「《知债：星穹学途》是一个跨课程知识债诊断与修复智能体——用确定性公式找出你"欠"了哪门课的先修债，用约束满足生成可完成的还债计划，用受约束智能体陪你一步步销账，同时守住教育伦理底线。」
- ReciteHelper：「一款基于AI技术帮助你智能学习/复习的软件喵！」
- GalReview：「The "千知万理" project repository」
- Notehelper：「笔记助理：不只是笔记整理，而是结合AI进行思维串联的学习地图。」
- Reciting-us：「This is an auxiliary tool that helps Chinese high school students recite and learn classical Chinese and ancient poems.」

**网络**：GitHub 域名可直连（api.github.com / raw.githubusercontent.com 200），hosts 劫持已不存在。

## 1. 各仓库详细分析

### 1.1 Notehelper（JavaScript / 6.6MB / MIT）

**定位**：面向 K12 的纯前端 AI 笔记工具——把零散笔记（图文/录音/文档混排）变成可检索、可对话、可按科目生成思维导图的结构化知识。底座 DeepSeek，用户自带 Key；产物是 Android WebView 壳 APK，也可浏览器直跑。

**覆盖环节**：A 输入 + C 关联 + 检索回顾。**缺 B 巩固（间隔重复）与 E 练习（测验）**。

**可复用资产（按价值排序）**：
| 资产 | 位置 | 价值 |
|---|---|---|
| `NHAI` 统一调用层 | `www/js/app.js:337-444` | 代理优先/直连回退、90s AbortController、thinking 可调。改两个常量即可接任何 OpenAI 兼容 API |
| `server.js` LLM 网关 | 根目录 129 行 | 零依赖，改一个常量即可给任意前端当 LLM 网关（含目录穿越防护） |
| 笔记"块"模型 + 富文本清洗 | `www/js/app.js:107-334`（NHBody） | `{t:'p'\|'img'\|'file'\|'audio'}` + ALLOW/DROP 白名单。**现成的输入层数据契约** |
| 双模检索 | `www/js/search.js:108-163` | 字段加权 + 多词 AND + `<mark>` 高亮，零请求纯本地 |
| AI 语义检索契约 | `www/js/search.js:392-429` | "候选集打包 → 模型只回 id+score+why → 用 id 回查本地库、**丢弃幻觉 id**"。这个防幻觉模式很成熟 |
| **（Lead 补充）检索兜底 answer 字段** | `www/js/search.js:395-399` | prompt 规定 `answer`"仅当没有条目能回答用户时才直接回答"——即**没检索到就明说没有，不许硬答**。比单纯"丢弃幻觉 id"多一层保护；`parseAI` 还容忍代码围栏与尾逗号 |
| 思维导图 JSON 树 + 布局 | `www/js/explore.js:127-307` | `{text,children[]}` + 缩进大纲（把树压成文本喂模型做增量修改） |
| 「AI 整理」四方向 prompt | `www/js/explore.js:686-700` | 精简主干/展开细节/按考点重组/**查漏补缺**——本身就是知识重组提示词模板 |
| localStorage 数据层 | `www/js/user.js` | 版本快照 + 媒体内容寻址 + 配额降级 + 全量导出导入 |
| Android WebView 壳 | `android/` | 最小可用"H5→APK"模板 |

**短板**：① **无复习闭环**（grep 间隔重复/SM-2/艾宾浩斯/Anki 全 0 命中）② 无后端、无多端同步，数据全在 localStorage ③ 硬编码单用户 `DEFAULT_USER='喔糖圆鼠'` ④ 视窗写死 402×874 靠 CSS zoom 缩放，非响应式 ⑤ 无模块系统（IIFE + 全局变量），**无法 npm 化** ⑥ 停更：最后 commit 2026-09-30，交付即冻结。

**集成难度：中**。务实建议是**按资产横向抽取**（NHAI + server.js + NHBody 块模型 + search.js + explore.js 导图树），在自己技术栈里重写薄层，不要整体嵌入。

**Lead 交叉核对**：`app.js` 4096 行 ✅ / `deepseek-flash` 在 346 行 ✅ / `DEFAULT_USER='喔糖圆鼠'` 硬编码 ✅。（`fork:true` 一条 API 未返回，标待复核，不影响主结论。）

### 1.2 Reciting-us（HTML / 13MB / MIT，fork）

**定位**：「背书哇！」——高中生本地优先 Web 应用：80 篇文言文/古诗词 + 自动出题 + 间隔重复错题本，解决背诵/默写/文言语法考点巩固。

**⚠️ fork 警告**：upstream = `HelloZWH-0620/Reciting-us`。ClassTechStar 侧 main 只有 2 个初始提交（2026-07-31），**完整可复用版本在 upstream 的 `feat/v0.2.0-p1-p4-full-refactor` 分支**（真 SM-2 + src/ 拆分 + 11 个单测）。移植基线应用该分支，不用 fork main。

**覆盖环节**：B 巩固（最强：SM-2 错题本）+ E 练习（5 类自动出题）+ F 部分（统计看板/打卡）。缺 A/C/D。

**可复用资产**：
| 资产 | 位置 | 说明 |
|---|---|---|
| SM-2 间隔重复错题本 | upstream 分支 `src/js/app.js`（main 版为固定 1/3/7/14/30 天） | EF 2.5 / 180 天上限 / 5 次连续答对移出；uid 防索引漂移；配 `test/store.test.js` 11 用例可直接跑 |
| 三条中文自动出题流水线 | main `app.html` generateBlank/Match/Flashcard | 中文切句 + 抠字 + 干扰项 + Fisher-Yates，**与语料解耦，换语料即可给任何学科用** |
| 80 篇四元组语料 | upstream `src/data/articles.js` 719 行 | 原文/译文/注释（1122 条）/赏析（仅 6/80，缺 74 篇） |
| 57 作者 + 64 句式 + 30 活用 + 50 情境默写 + 72 虚词题 | `src/data/` | 数据资产，清洗后可直迁 |
| 通假字判分归一化 | main `app.html` | 知→智、说→悦等 10 组映射，古文判分必备 |
| Canvas 图表四件套 | main `app.html` | 折线/柱状/饼/30 天热力图，零依赖 |

**关键 bug（main 实测）**：6 个 Store 方法（getStreak/updateStreak/addStudyTime/getStudyTime/setLastState/getLastState）**被调用但从未定义** → 统计页/计时器/继续学习直接崩；`config/*.json` 是死文件且非合法 JSON；PWA 图标全 404；单文件巨石 624KB。

**Lead 交叉核对**：`fork:true`，parent=HelloZWH-0620/Reciting-us ✅ / 6 个方法逐个 grep"定义:0 调用:2~3"证实 ✅ / `var intervals = [1, 3, 7, 14, 30]` ✅。

**集成难度：中**。只摘算法层+数据层，弃 Windows 壳，2-3 人日。

### 1.3 -Knowledge-Debt-Astral-Path（知债：星穹学途 / C#+Python 混合 / 37MB / Apache-2.0，**非 fork**）

**定位**：跨课程**知识债**诊断与修复智能体（2026 iCAN AI 竞赛实现，v2.6.0）。核心主张：卡住你的往往不是"这一章没听懂"，而是前面某门课的先修概念没打好——用确定性公式找出先修债，用约束满足生成可完成的还债计划，用受约束智能体陪伴销账。**五个仓库里唯一同时覆盖 D 诊断 + F 规划的**。

**⚠️ 树统计勘误**：之前统计的 672 个 `.bcmap` 不是数据文件，是 `deploy/monolith-web/ocr-engine/cmaps/` 下的 pdf.js CMap 资源。真实代码以 C#（174）+ Python 工具链（51）为主。

**六模块**（README §4）：藏书阁（PDF 本机解析→章节+关键词+出题）/ 识网（知识图谱 DAG：TextRank/PMI/依赖句式，瓶颈与关键路径）/ 知债（impact-v2 红边 + What-if + 14 天计划 K1–K5）/ 今日（≤3 任务 + 真题 + 信心 1–5 自评 + 判分）/ 智能体（意图路由 · 危机转人工 · 敏感词脱敏 · 读真实学情）/ 画像（Brier 信心校准 · 风格五轴）。

**核心公式 v2**（README 原文，实现在 `src/AstralPath.Core/`，1e-6 金样锁定）：
```text
score = min(0.50·know + 0.30·retention + 0.20·prereqSupport, 0.55+0.45·min(prereq))
know = 0.85·Beta(成功,失败) + 0.15·(conf/5)
retention = exp(-age/S);  S = 2.5·(1+0.45·streak)·(1+0.25·ln(1+reps))
销账 ⇔ 近期连续 2 次达标 ∧ 累计 ≥3 次；Weighted = 0.7·acc + 0.3·(conf/5) ≥ 0.65
```

**已验证的算法文件清单**（git tree）：`Algorithms/DebtScanner.cs`（知识债扫描）/ `ScoreCalculator.cs` / `MasteryCalculator.cs` / `PlannerBuilder.cs`（约束满足计划）/ `QuestionScheduler.cs` / **`SaleStateMachine.cs`（销账状态机）** / `GraphTopology.cs` / `CoachRules.cs` / `Agent/AgentRouter.cs` + `MimoClient.cs`（LLM 意图路由）；另有 10 个可选微服务（`services/*-svc`：spaced-review、prerequisite-simulator、exam-impact、learning-velocity 等，单体版不依赖）。

**架构红线（README §10，最有价值的一条）**：「数字只能算出来；AI 不许改分；不发明先修边；`cleared` 只由状态机写」——**LLM 只负责对话与路由，一切数字由纯函数产出**。

**数据资产**：`eval/question_bank.json` 100 题/34 知识点；`graph-packs/astralpath-v2/graph_pack.json` 34 节点/74 边（先修 50 + 迁移缺口 24，无环）；13 本教材思维导图（6,720 页/2,519 节点）；OCR 工具链 8 脚本 4,291 行。测试 235 项 ALL GREEN（Core 28 / Api 66 / MobileCore 84…），金样在 `eval/golden/*.json`（formula-cross/impact/plan_k/quiz/routing…）。

**与 discipline-agent 的架构同构**：它把"确定性公式管数字 + LLM 管对话"做成了硬边界——和 A 侧"物理闸门保留 + LLM 管决策"是同一个原则的成熟先例。`AgentRouter + CoachRules + SaleStateMachine` 三个模式可直接对照借鉴。

**短板**：① 面向"跨课程先修债"窄场景，且依赖预先构建的知识图谱（34 节点包靠工具链生成）② .NET 10 + Postgres/pgvector + Avalonia 技术栈重 ③ 竞赛交付导向，文档/代码混杂。**集成难度：中**（摘算法与护栏范式，不搬壳）。

**Lead 交叉核对**：非 fork（API `fork:false`，pushed 2026-10-16）✅ / Core 算法文件逐个在 git tree 确认存在 ✅ / 公式与 README §5 一致（金样 `eval/golden/formula-cross.json` 存在）✅。

### 1.4 ReciteHelper（C# WPF / 187MB / AGPL-3.0，**fork → 上游 ArabidopsisDev**）

**定位**：「把课程资料变成真正可以练习、检索和复习的学习项目」。AI 读资料 → 提取知识点 → 生成题目 → 练习/模拟考试 → 错题检索与 AI 解析 → **FSRS-6** 个性化调度。**五个仓库里调度算法最先进、A 输入 + E 练习最完整的**。

**⚠️ fork 警告**：ClassTechStar 版是 fork（pushed 2026-10-07），**source = `ArabidopsisDev/ReciteHelper`（pushed 2026-10-08，更新一天）**。移植基线用上游 `primary` 分支。（README 徽章写的 `OpenRecite/ReciteHelper` 在 API 上 404，实际 source 不是它。）

**已验证的核心资产**（git tree + 抽读源码）：
| 资产 | 位置 | 说明 |
|---|---|---|
| **FSRS-6 纯函数实现** | `ReciteHelper.Core/Scheduling/FsrsAlgorithm.cs` | D-S-R 三变量、w0–w20 共 21 参数、`R(t,S)=(1+F·t/S)^(-decay)`、难度演化、stability 三路径（rec/lap/day）、`IntervalForRetention` 反解。文件头有完整公式注释，**跨语言移植容易** |
| 个人参数拟合 | `Core/Scheduling/FsrsOptimizer.cs` | 积累记录后自动拟合个人 w 参数（README："积累足够记录后可自动拟合个人参数"） |
| 双模型 + 迁移 | `FsrsDualModel.cs` / `LegacyReviewMigrator.cs` / `MemoryState.cs` / `ReviewCalendar.cs` | 新旧模型共存与旧记录迁移，工程完整度高 |
| 项目级向量知识库 | `Core/ValueObjects/FileVectorStore.cs` + `Infrastructure/Services/KnowledgeBaseService.cs` | 每个学习项目独立文件型向量库；错题时检索知识点按需生成 AI 解析 |
| 五类题型 + 整卷导入 | `Application/Services/ExamSetImportService.cs`、`FileMergeService.cs`（.meg 合并 → .rhproj 项目） | PDF/TXT/HTML/MHTML 识别多套试卷；章节权重组卷、限时考试、自动评分 |
| 模型接入层 | DeepSeek + Qwen 直连 / OpenRouter / 激活码托管三方案 | Key 存本机 Config.xml，支持环境变量 |

**分层架构**（经典 DDD，已验证目录）：Core（实体/接口/纯算法）→ Application（服务）→ Infrastructure（实现）→ Wpf（界面）。测试在 `tests/ReciteHelper.Tests/`。

**短板**：① Windows-only WPF，界面层完全不可复用 ② 187MB 大头是 mp3/png 资源 ③ 单机无多端 ④ upstream/fork 会继续漂移。**集成难度：中高**（FSRS-6 移植 + 判分/导入思路，弃全部 UI）。

**Lead 交叉核对**：`fork:true` + parent=ArabidopsisDev/ReciteHelper ✅ / `FsrsAlgorithm.cs` 头部公式与 FSRS-6 参考一致（w0-w20、decay 公式）✅ / Scheduling 7 个文件与 KnowledgeBaseService 均在 tree 中 ✅。

### 1.5 GalReview 千知万理（C# + TS/TSX + Lua / 60MB，**fork → 上游 OpenRecite**）

**定位**：以 **ReciteHelper 的复习内核**（资料库/题库/练习/考试）为产品内核，按微服务架构接入**知识图谱、SM-2 与视觉小说复习**。README 明确定位："故事生成是学习项目的一种复习方式，不是高于日常复习主线的独立产品"。**五个仓库里工程规模最大（10 个后端服务 + 网关 + 三端）**。

**⚠️ fork 警告**：source = `OpenRecite/GalReview`（OpenRecite 是真实组织）。ClassTechStar 版 pushed 2026-09-30。

**已验证的架构**（git tree）：backend 10 服务（Auth / Credit / File / **GalGame** / **Knowledge** / Model / OCR / Practice / Render / User）+ `gateway/` + `frontend/`（Vite + TS/TSX）+ `desktop/` + `mobile/` + compose 三套（integration/production/smoke）。

**已验证的可摘资产**：
| 资产 | 位置 | 说明 |
|---|---|---|
| **经典 SM-2 纯函数** | `backend/KnowledgeService/KnowledgeService.Application/Mastery/Sm2Scheduler.cs` | 完整 EF 更新式、quality<3 重置（reps=0, interval=1）、序列 1/6/interval×EF、EF≥1.3、上限 3650 天、**lapses 计数**、`usedHint` 参数。比 Reciting-us 的实现完整；注释还解释了为何不加 EMA 双模型（"would add a second, arbitrary memory model"）——工程判断成熟 |
| 知识图谱后台构建管线 | `KnowledgeService.API/Background/GraphBuild{Queue,Worker,RecoveryService,WorkItem}` + `KnowledgeGraphEndpoints` | 队列化构建 + 崩溃恢复，"从章节到概念逐步建图"的产品化模式 |
| 剧情-图谱接线 | `backend/GalGameService/PlanGraphClient.cs` + `frontend/src/lib/storyAssets.ts`、`pages/review/useStoryProgress.ts` | 视觉小说与图谱/掌握度共享同一份复习记录的接线方式 |
| credits 计量 | `backend/CreditService/` | 生成前核对最低所需 credits、失败不扣额的计费防呆 |

**产品细节**：自动建库只生成单选/填空/名词解释/简答，**判断题保留给人工题录或整卷导入**（防 AI 造劣质判断题）；题数由通过来源与答案校验的原题/知识原子决定。三位角色立绘在 `design/model/`。

**短板**：① 微服务全家桶（10 服务+网关+compose）对个人工具过重 ② 继承 ReciteHelper 的 SM-2，调度上反而落后上游 ReciteHelper 的 FSRS-6 ③ 视觉小说依赖美术资产与 credits 后端。**集成难度：整体高 / 单点低**（只摘 Sm2Scheduler、GraphBuild 队列模式与 PlanGraphClient 接线思路）。

**Lead 交叉核对**：`fork:true` + parent=OpenRecite/GalReview ✅ / `Sm2Scheduler.cs` 抽读：EF 公式、1/6 序列、lapses、3650 上限逐行确认 ✅ / backend 10 服务与 GraphBuild 8 个文件均在 tree ✅。

## 2. 融入"知识学习流程"的整体判断

### 2.1 参照框架：一个完整学习流程有哪几个环节

（用于给每个仓库定位，避免"都很相关"的空话）

| 环节 | 这个环节要解决什么 | 用户在这个环节的典型痛点 |
|---|---|---|
| **A 输入** | 知识进脑子：读、看、听、做笔记 | 读完了没进脑子；笔记抄了不看 |
| **B 巩固** | 短期记忆转长期：背诵、间隔重复、主动回忆 | 忘得快；不知道什么时候该复习 |
| **C 关联** | 新知识挂到旧知识上：思维串联、知识地图 | 知识点是散的，做题想不起来用哪条 |
| **D 诊断** | 找出"哪里不会、为什么不会" | 只知道考砸了，不知道欠在哪 |
| **E 练习** | 输出与检验：做题、测验、复盘 | 会做的反复做，不会的一直不会 |
| **F 规划** | 什么时候学什么、学多久、先学哪科 | 计划列了执行不了；多科并行全崩 |

### 2.2 仓库 → 环节映射（已验证）

| 仓库 | A 输入 | B 巩固 | C 关联 | D 诊断 | E 练习 | F 规划 |
|---|---|---|---|---|---|---|
| Notehelper | ●●● NHBody块+AI整理 | — | ●● 思维串联导图 | — | — | — |
| Reciting-us | — | ●● SM-2错题本 | — | — | ●● 三条出题流水线 | ● 统计看板 |
| ReciteHelper | ●● 资料→知识点 | ●●● **FSRS-6** | ● 向量知识库 | — | ●●● 五题型+整卷考试 | ● 复习日历 |
| GalReview | ●● 继承ReciteHelper | ●● SM-2 | ●● 图谱构建管线 | ● 答题前选点 | ●●● 继承+智能复习 | ● 共享计划 |
| Astral-Path | ● 藏书阁PDF | ● retention公式 | ●● 图谱DAG | ●●● **DebtScanner+impact** | ● 今日≤3任务 | ●●● **约束满足计划+销账状态机** |

（● 数量 = 已验证的覆盖深度：● = 有涉及 / ●● = 有完整实现 / ●●● = 五仓库中最强）

**五个关键结论**：

1. **六环节无致命空洞**：五仓库拼起来正好覆盖 A–F 全部环节，每个环节至少有 ●● 级的可摘实现。
2. **B 巩固存在三代调度算法，直接用第三代**：Reciting-us SM-2（fork main 甚至退化为固定间隔）→ GalReview SM-2（完整 EF+lapses）→ **ReciteHelper FSRS-6**（D-S-R 21 参数 + 个人拟合）。前两代只作参考，不必移植。
3. **D 诊断 + F 规划只有 Astral-Path 有**，而且它不是 LLM 拍脑袋——是确定性公式 + 金样测试 + "AI 不许改数字"护栏。这与 discipline-agent 的"物理闸门 + LLM 决策"分层**完全同构**，是最值得对标的一个仓库。
4. **C 关联是两种互补形态**：Notehelper 的思维导图树（人脑联想视角，LLM 生成）vs Astral-Path/GalReview 的结构化 DAG（先修关系视角，算法构建）。前者管"知识长什么样"，后者管"知识欠了什么"。
5. **三个 fork 的基线选择**：Reciting-us 用 upstream `feat/v0.2.0-p1-p4-full-refactor`；ReciteHelper 用上游 `ArabidopsisDev/primary`（比 ClassTechStar 新一天）；GalReview 用上游 `OpenRecite/GalReview`。

## 3. 行动建议

### 3.1 总策略

**不整体嵌入任何仓库**（五个仓库没有一个是纯 Node/JS 技术栈，除了 Notehelper 而它缺大半流程）。按四类资产横向抽取，对接 discipline-agent 的 LLM 化架构（llm/roles.js 四角色 + 物理闸门）：

1. **算法层**：纯函数直接跨语言移植（FSRS-6、SM-2、DebtScanner 公式）——它们全部是确定性纯函数，C#→JS 是机械翻译。
2. **数据契约**：graph_pack.json 的图谱结构、NHBody 块模型、question_bank.json 题目格式。
3. **护栏模式**："AI 不许改数字"（Astral-Path）、防幻觉检索契约（Notehelper）、判断题不自动生成（GalReview）。
4. **提示词模板**：Notehelper "AI 整理"四方向 prompt、Astral-Path 智能体意图路由。

### 3.2 分环节落地建议

| 环节 | 采用什么 | 来源 | 对接点 |
|---|---|---|---|
| **A 输入** | NHBody 块模型做输入契约；"资料→知识点"提取交给 extractor 角色 | Notehelper + ReciteHelper 思路 | `llm/roles.js` extractor |
| **B 巩固** | **移植 FSRS-6 成纯 JS 模块**（MemoryState/Retrievability/IntervalForRetention 先行，Optimizer 后置） | ReciteHelper `FsrsAlgorithm.cs` | 新建 `fsrs6.js`，不动 llm 层 |
| **C 关联** | 双轨：思维导图树（LLM 生成）+ graph_pack DAG 数据结构 | Notehelper explore.js + Astral-Path graph_pack.json | observer 角色 |
| **D 诊断** | DebtScanner 思路 + impact 公式；**金样测试范式** | Astral-Path | strategist 护栏：诊断分只算不生成 |
| **E 练习** | 三条出题流水线（与语料解耦，换语料即换学科）+ 五题型判分框架 | Reciting-us + ReciteHelper | planner 角色 |
| **F 规划** | 约束满足计划（每日≤40min、0/2/6 间隔、K1–K5 分级）+ 销账状态机（连续 2 次达标 ∧ 累计 ≥3） | Astral-Path PlannerBuilder + SaleStateMachine | 物理闸门直接同构 |

### 3.3 优先级

- **P0（先做）**：① FSRS-6 移植（B，唯一最强调度）② Astral-Path 诊断公式 + 销账状态机（D/F，直接对标物理闸门架构）③ Notehelper 防幻觉检索契约（C，现成模式）。
- **P1（次做）**：④ Reciting-us 出题流水线（E）⑤ Notehelper NHBody 块模型（A 输入契约）⑥ Astral-Path 金样测试范式（测试方法学）。
- **P2（可选）**：⑦ GalReview GraphBuild 后台队列（C 的后台化）⑧ ReciteHelper 整卷导入/五题型判分（E 扩展）⑨ Astral-Path OCR 工具链（如需 PDF 管线）⑩ GalReview 视觉小说激励层（好玩但非主线）。

### 3.4 明确不做

- ❌ 任何仓库整体嵌入或壳复用（WPF / Avalonia / WebView 壳 / 10 服务微服务拆分全部弃）。
- ❌ SM-2 前两代移植（Reciting-us fork main 版有 6 个未定义 Store 方法会崩；GalReview 版被 FSRS-6 全面覆盖）。
- ❌ 以 ClassTechStar 的 fork 版做移植基线——三个 fork 都用 upstream 分支。
- ❌ GalReview credits/激活码后端（个人工具不需要计费层）。

### 3.5 三个 fork 基线速查

| 仓库 | ClassTechStar 版 | 应使用的基线 | 差异 |
|---|---|---|---|
| Reciting-us | main（2 个初始提交） | upstream `HelloZWH-0620/Reciting-us` 的 `feat/v0.2.0-p1-p4-full-refactor` | 真 SM-2 + src 拆分 + 11 单测 |
| ReciteHelper | primary（2026-10-07） | upstream `ArabidopsisDev/ReciteHelper` primary（2026-10-08） | 晚一天提交 |
| GalReview | main（2026-09-30） | upstream `OpenRecite/GalReview` | 需 diff 后确认 |
