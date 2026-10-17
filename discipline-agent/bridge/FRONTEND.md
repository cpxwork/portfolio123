# A↔B 连接层：前端接入说明

你（前端）只需要这一个桥。**文件操作、状态机、审计、还原全部在 A 侧，你不碰文件系统。**

- 桥地址：`http://127.0.0.1:8879`（只监听本机，不可公网）
- 契约源头：`instructions.js`（枚举不许擅改）
- 前端封装：`bridge/discipline-client.js`（可直接拷进 `haipigua/web/`）
- 测试：`node bridge/bridge.test.js`（11 项，全绿才允许联调）

## 1. 启动

```powershell
cd C:\Users\yi\laisgo\portfolio123\discipline-agent
node bridge/start-bridge.cjs --work-root "C:\Users\yi\laisgo\Desktop\demo" --authorize-l5 --l5-target "C:\Users\yi\laisgo\Desktop\demo\游戏截图.png"
```

| 参数 | 说明 |
|---|---|
| `--port` | 默认 8879 |
| `--work-root` | 受控工作根，文件操作**只在这里面**；不给则用临时目录 |
| `--authorize-l5` | 授权 L5 隔离。**不给则 L5 自动封顶在 L4**（安全默认） |
| `--l5-target` | 允许隔离的文件，可重复；必须在 `--work-root` 内且真实存在 |

## 2. 接口

### `GET /api/health`
```json
{"ready":true,"model":null,"mode":"local-bridge","version":"0.1.0",
 "capabilities":{"discipline":true,"camera":false,"llm":false,"fileOps":true,"restore":true,"audit":true}}
```
`camera:false` / `llm:false` 是**如实上报**：本桥不做视觉推理、不直连模型。别把它当"服务不可用"。

### `POST /api/discipline/start` —— 启动升级链（下发 L0）
```json
{"state":{"state":"lying_bed","confidence":0.9,"evidence":"camera:卧姿·床区域","explain":"摄像头判定为床区域卧姿","source":"manual"}}
```
`state` 字段即契约 6.2 的状态模型；拿不到就传 `unknown`，**宁可 unknown 也不瞎猜**。

### `POST /api/discipline/tick` —— 推进一次
前端定时器每隔一段时间调一次（或由 A 侧定时器驱动）。响应：
```json
{"instructionId":"ins_task_bridge_L0_xxx","level":"L2","action":"spawn_bugs",
 "status":"running","reason":"L1 后 3 分钟仍无响应","gateBlocked":false,
 "instruction":{"id":"...","level":"L2","action":"spawn_bugs","step":{"index":1,"label":"下床"},
                "issuedAt":"...","expiresAt":"...","reversible":false,"payload":null}}
```
> 时间门禁没到点时会返回**当前级别 + 原因**（`reason` 里写"距上次升级不足 N 分钟"），此时旧的 `instructionId` 仍然有效——不要以为出错。

### `POST /api/discipline/ack` —— 已展示该指令
```json
{"instructionId":"ins_..."}
```

### `POST /api/discipline/complete` —— 该步完成（**最关键的一个调用**）
```json
{"instructionId":"ins_...","reason":"用户坐到书桌前"}
```
调用后 A 侧**立即撤销全部强制状态并还原所有文件**。响应里 `status:"revoked"`、`restore.lost:0`。

### `POST /api/discipline/revoke` / `POST /api/discipline/restore`
`revoke` = 停状态机 + 全量还原；`restore` = 只还原文件（不动状态机）。给"一键还原"按钮用。

### `GET /api/discipline/state` —— 轮询
```json
{"escalation":{"taskId":"task_bridge","status":"running","level":"L2","reason":"...",
               "forcedToday":1,"dailyCap":4,"authorizeL4":true,"issuedLevels":["L0","L1","L2"]},
 "state":{...},"counts":{"issued":3,"acked":3,"completed":0,"revoked":0},
 "manifests":[{"manifestId":"...","kind":"shuffle","createdAt":"..."}]}
```

### `POST /api/discipline/audit` —— 审计查询
```json
{"action":"byTask","taskId":"task_bridge"}
```
`action` 可为 `byTask` / `byRange`(`from`,`to`) / `traceInstruction`(`instructionId`,`manifestId`) / `forcedCount` / 省略则返回全部。

## 3. 级别 ↔ 动作（前端要实现的只有一个 action 表）

| 级别 | action | 归属 | 前端做什么 |
|---|---|---|---|
| L0 | `notify` | **前端** | 角标 / 提示音 |
| L1 | `popup_countdown` | **前端** | 弹窗 + 倒计时 + "开始"按钮 |
| L2 | `spawn_bugs` | **前端** | 满屏虫子，带关闭倒计时 |
| L3 | `screen_flash` | **前端** | 整机闪屏，10 秒内自动清除，可立即退出 |
| L4 | `shuffle_desktop` | A 侧本地 | 桌面文件被改名；前端只展示"已打乱 + 可还原" |
| L5 | `quarantine_files` | A 侧本地 | 指定文件移入隔离区（加密）；前端只展示"已隔离 + 可还原" |

**只有 L0–L3 是你渲染的**；L4/L5 你拿到 `action` 后展示提示 + 还原入口即可。

## 4. 前端接入代码（可直接用）

```js
// haipigua/web/ 里
const dc = createDisciplineClient({ base: '' });   // 同源（preview 反代 8879）
// 或直连：createDisciplineClient({ base: 'http://127.0.0.1:8879' })

const r = await dc.tick({ state: currentStateModel });
const ui = dc.describe(r);          // → {kind:'frontend'|'local', level, action, text, ...}
if (ui.kind === 'frontend') render(ui);
else showLocalNotice(ui);           // L4/L5：展示 + 提供"一键还原"

document.querySelector('#done').onclick = () => dc.complete(r.instructionId, '用户点了完成');
document.querySelector('#restore').onclick = () => dc.restore();
```

## 5. 边界（违反会被测试拦下）

| 情形 | 行为 |
|---|---|
| 非本机 Host | `403 HOST_DENIED` |
| Origin 不在白名单（8877/8879/8880 的 127.0.0.1 与 localhost） | `403 ORIGIN_DENIED` |
| body > 128KiB | `413 BODY_TOO_LARGE` |
| body 不是合法 JSON | `400 BAD_JSON` |
| 未知路由 | `404 BAD_ROUTE` |
| 未知 instructionId | `404 NOT_FOUND` |
| 内部异常 | `500 INTERNAL_ERROR`（不泄漏堆栈与路径） |

错误统一 `{"error":{"code":"...","message":"..."}}`，**按 code 分支，别匹配 message 文案**。

## 6. 让 preview 反代（同源，免 CORS）

在 `haipigua/preview.cjs` 的 `/api/*` 分支里，把 `/api/discipline/` 前缀转发到 8879：

```js
const backendPort = req.url.startsWith('/api/discipline/') ? 8879 : 8878;
```

未启动桥时，前端会拿到 `LOCAL_BACKEND_OFFLINE`（沿用现有错误处理），**不会假装成功**。

## 7. 安全默认（务必保持）

- L5 隔离**默认关闭**（`--authorize-l5` 才开），未授权时封顶 L4 并在 `reason` 里说明。
- 单日强制上限 4 次（`dailyCap`），达到后当天封顶 L1。
- **永不删除**任何文件：L4 改名、L5 移入 `.quarantine/` 加密，全部写 manifest，任何时刻可还原。
- 每次完整动作都写审计：读了什么、依据什么、下了什么指令、执行/还原了什么。
