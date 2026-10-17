'use strict';
/**
 * service.cjs —— discipline-agent 对前端的唯一入口（纯逻辑，可单测）
 *
 * 设计原则：
 *   1. 前端只读：前端通过本文件拿"指令 JSON / 状态模型 / 审计"，不做任何文件操作。
 *   2. 指令契约由 instructions.js 校验，本文件只做装配与转发，不复制枚举。
 *   3. 数字只由确定性代码算出；LLM 只产对话文本与建议（见 NOTES.md 红线）。
 *   4. 所有文件操作都在 workRoot 内，永不删除，全程可还原。
 *
 * 与 haipigua 的关系：haipigua 前端通过 /api/discipline/* 调用这里；
 * 本文件不感知 HTTP，HTTP 细节在 server.cjs。
 */

const path = require('path');
const os = require('os');
const {
  createInstructionBus, isoWithOffset, validateInstruction, LEVEL_ACTION, LEVELS, ACTIONS
} = require('../instructions');
const { createExecutor } = require('../executor');
const { createEscalation, STATUS } = require('../escalation');
const { createAuditLog } = require('../audit');
const { createStateSensor, escalationEligibility } = require('../state-sensor');

const BRIDGE_VERSION = '0.1.0';

/**
 * createDisciplineService —— 装配一套 A 侧运行时
 * @param {object} opts
 *   workRoot    受控工作根（executor 只在此范围内动手）；默认 os.tmpdir 下的专属目录
 *   auditPath   审计 JSONL 路径；默认 workRoot/.discipline/audit/audit.jsonl
 *   options     传给 createEscalation 的 options（taskId / authorizeL4 / dailyCap / l4Targets / shuffleTargetDir / plan）
 *   clock       可注入时钟（测试用假时钟）；默认真实时钟
 */
