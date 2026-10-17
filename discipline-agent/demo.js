'use strict';
/**
 * demo.js —— 完整闭环演示（联调用）
 *
 * 跑法：node demo.js            （桩 LLM 演示，不联网、不花钱）
 *       node demo.js --llm      （真实模型：需配 LLM_API_BASE / LLM_API_KEY）
 *
 * 架构变更后（纯规则 → 多模型协作，见 NOTES.md）：
 *   聊天 → 待办提取  extractor 模型（chat-sense.extractTodosWithLlm）
 *   摄像头 → 状态     observer 多模态模型（vision-backend）
 *   状态 → 拆步       planner 模型（task-planner.planWithLlm）
 *   升级决策          strategist 模型（escalation.escalateWithLlm）
 *   文件执行/还原     确定性代码（用户确认保留）
 *
 * 安全：所有文件都在临时目录里生成，绝不碰真实桌面。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstructionBus, isoWithOffset } = require('./instructions');
const { createExecutor, sha256OfFile } = require('./executor');
const { createStateSensor, escalationEligibility } = require('./state-sensor');
const { createFakeBackend, loadFixture } = require('./fake-backend');
const { planWithLlm } = require('./task-planner');
const { createEscalation, STATUS } = require('./escalation');
const { createAuditLog } = require('./audit');
const { extractTodosWithLlm } = require('./chat-sense');
const { createVisionBackend } = require('./vision-backend');
const { createLlmClient } = require('./llm/llm-client');
const { tmpDir } = require('./test-util');

const USE_REAL_LLM = process.argv.indexOf('--llm') !== -1;

function hr(t) {
  console.log('\n' + '='.repeat(70));
  console.log(t);
  console.log('='.repeat(70));
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
      for (const d of due) {
        const i = timers.indexOf(d);
        if (i >= 0) timers.splice(i, 1);
        d.fn();
      }
    },
    setTimeout(fn, ms) { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimeout(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    clearAll() { timers.length = 0; },
    pending() { return timers.length; }
  };
}

/**
 * 桩传输：按角色返回预设 JSON，让 demo 无网也能跑全模型链路。
 * 联网跑（--llm）时不经过这里。
 */
function makeStubTransport() {
  const replies = {
    extractor: () => ({
      todos: [
        { subject: '数学', content: '写数学作业', date: '2026-10-17', time: null, quote: '明天要交数学作业', confidence: 0.95, ambiguous: false, ambiguousNote: '' },
        { subject: '英语', content: '背单词', date: '2026-10-23', time: null, quote: '英语单词周五前背完', confidence: 0.88, ambiguous: false, ambiguousNote: '' },
        { subject: '数学', content: '不确定', date: null, time: null, quote: '数学作业是明天还是后天？', confidence: 0.35, ambiguous: true, ambiguousNote: '明天或后天二选一' }
      ]
    }),
    planner: () => ({
      steps: [
        { label: '坐起来', minutes: 1, doneSignal: '双脚落地' },
        { label: '下床', minutes: 1, doneSignal: '站到地上' },
        { label: '走到书桌前坐下', minutes: 1, doneSignal: '屁股碰到椅子' },
        { label: '打开数学作业本', minutes: 2, doneSignal: '本子摊开在桌上' },
        { label: '做第 1 题', minutes: 3, doneSignal: '第 1 题有笔迹' }
      ],
      explain: '躺着先离开床，坐下再开本子，从最简单的第 1 题开始'
    }),
    strategist: (parsed, callIdx) => {
      // 桩策略：第 1 次调用发 L0，之后每次升一级（模拟"一直没响应"）
      const levels = ['L0', 'L1', 'L2', 'L3', 'L4'];
      const lv = levels[Math.min(callIdx, levels.length - 1)];
      const atTop = callIdx >= levels.length - 1;
      return {
        level: atTop ? 'L4' : lv,
        suspend: false,
        revoke: false,
        reason: atTop ? 'L4 已执行，等用户完成步骤' : '用户还没响应，升到 ' + lv
      };
    }
  };
  let strategistCalls = 0;
  return async (url, body) => {
    const parsed = JSON.parse(body);
    // 用 system prompt 判断角色（extractor/planner 默认同模型，靠内容区分）
    const sys = parsed.messages && parsed.messages[0] && parsed.messages[0].content || '';
    let reply;
    if (sys.indexOf('待办提取器') !== -1) reply = replies.extractor();
    else if (sys.indexOf('任务拆解器') !== -1) reply = replies.planner();
    else if (sys.indexOf('自律监督策略器') !== -1) reply = replies.strategist(parsed, strategistCalls++);
    else reply = { ok: true };
    return JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) } }] });
  };
}

