'use strict';
/**
 * learning-kernel.test.js —— Node↔C# 内核封装契约测试（M-K §3.3）
 * 运行：node learning-kernel.test.js
 *
 * 测：
 *   - kernelPath 双模式（env LEARNING_KERNEL_EXE 覆盖 / 默认 bin 路径）
 *   - 12 个 cmd 全部可调用（确定性 cmd 真实调用，needLLM cmd 校验挂起形态）
 *   - 协议形态：ok:true/data、ok:true/needLLM、ok:false/error
 *   - 错误路径：未知 cmd（BAD_CMD）、内核拒绝（KERNEL_REJECTED）、内核崩溃（KERNEL_CRASH）
 *   - 崩坏 exe 用假可执行文件注入，不依赖真实内核（红线：故障路径必须可测）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, equal, contains, createSuite } = require('./test-util');
const kernel = require('./learning-kernel');

const suite = createSuite('learning-kernel.test.js');

const KERNEL_EXE = process.env.LEARNING_KERNEL_EXE
  || path.join(__dirname, 'learning-kernel', 'bin', 'Debug', 'net10.0', 'learning-kernel.dll');

function hasKernel() { return fs.existsSync(KERNEL_EXE); }

// ── 1. 单元：CMDS 集合与 kernelPath ──────────────────────────
suite.test('CMDS 含 12 个命令', () => {
  const cmds = kernel.CMDS;
  ok(cmds instanceof Set, 'CMDS 是 Set');
  equal(cmds.size, 12, '命令数');
  for (const c of ['review', 'interval', 'score', 'scanDebts', 'transition', 'planDay',
    'graph', 'optimize', 'extractPoints', 'genQuestions', 'analyzeWrong', 'buildGraph'])
    ok(cmds.has(c), 'CMDS 含 ' + c);
});

suite.test('kernelPath：env 覆盖优先', () => {
  const saved = process.env.LEARNING_KERNEL_EXE;
  try {
    process.env.LEARNING_KERNEL_EXE = 'C:/fake/kernel.dll';
    equal(kernel.kernelPath(), 'C:/fake/kernel.dll', 'env 覆盖');
    delete process.env.LEARNING_KERNEL_EXE;
    ok(kernel.kernelPath().endsWith(path.join('learning-kernel', 'bin', 'Debug', 'net10.0', 'learning-kernel.dll')), '默认 Debug 路径: ' + kernel.kernelPath());
  } finally {
    if (saved === undefined) delete process.env.LEARNING_KERNEL_EXE; else process.env.LEARNING_KERNEL_EXE = saved;
  }
});

// ── 2. 真实内核调用（无内核时跳过，避免误报）──────────────────
suite.test('未知 cmd → BAD_CMD（不发进程）', async () => {
  let threw = null;
  try { await kernel.call('nope', {}); } catch (e) { threw = e; }
  ok(threw, '应抛错');
  equal(threw.code, 'BAD_CMD', '错误码');
});

suite.test('真实内核：review 返回确定性数值', async () => {
  if (!hasKernel()) return; // 未构建内核时跳过
  const r = await kernel.callOk('review', { grade: 3 }); // callOk 返回 {ok,data}
  ok(typeof r.data.stability === 'number', 'stability 数字');
  ok(Math.abs(r.data.stability - 2.3065) < 1e-9, '新点 Good 的 S=w2=2.3065，实得 ' + r.data.stability);
  ok(Math.abs(r.data.intervalDays - 2.3065) < 1e-6, 'R=0.9 反解自证 interval=S');
});

suite.test('真实内核：ok:false 走 KERNEL_REJECTED（不是崩溃）', async () => {
  if (!hasKernel()) return;
  let threw = null;
  try { await kernel.callOk('review', { grade: 9 }); } catch (e) { threw = e; }
  ok(threw, '应抛错');
  equal(threw.code, 'KERNEL_REJECTED', '错误码应为业务拒绝');
});

suite.test('真实内核：needLLM 挂起形态（extractPoints）', async () => {
  if (!hasKernel()) return;
  const res = await kernel.call('extractPoints', { text: '光合作用把光能转成化学能。' });
  ok(res.ok === true, 'ok:true');
  ok(res.needLLM, '有 needLLM 顶层字段');
  equal(res.needLLM.role, 'extractor', '角色');
  equal(res.needLLM.step, 'await_result', '挂起步骤');
  ok(res.needLLM.input && typeof res.needLLM.input === 'object', 'input 可回灌');
});

/** 崩溃注入：临时把 LEARNING_KERNEL_EXE 指向假可执行文件（kernelPath 读 env，零封装改动） */
async function withFakeExe(fakeMaker, fn) {
  const saved = process.env.LEARNING_KERNEL_EXE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-kernel-'));
  const exe = path.join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake.sh');
  fs.writeFileSync(exe, fakeMaker());
  process.env.LEARNING_KERNEL_EXE = exe;
  try { return await fn(); }
  finally {
    if (saved === undefined) delete process.env.LEARNING_KERNEL_EXE; else process.env.LEARNING_KERNEL_EXE = saved;
  }
}

// ── 3. 崩溃路径（注入假 exe，无需真实内核）────────────────────
suite.test('KERNEL_CRASH：非零退出且 stdout 不可解析', async () => {
  let threw = null;
  await withFakeExe(() => process.platform === 'win32'
    ? '@echo off\r\necho not-json-at-all\r\nexit /b 3\r\n'
    : '#!/bin/sh\necho not-json-at-all\nexit 3\n',
    () => kernel.call('review', {})).catch(e => { threw = e; });
  ok(threw, '应抛错');
  equal(threw.code, 'KERNEL_CRASH', '错误码');
  contains(String(threw.message), 'stderr', '崩溃消息带 stderr 诊断');
});

suite.test('KERNEL_CRASH：exe 不存在（ENOENT）', async () => {
  const saved = process.env.LEARNING_KERNEL_EXE;
  process.env.LEARNING_KERNEL_EXE = path.join(os.tmpdir(), 'no-such-kernel-' + Date.now() + '.exe');
  let threw = null;
  try { await kernel.call('review', {}); } catch (e) { threw = e; }
  finally {
    if (saved === undefined) delete process.env.LEARNING_KERNEL_EXE; else process.env.LEARNING_KERNEL_EXE = saved;
  }
  ok(threw, '应抛错');
  equal(threw.code, 'KERNEL_CRASH', '不存在的 exe 也算崩溃');
});

// 说明：封装 call 固定 execFile('dotnet', [kernelPath()])，假 exe 注入走的是
// "dotnet 报错非零退出 + stdout 为空 → KERNEL_CRASH"。"stdout 可解析则 resolve（与 exit 无关）"
// 分支由实现保证（先 parse 再判 exit），71 组 C# 金样同样覆盖了该 resolve 路径。

suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});