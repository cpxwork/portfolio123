'use strict';
/**
 * state-sensor.js —— 状态估计（摄像头多模态 + 时间规则 + 降级）（A-M2 交付）
 *
 * 契约来源：A任务提示词.md 6.2 / 7.A-M2。状态模型字段名不许擅改：
 *   { state, confidence, evidence, capturedAt, source, explain }
 *
 * 设计要点：
 *   1. 零第三方依赖：摄像头采集与姿态推理全部以"可注入后端"的方式接入
 *      （captureFrame / inferPose），测试用 fixtures 里的假后端。真实后端
 *      （onnxruntime-node 跑 YOLOv8n-pose，或 @mediapipe/tasks-vision 的
 *      Pose Landmarker）接入方式见 assets/README.md。
 *   2. 采集策略：常规每 60s 1 帧；提醒后 30s 补抓；必要时 2–3 帧 / 间隔 1s。
 *      只抓帧、不连续录像。
 *   3. 融合：camera 证据 + 时间/活跃度规则 → confidence（算法见 fuseEvidence）。
 *   4. 降级：无摄像头 / 权限拒 / 遮挡 / 光线差 → 退时间规则，
 *      confidence 压到 ≤0.5，source=time_rules，绝不抛异常。
 *   5. 消费约束：状态只用于"分步起点选择 + 是否有人"，
 *      **绝不单独触发 L2 及以上强制**（canTriggerForcedLevel 实现）。
 *   6. unknown 是合法且常用的状态：宁可 unknown 也不瞎猜。
 *   7. 用户纠正（source=manual）权重最高，并作为规则修正依据回流。
 */

const path = require('path');
const { STATES, SOURCES, isoWithOffset, parseIso } = require('./instructions');

/** 强制级别枚举（与 A-M4 escalation 的 L0..L5 对应） */
const FORCED_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/** 采集策略常量（PLAN-A 3.2） */
const POLL_INTERVAL_MS = 60 * 1000;        // 常规轮询：每 60s 抓 1 帧
const POST_NOTIFY_DELAY_MS = 30 * 1000;    // 提醒发出后 30s 补抓 1 次
const BURST_INTERVAL_MS = 1000;            // 连续帧间隔 1s
const MAX_BURST_FRAMES = 3;                // 必要时取 2–3 帧

/** 降级判定所需的置信度阈值 */
const DEGRADED_CONFIDENCE = 0.5;           // 降级来源（time_rules）置信度上限
const MIN_TRUSTED_CONFIDENCE = 0.6;        // 低于此值视为"不敢下结论"→ unknown

/** 摄像头不可用原因 → 人类可读说明 */
const CAMERA_REASONS = {
  no_camera: '没有摄像头设备',
  permission_denied: '摄像头权限被拒绝',
  occluded: '画面被遮挡',
  low_light: '光线太暗',
  busy: '摄像头被其它程序占用',
  unknown: '摄像头不可用'
};

/** 时段划分（用于时间规则） */
const TIME_BUCKETS = {
  earlyMorning: [4, 9],    // 04:00–08:59 清晨
  workHours: [9, 18],      // 09:00–17:59 白天
  evening: [18, 24]        // 18:00–03:59 晚间到深夜
};

function pad(n) { return String(n).padStart(2, '0'); }

/** Date → +08:00 ISO 串（与 instructions.js 保持一致，供 capturedAt 使用） */
function isoOffset(date) {
  return isoWithOffset(date);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 保留 2 位小数，避免 0.30000000000000004 这类输出污染 evidence/explain */
function round2(v) {
  return Math.round(clamp01(v) * 100) / 100;
}

/** 取某个 Date 在 +08:00 下的小时 */
function hourOf(date) {
  const shifted = new Date(date.getTime() + 8 * 3600000);
  return shifted.getUTCHours();
}

/** 取某个 Date 在 +08:00 下的 HH:MM */
function hhmm(date) {
  const shifted = new Date(date.getTime() + 8 * 3600000);
  return pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes());
}

/** 时段中文名 */
function bucketName(hour) {
  if (hour >= 4 && hour < 9) return '清晨';
  if (hour >= 9 && hour < 18) return '白天';
  return '夜间';
}

/** 活跃度分钟数 → 可读描述 */
function inactiveText(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 1) return '刚刚有操作';
  return m + '分钟无操作';
}

/** 姿态 → 中文 */
const POSTURE_TEXT = { lying: '卧姿', sitting: '坐姿', standing: '站姿', absent: '无人' };
/** 区域 → 中文 */
const ZONE_TEXT = { bed: '床区域', desk: '书桌区域', other: '其它区域', none: '无区域' };
/** 状态 → 中文 */
const STATE_TEXT = {
  lying_bed: '躺在床区域',
  seated_desk: '坐在书桌前',
  standing_or_moving: '站立或走动',
  away: '人已离开',
  learning: '学习中',
  unknown: '无法判断'
};

