'use strict';
/**
 * escalation.js —— L0→L4 升级规则状态机 + 与 bus/executor 联动（A-M4 交付）
 *
 * 铁律：
 *   1. **纯规则、不用 LLM**——强制动作必须可预测、可解释。
 *   2. 时钟/定时器可注入（测试用假时钟手动触发）。
 *   3. 时序：L0 → +2min → L1 → +3min → L2 → +5min → L3 → +5min → L4。
 *   4. 挂起/恢复由 strategist 模型决策（suspend 字段），不在状态机里写死；
 *      L2 以后只看步骤完成信号，不看画面。
 *   5. 单日强制（L2+）上限 3 次，达到后当天封顶 L1。
 *   6. L4 需 authorizeL4，未授权封顶 L3。
 *   7. 任一步完成 → revoke_all + 清定时器 + 停状态机。
 *   8. 每次 L3/L4 执行先写 manifest 再动手（由 executor 保证）。
 *   9. 摄像头证据**不能单独**触发 L2+：必须已有步骤完成信号缺失的计时，且
 *      当前步骤处于"已下发但未完成"状态。
 */

const { createInstructionBus, isoWithOffset } = require('./instructions');

/** 级别顺序与间隔（分钟） */
const LEVEL_ORDER = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4']);
const GAP_MINUTES = Object.freeze({ L0: 0, L1: 2, L2: 3, L3: 5, L4: 5 });
const LEVEL_ACTION = Object.freeze({
  L0: 'notify', L1: 'popup_countdown', L2: 'spawn_bugs',
  L3: 'shuffle_desktop', L4: 'quarantine_files'
});
/** 单日强制上限：L2 及以上算"强制" */
const FORCED_LEVELS = Object.freeze(['L2', 'L3', 'L4']);
const DAILY_FORCED_CAP = 3;

/** 状态机状态 */
const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUSPENDED: 'suspended',   // 模型判定挂起（等人回来）
  CAPPED: 'capped',         // 触达单日上限或未授权
  REVOKED: 'revoked',
  COMPLETED: 'completed'
});

function pad(n) { return String(n).padStart(2, '0'); }

/** 本地日期（+08:00）——单日上限按本地天计算 */
function localDate(ts) {
  const s = new Date(ts + 8 * 3600000);
  return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate());
}

/**
 * createEscalation
 * @param {object} opts
 * @param {object} opts.bus createInstructionBus() 的返回值（可注入桩）
 * @param {object} opts.executor createExecutor() 的返回值（可注入桩）
 * @param {object} opts.clock { now: ()=>ms, setTimeout, clearTimeout } 可注入假时钟
 * @param {object} [opts.options]
 * @param {boolean} [opts.options.authorizeL4=false]
 * @param {number} [opts.options.dailyCap=3]
 * @param {string[]} [opts.options.l4Targets] L4 要隔离的文件清单
 * @param {string} [opts.options.shuffleTargetDir]
 * @param {string} [opts.options.taskId]
 * @param {object} [opts.options.plan] task-planner 的计划结果（带 steps）
 */
