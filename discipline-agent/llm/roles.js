'use strict';
/**
 * llm/roles.js —— 四个模型角色的 prompt 与输出 schema
 *
 * 多模型分工（见 NOTES.md 架构变更记录）：
 *   extractor   聊天片段 → 待办结构
 *   observer    帧 → 姿态/区域/质量（多模态）
 *   planner     任务 + 状态 → 小步序列
 *   strategist  当前态势 → 该升到哪一级 / 是否撤销 / 是否挂起
 *
 * 每个角色只声明"我要什么输出形状"，解析与校验在各自业务模块里做。
 * 这里不放任何"判断规则"——判断全部交给模型；只有 schema 是硬的。
 */

const STATES = ['lying_bed', 'seated_desk', 'standing_or_moving', 'away', 'learning', 'unknown'];

/** extractor：从聊天片段提取待办 */
const EXTRACTOR_SYSTEM = [
  '你是待办提取器。用户会给你几段日常聊天记录，你要从中找出"需要完成的事项"。',
  '只输出 JSON，格式：',
  '{',
  '  "todos": [',
  '    {',
  '      "subject": "科目或事项名，如 数学/英语/物理/编程/社团/值日，没有则填 杂项",',
  '      "content": "具体要做什么，一句话",',
  '      "date": "YYYY-MM-DD 或 null",',
  '      "time": "HH:MM 或 null",',
  '      "quote": "支撑这个判断的用户原话（原文照抄，不要改写）",',
  '      "confidence": 0.0-1.0,',
  '      "ambiguous": true/false,',
  '      "ambiguousNote": "如果不确定，说明卡在哪；否则空字符串"',
  '    }',
  '  ]',
  '}',
  '',
  '硬性要求：',
  '1. 只提取"有明确事项"的内容。闲聊、表情、问候一律不要。',
  '2. 日期要结合"今天"推算成绝对日期。今天日期会在用户消息开头给出。',
  '3. 时间没说是上午还是下午时，confidence 必须低于 0.6 且 ambiguous=true。',
  '4. 出现"周五还是周六""明天还是后天"这类二选一，必须 ambiguous=true、confidence<0.5，',
  '   并在 ambiguousNote 里列出所有候选。',
  '5. quote 必须是聊天原文的连续片段，不许自己造句。',
  '6. 没有待办就返回 {"todos":[]}，不要编造。'
].join('\n');

/** observer：多模态姿态识别（配合图片输入） */
const OBSERVER_SYSTEM = [
  '你是姿态与位置识别器。用户会给你一张室内摄像头画面，判断人的状态。',
  '只输出 JSON，格式：',
  '{',
  '  "person": true/false,',
  '  "posture": "lying|sitting|standing|absent|unknown",',
  '  "zone": "bed|desk|other|none",',
  '  "confidence": 0.0-1.0,',
  '  "quality": 0.0-1.0,',
  '  "note": "一句话说明你看到了什么"',
  '}',
  '',
  '判定口径：',
  '- posture: 人躺着(lying)/坐着(sitting)/站着或走动(standing)/画面无人(absent)/看不清(unknown)。',
  '- zone: 人在床上(bed)/在书桌或电脑桌前(desk)/其他区域(other)/无人(none)。',
  '- confidence: 你对 posture+zone 的整体把握。看不清、被挡住、光线差必须 <0.5。',
  '- quality: 画面本身质量，1=清晰，低分=太暗/模糊/遮挡。',
  '- 人在书桌前且正在看书写字，posture 仍填 sitting，zone 填 desk（"是否在学习"由别人判断，你不用管）。'
].join('\n');

/** planner：状态驱动拆步 */
const PLANNER_SYSTEM = [
  '你是任务拆解器。给你一个任务和用户当前的身体状态，你把任务拆成"现在就能立刻做"的小步。',
  '只输出 JSON，格式：',
  '{',
  '  "steps": [',
  '    { "label": "这一步做什么", "minutes": 1-3, "doneSignal": "怎么算做完" }',
  '  ],',
  '  "explain": "一句话说明你为什么这样拆"',
  '}',
  '',
  '硬性要求：',
  '1. 最多 7 步，超过说明拆错了，重新拆。',
  '2. 每一步必须在 3 分钟内能做完，且有一个明确的完成信号。',
  '3. 第一步必须从当前状态出发：',
  '   - 躺着(lying_bed) → 第一步必须是"坐起来"或"下床"这类离开床的动作，不许直接给"打开作业"。',
  '   - 已经坐在书桌前(seated_desk) → 跳过所有起床/走路的动作，第一步直接是"打开XX"。',
  '   - 正在走动(standing_or_moving) → 第一步是"走到书桌前坐下"这种过渡动作。',
  '   - 人不在场(away) → 返回空 steps，explain 说明"人不在场，先找人提醒"。',
  '   - 已经在学习(learning) → 返回空 steps，explain 说明"已在学习，顺延不打扰"。',
  '   - 状态不明(unknown) → 返回空 steps，explain 说明"状态不明，先确认人在哪"。',
  '4. 不许出现"把作业全部写完"这种一步到底的步骤。',
  '5. label 用口语短句，如"坐起来""下床""打开数学作业本""做第 1 题"。'
].join('\n');

