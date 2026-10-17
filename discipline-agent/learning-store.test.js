'use strict';
/**
 * learning-store.test.js —— 学习记录存储测试（M-K §3.8）
 * 运行：node learning-store.test.js
 *
 * 测：
 *   - 读写回环（memory / sale / attempts / dueAt）
 *   - 原子写（tmp+rename：保存后无 .tmp-* 残留）
 *   - 损坏拒绝：坏 JSON / 空文件 / 缺版本字段 → 抛错不静默重置
 *   - 版本防线：过新版本拒绝；旧版本无迁移器时拒绝（§3.1 迁移接口占位）
 *   - 到期队列 listDue 过滤
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, equal, throws, createSuite } = require('./test-util');
const { createLearningStore, CURRENT_VERSION } = require('./learning/store');

const suite = createSuite('learning-store.test.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-store-')), 'learning.json');
}

suite.test('读写回环：memory/sale/attempts/due', () => {
  const f = tmpFile();
  const s = createLearningStore(f);
  s.setMemory('kp1', { stability: 5.25, difficulty: 4.99 });
  s.setSale('kp1', { status: 'Repairing', streak: 1, attempts: 2, weightedScorePct: 80 });
  s.appendAttempt('kp1', { correct: true, accuracy: 0.9, selfConf: 4 });
  s.setDue('kp1', '2026-10-19T08:00:00.000Z');
  s.save();

  const s2 = createLearningStore(f);
  const m = s2.getMemory('kp1');
  equal(m.stability, 5.25, 'stability 回读');
  equal(m.difficulty, 4.99, 'difficulty 回读');
  const sale = s2.getSale('kp1');
  equal(sale.status, 'Repairing', 'sale status');
  equal(sale.attempts, 2, 'sale attempts');
  equal(s2.listAttempts('kp1').length, 1, 'attempts 回读');
  equal(s2.listDue(Date.parse('2026-10-20T00:00:00Z'))[0].kpId, 'kp1', '到期过滤');
  equal(s2.listDue(Date.parse('2026-10-18T00:00:00Z')).length, 0, '未到期不出现');
  equal(s2.meta().version, CURRENT_VERSION, '版本号');
});

suite.test('原子写：保存后无 tmp 残留，可重复保存', () => {
  const f = tmpFile();
  const s = createLearningStore(f);
  s.setMemory('a', { stability: 1, difficulty: 5 });
  s.save();
  s.save();
  ok(fs.existsSync(f), '文件存在');
  const leftovers = fs.readdirSync(path.dirname(f)).filter(n => n.includes('.tmp-'));
  equal(leftovers.length, 0, '无 tmp 残留');
});

suite.test('损坏拒绝：坏 JSON 抛错（不静默重置）', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"version":1, BROKEN');
  let threw = null;
  try { createLearningStore(f).load(); } catch (e) { threw = e; }
  ok(threw, '应抛错');
  ok(/JSON 损坏/.test(threw.message), '消息含"JSON 损坏": ' + threw.message);
});

suite.test('损坏拒绝：空文件 / 缺版本字段', () => {
  const f1 = tmpFile();
  fs.writeFileSync(f1, '');
  throws(() => createLearningStore(f1).load(), '空文件应抛');
  const f2 = tmpFile();
  fs.writeFileSync(f2, '{"kps":{}}');
  throws(() => createLearningStore(f2).load(), '缺 version 应抛');
});

suite.test('版本防线：过新拒绝；旧版无迁移器拒绝', () => {
  const fNew = tmpFile();
  fs.writeFileSync(fNew, JSON.stringify({ version: CURRENT_VERSION + 1, kps: {} }));
  throws(() => createLearningStore(fNew).load(), '过新版本应抛');

  const fOld = tmpFile();
  fs.writeFileSync(fOld, JSON.stringify({ version: 0, kps: {} }));
  throws(() => createLearningStore(fOld).load(), 'v0 无迁移器应抛（§3.1 占位）');
});

suite.test('cleared 只读落盘（Node 不改写状态字段）', () => {
  const f = tmpFile();
  const s = createLearningStore(f);
  s.setSale('kp9', { status: 'Cleared', streak: 2, attempts: 3, weightedScorePct: 90 });
  s.save();
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  equal(raw.kps.kp9.sale.status, 'Cleared', 'Cleared 原样落盘（由 C# sale-machine 判定）');
});

suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});