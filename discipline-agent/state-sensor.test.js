'use strict';
/**
 * state-sensor.test.js —— A-M2 测试（node state-sensor.test.js 直跑）
 *
 * 覆盖：
 *   1. 契约自检：状态模型字段/枚举合法，非法值被拒绝
 *   2. 四类场景（躺床/在书桌前/离开/学习中）判定准确率 ≥80%（连拍 3 帧驱动）
 *   3. 降级：captureFrame 抛错 / 返回 null / 返回 ok:false / 推理质量差
 *      → source=time_rules、confidence ≤0.5、不抛异常
 *   4. 消费约束：仅有 camera 证据、无步骤完成信号时不可达 L2+
 *   5. 时间规则独立工作（锁屏、长时间无操作 → away/lying_bed 等）
 *   6. 用户纠正回流：correctState / getCorrections，纠正后同场景判定正确
 *   7. 采集调度：60s 轮询 / 提醒后 30s 补抓 / 必要时连拍
 *   8. 融合算法：同向加成、冲突扣分、矛盾降 unknown、帧间分歧打折
 *   9. 可读性：每类判定带中文 explain 与 evidence
 *
 * 说明：createSuite（A-M0 的 test-util.js）只支持同步用例；本文件多数用例
 * 是异步的，故用文件尾部的 runAsync 迷你 runner 串行执行，保证抛错被计数、
 * 退出码正确（不改 A-M0 的 test-util.js）。
 */

const { createSuite, ok, equal, contains } = require('./test-util');
const { loadFixture, listFixtures, createFakeBackend, createFakeClock } = require('./fake-backend');
const {
  STATES, SOURCES, DEGRADED_CONFIDENCE, MIN_TRUSTED_CONFIDENCE,
  validateStateModel, makeStateModel, fuseEvidence, timeRulesOnly,
  escalationEligibility, canTriggerForcedLevel, createCaptureScheduler,
  createStateSensor, ruleKey, isoOffset
} = require('./state-sensor');

/** 场景清单：fixture 名 → 期望状态（准确率统计与可读性检查复用） */
const SCENARIOS = [
  ['pose-lying-bed', 'lying_bed'],
  ['pose-seated-desk', 'seated_desk'],
  ['pose-away', 'away'],
  ['pose-learning', 'learning'],
  ['pose-burst-disagree', 'lying_bed']
];

const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/** 用 fixture 造一个 sensor；假时钟固定为 fixture 场景对应时间 */
function sensorFromFixture(name, opts) {
  const fixture = loadFixture(name + '.json');
  const backend = createFakeBackend(fixture, opts && opts.backend);
  const ctx = fixture.context || {};
  const hour = typeof ctx.hour === 'number' ? ctx.hour : 12;
  const clock = createFakeClock('2026-10-16T' + String(hour).padStart(2, '0') + ':30:00+08:00');
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: ctx.inactiveMin, locked: ctx.locked }),
    clock: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    sleepFn: () => Promise.resolve()
  });
  return { sensor, backend, fixture, clock };
}

/* ---------- 异步用例收集器 ---------- */
const asyncCases = [];
function atest(title, fn) { asyncCases.push([title, fn]); }

/* ================= 1. 契约自检（同步） ================= */
const contractSuite = createSuite('状态模型契约');

contractSuite.test('状态模型字段齐全且合法（躺床样例）', () => {
  const model = makeStateModel({
    state: 'lying_bed',
    confidence: 0.86,
    evidence: 'camera:卧姿·床区域 | inactive:18分钟无操作 | time:07:00',
    capturedAt: '2026-10-16T07:42:11+08:00',
    source: 'camera_local',
    explain: '摄像头判定为床区域卧姿，且已 18 分钟无操作'
  });
  equal(model.confidence, 0.86, 'confidence 保留两位小数');
  equal(model.source, 'camera_local', 'source 透传');
  ok(validateStateModel(model).length === 0, '校验应通过');
});

