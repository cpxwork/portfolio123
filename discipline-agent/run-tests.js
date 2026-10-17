'use strict';
/**
 * run-tests.js —— A 侧测试总入口
 * 跑法：node run-tests.js
 * 依次执行所有里程碑测试；任一失败则整体退出码为 1。
 */

const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  'instructions.test.js',
  'manifest.test.js',
  'executor.test.js',
  'crypto-vault.test.js',
  'chat-sense.test.js',
  'state-sensor.test.js',
  'escalation.test.js',
  'audit.test.js',
  // 模型路径（架构变更：纯规则 → 多模型协作）
  'llm-client.test.js',
  'task-planner-llm.test.js',
  'escalation-llm.test.js',
  // M-K 学习子系统（Node↔C# 内核 + 学习记录存储）
  'learning-kernel.test.js',
  'learning-store.test.js'
];

let failed = 0;
let ran = 0;
for (const suite of SUITES) {
  const abs = path.join(__dirname, suite);
  if (!require('fs').existsSync(abs)) continue; // 尚未交付的里程碑跳过
  ran++;
  console.log('\n▶ ' + suite);
  try {
    execFileSync(process.execPath, [abs], { stdio: 'inherit', cwd: __dirname });
  } catch (e) {
    failed++;
    console.log('✗ ' + suite + ' 失败（exit ' + e.status + '）');
  }
}

console.log('\n' + '='.repeat(64));
console.log('总计: ' + ran + ' 套测试，' + (ran - failed) + ' 套通过，' + failed + ' 套失败');
process.exit(failed ? 1 : 0);
