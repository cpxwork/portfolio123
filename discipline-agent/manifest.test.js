'use strict';
/**
 * manifest.test.js —— A-M0 测试②：可逆账本
 * 运行：node manifest.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManifestStore } = require('./manifest');
const { tmpDir, rmrf, ok, equal, contains, throws, createSuite } = require('./test-util');

const suite = createSuite('manifest.test.js');
let root;
let store;

suite.before(() => {
  root = tmpDir('dsc-mf-');
  store = createManifestStore({
    root: path.join(root, '.discipline', 'manifests'),
    auditPath: path.join(root, 'audit.jsonl'),
    idFn: (prefix) => (prefix || 'mf') + '_fixed_' + Math.floor(Math.random() * 100000)
  });
});
suite.after(() => rmrf(root));

suite.test('create 落盘，含 manifestId/instructionId/createdAt/items', () => {
  const m = store.create({
    kind: 'quarantine', instructionId: 'ins_1', taskId: 'task_1', workRoot: root,
    items: [{ from: path.join(root, 'a.txt'), to: null, sha256: 'x', size: 3 }],
    note: '测试'
  });
  ok(m.manifestId, '有 manifestId');
  equal(m.instructionId, 'ins_1', 'instructionId');
  equal(m.taskId, 'task_1', 'taskId');
  ok(m.createdAt && m.createdAt.length >= 20, 'createdAt 非空');
  equal(m.status, 'open', '初始 open');
  equal(m.items.length, 1, '一条 item');
  ok(fs.existsSync(path.join(store.root, m.manifestId + '.json')), 'manifest 文件已落盘');
  const disk = JSON.parse(fs.readFileSync(path.join(store.root, m.manifestId + '.json'), 'utf8'));
  equal(disk.items[0].from, m.items[0].from, '原路径落盘');
  equal(disk.items[0].to, null, '新路径初始为空');
});

suite.test('items 每项有 from/to/status/sha256 字段', () => {
  const m = store.create({
    kind: 'shuffle', instructionId: 'ins_2', taskId: 't', workRoot: root,
    items: [{ from: 'f1' }, { from: 'f2', to: 't2' }]
  });
  for (const it of m.items) {
    ok('from' in it && 'to' in it && 'status' in it, '三要素齐全');
    equal(it.status, it.to ? 'pending' : 'pending', '初始都 pending');
  }
});

suite.test('updateItem 逐条回写并记 updatedAt', () => {
  const m = store.create({
    kind: 'quarantine', instructionId: 'ins_3', workRoot: root,
    items: [{ from: 'f1' }, { from: 'f2' }]
  });
  const after = store.updateItem(m.manifestId, 1, { to: '/q/f2', status: 'done', reason: '已移动' });
  equal(after.items[1].to, '/q/f2', '新路径已回填');
  equal(after.items[1].status, 'done', '状态 done');
  ok(after.items[1].updatedAt, '有 updatedAt');
  equal(after.items[0].status, 'pending', '另一条不受影响');
  const disk = store.get(m.manifestId);
  equal(disk.items[1].status, 'done', '磁盘上也已更新');
});

suite.test('updateItem 越界抛错', () => {
  const m = store.create({ kind: 'quarantine', workRoot: root, items: [{ from: 'f' }] });
  throws(() => store.updateItem(m.manifestId, 5, { status: 'done' }), '越界下标');
  throws(() => store.updateItem('mf_not_exist', 0, {}), '不存在的 manifest');
});

suite.test('setStatus 与 restored 关闭', () => {
  const m = store.create({ kind: 'shuffle', workRoot: root, items: [{ from: 'f' }] });
  store.setStatus(m.manifestId, 'partial');
  equal(store.get(m.manifestId).status, 'partial', 'partial');
  store.setStatus(m.manifestId, 'restored');
  const after = store.get(m.manifestId);
  equal(after.status, 'restored', 'restored');
  ok(after.closedAt, 'restored 时记 closedAt');
});

suite.test('list 按 createdAt 排序；审计 JSONL 含 manifest_create/status', () => {
  const a = store.create({ kind: 'quarantine', workRoot: root, items: [{ from: 'x' }] });
  const b = store.create({ kind: 'shuffle', workRoot: root, items: [{ from: 'y' }] });
  store.setStatus(a.manifestId, 'restored');
  const all = store.list();
  ok(all.length >= 2, '至少 2 个');
  equal(all[0].createdAt <= all[all.length - 1].createdAt, true, '按时间升序');
  const events = store.readAudit().map(e => e.event);
  contains(events.join(','), 'manifest_create', '有 manifest_create');
  contains(events.join(','), 'manifest_status', '有 manifest_status');
});

suite.test('原子写不产生 .tmp 残留', () => {
  const m = store.create({ kind: 'quarantine', workRoot: root, items: [{ from: 'x' }] });
  store.updateItem(m.manifestId, 0, { status: 'done' });
  const files = fs.readdirSync(store.root).filter(f => f.endsWith('.tmp'));
  equal(files.length, 0, '无 .tmp 残留');
});

suite.test('不存在的 manifest get 返回 null', () => {
  equal(store.get('mf_missing'), null, '返回 null');
});

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