contractSuite.test('非法 state / confidence / capturedAt / source / evidence 被拒绝', () => {
  const nowIso = isoOffset(new Date());
  const bad = [
    { state: 'sleeping', confidence: 0.8, evidence: 'e', capturedAt: nowIso, source: 'time_rules', explain: 'x' },
    { state: 'away', confidence: 1.5, evidence: 'e', capturedAt: nowIso, source: 'time_rules', explain: 'x' },
    { state: 'away', confidence: 0.5, evidence: 'e', capturedAt: '2026-10-16 07:42:11', source: 'time_rules', explain: 'x' },
    { state: 'away', confidence: 0.5, evidence: '', capturedAt: nowIso, source: 'manual', explain: 'x' },
    { state: 'away', confidence: 0.5, evidence: 'e', capturedAt: nowIso, source: 'sensor_fused', explain: 'x' }
  ];
  for (const b of bad) {
    const errs = validateStateModel(b);
    ok(errs.length > 0, '应当拒绝: ' + JSON.stringify(b));
  }
});

contractSuite.test('枚举集合与 instructions.js 一致（6 状态 / 3 来源）', () => {
  equal(STATES.length, 6, '状态枚举长度');
  ok(STATES.indexOf('lying_bed') !== -1 && STATES.indexOf('unknown') !== -1, '含关键状态');
  equal(SOURCES.length, 3, '来源枚举长度');
  ok(SOURCES.indexOf('camera_local') !== -1 && SOURCES.indexOf('time_rules') !== -1 &&
     SOURCES.indexOf('manual') !== -1, '来源枚举值');
});

/* ================= 2. 四类场景准确率（异步） ================= */
atest('四类场景 + 连拍歧义场景判定（连拍 3 帧），准确率 ≥80%', async () => {
  let hit = 0;
  const total = SCENARIOS.length;
  const report = [];
  for (const [name, expected] of SCENARIOS) {
    const { sensor } = sensorFromFixture(name);
    const model = await sensor.estimate({ frames: 3, intervalMs: 1, reason: 'poll_burst' });
    const pass = model.state === expected;
    if (pass) hit++;
    report.push('    ' + name + ' → ' + model.state + '（期望 ' + expected + '）' + (pass ? ' ✓' : ' ✗') +
      ' conf=' + model.confidence + ' source=' + model.source);
  }
  console.log(report.join('\n'));
  const acc = hit / total;
  console.log('  准确率: ' + hit + '/' + total + ' = ' + Math.round(acc * 100) + '%');
  ok(acc >= 0.8, '准确率必须 ≥80%，实际 ' + Math.round(acc * 100) + '%');
});

atest('单帧估计同样能判定典型场景', async () => {
  const { sensor } = sensorFromFixture('pose-lying-bed');
  const model = await sensor.estimate({ frames: 1 });
  equal(model.state, 'lying_bed', '单帧卧姿判躺床');
  ok(model.confidence >= MIN_TRUSTED_CONFIDENCE, '置信度应达标');
});

atest('全部 fixture 都能产出合法状态模型（含 explain/evidence）', async () => {
  for (const name of listFixtures()) {
    const { sensor } = sensorFromFixture(name);
    const model = await sensor.estimate({ frames: 3, intervalMs: 1 });
    const errs = validateStateModel(model);
    ok(errs.length === 0, name + ' 输出不合法: ' + errs.join('；'));
    ok(model.explain.length > 0 && model.evidence.length > 0, name + ' 必须带 explain/evidence');
  }
});

/* ================= 3. 降级路径（异步） ================= */
atest('captureFrame 返回 ok:false → time_rules + 低置信度', async () => {
  const { sensor } = sensorFromFixture('pose-time-only-away');
  const model = await sensor.estimate({ frames: 1 });
  equal(model.source, 'time_rules', '降级来源');
  ok(model.confidence <= DEGRADED_CONFIDENCE, '置信度必须 ≤0.5，实际 ' + model.confidence);
  equal(model.state, 'away', '锁屏+30min 无操作 → away');
  contains(model.explain, '摄像头不可用', 'explain 需说明降级原因');
});

atest('captureFrame 抛异常 → 不抛到调用方，走降级', async () => {
  const backend = createFakeBackend(loadFixture('pose-time-only-lying.json'));
  const clock = createFakeClock('2026-10-16T23:10:00+08:00');
  const sensor = createStateSensor({
    captureFrame: async () => { throw new Error('设备被拔出'); },
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 40, locked: false }),
    clock: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  });
  const model = await sensor.estimate({ frames: 1 });
  equal(model.source, 'time_rules', '异常也要降级而不是崩掉');
  equal(model.state, 'lying_bed', '夜间+长无操作 → lying_bed');
  ok(model.confidence <= DEGRADED_CONFIDENCE, '低置信度');
});