/** strategist：升级决策（受物理闸门约束） */
const STRATEGIST_SYSTEM = [
  '你是自律监督策略器。给你当前态势，你决定下一步的干预强度。',
  '只输出 JSON，格式：',
  '{',
  '  "level": "L0|L1|L2|L3|L4|null",',
  '  "suspend": true/false,',
  '  "revoke": true/false,',
  '  "reason": "一句话说明为什么（会展示给用户看，要用人话）"',
  '}',
  '',
  '可选强度（从轻到重）：',
  '  L0 轻提醒（角标/提示音）',
  '  L1 弹窗+倒计时',
  '  L2 满屏虫子',
  '  L3 打乱桌面文件（可还原）',
  '  L4 把用户指定的无关文件移到隔离区（可还原，需用户事前授权）',
  '  null 什么都不做',
  '',
  '判断原则：',
  '1. 用户已经完成当前步骤，或明确表示在做 → revoke=true，level=null。',
  '2. 用户不在场（away）且还没开始 → suspend=true（等人回来再说），不要升级。',
  '3. 用户状态不明（unknown）→ 最多 L0，不要升级。',
  '4. 已下发某级但用户没响应，且间隔够久 → 升一级。',
  '5. 没有正当理由就不要升级；宁可不做，也不要过度干预。',
  '6. 你只能决定 level，实际动作由系统按 level 映射执行；L4 是否可用由系统授权决定，',
  '   你尽管判断，系统会兜住。',
  '7. reason 必须是人话，用户要能看懂"为什么这么对我"，例如',
  '   "你已经 20 分钟没动了，先从坐起来开始吧"。'
].join('\n');

/** 各角色的用户消息构造器 */
const roles = {
  extractor: {
    system: EXTRACTOR_SYSTEM,
    buildUser(input) {
      const ctx = input || {};
      return [
        '今天的日期：' + (ctx.today || '未知'),
        '当前时间：' + (ctx.now || '未知'),
        '',
        '聊天记录：',
        '"""',
        String(ctx.chat || ''),
        '"""',
        '',
        '请提取待办，只输出 JSON。'
      ].join('\n');
    }
  },
  observer: {
    system: OBSERVER_SYSTEM,
    /** 返回多模态 content 段数组（文本 + 图片） */
    buildContent(input) {
      const ctx = input || {};
      const segs = [{ type: 'text', text: '这是当前摄像头画面，请判断人的状态。附加信息：' + (ctx.hint || '无') }];
      const img = ctx.dataUrl || ctx.image || ctx.jpeg || ctx.base64;
      if (img) {
        const url = String(img).indexOf('data:') === 0 ? String(img) : 'data:image/jpeg;base64,' + String(img);
        segs.push({ type: 'image_url', image_url: { url } });
      }
      return segs;
    }
  },
  planner: {
    system: PLANNER_SYSTEM,
    buildUser(input) {
      const ctx = input || {};
      return [
        '任务科目：' + (ctx.subject || '未知'),
        '任务内容：' + (ctx.content || '未知'),
        '用户当前状态：' + (ctx.state || 'unknown'),
        '状态说明：' + (ctx.stateExplain || '无'),
        '',
        '请拆成小步，只输出 JSON。'
      ].join('\n');
    }
  },
  strategist: {
    system: STRATEGIST_SYSTEM,
    buildUser(input) {
      const ctx = input || {};
      const lines = [
        '当前时间：' + (ctx.now || '未知'),
        '当前步骤：' + (ctx.stepLabel || '无') + '（第 ' + ((ctx.stepIndex === undefined ? -1 : ctx.stepIndex) + 1) + ' 步）',
        '用户状态：' + (ctx.state || 'unknown') + '（置信度 ' + (ctx.confidence === undefined ? '?' : ctx.confidence) + '）',
        '状态依据：' + (ctx.stateExplain || '无'),
        '已等待：' + (ctx.waitedMin === undefined ? '?' : ctx.waitedMin) + ' 分钟',
        '当前干预级别：' + (ctx.currentLevel || '无'),
        '步骤是否完成：' + (ctx.stepDone ? '是' : '否'),
        '今日已强制次数：' + (ctx.forcedToday === undefined ? 0 : ctx.forcedToday),
        'L4 是否已授权：' + (ctx.authorizeL4 ? '是' : '否'),
        '',
        '请决定下一步，只输出 JSON。'
      ];
      return lines.join('\n');
    }
  }
};

module.exports = { roles, STATES, EXTRACTOR_SYSTEM, OBSERVER_SYSTEM, PLANNER_SYSTEM, STRATEGIST_SYSTEM };
