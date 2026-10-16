'use strict';
/**
 * audit.js —— 审计查询、用户纠正、误判申诉（A-M5 交付）
 *
 * 目标：任意一次强制的"依据 → 指令 → 执行 → 还原"四段可查；
 *       用户可随时纠正判定；纠正记录回流为 state-sensor 的规则修正依据。
 *
 * 数据来源（不另起炉灶，全部读既有日志）：
 *   - 指令总线审计（issue/ack/complete/revoke）：instructions.js 的 JSONL
 *   - 执行账本（manifest_create/manifest_status/executor_*）：manifest.js 的 JSONL
 *   - 状态判定记录：由外部通过 recordDecision() 追加到同一审计流
 */

const fs = require('fs');
const path = require('path');

const CORRECTION_SOURCES = ['manual'];

function pad(n) { return String(n).padStart(2, '0'); }
function nowIso() {
  const s = new Date(Date.now() + 8 * 3600000);
  return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate()) +
    'T' + pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes()) + ':' + pad(s.getUTCSeconds()) + '+08:00';
}

/**
 * createAuditLog
 * @param {object} opts
 * @param {string} opts.path 审计文件路径（JSONL，存判定/计划/纠正/申诉）
 * @param {string[]} [opts.sources] 额外只读日志源（指令总线 JSONL、执行账本 JSONL…）。
 *   四段链路（依据→指令→执行→还原）横跨多个文件，必须能一起查。
 * @param {() => string} [opts.nowFn] 可注入时钟
 */
function createAuditLog(opts) {
  const options = opts || {};
  const file = options.path;
  if (!file) throw new Error('createAuditLog 需要 opts.path');
  const nowFn = options.nowFn || nowIso;
  const sources = Array.isArray(options.sources) ? options.sources.slice() : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function append(entry) {
    const line = JSON.stringify(Object.assign({ ts: nowFn() }, entry)) + '\n';
    fs.appendFileSync(file, line, 'utf8');
    return entry;
  }

  function readOne(abs) {
    if (!abs || !fs.existsSync(abs)) return [];
    return fs.readFileSync(abs, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (e) { return { ts: null, event: 'unparsable', raw: l }; }
    });
  }

  /** 读全部源：自己的审计流 + 挂载的只读源 */
  function readAll() {
    const own = readOne(file);
    const extra = [];
    for (const s of sources) extra.push(...readOne(s));
    return own.concat(extra).sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0);
  }

  /** 只读自己的审计流（判定/纠正/申诉） */
  function readOwn() { return readOne(file); }

  /** 记录一次状态判定（供事后查"依据什么"） */
  function recordDecision(rec) {
    return append({
      event: 'state_decision',
      taskId: rec.taskId === undefined ? null : rec.taskId,
      state: rec.state,
      confidence: rec.confidence,
      source: rec.source,
      evidence: rec.evidence || null,
      explain: rec.explain || null,
      capturedAt: rec.capturedAt || null
    });
  }

  /** 记录一次计划拆步（供事后查"为什么给我这一步"） */
  function recordPlan(rec) {
    return append({
      event: 'plan_created',
      taskId: rec.taskId === undefined ? null : rec.taskId,
      mode: rec.mode,
      state: rec.state,
      stepCount: Array.isArray(rec.steps) ? rec.steps.length : 0,
      firstStep: rec.firstStep || null,
      explain: rec.explain || null
    });
  }

  /** 用户纠正判定：写回 source=manual 的状态，作为规则修正依据 */
  function recordCorrection(rec) {
    if (!rec || !rec.from || !rec.to) throw new Error('recordCorrection 需要 from/to');
    return append({
      event: 'state_correction',
      taskId: rec.taskId === undefined ? null : rec.taskId,
      from: rec.from,
      to: rec.to,
      evidenceAtTime: rec.evidenceAtTime || null,
      note: rec.note || null,
      source: 'manual',
      correctedAt: nowFn()
    });
  }

  /** 登记误判申诉 */
  function recordAppeal(rec) {
    if (!rec || !rec.targetId) throw new Error('recordAppeal 需要 targetId（被申诉的指令/判定 id）');
    return append({
      event: 'appeal',
      targetId: rec.targetId,
      targetKind: rec.targetKind || 'instruction',   // instruction | decision | manifest
      taskId: rec.taskId === undefined ? null : rec.taskId,
      reason: rec.reason || null,
      status: 'open',
      filedAt: nowFn()
    });
  }

  /** 申诉处理结果 */
  function resolveAppeal(targetId, resolution) {
    return append({
      event: 'appeal_resolved',
      targetId,
      resolution: resolution || 'accepted',
      note: (resolution && resolution.note) || null,
      resolvedAt: nowFn()
    });
  }

  // ---------- 查询 ----------

  /** 挂载额外只读源（bus/executor 的 JSONL），供四段链路查询 */
  function addSource(abs) {
    if (typeof abs === 'string' && abs && sources.indexOf(abs) === -1) sources.push(abs);
    return sources.slice();
  }

  /** 按 task 查全链路（含挂载源里的指令与执行记录） */
  function byTask(taskId) {
    return readAll().filter(r => r.taskId === taskId);
  }

  /** 按时间段查 [from, to]（ISO 串，按 ts 字典序即可比较） */
  function byRange(from, to) {
    const rows = readAll();
    return rows.filter(r => {
      if (!r.ts) return false;
      if (from && r.ts < from) return false;
      if (to && r.ts > to) return false;
      return true;
    });
  }

  /** 某次强制的四段链路：依据(decision) → 指令(issue/ack/complete) → 执行(manifest/executor) → 还原(restore) */
  function traceInstruction(instructionId) {
    const rows = readAll();
    const ins = rows.filter(r => r.event === 'issue' && r.id === instructionId);
    const acks = rows.filter(r => r.event === 'ack' && r.id === instructionId);
    const comps = rows.filter(r => r.event === 'complete' && r.id === instructionId);
    const manifestId = ins.length && ins[0].manifestId ? ins[0].manifestId
      : (comps.length && comps[0].result && comps[0].result.manifestId ? comps[0].result.manifestId : null);
    const exec = manifestId ? rows.filter(r => r.manifestId === manifestId) : [];
    const restore = rows.filter(r =>
      (r.event === 'executor_restore' && r.manifestId === manifestId) ||
      (r.event === 'executor_restore_all' && manifestId && r.event === 'executor_restore_all'));
    return {
      instructionId,
      basis: rows.filter(r => r.event === 'state_decision'),
      issued: ins, acked: acks, completed: comps,
      manifestId,
      executed: exec,
      restored: restore
    };
  }

  /** 汇总一段时间的强制次数（L2+） */
  function forcedCount(from, to) {
    return byRange(from, to).filter(r => r.event === 'issue' && ['L2', 'L3', 'L4'].indexOf(r.level) !== -1).length;
  }

  return {
    path: file, sources: sources.slice(),
    append, readAll, readOwn, addSource,
    recordDecision, recordPlan, recordCorrection, recordAppeal, resolveAppeal,
    byTask, byRange, traceInstruction, forcedCount
  };
}

module.exports = { createAuditLog, nowIso };
