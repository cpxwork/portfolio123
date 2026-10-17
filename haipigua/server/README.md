# 嗨皮瓜本机真实文本模型服务

这是可运行的本机服务，不是腾讯云已部署的后端。Node.js 20 或更高，无额外 npm 依赖；监听 `127.0.0.1:8878`。前端预览在 `127.0.0.1:8877`，由预览服务器将 `/api/health`、`/api/agent` 同源反向代理到本服务。

## 启动

在 `haipigua` 目录用 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1
```

这个交互启动脚本默认明确选择 `glm-4-flash-250414`。2026-10-17 本机联调时 `glm-4.7-flash` 返回1305模型访问量过大；同一账户对前者的小请求成功，因此演示先选择这个官方列出的免费文字模型。要选择4.7，可执行 `powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1 -ModelName glm-4.7-flash`。服务不会隐藏地自动切换型号。

按提示输入自己的智谱 API Key，输入使用 PowerShell 隐藏输入。秘密经子进程标准输入传递，保留在进程内存；不写配置文件、仓库、浏览器存储、命令行参数或日志。关闭进程后，下一次启动需重新输入。不要把真实密钥写进脚本或测试。

保持服务终端开启，再从共同仓库根目录在第二个终端执行 `node haipigua/preview.cjs`，打开 `http://127.0.0.1:8877/#chat`。前端健康状态只说明服务配置存在；发送成功才说明那次模型调用可用。

自动化启动可直接运行 `node server/run-local.cjs`，通过管道或进程工具的标准输入发送一行 JSON：`{"MODEL_API_KEY":"自己的秘密","MODEL_NAME":"glm-4-flash-250414"}`。不要把真实 JSON 放进终端历史。也支持父进程安全注入的 `MODEL_API_KEY` 环境变量；此路径请同时明确注入 `MODEL_NAME=glm-4-flash-250414`，避免落回程序默认的4.7。