async function main() {
  const root = tmpDir('dsc-demo-');
  // 三个日志都放在 .discipline/audit 下：executor 会把自己的账本/审计目录整体
  // 排除在 shuffle/quarantine 之外，审计文件绝不会被"打乱桌面"改名。
  const auditDir = path.join(root, '.discipline', 'audit');
  const busLog = path.join(auditDir, 'bus.jsonl');
  const execLog = path.join(auditDir, 'exec.jsonl');
  const auditLog = path.join(auditDir, 'decisions.jsonl');

  // ---------- LLM 客户端（四个角色多模型协作） ----------
  // --llm 走真实 API；默认用桩，保证 node demo.js 无网也能演示全链路。
  const llm = createLlmClient({
    apiBase: USE_REAL_LLM ? process.env.LLM_API_BASE : 'https://stub.local/v1',
    apiKey: USE_REAL_LLM ? process.env.LLM_API_KEY : 'sk-stub',
    auditPath: path.join(auditDir, 'llm.jsonl'),
    log() {},
    transport: USE_REAL_LLM ? undefined : makeStubTransport()
  });
  if (USE_REAL_LLM) {
    console.log('LLM 模式: 真实 API，base=' + process.env.LLM_API_BASE);
    const rep = llm.readinessReport();
    for (const r of Object.keys(rep)) {
      if (!rep[r].ready) console.warn('  ⚠ 角色 ' + r + ' 未配置完整（缺 ' + rep[r].missing + '）');
    }
  } else {
    console.log('LLM 模式: 桩（不联网）。要接真实模型：node demo.js --llm 并配置 LLM_API_BASE / LLM_API_KEY');
  }

  // 造一个"假桌面"
  fs.writeFileSync(path.join(root, '数学作业.docx'), 'math homework');
  fs.writeFileSync(path.join(root, '英语单词.txt'), 'word list');
  fs.writeFileSync(path.join(root, '游戏截图.png'), 'screenshot');
  fs.mkdirSync(path.join(root, '游戏存档'));
  fs.writeFileSync(path.join(root, '游戏存档', 'save.dat'), 'SAVE');
  const originals = ['数学作业.docx', '英语单词.txt', '游戏截图.png']
    .map(n => ({ name: n, abs: path.join(root, n), hash: sha256OfFile(path.join(root, n)) }));

  const bus = createInstructionBus({ logPath: busLog });
  const executor = createExecutor({ workRoot: root, auditPath: execLog });
  const audit = createAuditLog({ path: auditLog, sources: [busLog, execLog] });
  // 摄像头后端二选一：
  //   真实模式（--llm）：captureFrame 用假帧源（fixture 回放，提供 dataUrl），
  //     inferPose 交给 observer 多模态模型（vision-backend 适配 OpenAI 兼容 API）。
  //   演示模式（默认）：captureFrame 与 inferPose 都用假后端，无网可跑。
  const fixture = loadFixture('pose-lying-bed.json');
  const backend = createFakeBackend(fixture);
  let inferPose = backend.inferPose;
  if (USE_REAL_LLM) {
    const vision = createVisionBackend({ apiBase: process.env.VISION_API_BASE || process.env.LLM_API_BASE, apiKey: process.env.VISION_API_KEY || process.env.LLM_API_KEY, model: process.env.VISION_MODEL || 'gpt-4o-mini', log() {} });
    if (vision.isConfigured()) {
      // 包一层：把 fixture 帧的 dataUrl 转给模型；模型不可用时返回低质量 unknown（由 state-sensor 降级）
      inferPose = async (frames) => vision.inferPose(frames);
      console.log('摄像头推理: observer 多模态模型（' + (process.env.VISION_MODEL || 'gpt-4o-mini') + '）');
    } else {
      console.log('摄像头推理: VISION_* 未配置完整，仍用假姿态（' + vision.configProblem() + '）');
    }
  } else {
    console.log('摄像头推理: 假后端（fixture 回放）');
  }
  const sensor = createStateSensor({
    captureFrame: backend.captureFrame,
    inferPose,
    context: backend.context,
    // 全项目时钟契约：clock.now 返回 epoch 毫秒数（需要 Date 处由内部显式转换）
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    sleepFn: (ms) => new Promise(r => setTimeout(r, ms))
  });

  console.log('临时执行根:', root);
  console.log('初始文件:', fs.readdirSync(root).filter(f => !f.startsWith('.')).join(', '));

  // ---------- 1. 聊天感知 ----------
  hr('第 1 步：聊天记录 → 待办提取（A-M1，extractor 模型）');
  const chat = [
    '小明 2026-10-16 20:30 明天要交数学作业',
    '小红 2026-10-16 20:31 英语单词周五前背完',
    '小明 2026-10-16 20:32 数学作业是明天还是后天？',
    '小红 2026-10-16 20:33 哈哈哈'
  ].join('\n');
  const extracted = await extractTodosWithLlm(chat, {
    llm, now: Date.UTC(2026, 9, 16, 12, 0, 0), today: '2026-10-16'
  });
  if (!extracted.ok) {
    console.error('extractor 模型不可用:', extracted.error);
    console.error('（纯模型架构：不退回规则提取，直接亮错误）');
    process.exit(2);
  }
  console.log('extractor 模型提取待办 ' + extracted.all.length + ' 条（ready ' + extracted.todos.length + ' / 待确认 ' + extracted.pendingConfirm.length + '）');
  for (const t of extracted.all) {
    console.log('  [' + t.status + '] ' + t.subject + ' | ddl=' + (t.ddl || '-') + ' | conf=' + t.confidence);
    console.log('      原话: ' + t.quote);
  }
  const todo = extracted.todos.find(t => t.subject === '数学') || extracted.all[0];
  console.log('\n取待办「' + todo.subject + '」进入计划（低置信度的留在待确认）');

  // ---------- 2. 状态估计 ----------
  hr('第 2 步：摄像头多模态状态估计（A-M2）');
  const stateModel = await sensor.estimate({ frames: 3, intervalMs: 0, reason: 'poll_burst' });
  console.log('state      =', stateModel.state);
  console.log('confidence =', stateModel.confidence);
  console.log('source     =', stateModel.source);
  console.log('evidence   =', stateModel.evidence);
  console.log('explain    =', stateModel.explain);
  audit.recordDecision({
    taskId: 'task_math', state: stateModel.state, confidence: stateModel.confidence,
    source: stateModel.source, evidence: stateModel.evidence, explain: stateModel.explain
  });
  const eligible = escalationEligibility(stateModel, {});
  console.log('当前状态可达到的强制级别 =', eligible.level, '|', eligible.reason || '');
  console.log('（无步骤完成信号时，摄像头证据不能单独触发 L2+）');

  // ---------- 3. 拆步 ----------
  hr('第 3 步：状态驱动拆步（A-M3，planner 模型）');
  const task = { subject: todo.subject, content: todo.content, material: '作业本', level: 'beginner' };
  const planned = await planWithLlm(task, stateModel, { llm });
  if (!planned.ok) {
    console.error('planner 模型不可用:', planned.error);
    console.error('（纯模型架构：不退回规则步骤库）');
    process.exit(2);
  }
  console.log('mode =', planned.mode);
  console.log('explain =', planned.explain);
  for (const s of planned.steps) {
    console.log('  ' + (s.index + 1) + '. ' + s.label + '（≤' + s.minutes + ' 分钟，完成信号：' + s.doneSignal + '）');
  }
  if (planned.violations.length) {
    console.log('  约束留痕: ' + planned.violations.join('；'));
  }
  audit.recordPlan({
    taskId: 'task_math', mode: planned.mode, state: stateModel.state,
    steps: planned.steps, firstStep: planned.firstStep, explain: planned.explain
  });

  // ---------- 4. 强制升级 ----------
  hr('第 4 步：L0→L4 强制升级（A-M4，strategist 模型决策）');
  const clock = fakeClock(Date.UTC(2026, 9, 16, 12, 0, 0));
  const esc = createEscalation({
    bus, executor, clock,
    options: {
      taskId: 'task_math',
      authorizeL4: true,
      dailyCap: 3,
      l4Targets: [path.join(root, '游戏截图.png')],
      shuffleTargetDir: root,
      plan: planned,
      stateEvidence: stateModel
    }
  });
  let snap = await esc.escalateWithLlm({ llm, state: stateModel.state, confidence: stateModel.confidence, stateExplain: stateModel.explain, waitedMin: 0 });
  console.log('L0 ' + snap.status + ' | ' + snap.reason);
  // 每级间隔：L0→L1 2min，L1→L2 3min，L2→L3 5min，L3→L4 5min。
  // 推进后若被时间门禁拦住（距上次升级不足），再推进一次即可——
  // 真实环境由定时器自动触发，不会被门禁拦。
  const steps = [
    { gap: 2, label: 'L1' }, { gap: 3, label: 'L2' },
    { gap: 5, label: 'L3' }, { gap: 5, label: 'L4' }
  ];
  for (const s of steps) {
    clock.advance(s.gap * 60000);
    clock.clearAll();
    snap = await esc.escalateWithLlm({ llm, state: stateModel.state, confidence: stateModel.confidence, stateExplain: stateModel.explain, waitedMin: s.gap });
    if (esc.getState().level !== s.label) {
      // 门禁拦截（推进不足）：补足该级间隔再来一次
      clock.advance(s.gap * 60000);
      snap = await esc.escalateWithLlm({ llm, state: stateModel.state, confidence: stateModel.confidence, stateExplain: stateModel.explain, waitedMin: s.gap * 2 });
    }
    const st = esc.getState();
    console.log(s.label + ' → level=' + st.level + ' status=' + st.status + ' | ' + st.reason);
    if (st.level === 'L3') {
      console.log('     L3 已打乱桌面文件: ' + fs.readdirSync(root).filter(f => /^shuffled-/.test(f)).join(', '));
    }
    if (st.level === 'L4') {
      const moved = fs.existsSync(path.join(root, '游戏截图.png'));
      console.log('     L4 已隔离指定文件（加密）: 游戏截图.png → .quarantine/<manifestId>/');
      console.log('     原位还在吗:', moved ? '在（异常）' : '不在（正确）');
    }
  }

  // ---------- 5. 用户完成一步 → 撤销 ----------
  hr('第 5 步：用户完成一步 → revoke_all 全部还原（A-M0/A-M4）');
  const beforeHashes = executor.listManifests().map(m => m.manifestId);
  const revokeSnap = esc.completeStep();
  console.log('status =', revokeSnap.status, '| reason =', revokeSnap.reason);
  console.log('restore 汇总 =', JSON.stringify(revokeSnap.restore));
  console.log('定时器已清空:', clock.pending() === 0);

  hr('第 6 步：逐字节校验');
  let allOk = true;
  for (const o of originals) {
    const same = sha256OfFile(o.abs) === o.hash;
    allOk = allOk && same;
    console.log((same ? '  ✓ ' : '  ✗ ') + o.name + (same ? ' sha256 一致' : ' sha256 不一致'));
  }
  console.log('  子目录文件仍在:', fs.existsSync(path.join(root, '游戏存档', 'save.dat')) ? '是' : '否');

  // ---------- 6. 审计 ----------
  hr('第 7 步：审计四段链路（A-M5）');
  const l4 = bus.list({ action: 'quarantine_files' })[0];
  if (l4) {
    const trace = audit.traceInstruction(l4.id);
    console.log('指令 ' + l4.id + '（L4 quarantine_files）');
    console.log('  依据段(state_decision): ' + trace.basis.length + ' 条');
    console.log('  指令段: issue=' + trace.issued.length + ' ack=' + trace.acked.length + ' complete=' + trace.completed.length);
    console.log('  manifest: ' + (trace.manifestId || '-'));
    console.log('  执行段: ' + trace.executed.length + ' 条 | 还原段: ' + trace.restored.length + ' 条');
    const dec = trace.basis[0];
    if (dec) console.log('  判定 explain: ' + dec.explain);
  }
  console.log('\n用户纠正与申诉接口:');
  audit.recordCorrection({ taskId: 'task_math', from: 'lying_bed', to: 'seated_desk', note: '我当时其实已经坐起来了' });
  audit.recordAppeal({ targetId: l4 ? l4.id : 'n/a', targetKind: 'instruction', taskId: 'task_math', reason: '测试申诉' });
  const corrections = audit.readOwn().filter(r => r.event === 'state_correction');
  console.log('  纠正记录 ' + corrections.length + ' 条，可作为 state-sensor 规则修正依据');

  hr('结论');
  console.log(allOk ? '✅ 全流程闭环成功，文件 100% 还原（sha256 逐字节一致）' : '❌ 存在未还原项');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error('demo 失败:', e); process.exit(1); });
