'use strict';
/**
 * instructions.js —— 指令 schema 校验 + 指令总线 + JSONL 审计（A-M0 交付）
 *
 * 契约来源：A任务提示词.md 6.1。本文件是 A↔B 唯一指令契约的落地实现，
 * 字段名与枚举不许擅改；要改必须先改 NOTES.md 再改这里。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** action 枚举（契约定死，见 6.1） */
const ACTIONS = Object.freeze([
  'notify',
  'popup_countdown',
  'spawn_bugs',
  'shuffle_desktop',
  'quarantine_files',
  'revoke_all'
]);

/** level ↔ action 映射（契约定死，见 6.1） */
const LEVEL_ACTION = Object.freeze({
  L0: 'notify',
  L1: 'popup_countdown',
  L2: 'spawn_bugs',
  L3: 'shuffle_desktop',
  L4: 'quarantine_files'
});
const ACTION_LEVEL = Object.freeze({
  notify: 'L0',
  popup_countdown: 'L1',
  spawn_bugs: 'L2',
  shuffle_desktop: 'L3',
  quarantine_files: 'L4',
  revoke_all: null
});

/** 本地执行动作（executor 负责）；其余是前端表现动作 */
const LOCAL_ACTIONS = Object.freeze(['shuffle_desktop', 'quarantine_files', 'revoke_all']);

const LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4']);
const STATES = Object.freeze(['lying_bed', 'seated_desk', 'standing_or_moving', 'away', 'learning', 'unknown']);
const SOURCES = Object.freeze(['camera_local', 'time_rules', 'manual']);

/** 时区固定 +08:00（契约示例即此），避免不同机器时区导致 issuedAt 不可比 */
const TZ_OFFSET_MIN = 8 * 60;

function pad(n) { return String(n).padStart(2, '0'); }

/** Date → 带 +08:00 偏移的 ISO 字符串 */
function isoWithOffset(date) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MIN * 60000);
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) +
    'T' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + '+08:00';
}

/** 解析带偏移的 ISO 串 → Date；不合法返回 null */
function parseIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
  const d = new Date(utc - offsetMin * 60000);
  return Number.isFinite(+d) ? d : null;
}

function newId(prefix) {
  return (prefix || 'ins') + '_' + crypto.randomBytes(6).toString('hex');
}

/**
 * 校验指令对象。不合法时抛出带 errors 数组的 Error。
 * @param {object} instruction 待校验指令
 * @param {object} [opts] { now: Date } 用于默认时间戳与 expiry 校验
 */