/**
 * 校验状态模型字段（契约自检；测试与上层调用都用它兜底）。
 * 返回 errors 数组；空数组表示合法。
 */
function validateStateModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return ['状态模型必须是对象'];
  }
  if (STATES.indexOf(model.state) === -1) {
    errors.push('state 必须是枚举之一: ' + STATES.join(', ') + '，实际: ' + JSON.stringify(model.state));
  }
  if (typeof model.confidence !== 'number' || !Number.isFinite(model.confidence) ||
      model.confidence < 0 || model.confidence > 1) {
    errors.push('confidence 必须是 0..1 的数字，实际: ' + JSON.stringify(model.confidence));
  }
  if (typeof model.evidence !== 'string' || !model.evidence.trim()) {
    errors.push('evidence 必须是非空字符串');
  }
  if (typeof model.explain !== 'string' || !model.explain.trim()) {
    errors.push('explain 必须是非空字符串');
  }
  if (parseIso(model.capturedAt) === null) {
    errors.push('capturedAt 必须是带偏移的 ISO 时间，实际: ' + JSON.stringify(model.capturedAt));
  }
  if (SOURCES.indexOf(model.source) === -1) {
    errors.push('source 必须是枚举之一: ' + SOURCES.join(', ') + '，实际: ' + JSON.stringify(model.source));
  }
  return errors;
}

/** 构造一个合法状态模型对象（统一出口，保证字段齐全） */
function makeStateModel(fields) {
  const model = {
    state: fields.state,
    confidence: round2(fields.confidence),
    evidence: String(fields.evidence),
    capturedAt: fields.capturedAt,
    source: fields.source,
    explain: String(fields.explain)
  };
  const errors = validateStateModel(model);
  if (errors.length) {
    throw new Error('状态模型不合法: ' + errors.join('；'));
  }
  return model;
}

/* ------------------------------------------------------------------ *
 * 采集调度：只抓帧，不连续录像
 * ------------------------------------------------------------------ */

/**
 * createCaptureScheduler —— 采集策略的可注入实现（假时钟驱动，测试用）
 *
 * 时钟契约（全项目统一）：opts.nowFn 返回 epoch 毫秒数（number），不是 Date；
 * opts.setTimeoutFn / opts.clearTimeoutFn 为可注入定时器；notifySent(at) 的 at 同样传毫秒数。
 *
 * 策略：
 *   - 常规：每 pollIntervalMs 抓 1 帧（单帧）
 *   - 提醒后：notifySent 之后 postNotifyMs 补抓 1 次（单帧）
 *   - 必要时：needBurst 时取 burstFrames 帧 / 间隔 burstIntervalMs
 *     （区分"躺着不动"与"人已离开"）
 */
