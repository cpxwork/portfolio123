'use strict';
/**
 * instructions.test.js —— A-M0 测试①：指令 schema + 总线 + JSONL 审计
 * 运行：node instructions.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createInstructionBus, validateInstruction, normalizeInstruction,
  ACTIONS, LEVEL_ACTION, ACTION_LEVEL, isoWithOffset, parseIso, newId
} = require('./instructions');
const { tmpDir, rmrf, writeFile, readJsonl, ok, equal, contains, throws, createSuite } = require('./test-util');

const suite = createSuite('instructions.test.js');
let root;
let logPath;

suite.before(() => {
  root = tmpDir('dsc-ins-');
  logPath = path.join(root, 'audit.jsonl');
});
suite.after(() => rmrf(root));

suite.test('action 枚举与 level 映射与契约定死一致', () => {
  equal(ACTIONS.length, 6, 'action 数量');
  equal(LEVEL_ACTION.L0, 'notify', 'L0→notify');
  equal(LEVEL_ACTION.L1, 'popup_countdown', 'L1→popup_countdown');
  equal(LEVEL_ACTION.L2, 'spawn_bugs', 'L2→spawn_bugs');
  equal(LEVEL_ACTION.L3, 'shuffle_desktop', 'L3→shuffle_desktop');
  equal(LEVEL_ACTION.L4, 'quarantine_files', 'L4→quarantine_files');
  equal(ACTION_LEVEL.revoke_all, null, 'revoke_all 无 level');
});

suite.test('合法指令通过校验', () => {
  const ins = {
    id: 'ins_01', level: 'L2', action: 'spawn_bugs', taskId: 'task_math_01',
    step: { index: 1, label: '下床', stateAtPlan: 'lying_bed' },
    issuedAt: '2026-10-16T20:30:00+08:00', expiresAt: '2026-10-16T20:35:00+08:00',
    reversible: true, manifestId: null
  };
  validateInstruction(ins);
  const norm = normalizeInstruction(ins);
  equal(norm.id, 'ins_01', 'id 保留');
  equal(norm.level, 'L2', 'level 保留');
});

suite.test('level 与 action 不匹配被拒并带 errors', () => {
  let err = null;
  try {
    validateInstruction({
      id: 'x', level: 'L2', action: 'quarantine_files', taskId: 't',
      step: { index: 0, label: 'a' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true
    });
  } catch (e) { err = e; }
  ok(err, '应当抛错');
  ok(Array.isArray(err.errors) && err.errors.length >= 1, 'errors 是数组');
  contains(err.errors.join('；'), 'level L2', '错误说明 level/action 不匹配');
});

suite.test('未知 action / 非法 level / 缺失字段被拒', () => {
  const cases = [
    [{ id: 'a', level: 'L0', action: 'explode', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true }],
    [{ id: 'a', level: 'L9', action: 'notify', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true }],
    [{ level: 'L0', action: 'notify', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true }],
    [{ id: 'a', level: 'L0', action: 'notify', taskId: 't', issuedAt: '2026-10-16T20:30:00+08:00', reversible: true }],
    [{ id: 'a', level: 'L0', action: 'notify', taskId: 't', step: { index: -1, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true }],
    [{ id: 'a', level: 'L0', action: 'notify', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '不是时间', reversible: true }],
    [{ id: 'a', level: 'L0', action: 'notify', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: 'true' }],
    [{ id: 'a', level: 'L4', action: 'quarantine_files', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true, payload: {} }]
  ];
  for (let i = 0; i < cases.length; i++) {
    throws(() => validateInstruction(cases[i]), '第 ' + i + ' 个用例应被拒');
  }
});

suite.test('expiresAt 早于 issuedAt 被拒', () => {
  throws(() => validateInstruction({
    id: 'a', level: 'L0', action: 'notify', taskId: 't',
    step: { index: 0, label: 'x' },
    issuedAt: '2026-10-16T20:30:00+08:00', expiresAt: '2026-10-16T20:25:00+08:00',
    reversible: true
  }), 'expiresAt < issuedAt');
});

suite.test('revoke_all 允许 level=null 且可不带 step', () => {
  const ins = normalizeInstruction({
    id: 'rev_1', level: null, action: 'revoke_all', taskId: 'task_math_01',
    step: null, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true, manifestId: null
  });
  equal(ins.action, 'revoke_all', 'action');
  equal(ins.level, null, 'level 为 null');
  equal(ins.step, null, 'step 为 null');
});

suite.test('总线 issue→ack→complete 全链路写审计', () => {
  const bus = createInstructionBus({ logPath });
  const ins = bus.issue({
    id: 'ins_a', level: 'L0', action: 'notify', taskId: 'task_x',
    step: { index: 0, label: '坐起来', stateAtPlan: 'lying_bed' },
    issuedAt: '2026-10-16T20:30:00+08:00', expiresAt: '2026-10-16T20:35:00+08:00',
    reversible: false, manifestId: null, reason: '判定到点'
  });
  equal(ins.status, 'issued', 'issue 后状态');
  bus.ack('ins_a', { by: 'frontend' });
  equal(bus.get('ins_a').status, 'acked', 'ack 后状态');
  bus.complete('ins_a', { ok: true });
  equal(bus.get('ins_a').status, 'completed', 'complete 后状态');

  const audit = bus.readAudit();
  const events = audit.map(a => a.event);
  contains(events.join(','), 'issue', '有 issue');
  contains(events.join(','), 'ack', '有 ack');
  contains(events.join(','), 'complete', '有 complete');
  const issueLine = audit.find(a => a.event === 'issue');
  equal(issueLine.step.label, '坐起来', '审计保留 step.label');
  equal(issueLine.step.stateAtPlan, 'lying_bed', '审计保留 stateAtPlan');
});

suite.test('总线 issue 幂等去重', () => {
  const bus = createInstructionBus({ logPath });
  const base = {
    id: 'ins_dup', level: 'L1', action: 'popup_countdown', taskId: 'task_x',
    step: { index: 0, label: '下床' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false
  };
  const a = bus.issue(base);
  const b = bus.issue(base);
  equal(a.id, b.id, '同一 id');
  equal(bus.list().length, 1, '不会重复入库');
  const dups = bus.readAudit().filter(x => x.event === 'issue_duplicate');
  equal(dups.length, 1, '重复 issue 记一条 issue_duplicate');
});

suite.test('revoke(taskId) 撤销该任务下未完成指令', () => {
  const bus = createInstructionBus({ logPath });
  bus.issue({ id: 'i1', level: 'L0', action: 'notify', taskId: 'task_a', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false });
  bus.issue({ id: 'i2', level: 'L1', action: 'popup_countdown', taskId: 'task_a', step: { index: 0, label: 'y' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false });
  bus.issue({ id: 'i3', level: 'L0', action: 'notify', taskId: 'task_b', step: { index: 0, label: 'z' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false });
  const r = bus.revoke('task_a', '用户完成一步');
  equal(r.revoked.length, 2, '撤销 2 条');
  equal(bus.get('i3').status, 'issued', '别的任务不受影响');
  equal(bus.get('i1').status, 'revoked', 'i1 已撤销');
  equal(bus.get('i2').status, 'revoked', 'i2 已撤销');
});

suite.test('未知 id 的 ack/complete 抛错', () => {
  const bus = createInstructionBus({ logPath });
  throws(() => bus.ack('nope'), 'ack 未知 id');
  throws(() => bus.complete('nope'), 'complete 未知 id');
});

suite.test('审计日志是合法 JSONL，可逐行解析', () => {
  const bus = createInstructionBus({ logPath });
  bus.issue({ id: 'ins_j', level: 'L2', action: 'spawn_bugs', taskId: 'task_j', step: { index: 2, label: '做第 1 题', stateAtPlan: 'seated_desk' }, issuedAt: '2026-10-16T20:30:00+08:00', expiresAt: '2026-10-16T20:35:00+08:00', reversible: true });
  const rows = readJsonl(logPath);
  ok(rows.length >= 1, '至少一行');
  ok(rows.every(r => r && typeof r.event === 'string'), '每行都有 event');
  ok(rows.every(r => typeof r.ts === 'string' && r.ts.length >= 20), '每行都有 ts');
});

suite.test('时间戳往返：ISO 解析与 +08:00 输出', () => {
  const iso = isoWithOffset(new Date(Date.UTC(2026, 9, 16, 12, 30, 5)));
  contains(iso, '2026-10-16T20:30:05+08:00', 'UTC 12:30 → +08:00 20:30');
  const d = parseIso(iso);
  ok(d && d.getUTCFullYear() === 2026, '年份');
  equal(parseIso('not-a-time'), null, '非法返回 null');
  equal(parseIso('2026-10-16 20:30:00'), null, '缺时区偏移返回 null');
});

suite.test('newId 生成唯一前缀 id', () => {
  const a = newId('ins');
  const b = newId('ins');
  ok(a.startsWith('ins_'), '前缀');
  ok(a !== b, '不重复');
});

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