function createEscalation(opts) {
  const options = (opts && opts.options) || {};
  const bus = opts.bus;
  const executor = opts.executor;
  const clock = (opts.clock) || {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  };
  if (!bus) throw new Error('createEscalation 需要 opts.bus');
  if (!executor) throw new Error('createEscalation 需要 opts.executor');

  const taskId = options.taskId || 'task_default';
  const authorizeL4 = options.authorizeL4 === true;
  const dailyCap = Number.isInteger(options.dailyCap) ? options.dailyCap : DAILY_FORCED_CAP;
  const l4Targets = Array.isArray(options.l4Targets) ? options.l4Targets : [];
  const plan = options.plan || null;
  const shuffleTargetDir = options.shuffleTargetDir || null;

  // ---- 内部状态 ----
  let status = STATUS.IDLE;
  let currentLevel = null;
  let lastEscalatedAt = null;   // 上次真正升级的时刻（时间门禁用）
  let reason = '尚未启动';
  let currentStep = plan && plan.steps && plan.steps.length ? plan.steps[0] : null;
  let stepDone = false;             // 当前步骤完成信号
  const history = [];               // 每轮 level/status/reason 快照
  // 单日强制计数：可外部注入（跨状态机共享，保证"单日上限"对同一用户全局生效）；
  // 不注入则每个状态机各记一份（仅用于隔离测试）。
  const forcedByDate = options.forcedByDate instanceof Map ? options.forcedByDate : new Map();
  const issuedByLevel = new Map();  // level → instruction id

  /** 时间门禁：距上次升级不足该级间隔，则不允许再升级（防 tick 连跳） */
  function canEscalateTo(level) {
    if (lastEscalatedAt === null) return true;          // 首发（L0）不设门禁
    const gap = GAP_MINUTES[level];
    if (!gap) return true;
    return clock.now() - lastEscalatedAt >= gap * 60000;
  }

  function snapshot(extra) {
    const snap = Object.assign({
      ts: isoWithOffset(new Date(clock.now())),
      status, level: currentLevel, reason,
      step: currentStep ? { index: currentStep.index, label: currentStep.label } : null,
      stepDone
    }, extra || {});
    history.push(snap);
    return snap;
  }

  function forcedCountToday() {
    const d = localDate(clock.now());
    return forcedByDate.get(d) || 0;
  }

  function bumpForced() {
    const d = localDate(clock.now());
    forcedByDate.set(d, forcedCountToday() + 1);
    return forcedByDate.get(d);
  }

  /** 当前允许达到的最高级别（单日上限 / 授权封顶） */
  function capLevel(level) {
    if (level === 'L4' && !authorizeL4) return 'L3';
    if (FORCED_LEVELS.indexOf(level) !== -1 && forcedCountToday() >= dailyCap) return 'L1';
    return level;
  }

  function issueFor(level) {
    const capped = capLevel(level);
    if (capped !== level) {
      reason = (level === 'L4' && !authorizeL4)
        ? 'L4 未授权，封顶 L3'
        : '单日强制（L2+）已达上限 ' + dailyCap + ' 次，当天封顶 L1';
      status = STATUS.CAPPED;
      snapshot({ cappedFrom: level, cappedTo: capped });
      return null;
    }
    const action = LEVEL_ACTION[capped];
    let payload = null;
    if (capped === 'L3') payload = shuffleTargetDir ? { targetDir: shuffleTargetDir } : {};
    if (capped === 'L4') payload = { targets: l4Targets };
    // 契约要求非 revoke_all 指令必须带 step 对象；计划缺失时给一个占位步，
    // 保证"判定到点"这类没有具体步骤的场景也能合法下发。
    // stateAtPlan 必须落在状态枚举内，取 stateEvidence.state，缺省 unknown。
    const ev = options.stateEvidence || {};
    const stateAtPlan = typeof ev.state === 'string' && ev.state ? ev.state : 'unknown';
    const stepObj = currentStep
      ? { index: currentStep.index, label: currentStep.label, stateAtPlan: stateAtPlan }
      : { index: 0, label: '开始当前任务', stateAtPlan };
    const nxt = nextLevel(capped);
    // L4 是顶级，没有下一级，expiresAt 用本级间隔兜底（不能算成 NaN）
    const gapForExpiry = nxt ? GAP_MINUTES[nxt] : GAP_MINUTES[capped];
    const ins = bus.issue({
      id: 'ins_' + taskId + '_' + capped + '_' + Math.abs(clock.now()).toString(36),
      level: capped,
      action,
      taskId,
      step: stepObj,
      issuedAt: isoWithOffset(new Date(clock.now())),
      expiresAt: isoWithOffset(new Date(clock.now() + gapForExpiry * 60000)),
      reversible: capped === 'L3' || capped === 'L4',
      manifestId: null,
      payload,
      reason,
      stateEvidence: options.stateEvidence || null
    });
    issuedByLevel.set(capped, ins.id);
    currentLevel = capped;
    if (FORCED_LEVELS.indexOf(capped) !== -1) bumpForced();
    return ins;
  }

  function nextLevel(level) {
    const i = LEVEL_ORDER.indexOf(level);
    return i >= 0 && i + 1 < LEVEL_ORDER.length ? LEVEL_ORDER[i + 1] : null;
  }

  /** 真正执行本地动作（L3/L4），由 executor 落地 */
  function runLocal(ins) {
    if (!ins) return null;
    const rec = bus.get(ins.id);
    if (!rec) return null;
    if (rec.action === 'shuffle_desktop' || rec.action === 'quarantine_files') {
      bus.ack(ins.id, { by: 'executor' });
      const out = executor.execute(rec);
      bus.complete(ins.id, { ok: !!out.ok, manifestId: out.manifestId || null, moved: out.moved !== undefined ? out.moved : out.shuffled });
      // 把 manifestId 回填到指令记录，供审计与 revoke 追踪
      rec.manifestId = out.manifestId || null;
      return out;
    }
    bus.ack(ins.id, { by: 'frontend' });
    return { ok: true, action: rec.action, local: false };
  }

  /**
   * 进入下一级（机械执行 + 物理闸门，不含决策）。
   *
   * 决策由 escalateWithLlm（strategist 模型）给出；本函数只负责：
   * 时间门禁 / 单日上限 / L4 授权封顶（物理闸门）→ 下发指令 → 落地 → 记快照。
   * 原"自动升级定时器链"已按纯模型架构删除：升级时机一律由模型决策，
   * tick() 仅作为测试/联调的手动推进入口。
   */
  function escalate(opts) {
    if (status === STATUS.REVOKED || status === STATUS.COMPLETED) return snapshot({ skipped: '已停止' });
    if (stepDone) return revoke('当前步骤已完成');

    const from = currentLevel;
    const to = from === null ? 'L0' : nextLevel(from);
    if (!to) {
      status = STATUS.CAPPED;
      reason = '已到 L4 顶';
      return snapshot();
    }
    // 时间门禁：手动 tick 也不能跳过真实间隔，否则"每级之间留足等待时间"失效
    if (!canEscalateTo(to)) {
      const need = Math.ceil((GAP_MINUTES[to] * 60000 - (clock.now() - (lastEscalatedAt || clock.now()))) / 1000);
      reason = '距上次升级不足 ' + GAP_MINUTES[to] + ' 分钟（还需约 ' + Math.max(need, 1) + ' 秒），本次不升级';
      snapshot({ skipped: 'interval_not_reached', need: to });
      return snapshot();
    }
    const ins = issueFor(to);
    if (!ins) return snapshot();
    lastEscalatedAt = clock.now();
    const out = runLocal(ins);
    reason = from === null
      ? '判定到点，下发 ' + to
      : '上一级 ' + from + ' 超过 ' + GAP_MINUTES[to] + ' 分钟无响应，升级到 ' + to;
    snapshot({ instructionId: ins.id, localResult: out ? { ok: out.ok, manifestId: out.manifestId || null } : null });

    if (!nextLevel(to)) {
      status = STATUS.CAPPED;
      reason = '已到 L4 顶，等待用户完成步骤';
    }
    return snapshot();
  }

  /** 启动（从 L0 开始） */
  function start(extraReason) {
    if (status === STATUS.RUNNING) return snapshot({ skipped: '已在运行' });
    if (status === STATUS.REVOKED || status === STATUS.COMPLETED) {
      return snapshot({ skipped: '已结束，需重新创建状态机' });
    }
    status = STATUS.RUNNING;
    reason = extraReason || '判定到点，启动干预状态机';
    return escalate();
  }

  /** 步骤完成 → revoke_all + 停状态机 + 全量还原 */
  function revoke(why) {
    stepDone = true;
    status = STATUS.REVOKED;
    reason = why || '用户完成一步，撤销全部强制效果';
    const ins = bus.issue({
      id: 'ins_' + taskId + '_revoke_' + Math.abs(clock.now()).toString(36),
      level: null, action: 'revoke_all', taskId,
      step: null, issuedAt: isoWithOffset(new Date(clock.now())), expiresAt: null,
      reversible: true, manifestId: null, reason
    });
    bus.ack(ins.id, { by: 'executor' });
    const out = executor.execute(ins);
    bus.complete(ins.id, out);
    bus.revoke(taskId, '任务完成，撤销全部未完成指令');
    return snapshot({ instructionId: ins.id, restore: out });
  }

  /** 标记当前步骤完成（供外部调用） */
  function completeStep() {
    return revoke('步骤完成信号到达');
  }

  function getState() {
    return {
      taskId, status, level: currentLevel, reason,
      step: currentStep ? { index: currentStep.index, label: currentStep.label } : null,
      stepDone,
      forcedToday: forcedCountToday(),
      authorizeL4, dailyCap,
      issuedLevels: Array.from(issuedByLevel.keys())
    };
  }

  function getHistory() { return history.slice(); }

  /** 手动把时钟推到下一级（测试/联调用）；生产路径由 escalateWithLlm 决策 */
  function tick() { return escalate(); }

  /**
   * escalateWithLlm —— 模型决策版升级（架构变更后的生产入口）
   *
   * strategist 模型决定"该不该升 / 升到哪 / 是否撤销 / 是否挂起"，
   * 但下面这些是**物理闸门**，模型无权绕过（NOTES.md 架构变更记录）：
   *   1. 步骤已完成 → 无条件 revoke_all（模型说了不算）
   *   2. 时间门禁：距上次升级不足该级间隔，不许升
   *   3. 单日上限 + L4 授权（capLevel）
   *   4. action 由 level 映射表决定，模型不能自选动作
   *   5. L4 targets 只来自 options.l4Targets
   *   6. level 只认 L0..L4，其他值一律当 null（不动）
   *
   * @param {object} ctx 态势（模型看的输入）：
   *   { state, confidence, stateExplain, waitedMin, llm }
   *   llm 为 createLlmClient() 的返回值，必传。
   * @returns {Promise<object>} snapshot（含 modelDecision 字段）
   */
  async function escalateWithLlm(ctx) {
    const c = ctx || {};
    const llm = c.llm;
    if (!llm || typeof llm.chatJson !== 'function') {
      throw new Error('escalateWithLlm 需要 ctx.llm（createLlmClient 的返回值）');
    }
    // 闸门 1：完成信号 > 一切
    if (stepDone || status === STATUS.REVOKED || status === STATUS.COMPLETED) {
      return revoke('当前步骤已完成');
    }
    if (status === STATUS.IDLE) status = STATUS.RUNNING;
    const roleDefs = require('./llm/roles').roles;
    const user = roleDefs.strategist.buildUser({
      now: isoWithOffset(new Date(clock.now())),
      stepLabel: currentStep ? currentStep.label : '无',
      stepIndex: currentStep ? currentStep.index : -1,
      state: c.state || 'unknown',
      confidence: c.confidence === undefined ? '?' : c.confidence,
      stateExplain: c.stateExplain || '无',
      waitedMin: c.waitedMin === undefined ? 0 : c.waitedMin,
      currentLevel: currentLevel || '无',
      stepDone: false,
      forcedToday: forcedCountToday(),
      authorizeL4
    });
    const res = await llm.chatJson('strategist', roleDefs.strategist.system, user);
    if (!res.ok) {
      // 纯模型架构：模型不可用不退回规则链，停在这里把错误亮出来
      reason = 'strategist 模型不可用：' + res.error;
      snapshot({ modelDecision: null, modelError: res.error });
      return snapshot();
    }
    const d = res.data || {};
    const wantLevel = LEVEL_ORDER.indexOf(d.level) !== -1 ? d.level : null;

    // 模型判断撤销：仍然走闸门 1 的 revoke（全量还原不被禁止）
    if (d.revoke === true) {
      const snap = revoke(String(d.reason || '模型判定用户已完成'));
      snap.modelDecision = d;
      return snap;
    }
    // 模型判断挂起：等人回来
    if (d.suspend === true) {
      status = STATUS.SUSPENDED;
      reason = 'strategist：' + String(d.reason || '用户不在场，挂起');
      const snap = snapshot({ modelDecision: d });
      return snap;
    }
    // 模型说不动 / 非法 level：记快照即止
    if (!wantLevel) {
      reason = 'strategist：' + String(d.reason || '暂不干预');
      const snap = snapshot({ modelDecision: d });
      return snap;
    }
    // 闸门 6：只升不降——目标级别不高于当前级 + 1 链上有效值时按模型意愿执行；
    // 但 time-gap / capLevel 由 escalate 内部闸门 2、3 兜住。
    // 这里复用 escalate 的下发逻辑：先强制把"当前级"语义对齐——
    // escalate 总是发 nextLevel(current)。若模型要的级别 ≠ nextLevel(current)，
    // 只有"等于或低于当前级"才安全降级为不动。
    const from = currentLevel;
    const naturalNext = from === null ? 'L0' : nextLevel(from);
    if (from !== null && LEVEL_ORDER.indexOf(wantLevel) <= LEVEL_ORDER.indexOf(from)) {
      reason = 'strategist：' + String(d.reason || '维持当前级别');
      return snapshot({ modelDecision: d });
    }
    if (wantLevel !== naturalNext) {
      // 模型想跳级：临时把当前级视为目标级的前一级，让 escalate 直接发目标级。
      // 闸门仍然兜住：时间门禁按目标级间隔检查；capLevel 检查单日上限与 L4 授权。
      const savedFrom = currentLevel;
      currentLevel = LEVEL_ORDER[LEVEL_ORDER.indexOf(wantLevel) - 1];
      let snap = escalate();
      // 注意：escalate 返回的快照不带 instructionId（成功路径会 push 两个快照，
      // 返回的是第二个），所以用 currentLevel 是否到达目标级判断是否真发出。
      if (currentLevel !== wantLevel) {
        // 没发出去（被闸门拦下/挂起/已停止）：恢复现场后重建快照，
        // 不让快照里带临时级别值误导审计。
        currentLevel = savedFrom;
        snap = snapshot({ modelDecision: d, gateBlocked: true, blockedTarget: wantLevel });
        return snap;
      }
      snap.modelDecision = d;
      snap.strategistReason = String(d.reason || '');
      return snap;
    }
    const snap = escalate();
    snap.modelDecision = d;
    snap.strategistReason = String(d.reason || '');
    // 模型给了理由但 escalate 的链式文案没带上时，融合成"模型理由（链式事实）"，
    // 同步更新状态机 reason，保证 getState() 与快照一致。
    if (d.reason && snap.reason.indexOf(String(d.reason)) === -1) {
      reason = String(d.reason) + '（' + snap.reason + '）';
      snap.reason = reason;
    }
    return snap;
  }

  return {
    start, escalate: tick, tick, escalateWithLlm, revoke, completeStep, getState, getHistory,
    LEVEL_ORDER, GAP_MINUTES, STATUS, DAILY_FORCED_CAP,
    setStep(step) { currentStep = step; }
  };
}

module.exports = { createEscalation, LEVEL_ORDER, GAP_MINUTES, LEVEL_ACTION, STATUS, FORCED_LEVELS, DAILY_FORCED_CAP, localDate };
