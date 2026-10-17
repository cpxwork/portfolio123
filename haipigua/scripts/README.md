# 真实本机模型小评测

先启动前端 `127.0.0.1:8877` 和已配置模型的本机后端 `127.0.0.1:8878`。需要 Node.js 20+，无需 npm 依赖。在 `haipigua` 目录用两个 PowerShell 终端分别执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1
```

```powershell
node preview.cjs
```

第一个终端会隐藏输入 API Key。2026-10-17 起启动器默认明确选择 AI Ping 与 `GLM-4.7-Flash`；也可用 `-Provider zhipu -ModelName glm-4-flash-250414` 回到智谱免费型号。AI Ping 会按 token 计费，先用 `-BudgetCny` 设置本进程估算停止线，并在平台给 Key 设置固定额度。服务只允许 `server/providers.cjs` 列出的型号，不会自动切换。密钥留在服务进程内存，评测脚本无需密钥。

保持上述终端开启。在第三个终端运行评测，并暂停浏览器里的模型请求，避免单并发服务互相占用。健康检查已配置不等于真实请求一定成功。

在 `haipigua` 目录使用 Node.js 20 或更高版本：

```powershell
node scripts/evaluate-live.cjs --case route
```

上面只检查同段陶笛学习与校园换书创意的真实自动分流。完整四轮：

```powershell
node scripts/evaluate-live.cjs
```

脚本只调用已启动的本机 `/api/agent`，不读取或要求 API Key，不使用 mock，不访问浏览器存储。所有输入和内存用户记录都是合成案例。前三轮共用同一份内存状态，测试分流、实际反馈、下一步缩短；第四轮用空白上下文测试“那十二点”是否追问，避免已有任务日期被合理继承。

每轮最多等待 110 秒，串行调用，失败不自动重试。服务内部单个模型调用上限45秒、整轮95秒，因此可能更早返回超时。标准输出显示 `case / success / modelCalls / why`，最后显示结果路径。完整合成请求、响应、检查和最终状态写入 `.local/live-evaluation.json`；`.gitignore` 已忽略 `.local/`，不要将其他真实用户记录复制进评测结果。任务或反馈缺失时后续依赖检查标记 `skipped`，不创建假的替代数据，也不算通过。任何检查失败或跳过，进程退出码为 `1`；全部通过才为 `0`。

结果证明的是这次真实调用的表现，不代表模型每次都能成功；网络错误、模型拒绝、容量不足和格式错误会原样体现为失败，不会切换成本地规则冒充成功。

2026-10-17此前版本两次完整运行四轮全部通过，每次8次真实模型调用；当时最后一次约耗时10.6秒、6.5秒、7.0秒、1.1秒。当前版本完成plan与覆盖复核修改后，又真实复跑四轮全部通过，调用数仍为分流3、反馈2、下一步2、歧义1，共8次。完整检查见 `../LIVE_VALIDATION.md`。此前出现的格式、日期、引用及表情兼容失败也有记录；不把合成样例通过扩写成稳定成功率。

## 固定五种日常对话

```powershell
node scripts/evaluate-conversations.cjs
```

该脚本使用 `fixtures/conversation-context.json` 的固定合成兴趣、旧计划、任务和对话记录，每条样例独立载入同一份夹具。夹具的本地今天固定为2026-10-17，因此“明天”固定指2026-10-18，不随运行机器当天变化。它不读取浏览器存储或 API Key，经已启动的8877前端代理调用真实模型，不使用 mock，也不自动重试整轮请求。

| 样例名 | 验收重点 |
|---|---|
| `suggest-without-appointment` | 已有学习兴趣只改10分钟建议；实际调用规划员、更新 aiPlan 并保存消息快照，不改旧任务/长期偏好，不追问预约日期 |
| `new-busy-conflict` | 明确的12:00–13:00实验保存为忙碌；与旧任务冲突时追问，不静默改期 |
| `continue-creative` | 沿用校园换书兴趣，10分钟验证需求；实际调用创意模型，不重复创建兴趣 |
| `hypothetical-busy` | 生成5分钟学习建议；“如果有实验、尚未确定、先别记”的时段不写忙碌，不改旧约定 |
| `mixed-advice-and-busy` | 生成5分钟建议，同时保存另一个已确定的14:00–15:00实验时段；不修改原预约 |

`plan` 的 duration/energy/level/goal 只约束本轮建议，不改长期偏好；新消息保存独立 `note.advice` 快照，后续建议不会覆盖旧消息。旧建议进入模型上下文前仅取有限文字白名单，不带资源链接、媒体或额外属性。任一模型内容缺失或不合格，原子应用失败，不用本地模板补齐。

每条请求最多等待110秒，串行执行；服务内所有角色、覆盖复核和至多一次结构修复共享4次调用、95秒总预算。输出包含 `name/success/checks/error/calls/clarification`；完整合成请求结果和最终状态写入被忽略的 `.local/conversation-evaluation.json`。检查失败或请求异常时 `success:false`，脚本最终退出码为 `1`；五条全部通过才为 `0`。这不是离线测试命令，会使用本机服务配置的真实模型。

2026-10-17原来失败的前三种说法连续复跑通过。新增混合场景起初遗漏忙碌事实；加入模型覆盖复核后修复。加强后的假设忙碌复核又出现 `MODEL_FORMAT`；将该复核明确约束为严格 JSON、使用 JSON mode 且不带 tools 后，最新五种固定样例5/5通过。当前主路由实际记录也采用 JSON 输出；可选 tools 配置不能证明原生函数调用已经发生。当前版本另通过基础四轮及一次浏览器求职建议验证：2次真实模型调用生成项目卡建议，未新增预约，原有行动约定仍为1项。失败历史保留，详见 `../LIVE_VALIDATION.md`。固定样例通过不能推算其他表达的准确率或长期稳定性。以上数字是接入 AI Ping 之前的智谱基线；AI Ping 账户需重新跑并单独记录型号与费用。

## Review 真实样例

```powershell
node scripts/evaluate-review.cjs
```

使用合成兴趣、任务和原话，经本机 `/api/agent` 串行调用真实模型，检查五件事：未预约练习是否保存 review 并同轮交接；只有15分钟没有内容是否追问且不伪造完成；表单“轻松”加文字“排线难”是否两条都保留；两个相近兴趣是否只问一次且不误绑；明确没作品时是否不评分。结果写入被忽略的 `.local/review-evaluation.json`，标准输出含 `case/success/checks/modelCalls/provider/model/estimatedCostCny/error`。任一检查或请求失败退出码为 `1`。真实模型输出有随机性，失败原样保留，不用 mock 或本地模板补成通过。

离线回归使用 `node --test --test-isolation=none tests/*.test.cjs`，当前106项通过。这组测试使用 mock/本机 HTTP，不调用任何真实平台；它证明状态与边界检查，不替代真实模型评测。
