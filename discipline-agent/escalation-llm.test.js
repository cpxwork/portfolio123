'use strict';
/**
 * escalation-llm.test.js —— A-M4 测试：模型决策版升级（escalateWithLlm）
 * 运行：node escalation-llm.test.js
 *
 * 验证"模型决策 + 物理闸门"的边界：
 *   - strategist 模型说升级 → 真升级，且 reason 带模型的话
 *   - 模型说撤销 → revoke_all 立即执行（且步骤完成信号优先于模型）
 *   - 模型说挂起 → SUSPENDED
 *   - 模型说不动 → 快照即止
 *   - 模型给非法 level → 当不动
 *   - 模型想跳级 → 时间门禁按目标级间隔拦
 *   - 模型不可用 → 不退回规则链，亮出错误
 *   - L5 未授权 → 封顶 L4（模型说了不算）
 *   - 模型不能自选 action（action 由 level 映射）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstructionBus } = require('./instructions');
const { createExecutor } = require('./executor');
const { createEscalation, STATUS } = require('./escalation');
const { createLlmClient } = require('./llm/llm-client');
const { ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('escalation-llm.test.js');

/** 假时钟（ms 数字契约，escalation 用 number） */
function fakeClock(startMs) {
  let t = startMs;
  const timers = [];
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimeout(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    clearAll() { timers.length = 0; },
    advance(ms) {
      t += ms;
      const due = timers.filter(x => x.at <= t);
      for (const d of due) {
        const i = timers.indexOf(d);
        if (i >= 0) timers.splice(i, 1);
        d.fn();
      }
    },
    pending: () => timers.length
  };
}

/** 桩 LLM：按函数 (role, system, user) 返回模型 JSON */
function stubLlm(replyFn) {
  const calls = [];
  return {
    calls,
    async chatJson(role, system, user) {
      calls.push({ role, system, user });
      const out = replyFn(role, system, user);
      if (out && out.__throw) return { ok: false, error: out.__throw };
      return { ok: true, data: out, raw: JSON.stringify(out), model: 'stub', ms: 1 };
    }
  };
}

function makeEnv(authorizeL4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-llm-'));
  const auditDir = path.join(root, '.discipline', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const bus = createInstructionBus({ logPath: path.join(auditDir, 'bus.jsonl') });
  const executor = createExecutor({ workRoot: root, auditPath: path.join(auditDir, 'exec.jsonl') });
  fs.writeFileSync(path.join(root, '游戏截图.png'), 'fake-png');
  const clock = fakeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
  const esc = createEscalation({
    bus, executor, clock,
    options: {
      taskId: 'task_math',
      authorizeL4: authorizeL4 === true,
      l4Targets: [path.join(root, '游戏截图.png')],
      shuffleTargetDir: root,
      plan: { steps: [{ index: 0, label: '坐起来', stateAtPlan: 'lying_bed' }] },
      stateEvidence: { state: 'lying_bed', confidence: 0.9 }
    }
  });
  return { root, bus, executor, clock, esc, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ---------- 模型决策基本路径 ----------

suite.test('strategist 用 roles 定义，prompt 带态势字段', async () => {
  const env = makeEnv(false);
  try {
    const llm = stubLlm(() => ({ level: 'L0', suspend: false, revoke: false, reason: 'x' }));
    await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 3 });
    equal(llm.calls.length, 1, '调一次');
    const c = llm.calls[0];
    equal(c.role, 'strategist', 'strategist 角色');
    contains(c.user, 'lying_bed', '带状态');
    contains(c.user, '坐起来', '带步骤');
    contains(c.user, 'L4 是否已授权：否', '带授权信息');
    contains(c.user, '只输出 JSON', '要求 JSON');
  } finally { env.cleanup(); }
});

suite.test('模型说升 L1 → 真下发 L1，reason 带模型的话', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    env.clock.clearAll();
    env.clock.advance(2 * 60000);            // 等够 L1 间隔（2 分钟）
    const llm = stubLlm(() => ({ level: 'L1', suspend: false, revoke: false, reason: '躺太久了，弹个窗' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 3 });
    equal(snap.level, 'L1', '升到 L1');
    equal(snap.status, STATUS.RUNNING, '运行中');
    equal(snap.modelDecision.reason, '躺太久了，弹个窗', '模型决策留痕');
    const ins = env.bus.list({ action: 'popup_countdown' });
    equal(ins.length, 1, 'L1 = popup_countdown');
  } finally { env.cleanup(); }
});

