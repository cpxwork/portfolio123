'use strict';
/**
 * executor.test.js —— A-M0 测试③：执行层（隔离/打乱/还原/安全边界）
 * 运行：node executor.test.js
 * 铁律：全部路径来自 fs.mkdtempSync(os.tmpdir())，绝不碰真实桌面。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExecutor, validateWorkRoot } = require('./executor');
const { tmpDir, rmrf, writeFile, sha256, readJsonl, ok, equal, contains, throws, createSuite } = require('./test-util');

const suite = createSuite('executor.test.js');
let root;
let executor;

function setup() {
  root = tmpDir('dsc-exec-');
  // 造一批测试文件
  writeFile(root, 'a.txt', 'AAA');
  writeFile(root, 'b.txt', 'BBB');
  writeFile(root, 'c.txt', 'CCC');
  fs.mkdirSync(path.join(root, 'subdir'), { recursive: true });
  writeFile(root, 'subdir/inner.txt', 'INNER');
  writeFile(root, '.hidden.txt', 'HIDDEN');
  executor = createExecutor({ workRoot: root });
}

function teardown() { rmrf(root); }

suite.before(setup);
suite.after(teardown);

// ---------- workRoot 安全边界 ----------

suite.test('拒绝盘符根 C:\\', () => {
  throws(() => validateWorkRoot('C:\\'), 'C:\\ 必须被拒');
});

suite.test('拒绝系统目录 C:\\Windows', () => {
  throws(() => validateWorkRoot('C:\\Windows'), 'C:\\Windows 必须被拒');
});

suite.test('拒绝用户主目录本身', () => {
  const home = os.homedir();
  if (home && path.resolve(home) !== path.parse(home).root) {
    throws(() => validateWorkRoot(home), '用户主目录必须被拒');
  } else {
    // 主目录就是盘符根时，盘符根规则已覆盖
    ok(true, '主目录=盘符根，已被盘符根规则覆盖');
  }
});

suite.test('拒绝不存在/非目录的 workRoot', () => {
  throws(() => validateWorkRoot(path.join(root, 'no_such_dir')), '不存在');
  throws(() => validateWorkRoot(path.join(root, 'a.txt')), '是文件不是目录');
});

// ---------- quarantine_files ----------

suite.test('quarantine 移动 3 个文件进隔离区并记 manifest', () => {
  const targets = [path.join(root, 'a.txt'), path.join(root, 'b.txt'), path.join(root, 'c.txt')];
  const hashes = targets.map(sha256);
  const r = executor.quarantineFiles({ instructionId: 'ins_q1', taskId: 'task_1', targets });
  equal(r.moved, 3, '移动 3 个');
  equal(r.skipped.length, 0, '无跳过');
  ok(r.manifestId, '有 manifestId');
  for (const t of targets) equal(fs.existsSync(t), false, '原位已空');
  const destDir = path.join(root, '.quarantine', r.manifestId);
  equal(fs.readdirSync(destDir).length, 3, '隔离区内 3 个文件');
  for (let i = 0; i < targets.length; i++) {
    const m = r.manifest.items.find(it => it.from === targets[i]);
    ok(m, 'manifest 含 ' + targets[i]);
    equal(m.status, 'done', 'item 状态 done');
    // 隔离区里是密文：sha256 必须与明文不同，且 manifest 记的是明文 sha256
    ok(sha256(m.to) !== hashes[i], '隔离区文件是密文（sha256 与明文不同）');
    equal(m.sha256, hashes[i], 'manifest 记明文 sha256');
  }
});

suite.test('隔离区加密：密文落盘、明文 sha256 可还原', () => {
  const targets = [path.join(root, 'a.txt'), path.join(root, 'b.txt'), path.join(root, 'c.txt')];
  const before = targets.map(t => ({ path: t, hash: sha256(t), content: fs.readFileSync(t) }));
  const r = executor.quarantineFiles({ instructionId: 'ins_enc1', taskId: 'task_1', targets });
  equal(r.moved, 3, '移动 3 个');
  const destDir = path.join(root, '.quarantine', r.manifestId);
  for (let i = 0; i < targets.length; i++) {
    const item = r.manifest.items[i];
    ok(item.crypto, 'item 带加密元数据');
    equal(item.crypto.alg, 'aes-256-gcm', '算法 aes-256-gcm');
    ok(item.crypto.iv && item.crypto.authTag, 'iv/authTag 非空');
    equal(item.crypto.keyId, r.manifestId, 'keyId=manifestId');
    // 密文里不应出现明文字样
    const cipher = fs.readFileSync(item.to);
    ok(!cipher.includes(Buffer.from('AAA')) && !cipher.includes(Buffer.from('BBB')), '密文不含明文字样');
    // manifest 里记的是明文 sha256
    equal(item.sha256, before[i].hash, 'manifest 记明文 sha256');
    ok(executor.vault.hasKey(r.manifestId), '密钥已生成');
  }
  // 还原后逐字节一致
  const back = executor.restore(r.manifestId);
  equal(back.restored, 3, '还原 3 个');
  for (const b of before) {
    equal(sha256(b.path), b.hash, 'sha256 还原一致');
    equal(fs.readFileSync(b.path, 'utf8'), String(b.content), '内容一致');
  }
});

suite.test('密钥缺失 → 无法还原，记 lost，且不写坏数据回原位', () => {
  const target = path.join(root, 'a.txt');
  const hash = sha256(target);
  const r = executor.quarantineFiles({ instructionId: 'ins_enc2', targets: [target] });
  executor.deleteKey(r.manifestId);
  equal(fs.existsSync(target), false, '原件已加密移走');
  const back = executor.restore(r.manifestId);
  equal(back.lost, 1, '记 lost');
  equal(back.ok, false, '不 ok');
  equal(fs.existsSync(target), false, '没有密钥就不写回原位（避免坏数据）');
  ok(back.items[0].reason.indexOf('密钥') !== -1, '原因说明是缺密钥');
});

suite.test('隔离区加密不碰 shuffle（shuffle 仍是纯重命名）', () => {
  setup();
  const r = executor.shuffleDesktop({ instructionId: 'ins_enc3' });
  equal(r.shuffled, 3, 'shuffle 打乱 3 个');
  for (const it of r.manifest.items) {
    equal(it.crypto, undefined, 'shuffle 项不带加密元数据（只是改名）');
  }
});

suite.test('quarantine 与 shuffle 混用后 restoreAll 全部还原', () => {
  setup();
  const hashA = sha256(path.join(root, 'a.txt'));
  const q = executor.quarantineFiles({ instructionId: 'ins_mix1', targets: [path.join(root, 'a.txt')] });
  const s = executor.shuffleDesktop({ instructionId: 'ins_mix2' });
  const summary = executor.restoreAll();
  equal(summary.lost, 0, '无丢失');
  equal(fs.existsSync(path.join(root, 'a.txt')), true, 'a.txt 还原');
  equal(sha256(path.join(root, 'a.txt')), hashA, 'a.txt sha256 一致');
  const names = executor.store.get(s.manifestId).items.map(i => path.basename(i.from)).sort();
  const now = fs.readdirSync(root).filter(f => !f.startsWith('.') && f !== 'subdir');
  for (const n of names) ok(now.indexOf(n) !== -1, 'shuffle 原名还原: ' + n);
});

suite.test('manifest 含完整 原路径↔新路径、instructionId、createdAt', () => {
  const r = executor.quarantineFiles({ instructionId: 'ins_q3', taskId: 'task_1', targets: [path.join(root, 'a.txt')] });
  const m = executor.store.get(r.manifestId);
  equal(m.instructionId, 'ins_q3', 'instructionId');
  equal(m.taskId, 'task_1', 'taskId');
  ok(m.createdAt, 'createdAt');
  ok(m.items[0].from, '原路径');
  ok(m.items[0].to, '新路径');
  ok(m.items[0].sha256, 'sha256');
});

suite.test('重复 restore 幂等：不报错、不重复还原', () => {
  const r = executor.quarantineFiles({ instructionId: 'ins_q4', taskId: 'task_1', targets: [path.join(root, 'a.txt')] });
  const first = executor.restore(r.manifestId);
  equal(first.restored, 1, '首次还原 1');
  const second = executor.restore(r.manifestId);
  equal(second.restored, 0, '第二次不再还原');
  equal(second.already, 1, '记为已还原');
  equal(second.conflicts, 0, '无冲突');
  const third = executor.restore(r.manifestId);
  equal(third.restored, 0, '第三次仍幂等');
});

suite.test('原位被占 → conflict 且原文件不被覆盖', () => {
  const target = path.join(root, 'a.txt');
  const r = executor.quarantineFiles({ instructionId: 'ins_q5', taskId: 'task_1', targets: [target] });
  // 用户在原位放了新文件
  fs.writeFileSync(target, 'USER_NEW_DATA');
  const back = executor.restore(r.manifestId);
  equal(back.conflicts, 1, '记 1 个冲突');
  equal(back.ok, false, '整体不 ok');
  equal(fs.readFileSync(target, 'utf8'), 'USER_NEW_DATA', '用户文件未被覆盖');
  const m = executor.store.get(r.manifestId);
  equal(m.items[0].status, 'conflict', 'item 状态 conflict');
  ok(fs.existsSync(m.items[0].to), '隔离区文件仍在（用户可手动取回）');
});

suite.test('缺失 target → skipped，不中断其余', () => {
  const r = executor.quarantineFiles({
    instructionId: 'ins_q6', taskId: 'task_1',
    targets: [path.join(root, 'a.txt'), path.join(root, 'not_exist.txt'), path.join(root, 'b.txt')]
  });
  equal(r.moved, 2, '移动 2 个');
  equal(r.skipped.length, 1, '跳过 1 个');
  contains(r.skipped[0].reason, '不存在', '跳过原因');
});

suite.test('越界 target → skipped（不在 workRoot 内）', () => {
  const outside = path.join(os.tmpdir(), 'definitely-outside-dsc-' + Date.now() + '.txt');
  const r = executor.quarantineFiles({ instructionId: 'ins_q7', taskId: 'task_1', targets: [outside] });
  equal(r.moved, 0, '未移动');
  contains(r.skipped[0].reason, '不在 workRoot', '越界原因');
});

suite.test('目录 / 点开头文件 / 符号链接的处理', () => {
  // 目录不隔离
  const r1 = executor.quarantineFiles({ instructionId: 'ins_d1', targets: [path.join(root, 'subdir')] });
  contains(r1.skipped[0].reason, '不是普通文件', '目录被跳过');
  // 点开头文件：quarantine 允许（用户可显式指定），但 shuffle 跳过
  const r2 = executor.quarantineFiles({ instructionId: 'ins_d2', targets: [path.join(root, '.hidden.txt')] });
  equal(r2.moved, 1, '点开头文件可被显式隔离');
  // 符号链接跳过（Windows 无权限时降级为文件类型测试）
  const linkPath = path.join(root, 'link.txt');
  let madeLink = false;
  try {
    fs.symlinkSync(path.join(root, 'b.txt'), linkPath);
    madeLink = true;
  } catch (e) { madeLink = false; }
  if (madeLink) {
    const r3 = executor.quarantineFiles({ instructionId: 'ins_d3', targets: [linkPath] });
    contains(r3.skipped[0].reason, '符号链接', '符号链接被跳过');
  } else {
    ok(true, '当前环境无法建符号链接，跳过该子用例');
  }
});

suite.test('隔离区/账本目录自身拒绝被隔离', () => {
  const quarantineSelf = path.join(root, '.quarantine');
  const r = executor.quarantineFiles({ instructionId: 'ins_d4', targets: [quarantineSelf] });
  ok(r.skipped.length >= 1, '有跳过');
  ok(fs.existsSync(quarantineSelf), '隔离区目录仍在');
});

// ---------- shuffle_desktop ----------

suite.test('shuffle 只重命名顶层普通文件，保留扩展名，跳过目录/点文件', () => {
  setup();
  // before 只统计顶层普通文件（排除目录 subdir 与点开头文件）
  const before = fs.readdirSync(root).filter(f => !f.startsWith('.') && f !== 'subdir');
  const names = ['a.txt', 'b.txt', 'c.txt'];
  equal(JSON.stringify(before.sort()), JSON.stringify(names), '初始 3 个普通文件');
  const hashes = {};
  for (const n of names) hashes[n] = sha256(path.join(root, n));
  const r = executor.shuffleDesktop({ instructionId: 'ins_s1', taskId: 'task_1' });
  equal(r.shuffled, 3, '打乱 3 个');
  // 跳过：subdir（目录）、.hidden.txt（点开头文件）、.quarantine/.discipline（agent 内部目录）
  equal(r.skipped.length, 4, '跳过 4 项：目录+点文件+2 个 agent 内部目录');
  const skipReasons = r.skipped.map(s => s.reason).join('|');
  contains(skipReasons, '目录', '跳过目录');
  contains(skipReasons, '点开头文件', '跳过点文件');
  contains(skipReasons, 'agent 内部目录', '跳过 agent 内部目录');
  const after = fs.readdirSync(root).filter(f => !f.startsWith('.') && f !== 'subdir');
  equal(after.length, 3, '3 个用户文件打乱改名后仍在顶层（数量不变）');
  for (const n of after) ok(/\.txt$/.test(n), '扩展名保留: ' + n);
  for (const n of before) equal(fs.existsSync(path.join(root, n)), false, '原名已不在');
  // 内容集合不变
  const afterHashes = after.map(f => sha256(path.join(root, f))).sort();
  const beforeHashes = names.map(n => hashes[n]).sort();
  equal(JSON.stringify(afterHashes), JSON.stringify(beforeHashes), '文件内容集合不变');
  // 子目录内容不受影响
  ok(fs.existsSync(path.join(root, 'subdir', 'inner.txt')), '子目录文件未动');
  ok(fs.existsSync(path.join(root, '.hidden.txt')), '点开头文件未动');
  // manifest 记录
  const m = executor.store.get(r.manifestId);
  equal(m.kind, 'shuffle', 'kind=shuffle');
  equal(m.items.length, 3, '3 条 item');
  for (const it of m.items) ok(it.from !== it.to, 'from≠to');
});

suite.test('shuffle 后可 100% 还原', () => {
  setup();
  const before = fs.readdirSync(root).filter(f => !f.startsWith('.'));
  const contents = before.map(f => ({ f, hash: sha256(path.join(root, f)) }));
  const r = executor.shuffleDesktop({ instructionId: 'ins_s2', taskId: 'task_1' });
  const back = executor.restore(r.manifestId);
  equal(back.restored, 3, '还原 3 个');
  const after = fs.readdirSync(root).filter(f => !f.startsWith('.'));
  equal(JSON.stringify(after.sort()), JSON.stringify(before.sort()), '文件名集合还原');
  for (const c of contents) equal(sha256(path.join(root, c.f)), c.hash, 'sha256 一致: ' + c.f);
});

// ---------- restoreAll ----------

suite.test('restoreAll 按时间倒序还原多个 manifest', () => {
  setup();
  const q = executor.quarantineFiles({ instructionId: 'ins_ra1', targets: [path.join(root, 'a.txt')] });
  const s = executor.shuffleDesktop({ instructionId: 'ins_ra2' });
  const hashA = executor.store.get(q.manifestId).items[0].sha256; // manifest 记的明文 sha256
  const summary = executor.restoreAll();
  ok(summary.restored >= 1, '至少还原隔离文件');
  equal(fs.existsSync(path.join(root, 'a.txt')), true, 'a.txt 已还原');
  equal(sha256(path.join(root, 'a.txt')), hashA, 'sha256 一致');
  // shuffle 的文件名也还原
  const names = executor.store.get(s.manifestId).items.map(i => path.basename(i.from)).sort();
  const now = fs.readdirSync(root).filter(f => !f.startsWith('.'));
  for (const n of names) ok(now.indexOf(n) !== -1, 'shuffle 原名已还原: ' + n);
});

suite.test('revoke_all 指令 → restoreAll', () => {
  setup();
  executor.quarantineFiles({ instructionId: 'ins_rv1', targets: [path.join(root, 'a.txt')] });
  const out = executor.execute({ action: 'revoke_all', id: 'ins_rv', level: null, taskId: 'task_1', step: null, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true });
  equal(fs.existsSync(path.join(root, 'a.txt')), true, '文件已还原');
  ok(typeof out.restored === 'number', '返回还原计数');
});

suite.test('前端动作原样返回非本地动作', () => {
  for (const action of ['notify', 'popup_countdown', 'spawn_bugs']) {
    const out = executor.execute({ action, id: 'ins_f', level: 'L0', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: false });
    equal(out.local, false, action + ' 非本地');
    contains(out.note, '非本地动作', '有说明');
  }
});

suite.test('execute 分发 quarantine_files / shuffle_desktop', () => {
  setup();
  const base = { level: 'L4', taskId: 't', step: { index: 0, label: 'x' }, issuedAt: '2026-10-16T20:30:00+08:00', reversible: true };
  const q = executor.execute(Object.assign({ action: 'quarantine_files', id: 'ins_e1', payload: { targets: [path.join(root, 'a.txt')] } }, base));
  equal(q.action, 'quarantine_files', 'quarantine');
  const s = executor.execute(Object.assign({ action: 'shuffle_desktop', id: 'ins_e2', payload: {} }, base));
  equal(s.action, 'shuffle_desktop', 'shuffle');
  throws(() => executor.execute(Object.assign({ action: 'nope', id: 'ins_e3' }, base)), '未知 action 抛错');
});

// ---------- 审计 ----------

suite.test('executor 审计 JSONL 含 quarantine/shuffle/restore/restore_all', () => {
  setup();
  executor.quarantineFiles({ instructionId: 'ins_au1', targets: [path.join(root, 'a.txt')] });
  executor.shuffleDesktop({ instructionId: 'ins_au2' });
  executor.restoreAll();
  const rows = readJsonl(executor.store.auditPath);
  const events = rows.map(r => r.event);
  contains(events.join(','), 'executor_quarantine', 'quarantine 事件');
  contains(events.join(','), 'executor_shuffle', 'shuffle 事件');
  contains(events.join(','), 'executor_restore_all', 'restore_all 事件');
  ok(rows.every(r => typeof r.ts === 'string'), '每行 ts');
});

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
