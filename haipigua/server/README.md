# 嗨皮瓜本机真实文本模型服务

这是可运行的本机服务，不是腾讯云已部署的后端。Node.js 20 或更高，无额外 npm 依赖；监听 `127.0.0.1:8878`。前端预览在 `127.0.0.1:8877`，由预览服务器将 `/api/health`、`/api/agent` 同源反向代理到本服务。

2026-10-17 起支持显式选择两个平台：

| 平台 | 固定聊天地址 | 允许的型号（本仓库白名单） |
| --- | --- | --- |
| AI Ping | `https://aiping.cn/api/v1/chat/completions` | `GLM-4.7-Flash`（默认）、`GLM-5.3-Flash`、`Qwen3.5-Flash`、`DeepSeek-V4-Flash`、`DeepSeek-V4.1-Flash`、`Step-3.5-Flash` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4.7-flash`、`glm-4-flash-250414`（免费） |

平台、地址和型号必须同时明确；只换 Key 不会切换平台，也不允许自定义地址。AI Ping 型号 ID 区分大小写。价格快照与允许列表在 `server/providers.cjs`，实际费用以平台账单为准；本服务不会自动切到未列出的或更贵的型号。

## 启动

在 `haipigua` 目录用 PowerShell 执行。默认明确选择 AI Ping 与 `GLM-4.7-Flash`：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1
```

选择其他允许型号或平台：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1 -Provider aiping -ModelName GLM-5.3-Flash
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1 -Provider zhipu -ModelName glm-4-flash-250414
```

可选的本地保护参数（都不是平台账单硬上限）：

```powershell
# 估算消费达到 2 元后，本进程拒绝继续调用；重启会清零，必须同时看平台账单。
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1 -BudgetCny 2 -MaxTurns 20
```

按提示输入对应平台的 API Key，输入使用 PowerShell 隐藏输入。密钥经子进程标准输入传递，只留在进程内存；不写配置文件、仓库、浏览器存储、命令行参数或日志。关闭进程后，下一次启动需重新输入。不要把真实密钥写进脚本、测试或前端。

保持服务终端开启，再从共同仓库根目录在第二个终端执行 `node haipigua/preview.cjs`，打开 `http://127.0.0.1:8877/#chat`。页面会显示实际的平台、型号、价格和本机估算预算；健康状态只说明配置存在，发送成功才说明那次调用可用。

自动化启动可直接运行 `node server/run-local.cjs`，通过管道或进程工具的标准输入发送一行 JSON：

```json
{"MODEL_PROVIDER":"aiping","MODEL_API_KEY":"自己的秘密","MODEL_NAME":"GLM-4.7-Flash","MODEL_MAX_TURNS":20}
```

不要把真实 JSON 放进终端历史。也支持父进程安全注入同名环境变量；请同时明确注入 `MODEL_PROVIDER` 和 `MODEL_NAME`。AI Ping 默认用 JSON mode，不默认发送原生 tools；如确认所选上游支持工具调用，可显式设置 `MODEL_TOOLS=1`。`MODEL_JSON_MODE=0` 可关闭 `response_format`，但这会降低结构化输出的稳定性。

## 接口

`GET /api/health` 返回 `ready/provider/providerLabel/model/modelLabel/mode/capabilities/price/priceNote/budget/maxTurns/version`。`budget.estimatedSpentCny` 是按平台价格区间最高值估算的输入+输出成本，不是账单；`budget.remainingCny` 只在设置 `MODEL_BUDGET_CNY` 时出现。健康检查不验证账户余额，实际调用才确认上游可用性；不返回密钥、密钥片段或内部配置。视频理解、联网检索、账号云记忆、真实积分账本均为 `false`。

`POST /api/agent`，兼容 `/api/turn` 和 `/turn`：

```json
{
  "requestId": "浏览器生成的唯一UUID",
  "text": "今天学了十五分钟相关的，排线好难",
  "today": "2026-10-17",
  "clockMinutes": 720,
  "now": "2026-10-17T04:00:00Z",
  "context": {
    "ideas": [], "tasks": [], "feedback": [], "reviews": [], "availability": {},
    "notes": [], "chatContext": {},
    "confirmedFacts": [{"text": "用户明确确认的背景或偏好"}],
    "studio": {"preference": {"duration": 10, "energy": "low", "level": "beginner"}}
  }
}
```

`today` 和 `clockMinutes` 必须由前端按 `Asia/Shanghai` 计算。`text` 完整保留，1–8000 个 JavaScript 字符，HTTP 请求上限 128KiB。上下文只取白名单字段并有条数/长度限制；已有 `ideas[].aiPlan`、`ideas[].exploration` 和 `reviews[]` 只保留有限文字，不包含资源链接、媒体、秘密或额外属性。密钥、用户未同意上传的媒体不应进入此接口。