suite.test('模型说撤销 → revoke_all 立即全量还原', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();                                    // L0
    env.clock.advance(2 * 60000); env.esc.tick();       // L1
    env.clock.advance(3 * 60000); env.esc.tick();      // L2
    env.clock.advance(5 * 60000); env.esc.tick();       // L3 shuffle 执行
    const llm = stubLlm(() => ({ level: null, suspend: false, revoke: true, reason: '用户已在做了' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'seated_desk', confidence: 0.8, waitedMin: 5 });
    equal(snap.status, STATUS.REVOKED, '已撤销');
    ok(snap.restore && snap.restore.ok === true, 'restore 成功');
    equal(snap.restore.lost, 0, '零丢失');
    ok(fs.existsSync(path.join(env.root, '游戏截图.png')), '文件回到原位');
  } finally { env.cleanup(); }
});

suite.test('步骤完成信号优先于模型（不问模型直接撤销）', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    env.esc.completeStep();   // stepDone = true
    const llm = stubLlm(() => { throw new Error('不应被调用'); });
    const snap = await env.esc.escalateWithLlm({ llm, state: 'seated_desk', confidence: 0.9, waitedMin: 0 });
    equal(snap.status, STATUS.REVOKED, '撤销');
    equal(llm.calls.length, 0, '模型根本没被问');
  } finally { env.cleanup(); }
});

suite.test('模型说挂起 → SUSPENDED，不再升级', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    const llm = stubLlm(() => ({ level: 'L1', suspend: true, revoke: false, reason: '人不在电脑前' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'away', confidence: 0.7, waitedMin: 2 });
    equal(snap.status, STATUS.SUSPENDED, '挂起');
    equal(env.clock.pending(), 0, '定时器已清');
    const st = env.esc.getState();
    equal(st.level, 'L0', '级别停在 L0');
  } finally { env.cleanup(); }
});

suite.test('模型说不动（level=null）→ 快照即止，不产生指令', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    const before = env.bus.list().length;
    const llm = stubLlm(() => ({ level: null, suspend: false, revoke: false, reason: '刚提醒过，等等看' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'seated_desk', confidence: 0.5, waitedMin: 1 });
    equal(snap.status, STATUS.RUNNING, '状态不变');
    equal(env.bus.list().length, before, '没有新指令');
    equal(snap.modelDecision.reason, '刚提醒过，等等看', '留痕');
  } finally { env.cleanup(); }
});

suite.test('模型给非法 level → 当不动处理', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    const before = env.bus.list().length;
    const llm = stubLlm(() => ({ level: 'L9', suspend: false, revoke: false, reason: '乱说的' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 9 });
    equal(snap.status, STATUS.RUNNING, '不崩');
    equal(env.bus.list().length, before, '没有新指令');
    equal(env.esc.getState().level, 'L0', '级别没变');
  } finally { env.cleanup(); }
});

// ---------- 物理闸门 ----------

suite.test('闸门：模型想跳级，时间门禁按目标级间隔拦', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    env.clock.clearAll();   // 清掉 start 排的自动链：下面推进的是纯时间
    const llm = stubLlm(() => ({ level: 'L3', suspend: false, revoke: false, reason: '直接打乱桌面' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 1 });
    // L3 间隔 5 分钟，距上次升级 0 分钟 → 必须被拦
    equal(snap.level, 'L0', '仍停在 L0');
    contains(snap.reason, '不足', '门禁文案');
    equal(snap.gateBlocked, true, '标记被闸门拦截');
    equal(env.esc.getState().level, 'L0', '级别不变');
    const shuffles = env.bus.list({ action: 'shuffle_desktop' });
    equal(shuffles.length, 0, '没打乱任何东西');
  } finally { env.cleanup(); }
});

