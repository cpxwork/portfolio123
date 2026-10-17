# 嗨皮瓜成品运行说明

`server/app.cjs` 是成品入口：一个 Node 进程同时提供 `web/` 页面和同源 `/api/health`、`/api/agent`。不需要再分别启动 8877 预览和 8878 后端，也不需要 npm 依赖。

## 1. 配置

在 `haipigua` 目录：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写：

```dotenv
MODEL_PROVIDER=aiping
MODEL_API_KEY=你的密钥
MODEL_NAME=GLM-4.7-Flash
```

`.env` 已被 `.gitignore` 忽略，不会提交。密钥只在 Node 进程内存中使用，不进入浏览器、URL、日志或 Git。不要把 `.env` 发给别人。

可用变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL_PROVIDER` | `aiping`（成品脚本）；`zhipu`（仅旧兼容） | `aiping` 或 `zhipu` |
| `MODEL_API_KEY` | 空 | 必填；只放服务端 |
| `MODEL_NAME` | `GLM-4.7-Flash` / 智谱 `glm-4.7-flash` | 必须在 `server/providers.cjs` 白名单内 |
| `MODEL_BUDGET_CNY` | 空 | 本进程估算停止线；不是平台硬限额 |
| `MODEL_MAX_TURNS` | `60` | 每次启动最多对话段数 |
| `MODEL_TOOLS` | 不设置 | AI Ping 默认不发原生 tools；确认上游支持后可设 `1` |
| `MODEL_JSON_MODE` | 开启 | 设 `0` 关闭 `response_format`，结构化稳定性会下降 |
| `PORT` | `8877` | 成品服务端口 |
| `HOST` | `127.0.0.1` | 默认只本机可访问 |
| `APP_ORIGIN` | 空 | 公网反代后的精确浏览器 Origin，如 `https://haipigua.example.com` |
| `ALLOW_PUBLIC` | `0` | 非 loopback 监听必须显式设 `1`，并自行加反代鉴权 |

## 2. 启动

```powershell
cd haipigua
npm start
```

没有 npm 时：

```powershell
node server/app.cjs
```

打开 `http://127.0.0.1:8877/`。页面会显示实际平台、型号、价格和估算预算；只有发送成功并出现真实调用记录，才说明那一次模型调用成功。

## 3. 验证“能调用 API”

先做免费的健康检查：

```powershell
npm run verify
```

它只请求 `/api/health`，不调用模型、不花钱。输出会显示 `ready/provider/model/price/budget`。

确认 AI Ping 补贴到账后，做一次最小真实调用：

```powershell
$env:CONFIRM_LIVE="1"
node scripts/verify-product.cjs --live
```

这会用合成上下文发一段 review 请求，检查：真实模型来源、回回分析、逐字证据、同轮交接、没有服务端预约。结果写入 `.local/product-verification.json`，包含：

- 真实平台与型号
- 实际调用次数
- input/output tokens
- 本机估算费用 `estimatedCostCny`（不是平台账单）
- 未通过项和完整 trace

没有 `CONFIRM_LIVE=1` 时脚本不会发真实请求。不要在验证时开多个并行代理或循环跑大量模型。

## 4. 它实际调用了什么

浏览器 → 同源 `POST /api/agent` → `server/app.cjs` → `server/agent.cjs` → `server/providers.cjs` → AI Ping：

- 固定聊天地址：`https://aiping.cn/api/v1/chat/completions`
- Header：`Authorization: Bearer <服务端 .env 中的 Key>`
- 默认 JSON mode；Agent 1 需要工具能力时可按配置使用 `route_intents`
- 每轮最多 4 次模型调用、95 秒；单次最多 45 秒；结构修复最多一次
- 每次启动默认最多 60 段对话；每分钟 12 段
- 失败返回稳定错误码，不返回上游原文或请求头

## 5. 本地、公网与腾讯云

默认 `HOST=127.0.0.1`，只给本机使用。成品服务没有内置多用户账号系统；不要直接把 8877/8878 暴露到公网，否则别人可以消耗你的模型额度。

如果要公网：

1. 保持 Node 服务在私有网络/本机，前置带登录、TLS、请求限额的反向代理。
2. 设置精确的 `APP_ORIGIN=https://你的域名`，并设置 `ALLOW_PUBLIC=1`（仅当必须让 Node 监听非 loopback）。
3. 在 AI Ping 控制台给 Key 设置固定额度；`MODEL_BUDGET_CNY` 只是本进程估算，重启会清零。
4. 不要把静态站和 API 混为一谈：腾讯云当前公开站是静态托管，不能直接运行 Node 的 8877/8878。需要另选支持 Node/容器的运行环境，或把后端部署到独立服务。

## 6. Docker

在 `haipigua` 目录：

```powershell
docker build -t haipigua .
docker run --rm -p 8877:8877 --env-file .env -e HOST=0.0.0.0 haipigua
```

容器内默认监听 `0.0.0.0`，但 `.env` 里的 `HOST=127.0.0.1` 会覆盖镜像默认值，所以上面的 `-e HOST=0.0.0.0` 不能省。Dockerfile 设了 `ALLOW_PUBLIC=1`。这只适合本机/受控内网；公网仍必须加反代鉴权与 TLS。

## 7. 常见错误

| 页面/错误 | 含义 | 处理 |
| --- | --- | --- |
| `MODEL_AUTH` / 401 | 密钥或权限不对 | 检查 `.env` 的 Key 所属账户与型号权限 |
| `MODEL_QUOTA` / 402 | 付费模型余额不足 | 检查 AI Ping 余额/Key 额度；不会自动换型号 |
| `MODEL_NOT_FOUND` / 404 | 型号 ID 不对 | 对照平台列表，注意大小写 |
| `MODEL_PARAMETERS` / 422 | 型号不支持该参数 | 检查 `MODEL_JSON_MODE`、`MODEL_TOOLS`、max tokens |
| `MODEL_RATE_LIMIT` / 429 | 平台限流 | 稍后重试，不要并发轰炸 |
| `MODEL_OVERLOADED` / 503 | 平台繁忙 | 稍后重试或换允许的型号 |
| `BUDGET_EXCEEDED` | 本进程估算预算到线 | 核对平台账单后再调高/重启 |
| `SESSION_BUDGET` | 本次启动段数到线 | 确认额度后重启服务 |
| `HOST_DENIED` / `ORIGIN_DENIED` | 访问来源未配置 | 用本机地址或正确设置 `APP_ORIGIN` |

## 8. 数据与已知边界

- 文字记录保存在浏览器 `localStorage`；服务端不存用户领域数据。
- 视频只本机 IndexedDB 回看；当前文本模型不看视频，不能生成视频点评。
- 成长值是本地演示待核验记录，不抵现、不能抵扣模型费用。
- 没有跨设备账号记忆、真实积分账本、公网多用户鉴权。
- 108 项离线测试证明协议、边界和本机 HTTP 路径；它们不证明 AI Ping 账户额度、真实输出质量或长期稳定性。真实结论以 `.local/product-verification.json`、`.local/review-evaluation.json`、`.local/live-evaluation.json` 为准。

## 9. 测试

```powershell
cd haipigua
npm test
```

或：

```powershell
node --test --test-isolation=none tests/*.test.cjs
```