function validateInstruction(instruction, opts) {
  const errors = [];
  const ins = instruction;
  if (!ins || typeof ins !== 'object' || Array.isArray(ins)) {
    throw validationError(['指令必须是对象']);
  }

  // id
  if (typeof ins.id !== 'string' || !ins.id.trim()) errors.push('id 必须是非空字符串');

  // action
  if (typeof ins.action !== 'string' || ACTIONS.indexOf(ins.action) === -1) {
    errors.push('action 必须是枚举之一: ' + ACTIONS.join(', ') + '，实际: ' + JSON.stringify(ins.action));
  }

  // level（revoke_all 允许 null；其余必须与 action 对应）
  if (ins.action === 'revoke_all') {
    if (ins.level !== null && ins.level !== undefined && LEVELS.indexOf(ins.level) === -1) {
      errors.push('level 必须是 L0..L4 或 null，实际: ' + JSON.stringify(ins.level));
    }
  } else if (LEVELS.indexOf(ins.level) === -1) {
    errors.push('level 必须是 L0..L4 之一，实际: ' + JSON.stringify(ins.level));
  } else if (LEVEL_ACTION[ins.level] !== ins.action) {
    errors.push('level ' + ins.level + ' 必须对应 action ' + LEVEL_ACTION[ins.level] + '，实际 action: ' + ins.action);
  }

  // taskId：revoke_all 可按任务撤销，允许字符串；其余必须非空字符串
  if (ins.action === 'revoke_all') {
    if (ins.taskId !== null && ins.taskId !== undefined && typeof ins.taskId !== 'string') {
      errors.push('taskId 必须是字符串或 null');
    }
  } else if (typeof ins.taskId !== 'string' || !ins.taskId.trim()) {
    errors.push('taskId 必须是非空字符串');
  }

  // step：revoke_all 无 step；其余必须有合法 index 与 label
  if (ins.action === 'revoke_all') {
    if (ins.step !== null && ins.step !== undefined && typeof ins.step !== 'object') {
      errors.push('step 必须是对象或 null');
    }
  } else {
    if (!ins.step || typeof ins.step !== 'object' || Array.isArray(ins.step)) {
      errors.push('step 必须是对象');
    } else {
      if (!Number.isInteger(ins.step.index) || ins.step.index < 0) {
        errors.push('step.index 必须是非负整数，实际: ' + JSON.stringify(ins.step.index));
      }
      if (typeof ins.step.label !== 'string' || !ins.step.label.trim()) {
        errors.push('step.label 必须是非空字符串');
      }
      if (ins.step.stateAtPlan !== undefined && STATES.indexOf(ins.step.stateAtPlan) === -1) {
        errors.push('step.stateAtPlan 必须是状态枚举之一，实际: ' + JSON.stringify(ins.step.stateAtPlan));
      }
    }
  }

  // 时间戳
  const now = (opts && opts.now) || new Date();
  const issuedAt = parseIso(ins.issuedAt);
  if (!ins.issuedAt) {
    errors.push('issuedAt 必填（ISO8601 带时区偏移）');
  } else if (!issuedAt) {
    errors.push('issuedAt 无法解析: ' + JSON.stringify(ins.issuedAt));
  }
  if (ins.expiresAt !== undefined && ins.expiresAt !== null) {
    const expiresAt = parseIso(ins.expiresAt);
    if (!expiresAt) {
      errors.push('expiresAt 无法解析: ' + JSON.stringify(ins.expiresAt));
    } else if (issuedAt && expiresAt.getTime() < issuedAt.getTime()) {
      errors.push('expiresAt 不能早于 issuedAt');
    } else if (issuedAt && expiresAt.getTime() - issuedAt.getTime() > 24 * 3600 * 1000) {
      errors.push('expiresAt 与 issuedAt 相差不得超过 24 小时');
    }
  }

  // 布尔字段
  if (typeof ins.reversible !== 'boolean') {
    errors.push('reversible 必须是布尔值，实际: ' + JSON.stringify(ins.reversible));
  }
  if (ins.manifestId !== undefined && ins.manifestId !== null && typeof ins.manifestId !== 'string') {
    errors.push('manifestId 必须是字符串或 null');
  }

  // payload：按 action 校验
  if (ins.payload !== undefined && ins.payload !== null) {
    if (typeof ins.payload !== 'object' || Array.isArray(ins.payload)) {
      errors.push('payload 必须是对象');
    } else if (ins.action === 'quarantine_files') {
      if (!Array.isArray(ins.payload.targets) || !ins.payload.targets.length) {
        errors.push('quarantine_files 的 payload.targets 必须是非空数组');
      } else if (!ins.payload.targets.every(t => typeof t === 'string' && t.trim())) {
        errors.push('payload.targets 必须全部是非空字符串');
      }
    } else if (ins.action === 'shuffle_desktop') {
      if (ins.payload.targetDir !== undefined && (typeof ins.payload.targetDir !== 'string' || !ins.payload.targetDir.trim())) {
        errors.push('shuffle_desktop 的 payload.targetDir 必须是非空字符串');
      }
    }
  } else if (ins.action === 'quarantine_files') {
    errors.push('quarantine_files 必须带 payload.targets');
  }

  if (errors.length) throw validationError(errors);
  return true;
}

function validationError(errors) {
  const e = new Error('指令校验失败: ' + errors.join('；'));
  e.name = 'InstructionValidationError';
  e.errors = errors;
  return e;
}

/** 规范化一条指令：补默认时间戳、冻结 payload 引用（浅拷贝防外部改写） */
function normalizeInstruction(ins, opts) {
  const now = (opts && opts.now) || new Date();
  const out = {
    id: ins.id || newId('ins'),
    level: ins.level === undefined ? ACTION_LEVEL[ins.action] : ins.level,
    action: ins.action,
    taskId: ins.taskId === undefined ? null : ins.taskId,
    step: ins.step === undefined ? null : JSON.parse(JSON.stringify(ins.step)),
    issuedAt: ins.issuedAt || isoWithOffset(now),
    expiresAt: ins.expiresAt === undefined ? null : ins.expiresAt,
    reversible: ins.reversible === undefined ? false : ins.reversible,
    manifestId: ins.manifestId === undefined ? null : ins.manifestId
  };
  if (ins.payload !== undefined && ins.payload !== null) {
    out.payload = JSON.parse(JSON.stringify(ins.payload));
  }
  if (ins.stateEvidence !== undefined) {
    out.stateEvidence = ins.stateEvidence;
  }
  if (ins.reason !== undefined) out.reason = ins.reason;
  validateInstruction(out, { now });
  return out;
}

/**
 * createInstructionBus —— 指令总线
 * @param {object} opts
 * @param {string} [opts.logPath] JSONL 审计日志路径（默认 os.tmpdir()/discipline-agent-audit/audit.jsonl）
 * @param {() => Date} [opts.nowFn] 可注入时钟
 */
