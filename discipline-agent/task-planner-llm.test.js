'use strict';
/**
 * task-planner-llm.test.js —— A-M3 测试：模型版拆步（planWithLlm）
 * 运行：node task-planner-llm.test.js
 *
 * 验证"模型拆步 + 确定性约束"：
 *   - planner 模型正常拆步 → steps 结构合规
 *   - 安全约束（away/learning/unknown → 空步表）不问模型
 *   - 步数超 7 截断、每步超 3 分钟按 3 分钟计并留痕
 *   - 缺字段给默认值
 *   - 模型不可用 → ok:false 不退回规则库
 */

const { planWithLlm, MAX_STEPS, MAX_STEP_MINUTES } = require('./task-planner');
const { roles } = require('./llm/roles');
const { ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('task-planner-llm.test.js');

/** 桩 LLM */
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

function makeState(state) {
  return { state, confidence: 0.9, explain: '测试状态' };
}

suite.test('planner 角色被调用，prompt 带任务与状态', async () => {
  const llm = stubLlm(() => ({ steps: [{ label: '坐起来', minutes: 1, doneSignal: '脚落地' }], explain: '先离开床' }));
  const res = await planWithLlm(
    { subject: '数学', content: '写数学作业' },
    makeState('lying_bed'),
    { llm }
  );
  ok(res.ok, 'ok');
  equal(llm.calls.length, 1, '调一次');
  const c = llm.calls[0];
  equal(c.role, 'planner', 'planner 角色');
  equal(c.system, roles.planner.system, 'system prompt');
  contains(c.user, '数学', '带科目');
  contains(c.user, 'lying_bed', '带状态');
});

suite.test('躺着状态 → 模型拆出的步骤合规（index/id/minutes/doneSignal）', async () => {
  const llm = stubLlm(() => ({
    steps: [
      { label: '坐起来', minutes: 1, doneSignal: '双脚落地' },
      { label: '下床', minutes: 1, doneSignal: '站到地上' },
      { label: '打开数学作业本', minutes: 2, doneSignal: '本子摊开在桌上' }
    ],
    explain: '先离开床再开本子'
  }));
  const res = await planWithLlm({ subject: '数学', content: '写数学作业' }, makeState('lying_bed'), { llm });
  equal(res.mode, 'plan', '计划模式');
  equal(res.steps.length, 3, '3 步');
  equal(res.steps[0].index, 0, '第一 index=0');
  equal(res.steps[0].label, '坐起来', '第一步内容');
  equal(res.steps[0].minutes, 1, '分钟数');
  equal(res.steps[0].doneSignal, '双脚落地', '完成信号');
  equal(res.firstStep.label, '坐起来', 'firstStep 指向第一步');
});

suite.test('已坐书桌前 → 模型可跳过起床动作（契约交给模型，只验透传）', async () => {
  const llm = stubLlm(() => ({ steps: [{ label: '打开数学作业本', minutes: 2, doneSignal: '本子摊开' }], explain: '已坐好，直接开始' }));
  const res = await planWithLlm({ subject: '数学', content: '写数学作业' }, makeState('seated_desk'), { llm });
  equal(res.steps.length, 1, '1 步');
  equal(res.steps[0].label, '打开数学作业本', '直接开始');
});

// ---------- 安全约束：不问模型 ----------

for (const [state, mode, note] of [
  ['away', 'hold', '人不在场，先找人提醒'],
  ['learning', 'defer', '已在学习，顺延不打扰'],
  ['unknown', 'confirm', '状态不明，先确认']
]) {
  suite.test(state + ' → ' + note + '（不问模型）', async () => {
    const llm = stubLlm(() => { throw new Error('不该被调用'); });
    const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState(state), { llm });
    equal(llm.calls.length, 0, '模型没被问');
    equal(res.ok, true, 'ok');
    equal(res.mode, mode, 'mode=' + mode);
    equal(res.steps.length, 0, '无步骤');
    contains(res.explain, note.split('，')[0], '说明文字');
  });
}