atest('captureFrame 返回 null → 走降级', async () => {
  const backend = createFakeBackend(loadFixture('pose-time-only-away.json'));
  const sensor = createStateSensor({
    captureFrame: async () => null,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 30, locked: true }),
    clock: { now: () => new Date('2026-10-16T11:00:00+08:00') }
  });
  const model = await sensor.estimate({ frames: 1 });
  equal(model.source, 'time_rules', 'null 帧降级');
  equal(model.state, 'away', '降级判定');
});

atest('推理质量差（遮挡/光线差）→ 降级', async () => {
  const { sensor } = sensorFromFixture('pose-degraded-lowlight');
  const model = await sensor.estimate({ frames: 1 });
  equal(model.source, 'time_rules', '低质量帧视为无 camera 证据');
  ok(model.confidence <= DEGRADED_CONFIDENCE, '低置信度');
  contains(model.explain, '摄像头不可用', 'explain 需说明原因');
});

atest('拔摄像头后全流程仍可反复估计（稳定性）', async () => {
  const { sensor } = sensorFromFixture('pose-time-only-lying');
  for (let i = 0; i < 3; i++) {
    const model = await sensor.estimate({ frames: 2, intervalMs: 1 });
    ok(validateStateModel(model).length === 0, '第 ' + i + ' 次估计仍合法');
    equal(model.source, 'time_rules', '持续降级');
  }
});

atest('权限被拒 → 降级且 reason 体现在说明里', async () => {
  const fixture = loadFixture('pose-lying-bed.json');
  const backend = createFakeBackend(fixture, { failAtFrame: 0, failReason: 'permission_denied' });
  const clock = createFakeClock('2026-10-16T07:42:00+08:00');
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 18, locked: false }),
    clock: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  });
  const model = await sensor.estimate({ frames: 1 });
  equal(model.source, 'time_rules', '权限拒 → 降级');
  contains(model.explain, '权限被拒绝', '原因可读');
});

atest('连拍中途掉帧 → 部分折叠而非整批降级', async () => {
  const fixture = loadFixture('pose-lying-bed.json');
  // 第 2 帧起失败：还有第 1 帧可用，应继续用 camera 证据（打折），而不是直接降级
  const backend = createFakeBackend(fixture, { failAtFrame: 1, failReason: 'busy' });
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 18, locked: false }),
    clock: { now: () => new Date('2026-10-16T07:42:00+08:00') },
    sleepFn: () => Promise.resolve()
  });
  const model = await sensor.estimate({ frames: 3, intervalMs: 1 });
  equal(model.state, 'lying_bed', '仍应判躺床');
  equal(model.source, 'camera_local', '保留 camera 证据');
  contains(model.explain, '采集失败', '说明掉帧打折');
});

/* ================= 4. 时间规则独立（同步） ================= */
const timeSuite = createSuite('时间规则独立');

timeSuite.test('锁屏 + 长无操作 → away', () => {
  const r = timeRulesOnly({ inactiveMin: 35, locked: true, hour: 14 });
  equal(r.state, 'away', '锁屏+35min');
  ok(r.confidence <= DEGRADED_CONFIDENCE, '时间规则置信度封顶 0.5');
});

timeSuite.test('夜间 + 长无操作 → lying_bed', () => {
  const r = timeRulesOnly({ inactiveMin: 40, locked: false, hour: 23 });
  equal(r.state, 'lying_bed', '夜间+40min');
});

timeSuite.test('白天 + 长无操作 → seated_desk', () => {
  const r = timeRulesOnly({ inactiveMin: 30, locked: false, hour: 10 });
  equal(r.state, 'seated_desk', '白天+30min');
});

timeSuite.test('锁屏但时长短 → unknown（宁可 unknown）', () => {
  const r = timeRulesOnly({ inactiveMin: 3, locked: true, hour: 20 });
  equal(r.state, 'unknown', '信息不足');
});

timeSuite.test('锁屏 + 长无操作 + camera 判有人 → 方向冲突扣分', () => {
  const r = fuseEvidence({
    camera: { person: true, posture: 'sitting', zone: 'desk', confidence: 0.8, quality: 0.9 },
    context: { inactiveMin: 30, locked: true, hour: 15 }
  });
  ok(r.confidence < 0.8, '冲突应扣分，实际 ' + r.confidence);
  contains(r.evidence, 'locked', 'evidence 记录锁屏');
});