function createCaptureScheduler(opts) {
  const options = opts || {};
  const nowFn = options.nowFn || (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
  const postNotifyMs = options.postNotifyMs || POST_NOTIFY_DELAY_MS;
  const burstIntervalMs = options.burstIntervalMs || BURST_INTERVAL_MS;
  const burstFrames = Math.min(MAX_BURST_FRAMES, Math.max(2, options.burstFrames || 3));
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const onSample = options.onSample; // (reason) => void

  let lastPollAt = null;
  let notifySentAt = null;
  let postNotifyDone = false;
  let timer = null;

  /** 是否需要连拍（判断"躺着不动"还是"人已离开"） */
  function needBurst(lastResult) {
    if (!lastResult) return false;
    if (lastResult.person === false) return false; // 已经判无人，无需连拍
    if (lastResult.posture === 'lying' || lastResult.posture === 'sitting') return true;
    return false;
  }

  function fire(reason) {
    if (typeof onSample === 'function') onSample(reason);
  }

  /** 启动轮询（真实运行时由宿主驱动；测试用手动 tick 代替） */
  function start() {
    stop();
    timer = setTimeoutFn(function loop() {
      fire('poll');
      timer = setTimeoutFn(loop, pollIntervalMs);
    }, pollIntervalMs);
  }

  function stop() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  /**
   * 常规轮询到点（假时钟推进后由测试手动调用）
   * @returns {{reason:string, frames:number, intervalMs:number}|null}
   */
  function poll(lastResult) {
    const now = nowFn();
    if (lastPollAt !== null && now - lastPollAt < pollIntervalMs) return null;
    lastPollAt = now;
    if (needBurst(lastResult)) {
      return { reason: 'poll_burst', frames: burstFrames, intervalMs: burstIntervalMs };
    }
    return { reason: 'poll', frames: 1, intervalMs: 0 };
  }

  /** 提醒已发出（事件触发采样点） */
  function notifySent(at) {
    notifySentAt = typeof at === 'number' ? at : nowFn();
    postNotifyDone = false;
  }

  /**
   * 提醒后补抓：notifySent 之后 postNotifyMs 才允许补抓一次
   * @returns {{reason:string, frames:number, intervalMs:number}|null}
   */
  function postNotify(lastResult) {
    if (notifySentAt === null) return null;
    const now = nowFn();
    if (now - notifySentAt < postNotifyMs) return null;
    if (postNotifyDone) return null;
    postNotifyDone = true;
    if (needBurst(lastResult)) {
      return { reason: 'post_notify_burst', frames: burstFrames, intervalMs: burstIntervalMs };
    }
    return { reason: 'post_notify', frames: 1, intervalMs: 0 };
  }

  function state() {
    return {
      lastPollAt: lastPollAt ? isoOffset(new Date(lastPollAt)) : null,
      notifySentAt: notifySentAt ? isoOffset(new Date(notifySentAt)) : null,
      postNotifyDone,
      pollIntervalMs,
      postNotifyMs,
      burstIntervalMs,
      burstFrames
    };
  }

  return { start, stop, poll, notifySent, postNotify, needBurst, state };
}

/* ------------------------------------------------------------------ *
 * 融合算法
 * ------------------------------------------------------------------ */

/**
 * fuseEvidence —— camera 证据 + 时间/活跃度规则 → { state, confidence, ... }
 *
 * 算法（加权 + 否决，写在这里供审计与测试核对）：
 *
 *  1. camera 单独成帧：
 *     base   = camera.confidence（0..1）
 *     zone/posture 一致（lying+bed / sitting+desk）→ base *= 1.0（互相印证）
 *     posture 与 zone 矛盾（如 sitting+bed）→ base *= 0.6 并降级为 unknown
 *     person=false → away，base *= 0.9
 *
 *  2. 时间/活跃度加成/否决（camera 存在时才允许加成，不能凭空造置信度）：
 *     - 长时间无操作(inactiveMin ≥ 15) 与 camera 的静态姿态（lying/sitting）
 *       同向 → confidence += 0.05（上限 0.95）
 *     - 锁屏且 camera 判有人 → 方向冲突，confidence -= 0.1（人在但屏幕锁了，
 *       更可能是在休息而非学习）
 *     - 锁屏且 camera 判无人 → 同向（away），confidence += 0.05
 *     - 夜间时段与 lying_bed 同向 → += 0.03
 *     - 白天时段与 seated_desk/learning 同向 → += 0.03
 *
 *  3. 否决规则（优先级最高，命中即降 confidence 或改判）：
 *     - camera.confidence < 0.4 → 该帧不可信，视为无 camera 证据（走降级）
 *     - quality < 0.3（遮挡/光线差）→ 同上
 *     - 连拍帧之间姿态翻转（lying ↔ absent）→ 静态单帧会误判，
 *       取"帧间多数 + 更保守的一方"，confidence 打 7 折
 *
 *  4. 置信度 → 状态：
 *     confidence ≥ 0.6 → 采信 camera 结论
 *     confidence < 0.6 → unknown（宁可 unknown 也不瞎猜）
 *
 * @param {object} input
 *   camera: { person, posture, zone, confidence, quality } | null
 *   context: { inactiveMin, locked, hour }
 * @returns {{state, confidence, reason, evidence, explain}}
 */
function fuseEvidence(input) {
  const camera = input.camera || null;
  const ctx = input.context || {};
  const inactiveMin = Number(ctx.inactiveMin || 0);
  const locked = !!ctx.locked;
  const hour = typeof ctx.hour === 'number' ? ctx.hour : hourOf(new Date());

  // ---- 无 camera 证据（含被否决的低质量帧）→ 纯时间规则 ----
  if (!camera || camera.confidence < 0.4 || camera.quality < 0.3) {
    const rule = timeRulesOnly({ inactiveMin, locked, hour });
    return {
      state: rule.state,
      confidence: Math.min(DEGRADED_CONFIDENCE, rule.confidence),
      reason: 'degraded',
      evidence: rule.evidence,
      explain: rule.explain
    };
  }

  // ---- camera 单独成帧 ----
  let state = 'unknown';
  let confidence = clamp01(camera.confidence);
  let notes = [];

  if (camera.person === false) {
    state = 'away';
    confidence *= 0.9;
    notes.push('画面中没有人');
  } else if (camera.posture === 'lying') {
    state = camera.zone === 'bed' ? 'lying_bed' : 'unknown';
    notes.push(camera.zone === 'bed' ? '卧姿且位于床区域' : '卧姿但不在床区域，不敢断定');
  } else if (camera.posture === 'sitting') {
    state = camera.zone === 'desk' ? 'seated_desk' : 'unknown';
    notes.push(camera.zone === 'desk' ? '坐姿且位于书桌区域' : '坐姿但不在书桌区域，不敢断定');
  } else if (camera.posture === 'standing') {
    state = camera.zone === 'desk' ? 'seated_desk' : 'standing_or_moving';
    notes.push(camera.zone === 'desk' ? '站在书桌旁，按在桌前处理' : '站立或走动');
  } else {
    state = 'unknown';
    notes.push('姿态无法识别');
  }

  // posture 与 zone 矛盾 → 打 6 折
  if (state === 'unknown' && camera.person !== false) {
    confidence *= 0.6;
  }

  // ---- 时间/活跃度修正（camera 存在时才允许微调，不能凭空造置信度）----
  if (state === 'lying_bed' || state === 'seated_desk' || state === 'standing_or_moving') {
    if (inactiveMin >= 15) {
      confidence += 0.05;
      notes.push(inactiveText(inactiveMin) + '，与静态姿态同向');
    }
  }
  if (state === 'away') {
    if (locked) {
      confidence += 0.05;
      notes.push('屏幕已锁，与"人已离开"同向');
    } else if (inactiveMin >= 20) {
      confidence += 0.03;
      notes.push(inactiveText(inactiveMin) + '，与"人已离开"同向');
    }
  }
  if ((state === 'seated_desk' || state === 'standing_or_moving') && locked) {
    confidence -= 0.1;
    notes.push('屏幕已锁但在场，可能是在休息而非学习');
  }
  if (state === 'lying_bed' && (hour >= 22 || hour < 4)) {
    confidence += 0.03;
    notes.push('夜间卧姿更可信');
  }
  if ((state === 'seated_desk' || state === 'standing_or_moving') && hour >= 9 && hour < 18) {
    confidence += 0.03;
    notes.push('白天在桌前更可信');
  }

  // ---- learning：在书桌前 + 近期持续有操作 + 未锁屏 + 学习时段 ----
  // 说明：单目姿态无法可靠区分"在桌前发呆"与"在写作业"，learning 必须由
  // 活跃度佐证（近期有输入、未锁屏、处于学习时段），不允许只凭画面下结论。
  const studyHours = hour >= 8 && hour < 23;
  if ((state === 'seated_desk' || state === 'standing_or_moving') &&
      inactiveMin < 5 && !locked && studyHours) {
    state = 'learning';
    confidence = Math.min(0.95, confidence + 0.05);
    notes.push('近期持续有操作且屏幕未锁，处于学习时段，判为学习中');
  }

  confidence = Math.min(0.95, clamp01(confidence));

  // ---- 置信度阈值：低于阈值宁可 unknown ----
  let finalState = state;
  if (confidence < MIN_TRUSTED_CONFIDENCE) {
    finalState = 'unknown';
    notes.push('置信度不足，判为无法判断');
  }

  const camEvidence = 'camera:' + (camera.person === false ? '无人' :
    POSTURE_TEXT[camera.posture] + '·' + ZONE_TEXT[camera.zone]) +
    '(置信' + round2(camera.confidence) + ')';
  const ctxEvidence = [];
  ctxEvidence.push('inactive:' + inactiveText(inactiveMin));
  ctxEvidence.push('time:' + pad(hour) + ':00');
  if (locked) ctxEvidence.push('locked');

  return {
    state: finalState,
    confidence: round2(confidence),
    reason: 'camera',
    evidence: camEvidence + ' | ' + ctxEvidence.join(' | '),
    explain: buildExplain(finalState, notes, { degraded: false })
  };
}

/**
 * timeRulesOnly —— 纯时间/活跃度规则（降级路径，也是无摄像头时的兜底）
 *
 * 规则（可读、可审计）：
 *   1. 屏幕已锁 + 无操作 ≥ 20min → away（人大概率走了）
 *   2. 屏幕已锁 + 无操作 < 20min → unknown（可能只是暂时锁屏）
 *   3. 未锁屏 + 无操作 ≥ 25min + 夜间(22–04) → lying_bed（弱推断）
 *   4. 未锁屏 + 无操作 ≥ 25min + 白天 → seated_desk（弱推断）
 *   5. 未锁屏 + 无操作 < 25min + 白天 → seated_desk（弱推断，置信度更低）
 *   6. 其余 → unknown
 * 置信度一律 ≤ 0.5（降级路径不许给高置信度）。
 */
function timeRulesOnly(input) {
  const inactiveMin = Number((input && input.inactiveMin) || 0);
  const locked = !!(input && input.locked);
  const hour = typeof (input && input.hour) === 'number' ? input.hour : hourOf(new Date());
  const night = hour >= 22 || hour < 4;
  const day = hour >= 9 && hour < 18;

  let state = 'unknown';
  let confidence = 0.3;
  let why = '';

  if (locked && inactiveMin >= 20) {
    state = 'away';
    confidence = 0.5;
    why = '屏幕已锁且已 ' + Math.round(inactiveMin) + ' 分钟无操作，大概率人已离开';
  } else if (locked) {
    state = 'unknown';
    confidence = 0.35;
    why = '屏幕已锁但无操作时长不足 ' + 20 + ' 分钟，可能只是暂时锁屏';
  } else if (inactiveMin >= 25 && night) {
    state = 'lying_bed';
    confidence = 0.45;
    why = '未锁屏但已 ' + Math.round(inactiveMin) + ' 分钟无操作，且处于夜间时段，弱推断为躺床';
  } else if (inactiveMin >= 25 && day) {
    state = 'seated_desk';
    confidence = 0.4;
    why = '未锁屏但已 ' + Math.round(inactiveMin) + ' 分钟无操作，且处于白天时段，弱推断为在书桌前';
  } else if (inactiveMin < 25 && day) {
    state = 'seated_desk';
    confidence = 0.35;
    why = '白天时段、屏幕未锁、近期有操作，弱推断为在书桌前';
  } else {
    state = 'unknown';
    confidence = 0.3;
    why = '时间规则信息不足，无法判断';
  }

  const parts = [];
  parts.push('inactive:' + inactiveText(inactiveMin));
  parts.push('time:' + pad(hour) + ':00');
  if (locked) parts.push('locked');
  parts.push('camera:不可用');

  return {
    state,
    confidence: Math.min(DEGRADED_CONFIDENCE, confidence),
    evidence: parts.join(' | '),
    explain: why
  };
}

/** 把 notes 拼成一句人话 explain */
function buildExplain(state, notes, opts) {
  const o = opts || {};
  if (o.degraded) return notes.join('；');
  const head = {
    lying_bed: '摄像头判定为床区域卧姿',
    seated_desk: '摄像头判定为书桌前坐姿',
    standing_or_moving: '摄像头判定为站立或走动',
    away: '摄像头判定画面中无人',
    learning: '摄像头判定为书桌前坐姿且近期持续有操作，判为学习中',
    unknown: '证据不足，无法判断'
  }[state] || '无法判断';
  const tail = notes.length ? '，' + notes.join('，') : '';
  return head + tail;
}

/* ------------------------------------------------------------------ *
 * 消费约束：状态不能单独触发 L2+
 * ------------------------------------------------------------------ */

/**
 * canTriggerForcedLevel —— 该状态允许达到的最高强制级别
 *
 * 铁律（A任务提示词 7.A-M2 / 8.1）：
 *   - 状态只用于"分步起点选择 + 是否有人"，**绝不单独触发 L2 及以上强制**。
 *   - L0/L1 可以由状态驱动（人在场 + 该学习了）。
 *   - L2 及以上必须另有"步骤完成信号"（taskId + step 已确认未完成），
 *     不能只靠摄像头证据。
 *
 * @param {object} state 状态模型对象（或 { state, source, confidence }）
 * @param {object} [progress] 步骤完成信号 { stepCompleted: boolean, stepDeclined: boolean }
 * @returns {{ level: 'L0'|'L1'|'L2'..., allowed: boolean, reason: string }}
 */
function escalationEligibility(state, progress) {
  const prog = progress || {};
  const hasStepSignal = prog.stepCompleted === true || prog.stepDeclined === true;

  if (!state || typeof state.state !== 'string') {
    return { level: 'L0', allowed: false, reason: '状态不可用，不允许任何强制' };
  }

  // 无人 / 无法判断：只允许最弱的 L0 提醒，且必须人工确认后才继续
  if (state.state === 'away' || state.state === 'unknown') {
    return {
      level: 'L0',
      allowed: state.confidence >= 0.3,
      reason: state.state === 'away'
        ? '画面中无人，只能做一次找人提醒（L0）'
        : '状态不确定，只能做一次确认提醒（L0）'
    };
  }

  // 人在场且状态明确（lying_bed / seated_desk / standing_or_moving / learning）
  if (state.state === 'learning') {
    return { level: 'L0', allowed: true, reason: '正在学习，不打扰，最多保留 L0 通知能力' };
  }

  // 人在场但没在学：L0/L1 可以由状态驱动
  if (!hasStepSignal) {
    return {
      level: 'L1',
      allowed: state.confidence >= MIN_TRUSTED_CONFIDENCE,
      reason: '仅有状态证据（无步骤完成信号），最高到 L1；L2 及以上需要步骤完成信号'
    };
  }

  // 有步骤完成信号 → 允许进入 L2+（但仍受 A-M4 的其它规则约束：间隔/上限/授权）
  return {
    level: 'L4',
    allowed: state.confidence >= 0.3,
    reason: '存在步骤完成信号，可进入 L2 及以上（是否实际上升由 A-M4 决定）'
  };
}

/** 便捷包装：返回该状态允许达到的最高强制级别字符串 */
function canTriggerForcedLevel(state, progress) {
  return escalationEligibility(state, progress).level;
}

/* ------------------------------------------------------------------ *
 * 用户纠正回流
 * ------------------------------------------------------------------ */

/**
 * 纠正表 key 生成：把"时段桶 + 无操作档位 + 锁屏"编码成稳定字符串。
 * 用于把某类场景的判定结果改成用户纠正后的值。
 */
function ruleKey(ctx) {
  const hour = typeof ctx.hour === 'number' ? ctx.hour : hourOf(new Date());
  const inactiveMin = Math.round(Number(ctx.inactiveMin || 0));
  const band = inactiveMin < 5 ? 'lt5' : inactiveMin < 15 ? 'lt15' : inactiveMin < 25 ? 'lt25' : 'ge25';
  const bucket = bucketName(hour);
  const lock = ctx.locked ? 'lock' : 'unlock';
  return bucket + '/' + lock + '/' + band;
}

/**
 * createStateSensor —— 主入口
 *
 * @param {object} opts
 *   captureFrame: async () => ({ ok:true, frame } | { ok:false, reason })
 *   inferPose:    async (frames) => ({ person, posture, zone, confidence, quality })
 *   context:      () => ({ inactiveMin, locked })   当前活跃度/锁屏快照（可注入）
 *   clock:        { now: () => number, setTimeout, clearTimeout } 可注入假时钟
 *                 （全项目时钟契约统一：now 返回 epoch 毫秒数，不是 Date）
 *   fixturesDir:  假后端使用的 fixtures 目录（可选）
 *   corrections:  初始纠正表（可选，便于测试注入）
 */
function createStateSensor(opts) {
  const options = opts || {};
  if (typeof options.captureFrame !== 'function') {
    throw new Error('createStateSensor 需要 opts.captureFrame（可注入假后端）');
  }
  if (typeof options.inferPose !== 'function') {
    throw new Error('createStateSensor 需要 opts.inferPose');
  }

  const captureFrame = options.captureFrame;
  const inferPose = options.inferPose;
  const contextFn = typeof options.context === 'function' ? options.context : () => ({ inactiveMin: 0, locked: false });
  const clock = options.clock || {};
  const nowFn = clock.now || (() => Date.now());
  const setTimeoutFn = clock.setTimeout || setTimeout;
  const clearTimeoutFn = clock.clearTimeout || clearTimeout;
  const sleepFn = options.sleepFn || sleep;

  /** 纠正表：ruleKey → { state, note, at, count } */
  const corrections = new Map();
  if (options.corrections && typeof options.corrections === 'object') {
    for (const k of Object.keys(options.corrections)) {
      const c = options.corrections[k];
      corrections.set(k, {
        state: c.state,
        note: c.note || '',
        at: c.at || isoOffset(new Date(nowFn())),
        count: Number(c.count || 1)
      });
    }
  }

  /** 最近一次估计结果（内存态） */
  let last = null;

  /**
   * 抓一帧并做姿态推理。
   * @param {string} reason 采样原因（poll / post_notify / burst）
   * @returns {Promise<{ok:boolean, camera:object|null, reason:string|null}>}
   */
  async function sampleOnce(reason) {
    let capture;
    try {
      capture = await captureFrame(reason);
    } catch (e) {
      return { ok: false, camera: null, reason: 'unknown', detail: String(e && e.message) };
    }
    if (!capture || capture.ok !== true) {
      const r = (capture && capture.reason) || 'unknown';
      return { ok: false, camera: null, reason: r };
    }
    let pose;
    try {
      pose = await inferPose([capture.frame], reason);
    } catch (e) {
      return { ok: false, camera: null, reason: 'unknown', detail: String(e && e.message) };
    }
    if (!pose) return { ok: false, camera: null, reason: 'unknown' };
    // 推理质量差（遮挡/光线差）→ 视为无 camera 证据
    if (typeof pose.quality === 'number' && pose.quality < 0.3) {
      return { ok: false, camera: null, reason: pose.quality === 0 ? 'occluded' : 'low_light' };
    }
    return { ok: true, camera: normalizePose(pose), reason: null };
  }

  /** 连拍多帧，折叠成一份 camera 证据（帧间多数 + 分歧折扣） */
  async function sampleBurst(reason, frames, intervalMs) {
    const shots = [];
    const failed = [];
    for (let i = 0; i < frames; i++) {
      const r = await sampleOnce(reason);
      if (r.ok) shots.push(r.camera);
      else failed.push(r.reason);
      if (i < frames - 1 && intervalMs > 0) await sleepFn(intervalMs);
    }
    if (!shots.length) {
      return { ok: false, camera: null, reason: failed[0] || 'no_camera' };
    }
    const camera = foldFrames(shots);
    // 部分帧采集失败：说明摄像头不稳，折叠结果再打折，但比整批降级更有用
    if (failed.length) {
      camera.confidence = round2(camera.confidence * 0.85);
      camera.folded = (camera.folded || '') + '；' + failed.length + '帧采集失败，置信度已打折';
    }
    return { ok: true, camera, reason: null };
  }

  /** 归一化 pose 输出，缺字段给安全默认 */
  function normalizePose(pose) {
    const person = pose.person !== false;
    return {
      person,
      posture: person ? (pose.posture || 'unknown') : 'absent',
      zone: person ? (pose.zone || 'other') : 'none',
      confidence: clamp01(typeof pose.confidence === 'number' ? pose.confidence : 0.5),
      quality: clamp01(typeof pose.quality === 'number' ? pose.quality : 0.5)
    };
  }

  /**
   * 帧间折叠（连拍 2–3 帧 → 一份 camera 证据）：
   *   - 统计各姿态票数，取多数姿态（这才是"折叠"的本意）
   *   - 帧间有分歧 → 置信度打 7 折（并说明分歧）
   *   - 平票时偏向"有人在"（避免把睡着误判成没人），仍因分歧打折
   *   - confidence / quality 取均值
   * 注：全部帧都判无人时多数自然是 absent → away，这是正确结局。
   */
  function foldFrames(shots) {
    if (!shots.length) return null;
    const present = shots.filter(s => s.person !== false);
    const absentCount = shots.length - present.length;
    const mean = (pick) => round2(shots.reduce((a, s) => a + pick(s), 0) / shots.length);
    const foldedBase = shots.length + '帧' + (absentCount ? '（其中' + absentCount + '帧判无人）' : '');

    // 全部判无人 → away
    if (present.length === 0) {
      return {
        person: false, posture: 'absent', zone: 'none',
        confidence: mean(s => s.confidence),
        quality: mean(s => s.quality),
        folded: foldedBase
      };
    }

    const tally = {};
    for (const s of present) tally[s.posture] = (tally[s.posture] || 0) + 1;
    let top = null, topN = 0;
    for (const k of Object.keys(tally)) {
      if (tally[k] > topN || (tally[k] === topN && k !== 'absent')) { top = k; topN = tally[k]; }
    }
    const disagree = Object.keys(tally).length > 1 || absentCount > 0;
    const zoneOf = present.find(s => s.posture === top) || present[0];
    const conf = shots.reduce((a, s) => a + s.confidence, 0) / shots.length;
    // 分歧折扣：多数票占绝对多数（≥2/3）只打 8 折——结论仍可信，只是要标注分歧；
    // 票数接近时打 7 折，让它更可能掉到 unknown（宁可 unknown 也不瞎猜）。
    const strongMajority = topN >= Math.ceil(shots.length * 2 / 3);
    const discount = !disagree ? 1 : strongMajority ? 0.8 : 0.7;
    return {
      person: true,
      posture: top,
      zone: zoneOf.zone,
      confidence: round2(conf * discount),
      quality: mean(s => s.quality),
      folded: foldedBase + (disagree ? '，帧间有分歧，取多数「' + (POSTURE_TEXT[top] || top) + '」并打折' : '，帧间一致')
    };
  }

  /** 取出当前活跃度上下文 */
  function currentContext() {
    const c = contextFn() || {};
    return {
      inactiveMin: Number(c.inactiveMin || 0),
      locked: !!c.locked,
      hour: typeof c.hour === 'number' ? c.hour : hourOf(new Date(nowFn()))
    };
  }

  /**
   * estimate —— 主入口：一次状态估计
   * @param {object} [req] { frames: 1..3, intervalMs, reason, burst:boolean }
   * @returns {Promise<object>} 状态模型（契约 6.2）
   */
  async function estimate(req) {
    const r = req || {};
    const ctx = currentContext();
    const capturedAt = isoOffset(new Date(nowFn()));

    let sample;
    const wantFrames = Math.min(MAX_BURST_FRAMES, Math.max(1, r.frames || 1));
    if (wantFrames > 1) {
      sample = await sampleBurst(r.reason || 'burst', wantFrames, r.intervalMs || BURST_INTERVAL_MS);
    } else {
      sample = await sampleOnce(r.reason || 'poll');
    }

    let fused;
    if (sample.ok && sample.camera) {
      fused = fuseEvidence({ camera: sample.camera, context: ctx });
      if (sample.camera.folded) {
        fused.explain += '（连拍：' + sample.camera.folded + '）';
      }
    } else {
      // 降级路径：摄像头不可用 → 纯时间规则
      const rule = timeRulesOnly(ctx);
      fused = {
        state: rule.state,
        confidence: Math.min(DEGRADED_CONFIDENCE, rule.confidence),
        reason: 'degraded',
        evidence: rule.evidence,
        explain: rule.explain + '（摄像头不可用：' + cameraReasonText(sample.reason) + '，已降级为时间规则判断）'
      };
      // 降级路径下，纠正表仍然生效（规则修正）
      const key = ruleKey(ctx);
      const corr = corrections.get(key);
      if (corr) {
        fused.state = corr.state;
        fused.explain += '；已按用户此前的纠正改为「' + (STATE_TEXT[corr.state] || corr.state) + '」';
      }
    }

    const model = makeStateModel({
      state: fused.state,
      confidence: fused.confidence,
      evidence: fused.evidence,
      capturedAt,
      source: fused.reason === 'camera' ? 'camera_local' : 'time_rules',
      explain: fused.explain
    });

    last = model;
    return model;
  }

  /**
   * correctState —— 用户手动纠正当前判定（权重最高）
   * @param {string} state 纠正后的状态（必须合法枚举）
   * @param {string} [note] 用户原话/备注
   * @returns {object} 纠正后的状态模型（source=manual）
   */
  function correctState(state, note) {
    if (STATES.indexOf(state) === -1) {
      throw new Error('纠正状态不合法: ' + state + '，允许: ' + STATES.join(', '));
    }
    const ctx = currentContext();
    const key = ruleKey(ctx);
    const prev = corrections.get(key);
    const entry = {
      state,
      note: note || '',
      at: isoOffset(new Date(nowFn())),
      count: prev ? prev.count + 1 : 1,
      ruleKey: key
    };
    corrections.set(key, entry);

    const model = makeStateModel({
      state,
      confidence: 1,
      evidence: 'manual:用户纠正为' + (STATE_TEXT[state] || state) +
        (note ? '（' + note + '）' : '') + ' | 场景:' + key,
      capturedAt: isoOffset(new Date(nowFn())),
      source: 'manual',
      explain: '用户手动纠正为「' + (STATE_TEXT[state] || state) + '」' +
        (note ? '，备注：' + note : '') + '；该场景已记入规则修正表'
    });
    last = model;
    return model;
  }

  /** getCorrections —— 读取纠正表（A-M5 审计与规则回流用） */
  function getCorrections() {
    return Array.from(corrections.entries()).map(([k, v]) =>
      Object.assign({ ruleKey: k }, v));
  }

  /** 取/设最近一次判定 */
  function getLast() { return last; }

  return {
    estimate,
    correctState,
    getCorrections,
    getLast,
    escalationEligibility,
    canTriggerForcedLevel,
    scheduler: createCaptureScheduler({
      nowFn, setTimeoutFn, clearTimeoutFn,
      pollIntervalMs: options.pollIntervalMs,
      postNotifyMs: options.postNotifyMs,
      burstIntervalMs: options.burstIntervalMs,
      burstFrames: options.burstFrames
    })
  };
}

function cameraReasonText(reason) {
  return CAMERA_REASONS[reason] || CAMERA_REASONS.unknown;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  // 常量
  STATES, SOURCES, FORCED_LEVELS,
  POLL_INTERVAL_MS, POST_NOTIFY_DELAY_MS, BURST_INTERVAL_MS, MAX_BURST_FRAMES,
  DEGRADED_CONFIDENCE, MIN_TRUSTED_CONFIDENCE, CAMERA_REASONS, TIME_BUCKETS,
  // 工具
  isoOffset, hourOf, hhmm, round2, clamp01, validateStateModel, makeStateModel,
  cameraReasonText, ruleKey, inactiveText, bucketName,
  // 算法
  fuseEvidence, timeRulesOnly, buildExplain,
  // 消费约束
  escalationEligibility, canTriggerForcedLevel,
  // 采集调度
  createCaptureScheduler,
  // 主入口
  createStateSensor
};