// ---------- 确定性约束（模型超了就截断） ----------

suite.test('步数超上限 → 截断并留痕', async () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ label: '第' + i + '步', minutes: 1, doneSignal: 'done' });
  const llm = stubLlm(() => ({ steps: many, explain: '' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  equal(res.steps.length, MAX_STEPS, '最多 ' + MAX_STEPS + ' 步');
  ok(res.violations.some(v => v.indexOf('步数超上限') !== -1), '留痕');
  contains(res.explain, '截断', 'explain 也说明');
});

suite.test('单步超 3 分钟 → 按 3 分钟计并留痕', async () => {
  const llm = stubLlm(() => ({ steps: [{ label: '把数学作业全写完', minutes: 30, doneSignal: '全写完' }], explain: '' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  equal(res.steps[0].minutes, MAX_STEP_MINUTES, '按 ' + MAX_STEP_MINUTES + ' 分钟计');
  ok(res.violations.some(v => v.indexOf('超 3 分钟上限') !== -1), '留痕');
});

suite.test('minutes 缺失/非法 → 默认 2 分钟；小于 1 → 提到 1', async () => {
  const llm = stubLlm(() => ({ steps: [
    { label: 'a', doneSignal: 'x' },
    { label: 'b', minutes: 'abc', doneSignal: 'x' },
    { label: 'c', minutes: 0, doneSignal: 'x' },
    { label: 'd', minutes: -5, doneSignal: 'x' }
  ], explain: '' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  equal(res.steps[0].minutes, 2, '缺失 → 2');
  equal(res.steps[1].minutes, 2, '非数字 → 2');
  equal(res.steps[2].minutes, 1, '0 → 1');
  equal(res.steps[3].minutes, 1, '负数 → 1');
});

suite.test('缺 label/doneSignal → 有默认值不崩', async () => {
  const llm = stubLlm(() => ({ steps: [{ minutes: 2 }, null, '字符串'], explain: '' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  ok(res.steps.every(s => typeof s.label === 'string' && s.label.length > 0), 'label 有默认值');
  ok(res.steps.every(s => typeof s.doneSignal === 'string' && s.doneSignal.length > 0), 'doneSignal 有默认值');
});

suite.test('模型给空 steps → confirm 模式', async () => {
  const llm = stubLlm(() => ({ steps: [], explain: '拆不出来' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  equal(res.mode, 'confirm', 'confirm');
  equal(res.steps.length, 0, '无步骤');
  contains(res.explain, '拆不出来', '模型说明透传');
});

suite.test('steps 不是数组 → confirm 模式', async () => {
  const llm = stubLlm(() => ({ steps: '三步', explain: '' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('seated_desk'), { llm });
  equal(res.mode, 'confirm', 'confirm');
});

// ---------- 失败路径 ----------

suite.test('模型不可用 → ok:false，不退回规则库', async () => {
  const llm = stubLlm(() => ({ __throw: 'HTTP 500' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('lying_bed'), { llm });
  equal(res.ok, false, 'ok=false');
  contains(res.error, '500', '错误原因');
  equal(res.steps.length, 0, '无步骤（不兜底）');
  equal(res.mode, 'error', 'error 模式');
});

suite.test('缺 llm 参数直接抛错', async () => {
  let threw = 0;
  try { await planWithLlm({ subject: 'x' }, makeState('seated_desk'), {}); } catch (e) { threw++; }
  equal(threw, 1, '抛错');
});

suite.test('planWithLlm 的 explain 含模型解释', async () => {
  const llm = stubLlm(() => ({ steps: [{ label: '坐起来', minutes: 1, doneSignal: 'x' }], explain: '躺着先起来' }));
  const res = await planWithLlm({ subject: '数学', content: 'x' }, makeState('lying_bed'), { llm });
  contains(res.explain, '躺着先起来', '模型解释');
});

suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});