timeSuite.test('camera 置信度低于 0.4 → 视为无证据并降级', () => {
  const r = fuseEvidence({
    camera: { person: true, posture: 'lying', zone: 'bed', confidence: 0.3, quality: 0.9 },
    context: { inactiveMin: 30, locked: false, hour: 23 }
  });
  equal(r.state, 'lying_bed', '夜间弱推断');
  ok(r.confidence <= DEGRADED_CONFIDENCE, '低置信度帧不许给高置信度');
});

timeSuite.test('camera 置信度低且时段无倾向 → unknown', () => {
  const r = fuseEvidence({
    camera: { person: true, posture: 'lying', zone: 'bed', confidence: 0.3, quality: 0.9 },
    context: { inactiveMin: 10, locked: false, hour: 8 }
  });
  equal(r.state, 'unknown', '清晨短无操作，信息不足');
});

timeSuite.test('posture/zone 矛盾（sitting+bed）→ unknown', () => {
  const r = fuseEvidence({
    camera: { person: true, posture: 'sitting', zone: 'bed', confidence: 0.7, quality: 0.85 },
    context: { inactiveMin: 6, locked: false, hour: 14 }
  });
  equal(r.state, 'unknown', '矛盾不敢下结论');
});

timeSuite.test('learning 需要活跃度佐证（长无操作不许判学习）', () => {
  const withActivity = fuseEvidence({
    camera: { person: true, posture: 'sitting', zone: 'desk', confidence: 0.9, quality: 0.9 },
    context: { inactiveMin: 1, locked: false, hour: 20 }
  });
  const idle = fuseEvidence({
    camera: { person: true, posture: 'sitting', zone: 'desk', confidence: 0.9, quality: 0.9 },
    context: { inactiveMin: 20, locked: false, hour: 20 }
  });
  equal(withActivity.state, 'learning', '近期有操作 → 学习');
  ok(idle.state !== 'learning', '长无操作不许判学习');
});

timeSuite.test('confidence 上限 0.95，夜间卧姿有加成', () => {
  const night = fuseEvidence({
    camera: { person: true, posture: 'lying', zone: 'bed', confidence: 0.95, quality: 1 },
    context: { inactiveMin: 30, locked: false, hour: 23 }
  });
  ok(night.confidence <= 0.95, '不允许超 0.95，实际 ' + night.confidence);
  const day = fuseEvidence({
    camera: { person: true, posture: 'lying', zone: 'bed', confidence: 0.7, quality: 0.9 },
    context: { inactiveMin: 5, locked: false, hour: 13 }
  });
  const night2 = fuseEvidence({
    camera: { person: true, posture: 'lying', zone: 'bed', confidence: 0.7, quality: 0.9 },
    context: { inactiveMin: 5, locked: false, hour: 23 }
  });
  ok(night2.confidence > day.confidence, '夜间加成应更高: ' + night2.confidence + ' vs ' + day.confidence);
});

timeSuite.test('无人画面 → away 且带可读 evidence', () => {
  const r = fuseEvidence({
    camera: { person: false, posture: 'absent', zone: 'none', confidence: 0.85, quality: 0.9 },
    context: { inactiveMin: 30, locked: true, hour: 11 }
  });
  equal(r.state, 'away', '无人 → away');
  contains(r.evidence, 'camera:无人', 'evidence 记录无人');
  ok(r.explain.length > 0, 'explain 可读');
});

timeSuite.test('ruleKey 对同时段同活跃度稳定、不同则区分', () => {
  equal(ruleKey({ hour: 23, inactiveMin: 30, locked: false }), ruleKey({ hour: 1, inactiveMin: 30, locked: false }), '同属夜间');
  ok(ruleKey({ hour: 23, inactiveMin: 30, locked: false }) !== ruleKey({ hour: 23, inactiveMin: 2, locked: false }), '不同活跃度不同 key');
  ok(ruleKey({ hour: 23, inactiveMin: 30, locked: false }) !== ruleKey({ hour: 23, inactiveMin: 30, locked: true }), '锁屏与否不同 key');
});

/* ================= 5. 消费约束（同步） ================= */
const constraintSuite = createSuite('消费约束');

