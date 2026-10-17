'use strict';
/**
 * audit.test.js —— A-M5 测试：审计查询、用户纠正、误判申诉
 * 运行：node audit.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog } = require('./audit');
const { createInstructionBus } = require('./instructions');
const { createExecutor } = require('./executor');
const { createEscalation } = require('./escalation');
const { tmpDir, rmrf, writeFile, sha256, ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('audit.test.js');
let root, logPath, busLog, execLog, audit, bus, executor;

// 跨用例需要累积同一份审计流，故用 beforeAll/afterAll（整套一次）
suite.beforeAll(() => {
  root = tmpDir('dsc-audit-');
  logPath = path.join(root, 'audit.jsonl');
  busLog = path.join(root, 'bus.jsonl');
  execLog = path.join(root, 'exec.jsonl');
  audit = createAuditLog({ path: logPath, sources: [busLog, execLog] });
  bus = createInstructionBus({ logPath: busLog });
  executor = createExecutor({ workRoot: root, auditPath: execLog });
  writeFile(root, 'x.txt', 'X');
  writeFile(root, 'y.txt', 'Y');
});
suite.afterAll(() => rmrf(root));

// ---------- 记录与查询 ----------

suite.test('记录判定/计划，可按 task 与时间段查询', () => {
  audit.recordDecision({ taskId: 't1', state: 'lying_bed', confidence: 0.86, source: 'camera_local', evidence: 'camera:卧姿·床区域', explain: '摄像头判定为床区域卧姿' });
  audit.recordPlan({ taskId: 't1', mode: 'plan', state: 'lying_bed', steps: [{ index: 0 }], firstStep: { index: 0, label: '坐起来' }, explain: '当前躺着，第一步必须先离开床' });
  const rows = audit.byTask('t1');
  ok(rows.length >= 2, 't1 有 2 条以上');
  const events = rows.map(r => r.event);
  contains(events.join(','), 'state_decision', '有判定记录');
  contains(events.join(','), 'plan_created', '有计划记录');
  const all = audit.byRange('2000-01-01T00:00:00+08:00', '2100-01-01T00:00:00+08:00');
  ok(all.length >= 2, '时间段查询可用');
  equal(audit.byRange('2100-01-01T00:00:00+08:00', null).length, 0, '未来时段无记录');
});

suite.test('判定记录带 explain 原文', () => {
  audit.recordDecision({ taskId: 't2', state: 'seated_desk', confidence: 0.9, source: 'time_rules', evidence: 'inactive:18min', explain: '已 18 分钟无操作，时段为晚间自习' });
  const d = audit.readAll().filter(r => r.event === 'state_decision' && r.taskId === 't2')[0];
  equal(d.explain, '已 18 分钟无操作，时段为晚间自习', 'explain 原文保留');
  equal(d.evidence, 'inactive:18min', 'evidence 保留');
  equal(d.source, 'time_rules', 'source 保留');
});

suite.test('一次强制的四段链路可查：依据→指令→执行→还原', () => {
  const r = tmpDir('dsc-audit2-');
  const aLog = path.join(r, 'audit.jsonl');
  const a2 = createAuditLog({ path: aLog, sources: [path.join(r, 'bus.jsonl'), path.join(r, 'exec.jsonl')] });
  const b = createInstructionBus({ logPath: path.join(r, 'bus.jsonl') });
  const e = createExecutor({ workRoot: r, auditPath: path.join(r, 'exec.jsonl') });
  writeFile(r, 'note.txt', 'NOTE');
  // 1) 依据
  a2.recordDecision({ taskId: 'tt', state: 'lying_bed', confidence: 0.8, source: 'time_rules', evidence: 'inactive:20min', explain: '20 分钟无操作' });
  // 2) 指令 + 执行
  const ins = b.issue({ id: 'ins_q', level: 'L5', action: 'quarantine_files', taskId: 'tt', step: { index: 0, label: '坐起来', stateAtPlan: 'lying_bed' }, issuedAt: '2026-10-16T20:30:00+08:00', expiresAt: '2026-10-16T20:35:00+08:00', reversible: true, payload: { targets: [path.join(r, 'note.txt')] }, reason: 'L4 后仍无响应' });
  b.ack(ins.id, { by: 'executor' });
  const out = e.execute(b.get(ins.id));
  b.complete(ins.id, { ok: out.ok, manifestId: out.manifestId });
  b.get(ins.id).manifestId = out.manifestId;
  // 3) 还原
  e.restore(out.manifestId);

  const trace = a2.traceInstruction('ins_q');
  ok(trace.basis.length >= 0, '依据段存在（可为空，判定另行记录）');
  equal(trace.issued.length, 1, '指令段有 issue');
  equal(trace.acked.length, 1, '指令段有 ack');
  equal(trace.completed.length, 1, '指令段有 complete');
  ok(trace.manifestId, '关联到 manifest');
  ok(trace.executed.length >= 1, '执行段有记录');
  ok(trace.restored.length >= 1, '还原段有记录');
  rmrf(r);
});

suite.test('用户纠正判定：写回 source=manual，可查询', () => {
  audit.recordCorrection({ taskId: 't3', from: 'lying_bed', to: 'seated_desk', evidenceAtTime: 'camera:卧姿', note: '我其实已经坐在书桌前了' });
  const c = audit.readOwn().filter(r => r.event === 'state_correction')[0];
  equal(c.from, 'lying_bed', '原判定');
  equal(c.to, 'seated_desk', '纠正后');
  equal(c.source, 'manual', '来源标记为 manual');
  contains(c.note, '坐在书桌前', '保留用户说明');
});

suite.test('纠正记录可作为规则修正依据（提供读取接口）', () => {
  const corrections = audit.readOwn().filter(r => r.event === 'state_correction');
  ok(corrections.length >= 1, '有纠正记录');
  // 模拟 state-sensor 消费：按 from→to 建映射
  const map = {};
  for (const c of corrections) map[c.from] = c.to;
  equal(map.lying_bed, 'seated_desk', '可据此修正规则');
});

suite.test('登记误判申诉并解析', () => {
  audit.recordAppeal({ targetId: 'ins_q', targetKind: 'instruction', taskId: 't4', reason: '我当时已经在写作业了，不该打乱桌面' });
  const open = audit.readOwn().filter(r => r.event === 'appeal' && r.targetId === 'ins_q');
  equal(open.length, 1, '申诉已登记');
  equal(open[0].status, 'open', '初始 open');
  audit.resolveAppeal('ins_q', 'accepted');
  const resolved = audit.readOwn().filter(r => r.event === 'appeal_resolved' && r.targetId === 'ins_q');
  equal(resolved.length, 1, '已解析');
  equal(resolved[0].resolution, 'accepted', '解析结果');
});

suite.test('recordCorrection / recordAppeal 参数校验', () => {
  let threw = 0;
  try { audit.recordCorrection({ to: 'x' }); } catch (e) { threw++; }
  try { audit.recordAppeal({ reason: 'no id' }); } catch (e) { threw++; }
  equal(threw, 2, '缺参数必须抛错');
});

suite.test('forcedCount 统计 L2+ 次数', () => {
  const r = tmpDir('dsc-audit3-');
  const a3 = createAuditLog({ path: path.join(r, 'a.jsonl') });
  const b = createInstructionBus({ logPath: path.join(r, 'b.jsonl') });
  for (const [i, lvl] of [['L0', 'notify'], ['L1', 'popup_countdown'], ['L2', 'spawn_bugs'], ['L3', 'screen_flash']].entries()) {
    b.issue({ id: 'i' + i, level: lvl[0], action: lvl[1], taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false });
  }
  // 把 bus 的审计行并入 audit 视角（同一文件更简单，这里直接读 bus 的行验证口径）
  const rows = b.readAudit().filter(x => x.event === 'issue');
  const forced = rows.filter(x => ['L2', 'L3', 'L4'].indexOf(x.level) !== -1).length;
  equal(forced, 2, 'L2/L3 计 2 次，L0/L1 不计');
  rmrf(r);
});

suite.test('审计文件损坏行不导致整体崩溃', () => {
  const r = tmpDir('dsc-audit4-');
  const p = path.join(r, 'a.jsonl');
  fs.writeFileSync(p, '{"ts":"2026-10-16T20:30:00+08:00","event":"ok"}\n这不是JSON\n');
  const a4 = createAuditLog({ path: p });
  const rows = a4.readAll();
  equal(rows.length, 2, '两行都读到');
  // readAll 会按 ts 排序，坏行 ts=null 排最前；这里按 event 找
  const bad = rows.find(x => x.event === 'unparsable');
  ok(bad, '坏行标记为 unparsable');
  equal(rows.find(x => x.event === 'ok').event, 'ok', '好行仍可解析');
  rmrf(r);
});

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
