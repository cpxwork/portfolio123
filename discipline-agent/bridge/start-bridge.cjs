'use strict';
/**
 * start-bridge.cjs —— 启动 discipline-agent 本机桥服务
 *
 * 跑法（在 discipline-agent 目录）：
 *   node bridge/start-bridge.cjs
 *   node bridge/start-bridge.cjs --work-root "C:\Users\yi\laisgo\Desktop\demo" --authorize-l5
 *
 * 参数：
 *   --port <n>          监听端口，默认 8879
 *   --work-root <path>  受控工作根（文件操作只在此范围内）；默认系统临时目录下的专属目录
 *   --task-id <id>      任务 id，默认 task_bridge
 *   --authorize-l5      授权 L5（隔离指定文件）。不给则 L5 被封顶在 L4
 *   --l5-target <path>  L5 可隔离的文件，可重复；必须是 work-root 内的真实文件
 *
 * 安全：只监听 127.0.0.1；永不删除任何文件；全部动作记 manifest，随时可还原。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBridge } = require('./server.cjs');

function parseArgs(argv) {
  const out = { port: 8879, workRoot: null, taskId: 'task_bridge', authorizeL5: false, l5Targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--work-root') out.workRoot = argv[++i];
    else if (a === '--task-id') out.taskId = argv[++i];
    else if (a === '--authorize-l5') out.authorizeL5 = true;
    else if (a === '--l5-target') out.l5Targets.push(argv[++i]);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const workRoot = args.workRoot
    ? path.resolve(args.workRoot)
    : path.join(os.tmpdir(), 'discipline-agent-bridge');

  fs.mkdirSync(workRoot, { recursive: true });

  // L5 目标必须是 workRoot 内的真实文件；不合法就直接报错，不静默降级
  const l5Targets = [];
  for (const t of args.l5Targets) {
    const abs = path.resolve(t);
    if (abs !== workRoot && !abs.startsWith(workRoot + path.sep)) {
      throw new Error('L5 目标必须在 work-root 内：' + abs);
    }
    if (!fs.existsSync(abs)) throw new Error('L5 目标不存在：' + abs);
    l5Targets.push(abs);
  }

  const server = startBridge({
    port: args.port,
    workRoot,
    options: {
      taskId: args.taskId,
      authorizeL4: args.authorizeL5,     // 选项名沿用 authorizeL4，现契约控制 L5
      dailyCap: 4,
      l4Targets: l5Targets,
      shuffleTargetDir: workRoot
    }
  });

  server.once('listening', () => {
    const port = server.address().port;
    process.stdout.write(
      'discipline-agent 桥就绪：http://127.0.0.1:' + port + '\n' +
      '  受控工作根：' + workRoot + '\n' +
      '  L5 隔离授权：' + (args.authorizeL5 ? '是（' + l5Targets.length + ' 个目标）' : '否（L5 封顶在 L4）') + '\n' +
      '  健康检查：GET /api/health\n' +
      '  前端接入：见 bridge/FRONTEND.md\n'
    );
  });
  server.once('error', () => {
    process.stderr.write('桥无法启动，请检查端口 ' + args.port + ' 是否被占用。\n');
    process.exitCode = 1;
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { server.close(); server.closeAllConnections(); });
  }
  return server;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(String(e.message || e) + '\n'); process.exitCode = 1; }
}

module.exports = { main, parseArgs };
