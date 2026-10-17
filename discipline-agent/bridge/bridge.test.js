'use strict';
/**
 * bridge.test.js —— A↔B 连接层契约测试
 *
 * 覆盖：能力自述、状态推进、时间门禁、逐级升级、L4/L5 真实文件动作、
 *       完成即撤销还原、审计可查、边界（Host/Origin/体积/非法 JSON/未知路由）。
 *
 * 跑法：node bridge/bridge.test.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, equal, contains, createSuite } = require('../test-util');
const { createBridgeHandler, startBridge } = require('./server.cjs');
const { createDisciplineService } = require('./service.cjs');

const suite = createSuite('bridge');

function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), 'da-bridge-test', name + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 假时钟：时间只在我们推进时前进 */
function fakeClock(startMs) {
  let t = startMs;
  const timers = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      const due = timers.filter(x => x.at <= t);
      for (const d of due) { const i = timers.indexOf(d); if (i >= 0) timers.splice(i, 1); d.fn(); }
    },
    setTimeout(fn, ms) { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimeout(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    clearAll() { timers.length = 0; },
    pending() { return timers.length; }
  };
}

/** 起一套带假时钟的服务，并在 root 里放几个待打乱的文件 */
function makeEnv(opts) {
  const o = opts || {};
  const root = tmpRoot('env');
  fs.writeFileSync(path.join(root, 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(root, 'b.txt'), 'BBB');
  fs.writeFileSync(path.join(root, '游戏截图.png'), 'PNG');
  fs.writeFileSync(path.join(root, '无关文件.txt'), 'OTHER');
  const clock = fakeClock(Date.UTC(2026, 9, 17, 4, 0, 0));
  const service = createDisciplineService({
    workRoot: root,
    auditPath: path.join(root, '.discipline', 'audit', 'audit.jsonl'),
    clock,
    options: {
      taskId: 'task_bridge',
      authorizeL4: o.authorizeL4 === true,
      dailyCap: o.dailyCap || 4,
      l4Targets: [path.join(root, '游戏截图.png')],
      shuffleTargetDir: root
    }
  });
  const state = {
    state: 'lying_bed', confidence: 0.9,
    evidence: 'camera:卧姿·床区域', explain: '摄像头判定为床区域卧姿',
    source: 'manual'
  };
  return { root, clock, service, state };
}

suite.test('能力自述：级别/动作齐全，不谎报摄像头与模型', () => {
  const env = makeEnv();
  const caps = env.service.capabilities();
  equal(caps.levels.length, 6, 'L0..L5');
  equal(caps.levels[5], 'L5', '最高级 L5');
  equal(caps.levelAction.L3, 'screen_flash', 'L3=screen_flash（前端动作）');
  equal(caps.levelAction.L4, 'shuffle_desktop', 'L4=shuffle_desktop（本地动作）');
  equal(caps.levelAction.L5, 'quarantine_files', 'L5=quarantine_files（本地动作）');
  equal(caps.capabilities.camera, false, '摄像头能力如实为 false');
  equal(caps.capabilities.llm, false, '不谎报直连模型');
  rmrf(env.root);
});

suite.test('start 下发 L0；未到间隔时 tick 被时间门禁拦住且不改级', () => {
  const env = makeEnv();
  const a = env.service.start({ state: env.state });
  equal(a.level, 'L0', '启动即 L0');
  equal(a.action, 'notify', 'L0→notify');
  ok(a.instructionId, '带指令 id');
  const b = env.service.tick();
  equal(b.level, 'L0', '门禁拦住，仍是 L0');
  contains(b.reason, '不足', '原因说明间隔不足');
  equal(env.service.bus.counts().issued, 1, '只下发过一条指令');
  rmrf(env.root);
});

suite.test('逐级升级：L1→L2→L3 按 2/3/5 分钟门禁推进，L3 不动文件', () => {
  const env = makeEnv();
  env.service.start({ state: env.state });
  env.clock.advance(2 * 60000);
  const l1 = env.service.tick();
  equal(l1.level, 'L1', '+2min → L1');
  equal(l1.action, 'popup_countdown', 'L1→popup_countdown');
  env.clock.advance(3 * 60000);
  const l2 = env.service.tick();
  equal(l2.level, 'L2', '+3min → L2');
  equal(l2.action, 'spawn_bugs', 'L2→spawn_bugs');
  env.clock.advance(5 * 60000);
  const l3 = env.service.tick();
  equal(l3.level, 'L3', '+5min → L3');
  equal(l3.action, 'screen_flash', 'L3→screen_flash（前端全屏，A 侧不落地）');
  const shuffled = fs.readdirSync(env.root).filter(f => /^shuffled-/.test(f));
  equal(shuffled.length, 0, 'L3 不动文件');
  rmrf(env.root);
});

suite.test('L4 真实洗牌：重命名 workRoot 顶层文件并写账本', () => {
  const env = makeEnv();
  env.service.start({ state: env.state });
  for (const gap of [2, 3, 5, 5]) { env.clock.advance(gap * 60000); env.service.tick(); }
  const l4 = env.service.state().escalation;
  equal(l4.level, 'L4', '到 L4');
  const shuffled = fs.readdirSync(env.root).filter(f => /^shuffled-/.test(f));
  ok(shuffled.length >= 2, '桌面被打乱（' + shuffled.length + ' 个）');
  ok(env.service.executor.listManifests().some(m => m.kind === 'shuffle'), '写了 shuffle 账本');
  rmrf(env.root);
});

suite.test('L5 未授权 → 封顶 L4，绝不隔离', () => {
  const env = makeEnv({ authorizeL4: false });
  env.service.start({ state: env.state });
  for (const gap of [2, 3, 5, 5]) { env.clock.advance(gap * 60000); env.service.tick(); }
  equal(env.service.state().escalation.level, 'L4', '停在 L4');
  env.clock.advance(5 * 60000);
  const snap = env.service.tick();
  equal(snap.level, 'L4', '尝试 L5 被拦，仍 L4');
  contains(snap.reason, 'L5 未授权', '原因说明未授权');
  equal(env.service.bus.list({ action: 'quarantine_files' }).length, 0, '没有任何隔离指令');
  // L4 洗牌已把原名改掉，这里判"隔离区为空"才是"没被隔离"的正确证据
  const qdir = path.join(env.root, '.quarantine');
  const quarantined = fs.existsSync(qdir) ? fs.readdirSync(qdir).filter(f => f !== 'keys') : [];
  equal(quarantined.length, 0, '隔离区为空（目标未被隔离）');
  rmrf(env.root);
});

suite.test('L5 已授权 → 隔离指定文件，还原后逐字节一致', () => {
  const env = makeEnv({ authorizeL4: true });
  const target = path.join(env.root, '游戏截图.png');
  const before = sha256(target);
  env.service.start({ state: env.state });
  for (const gap of [2, 3, 5, 5, 5]) { env.clock.advance(gap * 60000); env.service.tick(); }
  equal(env.service.state().escalation.level, 'L5', '到 L5');
  equal(env.service.bus.list({ action: 'quarantine_files' }).length, 1, '隔离指令已下发');
  equal(fs.existsSync(target), false, '目标已移入隔离区');
  const out = env.service.restore();
  ok(out.restored >= 1, '还原了至少一份账本');
  equal(fs.existsSync(target), true, '目标已回到原位');
  equal(sha256(target), before, '内容逐字节一致');
  rmrf(env.root);
});

suite.test('完成一步 → 撤销全部强制 + 文件 100% 还原 + 状态机停止', () => {
  const env = makeEnv({ authorizeL4: true });
  const target = path.join(env.root, '游戏截图.png');
  const before = sha256(target);
  env.service.start({ state: env.state });
  for (const gap of [2, 3, 5, 5]) { env.clock.advance(gap * 60000); env.service.tick(); }
  equal(env.service.state().escalation.level, 'L4', '先到 L4（桌面已打乱）');
  const snap = env.service.completeStep('用户坐到书桌前');
  equal(snap.status, 'revoked', '状态机已停止');
  ok(snap.restore && snap.restore.ok, 'revoke 成功');
  equal(snap.restore.lost, 0, '零丢失');
  equal(fs.existsSync(target), true, '文件已还原');
  equal(sha256(target), before, '内容逐字节一致');
  rmrf(env.root);
});

suite.test('审计可查：按指令串起四段链路', () => {
  const env = makeEnv({ authorizeL4: true });
  env.service.start({ state: env.state });
  for (const gap of [2, 3, 5, 5]) { env.clock.advance(gap * 60000); env.service.tick(); }
  const ins = env.service.bus.list({ action: 'shuffle_desktop' })[0];
  ok(ins, '拿到 L4 指令');
  const trace = env.service.auditQuery({ action: 'traceInstruction', instructionId: ins.id, manifestId: ins.manifestId });
  ok(trace !== undefined && trace !== null, '能查到该指令的轨迹');
  ok(Array.isArray(env.service.auditQuery({ action: 'byTask', taskId: 'task_bridge' })), '按任务查询返回数组');
  rmrf(env.root);
});

suite.test('handler 边界：未知路由 404、非法 JSON 400、未装配 ready=false', async () => {
  const handler = createBridgeHandler({ getService: () => null });
  const nf = await handler({ method: 'POST', path: '/api/nope', headers: {}, body: '' });
  equal(nf.status, 404, '未知路由 404');
  const bad = await handler({ method: 'POST', path: '/api/discipline/tick', headers: {}, body: '{bad' });
  equal(bad.status, 400, '非法 JSON 400');
  equal(bad.body.error.code, 'BAD_JSON', '错误码明确');
  const health = await handler({ method: 'GET', path: '/api/health', headers: {}, body: '' });
  equal(health.status, 200, '健康检查 200');
  equal(health.body.ready, false, '未装配运行时如实 ready=false');
});

suite.test('handler：ack 未知名指令 → 404；ack 真实指令 → ok', async () => {
  const env = makeEnv();
  const handler = createBridgeHandler({ service: env.service });
  const missing = await handler({ method: 'POST', path: '/api/discipline/ack', headers: {}, body: JSON.stringify({ instructionId: 'ins_nope' }) });
  equal(missing.status, 404, '未知名指令 404');
  const started = env.service.start({ state: env.state });
  const acked = await handler({ method: 'POST', path: '/api/discipline/ack', headers: {}, body: JSON.stringify({ instructionId: started.instructionId }) });
  equal(acked.status, 200, '真实指令 ack 成功');
  equal(acked.body.ok, true, 'ok=true');
  rmrf(env.root);
});

suite.test('HTTP 端到端：起真实端口 → 走完 start/state/complete', async () => {
  const env = makeEnv();
  const server = startBridge({ port: 0, service: env.service });
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const health = await call('GET', '/api/health');
    equal(health.status, 200, 'health 200');
    equal(health.body.ready, true, '装配好即 ready');

    const started = await call('POST', '/api/discipline/start', { state: env.state });
    equal(started.status, 200, 'start 200');
    equal(started.body.level, 'L0', 'L0 起步');
    equal(started.body.action, 'notify', 'L0→notify');

    const st = await call('GET', '/api/discipline/state');
    equal(st.status, 200, 'state 200');
    equal(st.body.escalation.level, 'L0', '状态可读');

    const done = await call('POST', '/api/discipline/complete', { reason: '前端点了完成' });
    equal(done.status, 200, 'complete 200');
    equal(done.body.status, 'revoked', '完成即撤销');
  } finally {
    // Node 24 + Windows：close() 回调后仍有 keep-alive 套接字在关闭途中，
    // 等一小段时间让 libuv 收干净句柄，避免退出时的 UV_HANDLE_CLOSING 断言。
    server.close();
    await new Promise(r => setTimeout(r, 300));
    rmrf(env.root);
  }
});

suite.runAsync().then(result => process.exit(result.failures.length ? 1 : 0));