服务只允许官方列出的两个免费文字模型：`glm-4.7-flash`、`glm-4-flash-250414`。`run-local.cjs` 没有指定型号时仍默认4.7；更换时由启动配置明确指定 `MODEL_NAME`。地址固定 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，拒绝其他模型和自定义地址。未配置、额度用完、模型异常都明确返回错误，不自动改为付费模型，也不偷偷运行本地规则充当模型结果。[智谱官方模型列表](https://docs.bigmodel.cn/cn/guide/start/model-overview)

## 接口

`GET /api/health` 返回 `{ready,model,mode,capabilities,version}`。文字能力取决于配置，视频理解、联网检索、账号云记忆、真实积分账本均为 `false`。健康检查不验证账户额度，实际调用才确认上游可用性；不返回密钥、密钥片段或内部配置。

`POST /api/agent`，兼容 `/api/turn` 和 `/turn`：

```json
{
  "requestId": "浏览器生成的唯一UUID",
  "text": "我只练了五分钟，有点难",
  "today": "2026-10-17",
  "clockMinutes": 720,
  "now": "2026-10-17T04:00:00Z",
  "context": {
    "ideas": [], "tasks": [], "feedback": [], "availability": {},
    "notes": [], "chatContext": {},
    "confirmedFacts": [{"text": "用户明确确认的背景或偏好"}],
    "studio": {"preference": {"duration": 10, "energy": "low", "level": "beginner"}}
  }
}
```

`today` 和 `clockMinutes` 必须由前端按 `Asia/Shanghai` 计算。`text` 完整保留，1–8000 个 JavaScript 字符，HTTP 请求上限128KiB。上下文只取白名单字段并有条数/长度限制；已有 `ideas[].aiPlan` 与 `ideas[].exploration` 只保留有限的标题、步骤、标准和下一步等文字，不包含资源链接、媒体、秘密或额外属性。密钥、用户未同意上传的媒体不应进入此接口。

成功：`{source:"model",analysis:{intents,clarification?,understanding?},content:{plans,explorations,reflections},trace,usage,requestId}`。沿用前端 PocketFlow 可校验的 intents 格式。`understanding` 包含可纠正的 `goal`、`facts`、`constraints`、`unknowns`；facts/constraints 必须附 `evidence`，服务端只保留逐字匹配本次原话、近期原话或用户确认事实的证据片段。证据匹配证明原话存在，不代表模型的概括绝对正确；不要直接自动写为确认记忆。

Agent 1 独立调用模型理解/分流，再执行真实只读历史提取、确定性撞期检查；有相关任务时再并行调用 Agent 2 计划、Agent 3 创意实验、Agent 4 反馈。没有涉及的角色不调用、不伪造 trace。每次最多4次模型调用，资源只给标明来源的固定安全入口，不声称本次搜过网页。文本模型不看视频。

路由包含独立的 `plan` 意图，结构为 `{kind:"plan",ideaId?,newIdeaKey?,data:{canApply,duration?,energy?,level?,goal?}}`。必须明确关联已有兴趣，或同轮先创建的 `newIdeaKey`；不允许附带 `taskId/date/start/end/replaceTaskId`。`plan` 不要求预约日期时间：技能目标生成 `content.plans`，创意目标生成 `content.explorations`。前端只更新建议并保存本条 `note.advice` 快照，本轮预算不写长期偏好，不新增/修改旧任务或陪伴约定，不清除已有待改期问题。后续建议更新不改变旧消息快照；旧版无快照的模型消息只呈现自己的已保存回复。缺少合格专职模型内容则整轮拒绝，不使用本地模板补成模型输出。

Agent 1 的模型请求提供可选 `route_intents` function tool，使用 `tool_choice:"auto"`；服务也接收并校验模型直接返回的 JSON。`trace.format` 区分 `function_arguments` 与 JSON 输出。当前真实回归记录为 JSON 输出，提供 tools 配置不等于实际发生或验证了原生函数调用。

当“只改建议”的原话还包含时间范围而首次路由未给出忙碌等时间操作时，服务可另请 Agent 1 复核遗漏信息。该复核明确使用 `response_format:{type:"json_object"}`，不提供 tools；它不是一次已验证的原生工具调用。代码只触发复核，忙碌事实仍由模型提取并经校验；复核只允许补 busy/note，不能改建议、创建兴趣或预约。确定的实验/课程时段与“不预约学习”可并存；假设、未确定或明确不记录的时段不应保存。复核计入同一轮4次调用、95秒总预算，不另开隐藏预算。

反馈表单额外发送 `reportedFeedback:{taskId,completion,minutes,feeling,reason}`。服务端直接验证这些人填写的事实，只调用反馈模型给建议，不让模型重新抽取或改写完成情况。自然语言反馈仍由Agent 1理解。日期工具以用户的 `today` 校正无歧义的单个“明天/后天”等相对日，不以UTC的 `now` 充当本地今天。

每整轮最多一次结构修复，仅针对路由表示错误或反馈核心字段格式错误，仍使用同一个免费模型、完整重验并计入4次总调用。未知ID、无效日期、鉴权与容量错误不启动修复；失败不写入。无法识别的机器人表情仅改成中性姿态，不编造反馈正文。`trace/usage`也记录失败和修复；不是模型内部思考。

就业目标可以保存并生成准备性步骤，无明确日期、开始时间及行动时长时不会生成日程。不因理科背景默认编程、不将比赛报名当成实习履历。已有反馈及其 `nextAdjustment` 会连同对应任务传给下一次规划模型，不能把建议说成已经学会或已经完成。

本服务不存用户领域数据，不直接创建任务。前端应校验后原子应用成功响应，并以 `requestId` 去重；失败不应用部分结果。重试同一个 `requestId` 和同一请求体可复用10分钟内的内存结果/正在处理的请求；同编号不同请求体返回409。所有成功与失败均缓存，因此要主动重新调用模型时使用新编号。服务器重启清空缓存，前端自己的已应用编号去重仍需要保留。

错误：`{error:{code,message,stage?,formatIssue?,providerStatus?,providerCode?},trace?,usage?,requestId?}`。包括未配置503、结构化结果或引用无效502、超时504、撞期或信息不足的成功澄清、限流429、同编号不同内容409。安全诊断只保留固定字段名、角色、数字业务码和HTTP状态；1305映射`MODEL_OVERLOADED`（模型访问过大），1113映射`MODEL_QUOTA`（账户余额不足），1000映射`MODEL_AUTH`（鉴权失败）。不能把1305说成密钥错误或要求充值。绝不返回上游错误原文或请求头。[智谱官方错误码](https://docs.bigmodel.cn/cn/api/api-code)

## 本机边界与预算

只允许前端 `http://127.0.0.1:8877`、`http://localhost:8877` 及本服务8878的精确 Origin；Host 也必须是本机服务端口。不要求把共享口令塞进浏览器。主线程反向代理必须转发真实浏览器 Origin，不能自行补造缺失的 Origin；发送到8878时使用其本机 Host。

一次只处理一段对话，同编号重试可共享进行中的请求；每分钟12段，每次启动最多60段，不自动重发整个请求。普通角色调用、信息覆盖复核和至多一次结构修复共享整轮最多4次调用、95秒；单次普通模型调用上限45秒，结构修复最多20秒且受剩余总预算限制。没有进程在响应之后继续发起新角色调用。内部缓存至多64项，10分钟过期。重启不是绕过模型账户额度的承诺。

此简化服务只用于用户自己机器上的演示。不能把8878监听改成公网直接发布；公网部署需增加账号鉴权、配额及持久化隔离，并重新确认部署方式。

## 验证

```powershell
node --test --test-isolation=none tests/server-local.test.cjs
```

33项 mock/本机HTTP检查涵盖：两个免费型号可明确选择、收费及其他型号拒绝、无秘密泄露、1305/1113/1000准确分类、精确来源和Host、8000字原话、证据引用过滤、求职目标不造日程、本地日期、撞期澄清、空引用规范化、无效ID/日期、反馈传入下一轮、一轮有界修复、表单事实保护、中性表情兼容、并发/重试去重、上游失败/超时、请求和调用限制，以及建议意图、旧建议白名单和忙碌信息复核等合同。这些测试不调用智谱，不代表真实账号额度或输出质量已验证。

在 `haipigua` 目录运行全部离线回归：

```powershell
node --test --test-isolation=none tests/*.test.cjs
```

当前85项通过：前端52（本地流程27、模型桥11、客户端11、消息渲染3）、本机服务33。真实调用另用 `node scripts/evaluate-live.cjs --case route`、基础四轮 `node scripts/evaluate-live.cjs` 或固定合成上下文的五种对话 `node scripts/evaluate-conversations.cjs`；运行期间暂停浏览器发送。脚本和判定规则见 `../scripts/README.md`。

2026-10-17当前版本基础四轮再次全部通过，使用 `glm-4-flash-250414` 共8次真实调用（分流3、反馈2、下一步2、歧义1）。本轮原先失败的“只改建议”“完整忙碌时段”“继续创意”三条已连续复跑通过；覆盖复核改为严格 JSON 输出后，含加强版假设忙碌与混合真实忙碌的五种固定样例5/5通过。浏览器另以2次真实调用生成“撰写嗨皮瓜项目卡”建议，没有新增预约，行动约定仍为原有1项。失败历史与修复状态见 `../LIVE_VALIDATION.md`。这些结果不能推算泛化准确率、长期稳定性或其他浏览器场景的表现。