成功：`{source:"model",analysis:{intents,clarification?,understanding?},content:{plans,explorations,reflections,reviews},trace,usage,requestId}`。

- `analysis.intents` 沿用前端 PocketFlow 可校验的格式，新增 `review`。
- `content.plans` / `content.explorations` 是 Agent 2/3 的建议，不是任务。
- `content.reflections` 只用于已预约任务表单或明确完成情况的反馈，由本次 review 的调整字段派生。
- `content.reviews` 以 `idea.id` 为键，保存这次经历的分析。
- `trace` 记录每次真实模型调用、确定性工具和角色交接；`usage` 记录 calls/tokens/provider/model/estimatedCostCny。
- `analysis.understanding` 的 facts/constraints 必须附逐字证据；服务端只保留逐字匹配本次原话、近期原话或用户确认事实的证据。证据匹配证明原话存在，不代表概括绝对正确。

Agent 1 独立理解/分流，再执行只读历史提取和确定性撞期检查。需要时调用 Agent 2 计划、Agent 3 创意实验、Agent 4 反馈/回顾。没有涉及的角色不调用、不伪造 trace。每次最多 4 次模型调用，资源只给标明来源的固定安全入口，不声称本次搜过网页。文本模型不看视频。

## Review：回回先分析，再真实交接

`review` 用于未预约练习、补充反馈、文字/作品评价、卡点说明和回答回回追问。它不要求 taskId，不写完成状态、不写分钟数、不改预约；只有表单或明确完成情况的 `feedback` 才改任务状态。

服务端先按以下顺序确定兴趣目标，模型不能越过：

1. 原话完整出现某个兴趣标题；
2. 原话出现只属于一个兴趣的标题二字片段；
3. 正在回答的 `chatContext.pending.ideaId`；
4. 最近对话主题（`lastIdeaId` / 最近任务所属兴趣），且只有一个候选；
5. 只有一个兴趣；
6. 仍有多个相似候选时只追问一次，要求用户选 A 或 B，不猜、不硬绑旧任务。

Agent 4 输出每个目标一份：

```json
{
  "reviews": {
    "idea-id": {
      "response": "回应这次具体经历",
      "summary": "实际做了什么、结果如何",
      "progress": [{"point": "有依据的进展", "evidence": "逐字引用用户原话"}],
      "problems": [{"point": "具体卡点", "evidence": "逐字引用用户原话"}],
      "missingEvidence": ["还缺什么证据或信息"],
      "hasArtifact": false,
      "needsEvidence": true,
      "question": "只问一个最关键的问题",
      "nextStep": "一项小行动或产出",
      "durationScale": null,
      "difficulty": null,
      "emotion": "thinking",
      "advice": "为什么这样调整"
    }
  }
}
```

服务端强制：

- `progress/problems` 的 `evidence` 必须逐字出现在本次文字、表单 reason、近期用户原话或用户确认事实中；没有证据的条目拒绝整轮。
- 只有时长没有具体内容时 `needsEvidence=true`，先问具体做了什么或要一小段产出；不能凭时长判定学会、完成或水平。
- 明确没有作品时 `hasArtifact=false`、`needsEvidence=true`，不伪造评分、星级或水平；必须说明还缺什么证据。
- 表单总体“轻松”与文字“排线好难”同时出现时，`progress` 和 `problems` 都必须保留；不能用选项盖过文字，也不能断言没看到的手法/音准。
- 文字作品可以评价文字本身：引用具体词句、指出缺失的上下文/完整段落/目标读者；不能凭一句断言整体水平。
- 信息足够时 `needsEvidence=false`，`nextStep` 必须具体；服务端随后在同一轮实际调用 Agent 2 或 Agent 3，生成 `content.plans` / `content.explorations`，并追加一个只更新建议的 `plan` 意图。**不会创建任务、预约或改期。**
- 信息不足时只返回 review 和问题；下一轮原话会带上 `chatContext.pending` 与 `context.reviews`，绑定同一个兴趣继续，不重复已回答的问题。
- 已反馈任务的补充、已预约但未明确完成情况的反馈，会转成 review；任务状态和旧反馈不变。
- 服务端不直接写浏览器状态；前端校验后原子应用，失败整轮回退，原话保留。

表单额外发送 `reportedFeedback:{taskId,completion,minutes,feeling,reason}` 或 `reportedReview:{ideaId,completion?,minutes?,feeling?,reason}`。服务端直接验证这些人填写的事实；`reportedReview` 不改任务，`reportedFeedback` 记录完成情况和反馈，同时仍调用回回分析并尝试同轮交接。未填写的时长保持 `null`，不补 0、不补计划时长。

