# 嗨皮瓜：共同开发入口

这是从腾讯云当前线上版本建立的共同开发目录。2026年10月16日首次导入的 `web/` 内11个文件，来自腾讯云 `haipigua/` 目录，经逐一校验一致。

当前线上网站：[打开嗨皮瓜](https://frost-guard-d3gw4cry5916d32c4-1503361620.tcloudbaseapp.com/haipigua/)。公开站仍是旧静态版，Git push 不会自动部署。

## 成品启动：一个进程同时提供页面和 API

这是给最终用户/演示用的运行方式，不需要分别启动 8877 预览和 8878 后端：

```powershell
cd haipigua
Copy-Item .env.example .env
# 编辑 .env，至少填 MODEL_PROVIDER、MODEL_API_KEY、MODEL_NAME
npm start
```

然后打开 `http://127.0.0.1:8877/`。页面和 `/api/health`、`/api/agent` 同源；密钥只在 Node 进程里，`.env` 已被 Git 忽略。没有 `npm` 也可以直接运行：

```powershell
node server/app.cjs
```

先做不花钱的配置检查：

```powershell
npm run verify
```

确认补贴到账后，做一次最少量真实调用（需要显式确认）：

```powershell
$env:CONFIRM_LIVE="1"; node scripts/verify-product.cjs --live
```

真实调用会记录到 `.local/product-verification.json`，包含平台、型号、调用次数、token 和本机估算费用；不会包含密钥。完整配置、公网边界和 Docker 见 [PRODUCT.md](PRODUCT.md)。

## 开发时只看前端

在共同仓库根目录运行（建议统一使用 Node.js 20+，无第三方依赖）：

```bash
node haipigua/preview.cjs
```

然后打开终端显示的网址，默认 http://127.0.0.1:8877/ 。修改 `haipigua/web/` 后刷新网页，即可查看修改。这个预览只在启动它的电脑上运行；同伴可下载对应分支，使用同样命令预览。开发模式仍可把 `/api/health`、`/api/agent` 转发到本机 8878 的独立服务。

GitHub 文件页面展示源码；本机预览或腾讯云网址展示真正可操作的网页。预览中的浏览器记录与腾讯云网站各自独立。

## 目录与边界

- `web/`：原生 HTML、CSS、JavaScript 前端，可以直接编辑，无需 npm 安装或构建。
- `server/app.cjs`：成品单进程服务，直接提供 `web/` 页面和同源 `/api/health`、`/api/agent`；密钥从服务端环境/`.env` 读取。
- `preview.cjs`：开发用本机前端预览，可把 `/api/health`、`/api/agent` 转发给本机8878服务；它自己不持有密钥、不调用模型。
- `server/`：本机文本模型服务与 provider/review 合同，启动方法见下文；`server/app.cjs` 是成品入口。
- `PRODUCT.md`：成品配置、验证、Docker 与公网部署边界。
- `COLLABORATION.md`：前后端分工、提交与联调约定。

2026年10月17日的前端升级使用 `index.html`、`studio.js`、`studio-core.js`、`studio.css` 和四张机器人 WebP。旧 `app.js` 与样式保留作历史参考，不再由页面加载。无需 npm 安装或构建。

- `DEMO_GUIDE.md`：打开网站、三分钟演示顺序、赛事资料和奖励模式判断。
- `BACKEND_HANDOFF.md`：同伴当前提交情况、真实模型/视频/记忆/积分接口待办。
- `DESIGN.md`：四角色素材和生成规格。
- `tests/`：108项离线回归检查：前端与消息渲染、本机服务、review 闭环、AI Ping 配置与错误映射；不调用外网。
- `scripts/README.md`：真实模型的基础闭环与5种固定合成对话评测；与离线测试分开运行。

温和、奖励、督促三种陪伴方式已可选择；督促按天、自愿，可立即退出。成长值仅为自报生成的演示待核验记录，不能抵现或抵扣费用。视频只在本机保存回看，未接入 AI 分析。

现已加入可运行的本机文本模型服务：`server/` 可显式选择 AI Ping 或智谱，前端通过 `/api/agent` 同源代理发送原话与近期相关上下文。皮皮先理解/分流，再按需独立调用滴答、啵啵或回回；模型结果经过结构、证据、时间和关联校验后原子写入。每条模型记录可以展开实际调用轨迹。失败保留草稿，不自动改成本地规则冒充成功。仓库不保存密钥或真实浏览器记录。

“只改建议，不预约”使用独立的 `plan` 意图：更新已有兴趣的学习建议或创意实验，本次时长、精力、基础和目标仅约束这一轮，不改长期偏好、旧任务、陪伴约定或已有待改期问题。完整的忙碌事实仍可单独保存；假设或尚未确定的时段不应保存。新建议按消息保存独立快照，后续修改不会覆盖旧消息；旧版没有快照的模型消息只显示当时保存的回复。发给模型的旧建议只保留有限的文字白名单，不带资源链接、媒体或额外元数据。

回回的 `review` 支持未预约练习、补充反馈、文字/作品评价和回答追问；它不要求 taskId、不改任务完成状态、不凭空补分钟数。服务端按标题、当前追问、最近主题和唯一候选确定兴趣；两个相近兴趣无法区分时只问一次，不硬绑旧任务。只有有逐字依据的进展/卡点才进入分析；只有时长没有内容、明确没有作品时会追问而不评分。信息足够时，回回在同一轮实际调用滴答或啵啵生成针对性建议，仍然只更新建议、不预约；失败整轮回退。记录保存在浏览器 `reviews`，可撤销，并作为下一轮上下文。

Agent 1 主路由请求可选的 `route_intents` 工具参数，也兼容模型直接返回 JSON；当前真实回归记录采用 JSON 输出，不能据此宣称已经验证原生函数调用。建议旁出现时间段时可能额外调用 Agent 1 复核是否遗漏忙碌事实；此复核明确使用 JSON mode，不提供 tools。复核、结构修复和各角色共享整轮最多4次调用、95秒预算。

## 使用真实模型

需要 Node.js 20+，不需要安装 npm 依赖。从共同仓库根目录打开两个 PowerShell 终端。

终端一启动模型服务，并按隐藏输入提示粘贴自己的 AI Ping 或智谱 API Key：

```powershell
powershell -ExecutionPolicy Bypass -File .\haipigua\server\start-local.ps1
```

脚本现在默认明确选择 AI Ping 与 `GLM-4.7-Flash`；平台、地址和型号必须同时明确设置，换 Key 不会切换平台。也可显式选择：

```powershell
powershell -ExecutionPolicy Bypass -File .\haipigua\server\start-local.ps1 -Provider aiping -ModelName GLM-5.3-Flash -BudgetCny 2
powershell -ExecutionPolicy Bypass -File .\haipigua\server\start-local.ps1 -Provider zhipu -ModelName glm-4-flash-250414
```

AI Ping 的聊天地址是 `https://aiping.cn/api/v1/chat/completions`，型号 ID 区分大小写；智谱保留原免费型号。服务只允许 `server/providers.cjs` 列出的型号，不自动切换或使用更贵型号。`-BudgetCny` 是本进程的保守估算停止线，不是平台硬限额；请同时在 AI Ping 控制台给 Key 设置固定额度。

终端二启动前端：

```powershell
node haipigua/preview.cjs
```

保持两个终端开启，打开 `http://127.0.0.1:8877/#chat`。页面显示实际平台、型号、价格与本机估算预算；只有发送成功才说明该次真实调用成功。健康检查不验证账户额度或模型当前容量。密钥只留在服务进程内存，重启后需要重新输入；不要把密钥放进网页输入框、代码或提交。

完整接口、review 合同、故障分类与边界见 `server/README.md`。这不是公网后端，腾讯云静态站不能直接访问你电脑的8878端口。公网发布仍需服务端鉴权、配额与部署。

离线测试（不调用外网），在共同仓库根目录运行：

```powershell
node --test --test-isolation=none haipigua/tests/*.test.cjs
```

当前108项通过。真实模型可用性和理解质量另行检查：先暂停浏览器里的模型发送，再运行 `node haipigua/scripts/evaluate-live.cjs --case route`；完整四轮去掉 `--case route`。2026-10-17当前版本基础四轮再次全部通过，共8次模型调用（3/2/2/1）：学习/创意分流、反馈保存、下一步根据反馈缩短、模糊时间追问。

另运行 `node haipigua/scripts/evaluate-conversations.cjs`，用固定2026-10-17上下文逐项检查只改建议、忙碌冲突、继续创意、假设忙碌、建议与真实忙碌并存。原来失败的前三条已连续复跑通过；完成忙碌覆盖复核的 JSON 输出修复后，当前五种固定样例5/5通过。浏览器求职场景也实际调用2次模型，生成“撰写嗨皮瓜项目卡”建议，明确没有预约，行动约定保持原有1项。任何评测失败均返回非零退出码。失败历史及修复状态见 `LIVE_VALIDATION.md`；合成结果分别保存在被 Git 忽略的 `.local/live-evaluation.json` 和 `.local/conversation-evaluation.json`，浏览器证据仅留本机。这些是有限样例的实际记录，不能推算泛化准确率或稳定性。

## 同步与发布

前端在 `frontend/haipigua` 分支持续提交，通过合并请求与 `main` 对齐。已存在的其他项目保留在仓库原目录。提交代码与更新腾讯云分别进行；本次建立开发入口不会修改现有腾讯云网站。

经团队验收需要正式发布时，将 `web/` 内静态文件部署到腾讯云的 `haipigua/` 子目录。部署路径不要选择环境根目录。