const NO_STEP_STATES = [
  { state: 'lying_bed', source: 'camera_local', confidence: 0.86 },
  { state: 'seated_desk', source: 'camera_local', confidence: 0.82 },
  { state: 'standing_or_moving', source: 'camera_local', confidence: 0.7 },
  { state: 'away', source: 'camera_local', confidence: 0.8 },
  { state: 'learning', source: 'camera_local', confidence: 0.9 },
  { state: 'unknown', source: 'time_rules', confidence: 0.4 }
];

constraintSuite.test('仅有 camera 证据、无步骤完成信号 → 全部不可达 L2+', () => {
  for (const st of NO_STEP_STATES) {
    const el = escalationEligibility(st, { stepCompleted: false, stepDeclined: false });
    ok(LEVEL_ORDER[el.level] < LEVEL_ORDER.L2,
      st.state + ' 无步骤信号时只能到 ' + el.level + '（不允许 L2+）');
    ok(typeof el.reason === 'string' && el.reason.length > 0, st.state + ' 必须给出理由');
  }
  console.log('    各状态（无步骤信号）最高级别: ' +
    NO_STEP_STATES.map(s => s.state + '→' + escalationEligibility(s).level).join(', '));
});

constraintSuite.test('canTriggerForcedLevel 与 escalationEligibility 一致', () => {
  for (const st of NO_STEP_STATES) {
    equal(canTriggerForcedLevel(st), escalationEligibility(st).level, st.state + ' 包装一致');
  }
});

constraintSuite.test('away / unknown 只能到 L0', () => {
  equal(canTriggerForcedLevel({ state: 'away', confidence: 0.9 }), 'L0', '无人');
  equal(canTriggerForcedLevel({ state: 'unknown', confidence: 0.4 }), 'L0', '不确定');
});

constraintSuite.test('learning 不打扰，最高 L0', () => {
  equal(canTriggerForcedLevel({ state: 'learning', confidence: 0.95 }), 'L0', '学习');
});

constraintSuite.test('有步骤完成信号才允许 L2+', () => {
  const st = { state: 'lying_bed', source: 'camera_local', confidence: 0.86 };
  const none = escalationEligibility(st, { stepCompleted: false });
  const done = escalationEligibility(st, { stepCompleted: true });
  ok(LEVEL_ORDER[none.level] < LEVEL_ORDER.L2, '无信号封顶 L1');
  ok(LEVEL_ORDER[done.level] >= LEVEL_ORDER.L2, '有信号可到 L2+');
});

constraintSuite.test('状态不可用 → 不允许任何强制', () => {
  const el = escalationEligibility(null);
  equal(el.allowed, false, '空状态不允许');
  equal(el.level, 'L0', '空状态最高 L0');
});

/* ================= 6. 用户纠正回流（同步 + 异步） ================= */
const correctSuite = createSuite('用户纠正回流');

correctSuite.test('correctState 产出 source=manual 且置信度最高', () => {
  const clock = createFakeClock('2026-10-16T23:30:00+08:00');
  const backend = createFakeBackend(loadFixture('pose-lying-bed.json'));
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 30, locked: false }),
    clock: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  });
  const m = sensor.correctState('away', '我不在床上，我在客厅');
  equal(m.source, 'manual', '纠正来源');
  equal(m.state, 'away', '纠正状态');
  equal(m.confidence, 1, '手动纠正置信度最高');
  contains(m.evidence, 'manual:', 'evidence 标注 manual');
});

correctSuite.test('非法纠正状态直接抛错', () => {
  const backend = createFakeBackend(loadFixture('pose-lying-bed.json'));
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 0, locked: false })
  });
  let threw = false;
  try { sensor.correctState('sleeping'); } catch (e) { threw = true; }
  ok(threw, 'sleeping 不是合法状态');
});

correctSuite.test('getCorrections 可读取回流表（含次数与场景 key）', () => {
  const clock = createFakeClock('2026-10-16T23:30:00+08:00');
  const backend = createFakeBackend(loadFixture('pose-lying-bed.json'));
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 30, locked: false }),
    clock: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  });
  sensor.correctState('away', '出门');
  sensor.correctState('away', '又出门');
  const list = sensor.getCorrections();
  ok(list.length >= 1, '有纠正记录');
  const hit = list.find(c => c.state === 'away');
  ok(!!hit, '含 away 纠正');
  ok(hit.count >= 1, '记录次数');
  ok(typeof hit.ruleKey === 'string' && hit.ruleKey.length > 0, '带场景 key');
});