## 路由与建议边界

路由包含独立 `plan` 意图：更新已有兴趣的建议，不预约、不改旧任务。`review` 交接产生的也是这种 `plan` 意图。`plan` 不允许 `taskId/date/start/end/replaceTaskId`；本轮 duration/energy/level/goal 不写长期偏好。前端只更新 `aiPlan`/`exploration` 并保存本条 `note.advice` 快照，旧消息按自身快照显示。旧建议进入 context 前只取有限文字白名单，不带资源链接、媒体或额外属性。

Agent 1 的模型请求在允许 tools 时提供可选 `route_intents` function tool，使用 `tool_choice:"auto"`；否则使用 JSON mode。服务也接收并校验模型直接返回的 JSON。`trace.format` 区分 `function_arguments` 与 JSON 输出；提供 tools 配置不等于实际发生或验证了原生函数调用。

“只改建议”的原话还包含时间范围而首次路由未给出忙碌等时间操作时，服务可另请 Agent 1 复核遗漏信息。该复核明确使用 JSON mode、不提供 tools；只允许补 busy/note，不能改建议、创建兴趣或预约。复核计入同一轮 4 次调用、95 秒总预算。

## 错误、预算与限流

错误：`{error:{code,message,stage?,formatIssue?,providerStatus?,providerCode?},trace?,usage?,requestId?}`。绝不返回上游错误原文或请求头。

AI Ping HTTP 映射：`401/403 → MODEL_AUTH`、`402 → MODEL_QUOTA`、`404 → MODEL_NOT_FOUND`（核对型号 ID 大小写）、`413 → MODEL_INPUT_TOO_LARGE`、`422 → MODEL_PARAMETERS`、`429 → MODEL_RATE_LIMIT`、`503 → MODEL_OVERLOADED`，其余 5xx → `MODEL_UNAVAILABLE`。智谱业务码仍保留：`1305 → MODEL_OVERLOADED`、`1113 → MODEL_QUOTA`、`1000 → MODEL_AUTH`。不能把 1305 说成密钥错误或要求充值。

预算：每轮最多 4 次模型调用、95 秒；单次普通调用最多 45 秒；结构修复最多一次、最多 20 秒且受剩余预算限制；每次启动默认最多 60 段对话，可由 `MODEL_MAX_TURNS` 降低。`MODEL_BUDGET_CNY` 是本进程的保守估算停止线，使用价格区间最高值计算；不是平台硬限额，重启清零，必须同时看平台账单和 Key 额度。建议在 AI Ping 创建 Key 时设置固定额度。不要在验证时开多个并行代理或循环跑大量模型。

服务只允许前端 `http://127.0.0.1:8877`、`http://localhost:8877` 及本服务 8878 的精确 Origin；Host 也必须是本机服务端口。不要求把共享口令塞进浏览器。主线程反向代理必须转发真实浏览器 Origin，不能自行补造缺失的 Origin；发送到 8878 时使用其本机 Host。一次只处理一段对话；每分钟 12 段；同编号重试可复用 10 分钟内结果，同编号不同请求体返回 409。内部缓存至多 64 项。服务器重启清空缓存和预算估算，前端自己的已应用编号去重仍需要保留。

此简化服务只用于用户自己机器上的演示。不能把 8878 监听改成公网直接发布；公网部署需增加账号鉴权、配额、持久化隔离和独立预算，并重新确认部署方式。腾讯云静态站不能直接访问你电脑的 8878 端口。

## 验证

```powershell
node --test --test-isolation=none haipigua/tests/*.test.cjs
```

当前 106 项离线检查通过，覆盖：两个平台与型号白名单、AI Ping 地址/JSON mode/错误映射/预算、健康状态不泄露密钥、review 目标解析与相近兴趣追问、逐字证据、时长-only 追问、表单“轻松+排线难”、补充反馈不改旧任务、同轮 handoff、失败原子回退、前端持久化/撤销/上下文/渲染，以及原有路由、预约、撞期、修复和限流合同。这些测试不调用真实平台，不代表真实账号额度或输出质量已验证。

真实调用另用：

```powershell
node haipigua/scripts/evaluate-live.cjs --case route
node haipigua/scripts/evaluate-live.cjs
node haipigua/scripts/evaluate-conversations.cjs
```

运行期间暂停浏览器发送。脚本和判定规则见 `../scripts/README.md`。真实结果保存在被 Git 忽略的 `.local/`；记录真实型号、调用次数、可用时费用和未通过项。任何评测失败均返回非零退出码。有限样例不能推算泛化准确率或长期稳定性。
