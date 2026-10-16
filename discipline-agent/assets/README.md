# assets/ —— 真实推理后端接入说明

本目录**不放任何模型二进制**（仓库不放大文件）。这里只写清楚：真实摄像头/推理后端
怎么接进 `state-sensor.js`，接口形状是什么，以及各后端的取舍。

> A-M2 的 `state-sensor.js` 本身**零第三方依赖**，推理全部走依赖注入：
> `captureFrame` + `inferPose` 两个函数由宿主提供。测试与联调用
> `fixtures/` 里的假后端（`fake-backend.js`），**不碰真实摄像头**。

---

## 1. 接口形状（唯一约定）

`createStateSensor(opts)` 需要注入两个异步函数 + 一个上下文函数 + 一个时钟：

```js
const { createStateSensor } = require('./state-sensor');

const sensor = createStateSensor({
  // ① 抓一帧（不连续录像，按调度策略调用）
  captureFrame: async (reason) => {
    // reason: 'poll' | 'poll_burst' | 'post_notify' | 'post_notify_burst' | 'burst'
    // 成功：{ ok: true, frame: <帧对象>, reason: null }
    // 失败：{ ok: false, reason: 'no_camera' | 'permission_denied' | 'occluded'
    //                    | 'low_light' | 'busy' | 'unknown', frame: null }
    // 注意：允许 throw，state-sensor 会捕获并按降级处理
  },

  // ② 姿态/区域推理（frames 是 1~3 帧的数组）
  inferPose: async (frames) => ({
    person: true,                 // 画面里有没有人
    posture: 'lying' | 'sitting' | 'standing' | 'absent' | 'unknown',
    zone: 'bed' | 'desk' | 'other' | 'none',
    confidence: 0.88,             // 0..1，推理置信度
    quality: 0.9,                 // 0..1，画面质量（遮挡/光线差的综合分）
    keypoints: { /* 可选，调试用 */ }
  }),

  // ③ 活跃度上下文（由宿主从"无操作时长 / 锁屏状态"提供）
  context: () => ({ inactiveMin: 18, locked: false }),

  // ④ 时钟（可注入假时钟做测试；intervalMs 之间的 sleep 也可注入）
  clock: { now, setTimeout, clearTimeout },
  sleepFn: (ms) => new Promise(r => setTimeout(r, ms))
});

// 一次估计 → 状态模型（契约 6.2）
const model = await sensor.estimate({ frames: 3, intervalMs: 1000, reason: 'poll_burst' });
```

### `captureFrame` 的返回值约定

| 字段 | 说明 |
|---|---|
| `ok: true` | 抓到帧，`frame` 可以是任意对象（后端私有格式），会原样传给 `inferPose` |
| `ok: false` | 抓不到，`reason` 必须是下表之一；`state-sensor` 据此写 explain |
| `throw` | 等同于 `ok:false, reason:'unknown'`，不会向上抛 |

| `reason` | explain 里的中文说明 |
|---|---|
| `no_camera` | 没有摄像头设备 |
| `permission_denied` | 摄像头权限被拒绝 |
| `occluded` | 画面被遮挡 |
| `low_light` | 光线太暗 |
| `busy` | 摄像头被其它程序占用 |
| `unknown` | 摄像头不可用 |

### `inferPose` 的返回值约定

| 字段 | 类型 | 说明 |
|---|---|---|
| `person` | boolean | `false` 时直接走 `away`，其余字段忽略 |
| `posture` | 枚举 | `lying` / `sitting` / `standing` / `absent` / `unknown` |
| `zone` | 枚举 | `bed` / `desk` / `other` / `none` |
| `confidence` | 0..1 | **低于 0.4 的帧会被当作无证据**，触发降级 |
| `quality` | 0..1 | **低于 0.3 的帧会被当作无证据**，触发降级（遮挡/光线差走这里） |
| `keypoints` | 任意 | 可选，仅用于调试/审计展示 |

---

## 2. 姿态 → 状态的映射（融合层，已在 `state-sensor.js` 实现）

| posture | zone | → state |
|---|---|---|
| `lying` | `bed` | `lying_bed` |
| `lying` | 其它 | `unknown`（矛盾，不敢下结论） |
| `sitting` | `desk` | `seated_desk` |
| `sitting` | 其它 | `unknown`（矛盾） |
| `standing` | `desk` | `seated_desk`（站在桌旁按在桌前处理） |
| `standing` | 其它 | `standing_or_moving` |
| `absent` / `person:false` | — | `away` |

`learning` 不由姿态单独决定：必须**同时**满足「在书桌前 + 无操作 <5min + 未锁屏 +
8:00–23:00」，否则只能是 `seated_desk`。单目姿态分不清"在桌前发呆"和"在写作业"。

---

## 3. 两个候选真实后端

### 方案 A：ONNX Runtime + YOLOv8n-pose（推荐 v1）

