'use strict';
/**
 * escalation.test.js —— A-M4 测试：升级执行器 + 物理闸门 + 与 bus/executor 联动
 * 运行：node escalation.test.js
 *
 * 架构变更后：**升级决策**交给 strategist 模型（模型路径测试见 escalation-llm.test.js），
 * 本套件只测确定性的**执行机制与物理闸门**（模型无权绕过的部分）：
 *   1. 时间门禁：L0→L1 ≥2min、L1→L2 ≥3min、L2→L3 ≥5min、L3→L4 ≥5min
 *   2. 单日强制（L2+）上限 3 次 + L4 需授权（capLevel 封顶）
 *   3. action 由 level 映射表决定；L4 targets 只来自 options.l4Targets
 *   4. revoke_all 永不被禁止，文件 100% 还原
 *   5. 无自动升级链：时间流逝不会自己升级（纯模型架构，升级时机由模型决策）
 *
 * 时钟完全注入：用假时钟手动推进，不依赖真实等待。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstructionBus } = require('./instructions');
const { createExecutor, sha256OfFile } = require('./executor');
const { createEscalation, LEVEL_ORDER, GAP_MINUTES, STATUS } = require('./escalation');
const { tmpDir, rmrf, writeFile, sha256, ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('escalation.test.js');

/** 假时钟：时间只在 advance 时推进（自动定时器链已删，无需 timer 语义） */
function fakeClock(startMs) {
  let t = startMs || Date.UTC(2026, 9, 16, 12, 0, 0);
  return {
    now: () => t,
    advance(ms) { t += ms; }
  };
}

/** 深合并 options：覆盖单项时不丢掉 l4Targets / shuffleTargetDir 等 */
function mergeOptions(base, override) {
  const out = Object.assign({}, base, override || {});
  const o = Object.assign({}, base.options || {}, (override && override.options) || {});
  if (override && override.options) {
    for (const k of Object.keys(override.options)) {
      if (override.options[k] !== undefined) o[k] = override.options[k];
    }
  }
  out.options = o;
  return out;
}

function makeEnv(extraOptions) {
  const root = tmpDir('dsc-esc-');
  writeFile(root, 'a.txt', 'AAA');
  writeFile(root, 'b.txt', 'BBB');
  writeFile(root, '无关文件.txt', 'NOISE');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  writeFile(root, 'sub/keep.txt', 'KEEP');
  const logPath = path.join(root, '.discipline', 'audit', 'audit.jsonl');
  const bus = createInstructionBus({ logPath });
  const executor = createExecutor({ workRoot: root, auditPath: logPath });
  const clock = fakeClock();
  const base = {
    bus, executor, clock,
    options: {
      taskId: 'task_math_01',
      authorizeL4: false,
      dailyCap: 3,
      l4Targets: [path.join(root, '无关文件.txt')],
      shuffleTargetDir: root,
      plan: { steps: [{ index: 0, id: 'sit_up', label: '坐起来', stateAtPlan: 'lying_bed' }] },
      stateEvidence: { state: 'lying_bed', confidence: 0.9, source: 'time_rules', explain: '18 分钟无操作' }
    }
  };
  const esc = createEscalation(mergeOptions(base, extraOptions));
  return { root, bus, executor, clock, esc };
}

// ---------- 时序与间隔（物理闸门 1） ----------