atest('纠正后同一场景再次判定正确（规则修正表回流）', async () => {
  const { sensor } = sensorFromFixture('pose-correction-target');
  const before = await sensor.estimate({ frames: 1 });
  equal(before.state, 'lying_bed', '纠正前：时间规则判躺床');
  sensor.correctState('away', '我出门了');
  const after = await sensor.estimate({ frames: 1 });
  equal(after.state, 'away', '纠正后：同场景直接给 away');
  contains(after.explain, '纠正', '说明里体现这是纠正回流');
});

atest('初始 corrections 可注入（A-M5 审计写回）', async () => {
  const fixture = loadFixture('pose-correction-target.json');
  const backend = createFakeBackend(fixture);
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose: backend.inferPose,
    context: () => ({ inactiveMin: 30, locked: false }),
    clock: { now: () => new Date('2026-10-16T23:30:00+08:00') },
    corrections: { '夜间/unlock/ge25': { state: 'away', note: '上次纠正' } }
  });
  const model = await sensor.estimate({ frames: 1 });
  equal(model.state, 'away', '注入的纠正表立即生效');
});

/* ================= 7. 采集调度（同步） ================= */
const schedSuite = createSuite('采集调度');

schedSuite.test('常规 60s 轮询，未到点返回 null', () => {
  const clock = createFakeClock('2026-10-16T07:40:00+08:00');
  const sched = createCaptureScheduler({ nowFn: clock.now });
  const first = sched.poll(null);
  ok(first && first.reason === 'poll' && first.frames === 1, '首次轮询立刻可采');
  equal(sched.poll(null), null, '60s 内不重复采');
  clock.advance(60 * 1000);
  const second = sched.poll(null);
  ok(second && second.reason === 'poll', '60s 后再采');
  equal(sched.poll(null), null, '再等 60s 内仍不采');
});

schedSuite.test('静态姿态触发连拍 2–3 帧 / 间隔 1s', () => {
  const clock = createFakeClock('2026-10-16T07:40:00+08:00');
  const sched = createCaptureScheduler({ nowFn: clock.now });
  const last = { person: true, posture: 'lying', zone: 'bed', confidence: 0.9, quality: 0.9 };
  const r = sched.poll(last);
  ok(r && r.reason === 'poll_burst', '静态姿态需连拍区分"躺着不动/人已离开"');
  ok(r.frames >= 2 && r.frames <= 3, '连拍 2–3 帧，实际 ' + r.frames);
  equal(r.intervalMs, 1000, '帧间隔 1s');
  ok(!sched.needBurst({ person: false }), '已判无人不再连拍');
});

schedSuite.test('提醒发出后 30s 才补抓，且只补一次', () => {
  const clock = createFakeClock('2026-10-16T20:30:00+08:00');
  const sched = createCaptureScheduler({ nowFn: clock.now });
  sched.notifySent();
  equal(sched.postNotify(null), null, '30s 内不补抓');
  clock.advance(29 * 1000);
  equal(sched.postNotify(null), null, '29s 仍不补抓');
  clock.advance(1000);
  const first = sched.postNotify(null);
  ok(first && first.reason === 'post_notify', '30s 补抓一次');
  equal(sched.postNotify(null), null, '只补一次');
});

schedSuite.test('未发提醒则不会补抓', () => {
  const clock = createFakeClock('2026-10-16T20:30:00+08:00');
  const sched = createCaptureScheduler({ nowFn: clock.now });
  clock.advance(10 * 60 * 1000);
  equal(sched.postNotify(null), null, '没有提醒就没有补抓点');
});

schedSuite.test('调度器状态可读（供审计）', () => {
  const clock = createFakeClock('2026-10-16T07:40:00+08:00');
  const sched = createCaptureScheduler({ nowFn: clock.now });
  sched.poll(null);
  sched.notifySent();
  const st = sched.state();
  ok(st.lastPollAt && st.notifySentAt, '记录时间点');
  equal(st.pollIntervalMs, 60000, '60s 轮询');
  equal(st.postNotifyMs, 30000, '30s 补抓');
});