function createDisciplineService(opts) {
  const options = opts || {};
  const workRoot = options.workRoot || path.join(os.tmpdir(), 'discipline-agent-bridge');
  const auditPath = options.auditPath || path.join(workRoot, '.discipline', 'audit', 'audit.jsonl');
  const clock = options.clock || { now: () => Date.now() };
  const nowFn = () => clock.now();

  const bus = createInstructionBus({ logPath: auditPath, nowFn });
  const executor = createExecutor({ workRoot, auditPath, nowFn });
  // 审计：主审计流独立于指令总线 JSONL；把总线/账本挂成只读源，四段链路一起查
  const audit = createAuditLog({
    path: auditPath,
    sources: [bus.logPath, executor.store && executor.store.path].filter(Boolean),
    nowFn: () => isoWithOffset(new Date(nowFn()))
  });

  let escalation = null;
  let currentState = null;       // 最近一次状态模型（前端展示用）
  let lastInstruction = null;

  /** 懒建状态机：首次 tick 时才装配，带着当时的 options */
  function ensureEscalation(over) {
    if (escalation && !over) return escalation;
    const merged = Object.assign({}, options.options || {}, over || {});
    escalation = createEscalation({
      bus, executor, clock,
      options: Object.assign({
        taskId: merged.taskId || 'task_bridge',
        authorizeL4: merged.authorizeL4 === true,
        dailyCap: merged.dailyCap,
        l4Targets: Array.isArray(merged.l4Targets) ? merged.l4Targets : [],
        shuffleTargetDir: merged.shuffleTargetDir || workRoot,
        plan: merged.plan,
        stateEvidence: merged.stateEvidence || currentState
      }, merged)
    });
    return escalation;
  }

  /** 把状态模型规范化成契约 6.2 的形状（缺失字段补 unknown，不猜） */
  function normalizeState(input) {
    const s = input || {};
    return {
      state: typeof s.state === 'string' ? s.state : 'unknown',
      confidence: typeof s.confidence === 'number' ? s.confidence : 0,
      evidence: typeof s.evidence === 'string' ? s.evidence : '',
      explain: typeof s.explain === 'string' ? s.explain : '',
      capturedAt: s.capturedAt || isoWithOffset(new Date(nowFn())),
      source: s.source || 'manual'
    };
  }

  /**
   * tick —— 推进一次升级判断，返回前端要的指令
   * 输入 { state, confidence, evidence, explain, waitedMin, options? }
   * 输出 { instructionId, level, action, payload, status, reason, state, explain }
   */
  function tick(input) {
    const req = input || {};
    currentState = normalizeState(req);
    const esc = ensureEscalation(req.options);
    const snap = esc.tick();
    lastInstruction = pickInstruction(snap);
    return view(snap);
  }

  /** start —— 启动升级链（下发 L0） */
  function start(input) {
    const req = input || {};
    if (req.state) currentState = normalizeState(req.state);
    const esc = ensureEscalation(req.options);
    const snap = esc.start();
    lastInstruction = pickInstruction(snap);
    return view(snap);
  }

  /** ack / complete —— 前端回执 */
  function ack(instructionId) {
    const ins = bus.get(instructionId);
    if (!ins) return { ok: false, error: 'NOT_FOUND' };
    bus.ack(instructionId, { by: 'frontend' });
    return { ok: true };
  }

  function complete(instructionId) {
    const ins = bus.get(instructionId);
    if (!ins) return { ok: false, error: 'NOT_FOUND' };
    bus.complete(instructionId, { by: 'frontend' });
    return { ok: true };
  }

  /** completeStep —— 用户完成了一步：立即撤销全部强制并还原 */
  function completeStep(reason) {
    const esc = ensureEscalation();
    const snap = esc.completeStep(reason);
    return view(snap);
  }

  /** revoke —— 无条件全量还原 */
  function revoke(reason) {
    const esc = ensureEscalation();
    const snap = esc.revoke(reason || '前端请求撤销');
    return view(snap);
  }

  /** restore —— 只做文件还原（不碰状态机），前端"一键还原"按钮用 */
  function restore() {
    const out = executor.restoreAll();
    return { ok: out.ok !== false, restored: out.restored || 0, lost: out.lost || 0, detail: out };
  }

  /** state —— 前端轮询用：状态机 + 当前状态模型 + 计数 */
  function state() {
    const esc = escalation;
    const st = esc ? esc.getState() : { level: 'L0', status: STATUS.IDLE, reason: '尚未启动' };
    return {
      escalation: st,
      state: currentState,
      counts: bus.counts(),
      manifests: executor.listManifests().map(m => ({
        manifestId: m.manifestId, kind: m.kind, createdAt: m.createdAt
      }))
    };
  }

  /**
   * auditQuery —— 审计查询（B 展示"读了什么 / 依据什么 / 下了什么指令 / 执行还原了什么"）
   * action: byTask | byRange | traceInstruction | forcedCount | readAll
   */
  function auditQuery(input) {
    const req = input || {};
    const action = req.action || 'byTask';
    if (action === 'byTask') return audit.byTask(req.taskId);
    if (action === 'byRange') return audit.byRange(req.from, req.to);
    if (action === 'traceInstruction') return audit.traceInstruction(req.instructionId, req.manifestId);
    if (action === 'forcedCount') return audit.forcedCount(req.taskId);
    return audit.readAll();
  }

  /** capabilities —— 自述能力，对齐 haipigua 的 /api/health 风格 */
  function capabilities() {
    return {
      ready: true,
      version: BRIDGE_VERSION,
      workRoot,
      auditPath,
      levels: LEVELS,
      actions: ACTIONS,
      levelAction: LEVEL_ACTION,
      localActions: ['shuffle_desktop', 'quarantine_files', 'revoke_all'],
      capabilities: {
        stateTick: true,
        instructionBus: true,
        localFileOps: true,
        restore: true,
        audit: true,
        camera: false,          // 摄像头由前端/另一路提供，本桥不做视觉推理
        llm: false              // 本桥不直连模型；模型调用仍走 llm/llm-client
      }
    };
  }

  /**
   * 从快照挑出前端要执行的指令。
   * 快照只在"真的升级了"时才带 instructionId；被时间门禁/单日上限拦住时没有新指令，
   * 此时按快照 level 回查总线该级最近一条指令，保证前端始终拿得到"当前该做什么"。
   */
  function pickInstruction(snap) {
    if (!snap) return null;
    if (snap.instructionId) {
      const direct = bus.get(snap.instructionId);
      if (direct) return direct;
    }
    const lvl = snap.level;
    if (!lvl) return null;
    const rows = bus.list({}).filter(i => i.level === lvl);
    return rows.length ? rows[rows.length - 1] : null;
  }

  /** view —— 统一响应形状 */
  function view(snap) {
    const ins = lastInstruction;
    return {
      instructionId: ins ? ins.id : null,
      level: snap && snap.level !== undefined ? snap.level : null,
      action: ins ? ins.action : (snap && snap.action) || null,
      payload: ins && ins.payload ? ins.payload : null,
      reversible: ins ? ins.reversible === true : null,
      status: snap && snap.status !== undefined ? snap.status : null,
      reason: snap && snap.reason !== undefined ? snap.reason : null,
      gateBlocked: snap && snap.gateBlocked === true,
      state: currentState,
      restore: snap && snap.restore ? snap.restore : null,
      instruction: ins ? {
        id: ins.id, level: ins.level, action: ins.action, taskId: ins.taskId,
        step: ins.step, issuedAt: ins.issuedAt, expiresAt: ins.expiresAt,
        reversible: ins.reversible, manifestId: ins.manifestId,
        payload: ins.payload || null, reason: ins.reason
      } : null
    };
  }

  return {
    workRoot, auditPath, bus, executor,
    start, tick, ack, complete, completeStep, revoke, restore, state, auditQuery, capabilities,
    validate: validateInstruction,
    verify: () => { if (!escalation) ensureEscalation(); return escalation.getState(); }
  };
}

module.exports = { createDisciplineService, BRIDGE_VERSION };