function createInstructionBus(opts) {
  const options = opts || {};
  const logPath = options.logPath || path.join(os.tmpdir(), 'discipline-agent-audit', 'audit.jsonl');
  const nowFn = options.nowFn || (() => new Date());
  const logDir = path.dirname(logPath);
  fs.mkdirSync(logDir, { recursive: true });

  const issued = new Map();      // id → instruction（含生命周期）
  const byTask = new Map();      // taskId → Set(id)
  const acked = new Set();
  const completed = new Set();
  const revoked = new Set();

  function appendAudit(entry) {
    const line = JSON.stringify(Object.assign({ ts: isoWithOffset(nowFn()) }, entry)) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
    return entry;
  }

  function registerTask(id, taskId) {
    if (!byTask.has(taskId)) byTask.set(taskId, new Set());
    byTask.get(taskId).add(id);
  }

  /** issue：幂等去重（同 id 重复 issue 返回已存在指令，不重复记审计） */
  function issue(input) {
    const ins = normalizeInstruction(input, { now: nowFn() });
    if (issued.has(ins.id)) {
      const existing = issued.get(ins.id);
      appendAudit({ event: 'issue_duplicate', id: ins.id, action: ins.action, level: ins.level, taskId: ins.taskId });
      return existing;
    }
    const record = Object.assign({}, ins, { status: 'issued', history: ['issued'] });
    issued.set(ins.id, record);
    registerTask(ins.id, ins.taskId === null || ins.taskId === undefined ? '__global__' : ins.taskId);
    appendAudit({
      event: 'issue', id: ins.id, level: ins.level, action: ins.action, taskId: ins.taskId,
      step: ins.step ? { index: ins.step.index, label: ins.step.label, stateAtPlan: ins.step.stateAtPlan } : null,
      manifestId: ins.manifestId, reversible: ins.reversible, expiresAt: ins.expiresAt,
      reason: ins.reason || null, stateEvidence: ins.stateEvidence || null
    });
    return record;
  }

  function requireIssued(id) {
    const rec = issued.get(id);
    if (!rec) throw new Error('未知指令 id: ' + id);
    return rec;
  }

  function ack(id, ackInfo) {
    const rec = requireIssued(id);
    if (acked.has(id)) return rec;
    acked.add(id);
    rec.status = 'acked';
    rec.history.push('acked');
    rec.ackedAt = isoWithOffset(nowFn());
    appendAudit({ event: 'ack', id, action: rec.action, level: rec.level, taskId: rec.taskId, info: ackInfo || null });
    return rec;
  }

  function complete(id, result) {
    const rec = requireIssued(id);
    if (completed.has(id)) return rec;
    completed.add(id);
    rec.status = 'completed';
    rec.history.push('completed');
    rec.completedAt = isoWithOffset(nowFn());
    appendAudit({ event: 'complete', id, action: rec.action, level: rec.level, taskId: rec.taskId, result: result || null });
    return rec;
  }

  /** revoke(taskId)：撤销该任务下所有未完成指令 */
  function revoke(taskId, reason) {
    const ids = byTask.get(taskId);
    const targets = ids ? Array.from(ids) : [];
    const revokedNow = [];
    for (const id of targets) {
      if (revoked.has(id)) continue;
      const rec = requireIssued(id);
      revoked.add(id);
      rec.status = 'revoked';
      rec.history.push('revoked');
      rec.revokedAt = isoWithOffset(nowFn());
      revokedNow.push(id);
      appendAudit({ event: 'revoke', id, action: rec.action, level: rec.level, taskId: rec.taskId, reason: reason || null });
    }
    return { taskId, revoked: revokedNow };
  }

  function get(id) { return issued.get(id) || null; }

  function list(filter) {
    const f = filter || {};
    let rows = Array.from(issued.values());
    if (f.taskId !== undefined) rows = rows.filter(r => r.taskId === f.taskId);
    if (f.action !== undefined) rows = rows.filter(r => r.action === f.action);
    if (f.level !== undefined) rows = rows.filter(r => r.level === f.level);
    if (f.status !== undefined) rows = rows.filter(r => r.status === f.status);
    return rows;
  }

  /** 读审计日志为对象数组 */
  function readAudit() {
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }

  return {
    issue, ack, complete, revoke, get, list, readAudit,
    logPath,
    counts() {
      return { issued: issued.size, acked: acked.size, completed: completed.size, revoked: revoked.size };
    }
  };
}

module.exports = {
  ACTIONS, LEVELS, LEVEL_ACTION, ACTION_LEVEL, LOCAL_ACTIONS, STATES, SOURCES,
  isoWithOffset, parseIso, newId,
  validateInstruction, normalizeInstruction, createInstructionBus
};