/* ================= 8. 融合与可读性（异步） ================= */
atest('连拍帧间分歧 → 取多数并降置信度', async () => {
  const { sensor } = sensorFromFixture('pose-burst-disagree');
  const model = await sensor.estimate({ frames: 3, intervalMs: 1 });
  equal(model.state, 'lying_bed', '多数帧为卧姿');
  ok(model.confidence < 0.8, '分歧打折，实际 ' + model.confidence);
  contains(model.explain, '连拍', 'explain 记录连拍折叠');
});

atest('estimate 出的模型同样受消费约束', async () => {
  const { sensor } = sensorFromFixture('pose-lying-bed');
  const model = await sensor.estimate({ frames: 1 });
  const el = sensor.escalationEligibility(model, { stepCompleted: false });
  ok(LEVEL_ORDER[el.level] < LEVEL_ORDER.L2, '真实判定链路也不许单独上 L2');
});

atest('每类判定都带中文 explain 与 evidence（含 camera/inactive/time）', async () => {
  for (const [name] of SCENARIOS) {
    const { sensor } = sensorFromFixture(name);
    const model = await sensor.estimate({ frames: 3, intervalMs: 1 });
    contains(model.explain, '摄像头', '有摄像头说明（' + name + '）');
    contains(model.evidence, 'camera:', '有 camera 证据（' + name + '）');
    contains(model.evidence, 'inactive:', '有无操作时长（' + name + '）');
    contains(model.evidence, 'time:', '有时段（' + name + '）');
  }
});

atest('降级判定的 explain 说明为什么信不过', async () => {
  const { sensor } = sensorFromFixture('pose-time-only-away');
  const model = await sensor.estimate({ frames: 1 });
  contains(model.explain, '摄像头不可用', '降级原因');
  contains(model.evidence, 'camera:不可用', 'evidence 标注');
});

atest('getLast 返回最近一次判定，capturedAt 带 +08:00 偏移', async () => {
  const { sensor } = sensorFromFixture('pose-lying-bed');
  ok(sensor.getLast() === null, '初始为空');
  const m = await sensor.estimate({ frames: 1 });
  ok(sensor.getLast() === m, '同一次对象');
  ok(/\+08:00$/.test(m.capturedAt), 'capturedAt 偏移: ' + m.capturedAt);
});

/* ================= 9. 参数校验（同步） ================= */
const argSuite = createSuite('参数校验');

argSuite.test('缺少 captureFrame / inferPose 抛错', () => {
  let n = 0;
  try { createStateSensor({ inferPose: async () => ({}) }); } catch (e) { n++; }
  try { createStateSensor({ captureFrame: async () => ({ ok: true }) }); } catch (e) { n++; }
  equal(n, 2, '两个必填入参都要校验');
});

/* ================= 汇总执行 ================= */

/**
 * runAsync —— 异步用例串行执行器。
 * A-M0 的 createSuite.run() 是同步的，async 用例的抛错不会被它捕获；
 * 这里补齐计数与退出码，不改 test-util.js。
 */
async function runAsync(name, cases) {
  let pass = 0;
  const failures = [];
  for (const [title, fn] of cases) {
    try {
      await fn();
      pass++;
      console.log('  ✓ ' + title);
    } catch (e) {
      failures.push({ title, error: e });
      console.log('  ✗ ' + title);
      console.log('    ' + String(e && e.message).split('\n').join('\n    '));
    }
  }
  console.log('\n' + name + ': ' + pass + '/' + cases.length + ' 通过');
  if (failures.length) {
    console.log(name + ': ' + failures.length + ' 失败');
    process.exitCode = 1;
  }
  return { pass, total: cases.length, failures };
}

(async () => {
  console.log('\n▶ 状态模型契约');
  contractSuite.run();
  console.log('\n▶ 时间规则独立');
  timeSuite.run();
  console.log('\n▶ 消费约束');
  constraintSuite.run();
  console.log('\n▶ 用户纠正回流（同步部分）');
  correctSuite.run();
  console.log('\n▶ 采集调度');
  schedSuite.run();
  console.log('\n▶ 参数校验');
  argSuite.run();
  console.log('\n▶ 四类场景 / 降级 / 纠正回流 / 融合 / 可读性（异步）');
  await runAsync('异步用例', asyncCases);
})();