```bash
# 仅在真实宿主机执行；仓库与 CI 不装
npm i onnxruntime-node
# 模型文件放到本目录（或宿主配置的模型目录）：
#   yolov8n-pose.onnx
```

适配层示意（**不要**写进 `state-sensor.js`，放宿主的 `camera-backend.js`）：

```js
const ort = require('onnxruntime-node');

let session = null;
async function loadModel(modelPath) {
  session = await ort.InferenceSession.create(modelPath);
}

async function captureFrame(reason) {
  // 用宿主平台的取帧能力：node-webcam / ffmpeg 抽帧 / Electron 的 desktopCapturer
  // 只抓 1 帧，不保持视频流
  try {
    const frame = await grabSingleFrame();
    return { ok: true, frame, reason: null };
  } catch (e) {
    return { ok: false, reason: 'unknown' };
  }
}

async function inferPose(frames) {
  const f = frames[0];
  const tensor = preprocess(f);              // → float32[N,3,640,640]
  const out = await session.run({ images: tensor });
  const kpts = parseKeypoints(out);          // 17 个关键点 (x,y,conf)
  const person = kpts.length > 0 && meanConf(kpts) > 0.3;
  return {
    person,
    posture: person ? postureFrom(kpts) : 'absent',
    zone: person ? zoneFrom(kpts) : 'none',
    confidence: person ? meanConf(kpts) : 0.9,
    quality: imageQuality(f),
    keypoints: kpts
  };
}

/** 姿态判据：躯干连线与水平面的夹角 */
function postureFrom(kpts) {
  const [ls, rs, lh, rh] = [kpts[5], kpts[6], kpts[11], kpts[12]];
  const shoulderY = (ls[1] + rs[1]) / 2;
  const hipY = (lh[1] + rh[1]) / 2;
  const dx = Math.abs(ls[0] - lh[0]);
  const dy = Math.abs(shoulderY - hipY);
  if (dy < 0.08 && dx > 0.15) return 'lying';   // 肩髋近乎同高且水平跨度大 → 卧
  if (dy > 0.15) return 'sitting';              // 肩明显高于髋 → 坐/站
  return 'standing';
}
```

- **优点**：离线、无网络请求、延迟低（nano 级在 CPU 上几十毫秒）。
- **代价**：`onnxruntime-node` 是原生模块，需按 Node ABI 版本安装；
  模型文件约 6MB，需自行下载（Ultralytics 仓库 release）。
- **装不上的退路**：直接落到时间规则（`source=time_rules`，`confidence ≤0.5`），
  功能不中断——这条路径已有测试覆盖。

### 方案 B：MediaPipe Tasks Vision Pose Landmarker

```bash
npm i @mediapipe/tasks-vision
# 模型：pose_landmarker_lite.task（约 6MB）
```

```js
const { FilesetResolver, PoseLandmarker } = require('@mediapipe/tasks-vision');

let landmarker = null;
async function loadModel(modelPath, wasmDir) {
  const fileset = await FilesetResolver.forVisionTasks(wasmDir);
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 1
  });
}

async function inferPose(frames) {
  const res = landmarker.detect(frames[0]);   // frames[0] 需是 MP Image
  if (!res.landmarks || !res.landmarks.length) {
    return { person: false, posture: 'absent', zone: 'none', confidence: 0.9, quality: 0.9 };
  }
  const lm = res.landmarks[0];                // 33 个关键点，归一化坐标
  return {
    person: true,
    posture: postureFrom(lm),
    zone: zoneFrom(lm),
    confidence: meanVisibility(lm),
    quality: 0.9,
    keypoints: lm
  };
}
```

- **优点**：WASM 版跨平台、无需原生编译；关键点质量好。
- **代价**：单帧需要构造成 `MPImage`；CPU 上比 ONNX nano 略慢。

### 选型建议

| 场景 | 选 |
|---|---|
| Windows/Node 本地长期跑 | 方案 A（ONNX + YOLOv8n-pose） |
| 跨平台 / 不想装原生模块 | 方案 B（MediaPipe WASM） |
| 只是联调、没摄像头 | `fake-backend.js` + `fixtures/` |

两者**都实现同一组接口**即可热替换，`state-sensor.js` 不用改一行。

---

## 4. 采集调度怎么接

`createCaptureScheduler` 已实现策略，宿主只需按它的返回值决定抓几帧：

```js
const sched = sensor.scheduler;   // 或独立 createCaptureScheduler({...})

// 每 60s 调一次（宿主自己的定时器）
const plan = sched.poll(lastResult);
if (plan) {
  // plan: { reason: 'poll' | 'poll_burst', frames: 1|2|3, intervalMs: 0|1000 }
  await sensor.estimate({ frames: plan.frames, intervalMs: plan.intervalMs, reason: plan.reason });
}

// A-M4 发出提醒时
sched.notifySent();

// 之后每 30s 试一次补抓
const plan2 = sched.postNotify(lastResult);
if (plan2) {
  await sensor.estimate({ frames: plan2.frames, intervalMs: plan2.intervalMs, reason: plan2.reason });
}
```

