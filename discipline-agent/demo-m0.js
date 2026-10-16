'use strict';
/**
 * demo-m0.js —— A-M0 闭环演示（联调用）
 *
 * 跑法：node demo-m0.js
 * 演示内容：指令下发 → executor 执行 L3 打乱 / L4 隔离 → manifest 记账 →
 *           审计日志 → revoke_all 一键还原 → sha256 校验。
 * 安全：所有文件都在临时目录里生成，绝不碰真实桌面。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstructionBus, isoWithOffset } = require('./instructions');
const { createExecutor, sha256OfFile } = require('./executor');
const { tmpDir } = require('./test-util');

function hr(title) {
  console.log('\n' + '='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

function main() {
  const root = tmpDir('dsc-demo-m0-');
  const logPath = path.join(root, 'audit.jsonl');

  // 造一个"假桌面"：3 个文件 + 1 个子目录
  fs.writeFileSync(path.join(root, '数学作业.docx'), 'math homework');
  fs.writeFileSync(path.join(root, '英语单词.txt'), 'word list');
  fs.writeFileSync(path.join(root, '照片.png'), 'PNGDATA');
  fs.mkdirSync(path.join(root, '游戏存档'));
  fs.writeFileSync(path.join(root, '游戏存档', 'save.dat'), 'SAVE');
  console.log('临时执行根:', root);
  console.log('初始顶层文件:', fs.readdirSync(root).filter(f => !f.startsWith('.')).join(', '));

  const bus = createInstructionBus({ logPath });
  const executor = createExecutor({ workRoot: root });

  const originals = ['数学作业.docx', '英语单词.txt', '照片.png']
    .map(n => ({ name: n, abs: path.join(root, n), hash: sha256OfFile(path.join(root, n)) }));
  console.log('\n原始 sha256:');
  for (const o of originals) console.log('  ' + o.name + ' → ' + o.hash);

  hr('步骤 1：下发 L3 shuffle_desktop 指令');
  const insL3 = bus.issue({
    id: 'ins_L3_01', level: 'L3', action: 'shuffle_desktop', taskId: 'task_math_01',
    step: { index: 2, label: '打开数学作业本', stateAtPlan: 'seated_desk' },
    issuedAt: isoWithOffset(new Date()), expiresAt: isoWithOffset(new Date(Date.now() + 5 * 60000)),
    reversible: true, manifestId: null,
    reason: '用户 5 分钟未响应 L2 提醒',
    stateEvidence: { state: 'seated_desk', confidence: 0.82, source: 'time_rules', explain: '18 分钟无操作，时段为晚间自习时间' }
  });
  bus.ack(insL3.id, { by: 'executor' });
  const rShuffle = executor.execute(insL3);
  bus.complete(insL3.id, { ok: rShuffle.ok, moved: rShuffle.shuffled });
  console.log('打乱完成:', rShuffle.shuffled, '个文件，manifestId =', rShuffle.manifestId);
  console.log('现在顶层:', fs.readdirSync(root).filter(f => !f.startsWith('.') && f !== '游戏存档').join(', '));
  console.log('子目录未受影响:', fs.existsSync(path.join(root, '游戏存档', 'save.dat')) ? '是' : '否');

  hr('步骤 2：下发 L4 quarantine_files 指令（把"游戏存档"换成隔离一个文件）');
  const targetFile = path.join(root, '音乐歌单.txt');
  fs.writeFileSync(targetFile, 'playlist data');
  const insL4 = bus.issue({
    id: 'ins_L4_01', level: 'L4', action: 'quarantine_files', taskId: 'task_math_01',
    step: { index: 3, label: '做第 1 题', stateAtPlan: 'seated_desk' },
    issuedAt: isoWithOffset(new Date()), expiresAt: isoWithOffset(new Date(Date.now() + 5 * 60000)),
    reversible: true, manifestId: null,
    payload: { targets: [targetFile] },
    reason: '用户仍未响应，升至 L4'
  });
  bus.ack(insL4.id, { by: 'executor' });
  const rQuar = executor.execute(insL4);
  bus.complete(insL4.id, { ok: rQuar.ok, moved: rQuar.moved });
  console.log('隔离完成:', rQuar.moved, '个文件 →', path.join(root, '.quarantine', rQuar.manifestId));
  console.log('原位还在吗:', fs.existsSync(targetFile) ? '在（异常）' : '不在（正确）');

  hr('步骤 3：用户完成一步 → 下发 revoke_all');
  const insRevoke = bus.issue({
    id: 'ins_revoke_01', level: null, action: 'revoke_all', taskId: 'task_math_01',
    step: null, issuedAt: isoWithOffset(new Date()), expiresAt: null,
    reversible: true, manifestId: null, reason: '用户点击"已完成第 2 步"'
  });
  bus.ack(insRevoke.id, { by: 'executor' });
  const rAll = executor.execute(insRevoke);
  bus.complete(insRevoke.id, rAll);
  bus.revoke('task_math_01', '任务完成，撤销全部未完成指令');
  console.log('restoreAll 汇总:', JSON.stringify(rAll));

  hr('步骤 4：逐字节校验还原结果');
  let allOk = true;
  for (const o of originals) {
    const now = sha256OfFile(o.abs);
    const same = now === o.hash;
    allOk = allOk && same;
    console.log((same ? '  ✓ ' : '  ✗ ') + o.name + ' sha256 ' + (same ? '一致' : '不一致(' + now + ')'));
  }
  const playlistBack = fs.existsSync(targetFile);
  console.log('  ' + (playlistBack ? '✓' : '✗') + ' 音乐歌单.txt 已还原到原位');
  allOk = allOk && playlistBack;

  hr('步骤 4b：隔离加密说明');
  console.log('  隔离区路径: ' + path.join(root, '.quarantine', '<manifestId>'));
  console.log('  加密算法: aes-256-gcm，每文件独立随机 IV');
  console.log('  manifest 只记 iv/authTag/plainSha256，绝不记密钥本身');
  console.log('  密钥目录: ' + path.join(root, '.discipline', 'keys') + '（与密文分目录存放）');
  console.log('  解密前先校验 sha256，不一致不落盘，不会把损坏数据写回原位');

  hr('步骤 5：审计日志（全链路）');
  const audit = bus.readAudit();
  console.log('日志文件:', logPath);
  for (const row of audit) {
    const extra = row.action ? ' [' + row.level + ' ' + row.action + ']' : '';
    console.log('  ' + row.ts + '  ' + row.event + extra);
  }

  hr('步骤 6：manifest 账本');
  for (const m of executor.listManifests()) {
    console.log('  ' + m.manifestId + ' (' + m.kind + ', ' + m.status + ') instructionId=' + m.instructionId);
    for (const it of m.items) console.log('      ' + it.status + '  ' + path.basename(it.from) + ' → ' + (it.to ? path.basename(it.to) : '-'));
  }

  hr('结论');
  console.log(allOk ? '✅ 全部文件 100% 还原，sha256 逐字节一致' : '❌ 存在未还原项，请检查上面的输出');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(allOk ? 0 : 1);
}

main();
