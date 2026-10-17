'use strict';
/**
 * learning-kernel.js —— C# 学习内核进程边界封装（M-K1 §3.0）
 *
 * 协议：每个请求一个 dotnet 进程；
 *   stdin 写 {"cmd":"...","args":{...}}，
 *   stdout 读 {"ok":true,"data":{...}} / {"ok":false,"error":"..."} / {"ok":true,"needLLM":{...}}。
 *   Node 与 C# 只走这条 JSON 进程边界（红线 4：不共享文件、不用网络端口）。
 *
 * KERNEL 路径双模式（M-K §3.0）：
 *   1) env LEARNING_KERNEL_EXE 显式覆盖（发布/自测路径）
 *   2) learning-kernel/publish/learning-kernel.dll（dotnet publish 交付产物）
 *   3) learning-kernel/bin/Debug/net10.0/learning-kernel.dll（开发期 dotnet build 产物）
 *
 * 超时：默认 5s；optimize/buildGraph 允许 60s。
 * 无共享状态：学习记录由 learning/store.js 持有，随 args 传入。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 5000;
const LONG_TIMEOUT_MS = 60000;
const LONG_CMDS = new Set(['optimize', 'buildGraph']);

/** 支持 12 个 cmd（M-K §3.0 枚举）；未知 cmd 由内核报错 */
const CMDS = new Set([
  'review', 'interval', 'score', 'scanDebts', 'transition', 'planDay',
  'graph', 'extractPoints', 'genQuestions', 'analyzeWrong', 'optimize', 'buildGraph'
]);

function kernelPath() {
  if (process.env.LEARNING_KERNEL_EXE) return process.env.LEARNING_KERNEL_EXE;
  const root = path.join(__dirname, 'learning-kernel');
  const pub = path.join(root, 'publish', 'learning-kernel.dll');
  if (fs.existsSync(pub)) return pub;
  return path.join(root, 'bin', 'Debug', 'net10.0', 'learning-kernel.dll');
}

/**
 * 调用内核。resolve 解析后的响应对象（{ok,data} / {ok:false,error} / {ok,needLLM}）；
 * 仅在"内核崩溃"（非零退出且 stdout 不可解析为 JSON）时 reject。
 * 业务侧用 callOk() 便捷取 data。
 */
function call(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    if (!CMDS.has(cmd)) {
      const e = new Error('未知 cmd: ' + cmd + '（内核协议只支持 ' + [...CMDS].join('/') + '）');
      e.code = 'BAD_CMD';
      return reject(e);
    }
    const payload = JSON.stringify({ cmd, args: args || {} });
    const timeoutMs = (opts && opts.timeoutMs) || (LONG_CMDS.has(cmd) ? LONG_TIMEOUT_MS : TIMEOUT_MS);
    const child = execFile(
      'dotnet',
      [kernelPath()],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let parsed = null;
        try { parsed = JSON.parse(String(stdout).trim()); } catch (_) { /* 崩溃时不可解析 */ }
        if (!parsed || typeof parsed.ok !== 'boolean') {
          const e2 = new Error(
            'learning-kernel 内核崩溃：非零退出或 stdout 不可解析' +
            (err && err.code ? '（exit=' + err.code + '）' : '') +
            (stderr ? ' stderr: ' + String(stderr).slice(0, 300) : ''));
          e2.code = 'KERNEL_CRASH';
          return reject(e2);
        }
        resolve(parsed);
      }
    );
    // stdin 写完整请求后立即关闭（内核 ReadToEnd）
    child.stdin.on('error', () => { /* 内核提前退出时的 EPIPE 忽略，回调里按崩溃处理 */ });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** call 的抛错版本：ok:false 也 throw（错误信息取内核 error 字段） */
async function callOk(cmd, args, opts) {
  const res = await call(cmd, args, opts);
  if (!res.ok) {
    const e = new Error('learning-kernel 拒绝请求（' + cmd + '）: ' + (res.error || '未知错误'));
    e.code = 'KERNEL_REJECTED';
    throw e;
  }
  return res;
}

module.exports = { call, callOk, kernelPath, CMDS, TIMEOUT_MS, LONG_TIMEOUT_MS };
