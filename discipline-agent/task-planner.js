'use strict';
/**
 * task-planner.js —— 状态驱动任务拆步（A-M3 交付，架构变更后）
 *
 * 拆步判断交给 planner 模型（prompt 见 llm/roles.js）；本文件保留：
 *   1. 状态归一化 normalizeState（契约：低置信度一律按 unknown）
 *   2. planWithLlm 的确定性校验：≤7 步、单步 ≤3 分钟（物理约束，超了截断并标注）
 *   3. 安全短路：away → 不拆步；learning → 顺延不打扰；unknown → 只确认
 *      （这些是安全约束，不交给模型，模型无权绕过）
 *
 * 原规则版步骤库/拆步实现（STEP_LIBRARY/plan/replan 等约 250 行）已按用户
 * 决定**物理删除**，生产路径纯模型，模型不可用不静默兜底。
 */

/** 状态枚举（与 instructions.js / state-sensor.js 共用，契约不许改） */
const STATES = Object.freeze([
  'lying_bed', 'seated_desk', 'standing_or_moving', 'away', 'learning', 'unknown'
]);

/** 单步时长上限（分钟） */
const MAX_STEP_MINUTES = 3;
/** 步数上限 */
const MAX_STEPS = 7;

/** 低置信度阈值：低于它按 unknown 处理 */
const LOW_CONFIDENCE = 0.6;

/** 归一化状态：低置信度一律按 unknown 处理（宁可 unknown 也不瞎猜） */
function normalizeState(state) {
  if (!state || typeof state !== 'object') return 'unknown';
  const s = state.state;
  if (STATES.indexOf(s) === -1) return 'unknown';
  const conf = typeof state.confidence === 'number' ? state.confidence : 0;
  if (conf < LOW_CONFIDENCE) return 'unknown';
  return s;
}

/**
 * planWithLlm —— 模型版拆步（架构变更后的生产入口）
 *
 * 拆步判断交给 planner 模型（prompt 见 llm/roles.js）；
 * 本函数只做两件确定性的事（schema 校验，不算规则判断）：
 *   1. 步数 ≤7、每步 ≤3 分钟——物理约束，模型超了就截断并标注
 *   2. away/learning/unknown → 空步表挂起——安全约束，模型无权绕过
 *
 * 用户选择"纯模型，删掉兜底"：模型不可用时不退回规则库（STEP_LIBRARY），
 * 直接返回 ok:false 让上层处理。
 */
async function planWithLlm(task, state, opts) {
  const options = opts || {};
  const llm = options.llm;
  if (!llm || typeof llm.chatJson !== 'function') {
    throw new Error('planWithLlm 需要 opts.llm（createLlmClient 的返回值）');
  }
  const st = normalizeState(state);
  // 安全约束（不可交给模型）：人不在场 / 已在学习 / 状态不明 → 不拆步
  if (st === 'away') {
    return { ok: true, mode: 'hold', steps: [], violations: [], explain: '人不在场，先找人提醒。', firstStep: null, llmSkipped: 'away' };
  }
  if (st === 'learning') {
    return { ok: true, mode: 'defer', steps: [], violations: [], explain: '已在学习，顺延不打扰。', firstStep: null, llmSkipped: 'learning' };
  }
  if (st === 'unknown') {
    return { ok: true, mode: 'confirm', steps: [], violations: [], explain: '状态不明，先确认人在哪。', firstStep: null, llmSkipped: 'unknown' };
  }

  const roleDefs = require('./llm/roles').roles;
  const user = roleDefs.planner.buildUser({
    subject: task.subject || task.content || '任务',
    content: task.content || '',
    state: st,
    stateExplain: (state && state.explain) || ''
  });
  const res = await llm.chatJson('planner', roleDefs.planner.system, user);
  if (!res.ok) {
    return { ok: false, error: res.error, mode: 'error', steps: [], violations: [], firstStep: null, llm: res };
  }

  const rawSteps = Array.isArray(res.data.steps) ? res.data.steps : [];
  const violations = [];
  const steps = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    if (steps.length >= MAX_STEPS) { violations.push('步数超上限，第 ' + (steps.length + 1) + ' 步起被截断'); break; }
    const minutes = Number(s.minutes);
    let m = Number.isFinite(minutes) ? minutes : 2;
    if (m < 1) m = 1;
    if (m > MAX_STEP_MINUTES) { violations.push('「' + s.label + '」声称 ' + m + ' 分钟，超 3 分钟上限，按 3 分钟计'); m = MAX_STEP_MINUTES; }
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : '(未命名步骤)';
    steps.push({
      index: steps.length,
      id: 'llm-' + steps.length,
      label,
      minutes: m,
      doneSignal: typeof s.doneSignal === 'string' && s.doneSignal.trim() ? s.doneSignal.trim() : '完成「' + label + '」'
    });
  }
  if (!steps.length) {
    return { ok: true, mode: 'confirm', steps: [], violations, explain: String(res.data.explain || '模型未给出步骤，先确认。'), firstStep: null, llm: res };
  }
  return {
    ok: true,
    mode: 'plan',
    steps,
    firstStep: steps[0],
    violations,
    explain: String(res.data.explain || '') + (violations.length ? '；' + violations.join('；') : ''),
    llm: res
  };
}

module.exports = {
  STATES, MAX_STEP_MINUTES, MAX_STEPS, LOW_CONFIDENCE,
  normalizeState, planWithLlm
};