suite.test('闸门：跳级但间隔够 → 一次到位且真实执行', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();                                   // L0
    env.clock.clearAll();                               // 清自动链，纯时间推进
    env.clock.advance(5 * 60000);                       // 等够 L4 间隔
    const llm = stubLlm(() => ({ level: 'L4', suspend: false, revoke: false, reason: '等了够久了' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 5 });
    equal(snap.level, 'L4', '直接到 L4');
    const shuffles = env.bus.list({ action: 'shuffle_desktop' });
    equal(shuffles.length, 1, 'shuffle 真执行了');
    equal(env.esc.getState().level, 'L4', '级别 L4');
  } finally { env.cleanup(); }
});

suite.test('闸门：L5 未授权 → 模型说 L5 也被封顶，维持原级', async () => {
  const env = makeEnv(false);   // authorizeL4 = false
  try {
    env.esc.start();
    env.clock.clearAll();
    env.clock.advance(5 * 60000);
    const llm = stubLlm(() => ({ level: 'L5', suspend: false, revoke: false, reason: '隔离游戏文件' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 5 });
    equal(snap.level, 'L0', '维持原级 L0');
    equal(snap.status, STATUS.CAPPED, 'CAP 状态（当天/授权封顶）');
    const q = env.bus.list({ action: 'quarantine_files' });
    equal(q.length, 0, 'L5 没执行');
  } finally { env.cleanup(); }
});

suite.test('闸门：L5 已授权且间隔够 → 真隔离', async () => {
  const env = makeEnv(true);    // authorizeL4 = true
  try {
    env.esc.start();
    env.clock.clearAll();
    env.clock.advance(5 * 60000);
    const llm = stubLlm(() => ({ level: 'L5', suspend: false, revoke: false, reason: '多次无效，隔离' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 5 });
    equal(snap.level, 'L5', '到 L5');
    const q = env.bus.list({ action: 'quarantine_files' });
    equal(q.length, 1, 'L5 真执行');
    equal(fs.existsSync(path.join(env.root, '游戏截图.png')), false, '原位已空');
  } finally { env.cleanup(); }
});

suite.test('闸门：模型不能自选 action（L5 只能 quarantine_files）', async () => {
  const env = makeEnv(true);
  try {
    env.esc.start();
    env.clock.clearAll();
    env.clock.advance(5 * 60000);
    const llm = stubLlm(() => ({ level: 'L5', suspend: false, revoke: false, reason: 'x', action: 'delete_files' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 5 });
    equal(snap.level, 'L5', 'L5');
    const q = env.bus.list({ action: 'quarantine_files' });
    equal(q.length, 1, 'action 仍是 quarantine_files，模型塞的 action 被忽略');
    const bad = env.bus.list({ action: 'delete_files' });
    equal(bad.length, 0, '不存在模型自造的 action');
  } finally { env.cleanup(); }
});

suite.test('模型不可用 → 不退回规则链，亮错误', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    const llm = stubLlm(() => ({ __throw: 'HTTP 500' }));
    const snap = await env.esc.escalateWithLlm({ llm, state: 'lying_bed', confidence: 0.9, waitedMin: 5 });
    contains(snap.reason, 'strategist 模型不可用', '错误亮出来');
    equal(env.esc.getState().level, 'L0', '没偷偷升级');
    const before = env.bus.list({ action: 'popup_countdown' }).length;
    equal(before, 0, '没有任何新指令');
  } finally { env.cleanup(); }
});

suite.test('缺 llm 参数直接抛错', async () => {
  const env = makeEnv(false);
  try {
    let threw = 0;
    try { await env.esc.escalateWithLlm({ state: 'lying_bed', waitedMin: 1 }); } catch (e) { threw++; }
    equal(threw, 1, '抛错');
  } finally { env.cleanup(); }
});

// ---------- 撤销后 ----------

suite.test('撤销后再调 escalateWithLlm → 直接 revoke（模型不重复问）', async () => {
  const env = makeEnv(false);
  try {
    env.esc.start();
    env.esc.completeStep();
    const llm = stubLlm(() => { throw new Error('不应被调用'); });
    const snap = await env.esc.escalateWithLlm({ llm, state: 'seated_desk', confidence: 0.9, waitedMin: 0 });
    equal(snap.status, STATUS.REVOKED, '维持撤销');
    equal(llm.calls.length, 0, '模型没被问');
  } finally { env.cleanup(); }
});

suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});