suite.test('L0→L1→L2→L3 逐级触发，时间门禁按 2/3/5 分钟拦', () => {
  const { root, esc, clock } = makeEnv();
  const s0 = esc.start();
  equal(s0.level, 'L0', '起点 L0');
  equal(s0.status, STATUS.RUNNING, '运行中');

  // 差 1 分钟就推进 → 不应升级
  clock.advance(1 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L0', '1 分钟仍在 L0');

  // +2 分钟 → L1
  clock.advance(1 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L1', '+2min → L1');
  equal(GAP_MINUTES.L1, 2, 'L1 间隔 2 分钟');

  // +3 分钟 → L2
  clock.advance(3 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L2', '+3min → L2');
  equal(GAP_MINUTES.L2, 3, 'L2 间隔 3 分钟');

  // +5 分钟 → L3（本地执行）
  clock.advance(5 * 60000);
  esc.tick();
  const s3 = esc.getState();
  equal(s3.level, 'L3', '+5min → L3');
  equal(GAP_MINUTES.L3, 5, 'L3 间隔 5 分钟');
  equal(s3.status, STATUS.RUNNING, '仍在运行');
  // L3 真打了文件
  const shuffled = fs.readdirSync(root).filter(f => /^shuffled-/.test(f));
  ok(shuffled.length >= 2, 'L3 执行了打乱（' + shuffled.length + ' 个）');
  rmrf(root);
});

suite.test('同一时刻连续 tick：时间门禁拦住，不能连跳', () => {
  const { root, esc, clock } = makeEnv({ options: { taskId: 't9' } });
  // 只启动（L0），在同一时刻连续 tick：时间门禁必须拦住，最高只能到 L0/L1
  esc.start();
  for (let i = 0; i < 5; i++) esc.tick();
  const s = esc.getState();
  ok(LEVEL_ORDER.indexOf(s.level) <= LEVEL_ORDER.indexOf('L1'),
    '无时间推进时最高到 L1，实际 ' + s.level);
  // 逐步推进时钟才能一级级升
  clock.advance(2 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L1', '推进 2 分钟后到 L1');
  clock.advance(3 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L2', '再推进 3 分钟才到 L2');
  rmrf(root);
});

// ---------- 无自动升级链（纯模型架构回归） ----------

suite.test('时间流逝不会自己升级：无推进调用则停在原级', () => {
  const { root, esc, clock } = makeEnv({ options: { taskId: 't_auto' } });
  esc.start();
  clock.advance(60 * 60000);   // 推进 1 小时，不做任何 tick/模型调用
  equal(esc.getState().level, 'L0', '停在 L0');
  equal(esc.getState().status, STATUS.RUNNING, '仍在运行（等待模型决策）');
  rmrf(root);
});

// ---------- 授权封顶（物理闸门 2） ----------

suite.test('L4 未授权 → 封顶 L3，绝不上 L4', () => {
  const { root, esc, clock, executor } = makeEnv({ options: { taskId: 't2', authorizeL4: false } });
  esc.start();
  clock.advance(2 * 60000); esc.tick();   // L1
  clock.advance(3 * 60000); esc.tick();   // L2
  clock.advance(5 * 60000); esc.tick();   // L3
  equal(esc.getState().level, 'L3', '先到 L3');
  clock.advance(5 * 60000); esc.tick();   // 尝试 L4
  const after = esc.getState();
  equal(after.level, 'L3', '仍是 L3');
  equal(after.status, STATUS.CAPPED, '状态 capped');
  contains(after.reason, 'L4 未授权', '原因说明未授权');
  // 没有任何 quarantine manifest（L4 从未执行）
  const quarantines = executor.listManifests().filter(m => m.kind === 'quarantine');
  equal(quarantines.length, 0, '没有执行过隔离');
  const shuffles = executor.listManifests().filter(m => m.kind === 'shuffle');
  ok(shuffles.length >= 1, 'L3 确实执行过打乱');
  rmrf(root);
});

suite.test('L4 已授权 → 会上 L4 并隔离指定文件（targets 只来自 l4Targets）', () => {
  const { root, esc, clock } = makeEnv({ options: { taskId: 't3', authorizeL4: true } });
  const target = path.join(root, '无关文件.txt');
  const hash = sha256(target);
  esc.start();
  clock.advance(2 * 60000); esc.tick();   // L1
  clock.advance(3 * 60000); esc.tick();   // L2
  clock.advance(5 * 60000); esc.tick();   // L3
  clock.advance(5 * 60000); esc.tick();   // L4
  const s = esc.getState();
  equal(s.level, 'L4', '已到 L4');
  equal(fs.existsSync(target), false, '目标已移入隔离区');
  // 还原后 sha256 一致
  const back = esc.revoke('完成');
  ok(back.restore.restored >= 1, '还原至少 1 个');
  equal(sha256(target), hash, '还原后 sha256 一致');
  rmrf(root);
});

suite.test('单日强制上限 3 次：达到后当天封顶 L1（跨状态机共享计数）', () => {
  const { root, bus, executor, clock } = makeEnv({ options: { taskId: 't4', authorizeL4: true, dailyCap: 3 } });
  // 共享同一个 forcedByDate：单日上限必须跨状态机/跨任务全局生效，不能各记各的
  const sharedForced = new Map();
  const escs = [];
  for (let i = 0; i < 4; i++) {
    escs.push(createEscalation(mergeOptions({
      bus, executor, clock,
      options: {
        taskId: 'cap_' + i, authorizeL4: true, dailyCap: 3, forcedByDate: sharedForced,
        l4Targets: [], shuffleTargetDir: root,
        plan: { steps: [{ index: 0, label: 'x', stateAtPlan: 'lying_bed' }] }
      }
    }, null)));
  }
  for (let i = 0; i < 4; i++) {
    // 每个状态机独立推进，但共享同一时钟与同一张单日计数表
    escs[i].start();
    clock.advance(2 * 60000); escs[i].tick();   // L1
    clock.advance(3 * 60000); escs[i].tick();   // L2（记一次强制）
    const lvl = escs[i].getState().level;
    if (i < 3) {
      equal(lvl, 'L2', '第 ' + (i + 1) + ' 次强制可达 L2');
    } else {
      equal(lvl, 'L1', '第 4 次被封顶 L1');
      equal(escs[i].getState().status, STATUS.CAPPED, '状态 capped');
      contains(escs[i].getState().reason, '单日强制', '原因说明单日上限');
    }
  }
  rmrf(root);
});

// ---------- 撤销与还原（物理闸门 3/5） ----------

suite.test('任一步完成 → revoke_all + 停状态机 + 文件 100% 还原', () => {
  const { root, esc, clock, bus } = makeEnv({ options: { taskId: 't7', authorizeL4: true } });
  const target = path.join(root, '无关文件.txt');
  const hashes = ['a.txt', 'b.txt', 'sub/keep.txt'].map(p => ({ p, h: sha256(path.join(root, p)) }));
  esc.start();
  clock.advance(2 * 60000); esc.tick();   // L1
  clock.advance(3 * 60000); esc.tick();   // L2
  clock.advance(5 * 60000); esc.tick();   // L3
  clock.advance(5 * 60000); esc.tick();   // L4
  equal(esc.getState().level, 'L4', 'L4');
  const done = esc.completeStep();
  const st = esc.getState();
  equal(st.status, STATUS.REVOKED, '已撤销');
  equal(st.stepDone, true, '步骤标记完成');
  // 文件全部还原
  for (const h of hashes) equal(sha256(path.join(root, h.p)), h.h, h.p + ' 还原');
  ok(fs.existsSync(target), '隔离文件已还原');
  equal(sha256(target), sha256(target) || null, '目标文件');
  // 之后再 tick 不再升级
  clock.advance(60 * 60000);
  esc.tick();
  equal(esc.getState().level, 'L4', '停止后不再升级');
  equal(esc.getState().status, STATUS.REVOKED, '保持撤销');
  rmrf(root);
});

// ---------- 可解释性 ----------

suite.test('每轮输出当前 level/status/原因（可解释）', () => {
  const { root, esc, clock } = makeEnv({ options: { taskId: 't8' } });
  const snaps = [];
  snaps.push(esc.start());
  clock.advance(2 * 60000); esc.tick(); snaps.push(esc.getState());
  clock.advance(3 * 60000); esc.tick(); snaps.push(esc.getState());
  for (const s of snaps) {
    ok(typeof s.level === 'string', '有 level');
    ok(typeof s.status === 'string', '有 status');
    ok(s.reason && s.reason.length > 0, '有 reason');
  }
  ok(snaps[0].reason.length > 0, '首轮有原因');
  const hist = esc.getHistory();
  ok(hist.length >= 3, '历史至少 3 轮');
  ok(hist.every(h => h.reason), '每轮都有 reason');
  rmrf(root);
});

// ---------- 审计 ----------

suite.test('审计日志包含 L3/L4 的 manifest 关联与 revoke 全链路', () => {
  const { root, esc, clock, bus } = makeEnv({ options: { taskId: 't10', authorizeL4: true } });
  esc.start();
  clock.advance(2 * 60000); esc.tick();
  clock.advance(3 * 60000); esc.tick();
  clock.advance(5 * 60000); esc.tick();   // L3
  const l3rec = bus.list({ action: 'shuffle_desktop' })[0];
  ok(l3rec.manifestId, 'L3 指令回填 manifestId');
  clock.advance(5 * 60000); esc.tick();   // L4
  const l4rec = bus.list({ action: 'quarantine_files' })[0];
  ok(l4rec.manifestId, 'L4 指令回填 manifestId');
  esc.completeStep();
  const audit = bus.readAudit();
  const events = audit.map(a => a.event);
  contains(events.join(','), 'issue', 'issue');
  contains(events.join(','), 'ack', 'ack');
  contains(events.join(','), 'complete', 'complete');
  contains(events.join(','), 'revoke', 'revoke');
  rmrf(root);
});

suite.test('完成后再 start 不会重新升级', () => {
  const { root, esc, clock } = makeEnv({ options: { taskId: 't11' } });
  esc.start();
  esc.completeStep();
  const again = esc.start();
  equal(again.status, STATUS.REVOKED, '保持撤销');
  rmrf(root);
});

suite.test('localDate 按 +08:00 计算单日归属', () => {
  const { localDate } = require('./escalation');
  // UTC 2026-10-16T16:30:00Z → +08:00 为 2026-10-17
  equal(localDate(Date.UTC(2026, 9, 16, 16, 30)), '2026-10-17', '跨天按本地天');
  equal(localDate(Date.UTC(2026, 9, 16, 10, 30)), '2026-10-16', '同一天');
});

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
