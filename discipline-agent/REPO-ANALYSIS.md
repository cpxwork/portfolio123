# ClassTechStar 仓库群分析（进行中）

> 2026-10-16 启动。5 个子代理并行分析，本文件由 Lead 汇总。
> **License 因素已排除**：用户（作者）确认同意使用全部仓库，无需考虑许可证限制。

## 0. 已核实元数据（Lead 亲自拉取，非子代理转述）

| 仓库 | 语言 | 体积 | 默认分支 | 最近推送 | Stars/Forks | 开放 Issue | 归档 |
|---|---|---|---|---|---|---|---|
| `-Knowledge-Debt-Astral-Path` | HTML | 37 MB | main | 2026-10-15 | 1 / 0 | 0 | 否 |
| `ReciteHelper` | C# | 187 MB | primary | 2026-10-07 | 0 / 0 | 0 | 否 |
| `GalReview` | C# | 60 MB | main | 2026-09-30 | 0 / 0 | 0 | 否 |
| `Notehelper` | JavaScript | 6.6 MB | main | 2026-09-29 | 0 / 0 | 0 | 否 |
| `Reciting-us` | 未识别 | 13 MB | main | 2026-08-06 | 1 / 0 | 0 | 否 |

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

### 2.2 仓库 → 环节映射（初判，待子代理验证）

（待汇总）

## 3. 行动建议

（待汇总）