| 策略 | 参数 | 说明 |
|---|---|---|
| 常规轮询 | `pollIntervalMs = 60000` | 每 60s 抓 1 帧 |
| 提醒后补抓 | `postNotifyMs = 30000` | 提醒发出后 30s 补抓 1 次，只补一次 |
| 连拍 | `burstIntervalMs = 1000`，`burstFrames = 3` | 静态姿态（lying/sitting）时取 2–3 帧 / 间隔 1s，区分"躺着不动"与"人已离开" |
| 不连续录像 | — | 全程只抓单帧或短连拍，**不保持视频流** |

---

## 5. 降级路径（真实后端出问题时自动走）

| 触发条件 | 处理 |
|---|---|
| `captureFrame` 抛错 / 返回 `ok:false` / 返回 null | 整批降级到时间规则 |
| `inferPose` 抛错 | 同上 |
| `inferPose.confidence < 0.4` | 该帧视为无证据 |
| `inferPose.quality < 0.3` | 该帧视为无证据（遮挡/光线差） |
| 连拍中部分帧失败 | 保留可用帧折叠，置信度打 85 折，**不整批降级** |

降级结果：`source = 'time_rules'`、`confidence ≤ 0.5`、`explain` 里写明"摄像头不可用：<原因>"。
降级下**同样**应用户纠正表（规则修正回流），所以纠正在无摄像头时依然有效。

---

## 6. 测试与联调怎么跑

```bash
node state-sensor.test.js     # A-M2 全套（假后端 + fixtures，不碰真实摄像头）
node run-tests.js             # 全里程碑汇总
```

- 假后端：`fake-backend.js` 的 `createFakeBackend(fixture, opts)`
  （`opts.failAtFrame` / `opts.failReason` 可模拟"第 N 帧起失败"）。
- 假时钟：`createFakeClock(startIso)`，`advance(ms)` 手动推进并触发定时器。
- fixtures：`fixtures/pose-*.json`，每个文件是一个场景的**帧序列 + 活跃度上下文**。
  加新场景只需新增一个 JSON，测试里的 `SCENARIOS` 加一行。

### fixtures 清单

| 文件 | 场景 | 帧数 |
|---|---|---|
| `pose-lying-bed.json` | 躺床（凌晨卧姿·床区域） | 3 |
| `pose-seated-desk.json` | 在书桌前（白天坐姿·书桌） | 3 |
| `pose-learning.json` | 学习中（桌前 + 近期有操作 + 未锁屏） | 2 |
| `pose-away.json` | 离开（3 帧全无人 + 锁屏） | 3 |
| `pose-burst-disagree.json` | 帧间分歧（2 卧姿 + 1 无人） | 3 |
| `pose-ambiguous.json` | 矛盾（坐姿·床区域）→ unknown | 1 |
| `pose-degraded-lowlight.json` | 光线差（quality 0.1）→ 降级 | 1 |
| `pose-time-only-away.json` | 无摄像头 + 锁屏 → away | 0 |
| `pose-time-only-lying.json` | 无摄像头 + 夜间 → lying_bed | 0 |
| `pose-correction-target.json` | 纠正回流目标场景 | 0 |

---

## 7. 消费约束（对接 A-M4 前必读）

状态**只能**用于：分步起点选择 + 是否有人。
**绝不单独触发 L2 及以上强制**——这是 `state-sensor.js` 里写死的规则：

```js
const { escalationEligibility, canTriggerForcedLevel } = require('./state-sensor');

escalationEligibility(state, { stepCompleted: false });
// → { level: 'L1', allowed: true, reason: '仅有状态证据（无步骤完成信号），最高到 L1…' }
```

| 状态 | 无步骤完成信号时最高级别 |
|---|---|
| `lying_bed` / `seated_desk` / `standing_or_moving` | **L1** |
| `away` | L0 |
| `learning` | L0 |
| `unknown` | L0 |

只有拿到**步骤完成信号**（`stepCompleted: true` 或 `stepDeclined: true`）才允许进入 L2+，
且是否实际上升仍由 A-M4 的间隔/单日上限/授权规则决定。

---

## 8. 目录说明

```
state-sensor.js          状态估计主模块（零第三方依赖）
state-sensor.test.js     测试（node state-sensor.test.js）
fake-backend.js          假摄像头 + 假推理 + 假时钟（测试/联调用）
fixtures/                场景样本（帧序列 JSON）
assets/README.md         本文件：真实后端接入说明
```

本目录**不放** `.onnx` / `.task` / `.wasm` 等二进制；宿主部署时自行下载到配置的模型目录，
并在 `assets/README.md` 记下版本与哈希即可。
