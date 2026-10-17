(function (global) {
  'use strict';

  // A transparent, deterministic demo. No model, browsing, calendar or video API is called.
  const SOURCE = 'local-demo';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clean = value => String(value == null ? '' : value).trim();
  const unique = values => [...new Set(values)];
  const stepId = (start, index) => 'step-' + start + '-' + index;

  const profiles = [
    {
      key: 'dance', match: /跳舞|舞蹈|街舞|爵士舞|芭蕾|hip.?hop|dance/i, label: '跳舞',
      beginner: ['活动肩颈和脚踝，选一个舒服的站姿。', '挑一个基础动作，慢速重复；先跟上节拍，不急着跳整段。', '写下一个顺手的动作和一个还卡住的地方。'],
      some: ['复习一个熟悉的基础动作，慢速找回节拍。', '选一小段组合，分两次慢速练，再连起来。', '记录最容易卡住的衔接，下次只练这一处。'],
      advanced: ['用熟悉的动作做轻量热身。', '选一个具体技术点或短组合，集中练习节奏与控制。', '记录一次自我观察和下一次要验证的改进。'],
      query: '舞蹈 零基础 基础动作 节拍', tiny: '跟着自己喜欢的一首歌，慢速重复一个基础动作。'
    },
    {
      key: 'sing', match: /唱歌|演唱|声乐|歌唱|sing/i, label: '唱歌',
      beginner: ['放松肩膀，轻声哼一个舒服的音，不挤压嗓子。', '选一句喜欢的歌词，用舒适的音区轻唱几次，先听清节奏。', '记录一句最喜欢的片段和一个想改进的地方。'],
      some: ['轻声哼唱熟悉的旋律，确认音区舒适。', '只练一小句的节奏或换气；每次只改一个问题。', '写下这句哪里变轻松了，哪里仍需要练习。'],
      advanced: ['用舒适音区做轻量热身。', '挑一句作品，聚焦一个表达或节奏问题，做两种唱法的对比。', '记录你偏好的版本与原因。'],
      query: '唱歌 初学 节奏 轻声练习', tiny: '轻声唱一小句喜欢的歌词，听一听它的节奏。'
    },
    {
      key: 'draw', match: /画画|绘画|素描|插画|水彩|速写|draw|paint/i, label: '画画',
      beginner: ['准备纸笔，画几条直线和圆，让手慢慢熟悉。', '选杯子或水果，只观察外轮廓，画一张小速写。', '圈出一个满意的部分，写下一个想再观察的细节。'],
      some: ['用几个简单形状热身。', '选一个物件，聚焦比例或明暗之一，完成一张小练习。', '标记一处值得保留的处理和一处要重画的部分。'],
      advanced: ['明确这次只练构图、色彩或表现中的一项。', '做两个小草图，用不同处理方式验证自己的选择。', '写下哪个版本更接近想表达的感觉。'],
      query: '绘画 零基础 简单物体 速写', tiny: '拿纸笔画身边一个小物件的轮廓。'
    },
    {
      key: 'code', match: /编程|写代码|代码|python|javascript|前端|程序开发|coding/i, label: '编程',
      beginner: ['选择一个入门语言或在线练习环境，今天只处理一个小概念。', '照一个最小例子运行，修改一个数值或文字，再观察结果。', '写下“改了什么，结果怎么变了”，保留这一段例子。'],
      some: ['选一个已学过的概念，读一段熟悉的小例子。', '把它改成完成一个小需求的程序，运行并观察输出。', '记录一个报错或疑问，留给下一次处理。'],
      advanced: ['把想改善的地方写成一个可验证的输入与输出。', '实现最小改动，用一个代表性例子验证结果。', '记录剩余边界情况与下一步。'],
      query: '编程 入门 在线练习 最小例子', tiny: '运行一个最小例子，只改一行，观察结果。'
    },
    {
      key: 'language', match: /英语|日语|韩语|法语|德语|西班牙语|语言|单词|口语|english|japanese/i, label: '语言',
      beginner: ['选一个生活场景，比如打招呼或点餐。', '只学三句常用表达，听一句、跟读一句，再自己说一遍。', '写下今天能脱口而出的一句。'],
      some: ['选一个你最近会遇到的生活场景。', '用已经会的词说四五句话，再补一个不会的表达。', '保留一个需要重复练习的句子。'],
      advanced: ['选一个你愿意表达观点的小话题。', '做一段短表达，聚焦逻辑或一个更自然的说法。', '记录一个表达上的新发现。'],
      query: '语言学习 初学 生活场景 跟读', tiny: '选一句生活中用得到的表达，听后跟读三遍。'
    }
  ];

  const genericProfile = {
    key: 'general', label: '新技能',
    beginner: ['选一个最小知识点，准备需要的材料。', '看一个短例子，马上动手模仿一次；今天先追求做出来。', '记下一个收获和一个疑问。'],
    some: ['回顾一个已有基础，明确本次只练哪一项。', '做一份小练习或作品，试着改进一个具体细节。', '记录一次变化，下次从这里继续。'],
    advanced: ['写下这次要验证的具体问题与成功标准。', '围绕这一点做一次短练习或小实验。', '对照标准记录结果与后续问题。'],
    query: '初学 基础 入门 练习', tiny: '挑一个最小动作或例子，亲手尝试一次。'
  };

  function profileFor(idea) {
    return profiles.find(profile => profile.match.test(clean(idea))) || genericProfile;
  }

  function shortTitle(idea) {
    const result = clean(idea)
      .replace(/^(嗯[，,、\s]*)?(我)?(突然)?(有点)?(想要|想|打算|希望)[，,、\s]*/u, '')
      .replace(/[。！!？?]+$/u, '');
    return result ? (result.length > 32 ? result.slice(0, 31) + '…' : result) : '一颗还没命名的小灵感';
  }

  function searchLinks(query) {
    return [
      {label: '去 B 站搜教程', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(query)},
      {label: '去网页搜资料', url: 'https://www.bing.com/search?q=' + encodeURIComponent(query)}
    ];
  }

  function classifyIdea(text, preferred) {
    const idea = clean(text);
    const preference = ['skill', 'creative', 'park'].includes(preferred) ? preferred : 'auto';
    const creative = /想法|创意|创业|产品|应用|app|网站|工具|平台|发明|设计一个|做一个|制作一个|开发一个|组织|活动|校园|社团|音乐会|分享会|展览|故事|小说|短片|视频作品/i.test(idea);
    const skill = /学习|学会|学点|学一下|练习|练一练|提高|提升|入门|掌握|零基础|小白|想学|深造/i.test(idea) || profiles.some(profile => profile.match.test(idea));
    const shouldPark = !idea || /^(先记|先存|先收藏|以后再|暂时不|只是记)/u.test(idea);
    const type = preference !== 'auto' ? preference : shouldPark ? 'park' : creative ? 'creative' : skill ? 'skill' : 'park';
    const keywords = unique([
      ...profiles.filter(profile => profile.match.test(idea)).map(profile => profile.label),
      ...['校园', '工具', '活动', '创作', '网站', '学习', '设计'].filter(word => idea.includes(word))
    ]).slice(0, 5);
    const needsClarification = !idea || (preference === 'auto' && !creative && !skill && !shouldPark);
    return {
      source: SOURCE, type, title: shortTitle(idea), keywords, needsClarification,
      summary: type === 'skill' ? '把这个兴趣变成一个适合你时间与精力的小练习。' : type === 'creative' ? '先找一个能验证的假设，再决定要不要继续投入。' : '先把灵感放进口袋，想继续时再打开。',
      route: type === 'skill' ? 'Agent 2' : type === 'creative' ? 'Agent 3' : 'Agent 1',
      trace: [{agent: 'Agent 1', action: '记录并分流', detail: needsClarification ? '还需要你选择：学习技能、探索创意，还是先收藏。' : '根据你的文字和路线选择保存这颗灵感。'}]
    };
  }

  function parseTime(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
    const pieces = value.split(':').map(Number);
    return pieces[0] <= 23 && pieces[1] <= 59 ? pieces[0] * 60 + pieces[1] : null;
  }

  function formatTime(value) {
    return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  }

  function validateDate(date) {
    if (!date) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parts = date.split('-').map(Number);
    const candidate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return candidate.getUTCFullYear() === parts[0] && candidate.getUTCMonth() + 1 === parts[1] && candidate.getUTCDate() === parts[2];
  }

  function planLearning(input) {
    input = input || {};
    const idea = clean(input.idea || input.title);
    const title = shortTitle(input.title || idea);
    const start = parseTime(input.availableStart);
    const end = parseTime(input.availableEnd);
    const trace = [{agent: 'Agent 1', action: '读取学习灵感', detail: title}];
    const invalid = error => ({source: SOURCE, ok: false, error, tasks: [], rationale: error, trace, nextAdvice: '调整后再生成，我们一起找一个舒服的时间。'});
    if (!idea) return invalid('先告诉我你想尝试什么，再一起安排时间。');
    if (!validateDate(clean(input.date))) return invalid('这个日期不存在，请重新选择日期。');
    if (start === null || end === null) return invalid('请填写合法的开始与结束时间，例如 19:00 到 19:30。');
    if (end <= start) return invalid('结束时间要晚于开始时间；跨夜安排请拆成两天。');

    const busySlots = Array.isArray(input.busySlots) ? input.busySlots : [];
    const clipped = [];
    for (const busy of busySlots) {
      const busyStart = parseTime(busy && busy.start);
      const busyEnd = parseTime(busy && busy.end);
      if (busyStart === null || busyEnd === null || busyEnd <= busyStart) return invalid('有一段忙碌时间不完整，或结束早于开始，请检查一下。');
      if (busyEnd > start && busyStart < end) clipped.push([Math.max(busyStart, start), Math.min(busyEnd, end)]);
    }
    clipped.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const slot of clipped) {
      const last = merged[merged.length - 1];
      if (last && slot[0] <= last[1]) last[1] = Math.max(last[1], slot[1]);
      else merged.push(slot.slice());
    }
    const free = [];
    let cursor = start;
    for (const slot of merged) {
      if (slot[0] > cursor) free.push([cursor, slot[0]]);
      cursor = Math.max(cursor, slot[1]);
    }
    if (cursor < end) free.push([cursor, end]);
    trace.push({agent: 'Agent 2', action: '检查时间冲突', detail: '根据你填写的 ' + busySlots.length + ' 段忙碌时间，找到 ' + free.length + ' 段空闲；没有读取外部日历。'});

    const energy = ['low', 'medium', 'high'].includes(input.energy) ? input.energy : 'medium';
    const level = ['beginner', 'some', 'advanced'].includes(input.level) ? input.level : 'beginner';
    const previousFeedback = input.previousFeedback && typeof input.previousFeedback === 'object' ? input.previousFeedback : {};
    const adjustment = input.adjustment || previousFeedback.nextAdjustment || previousFeedback;
    const numericScale = Number(adjustment.durationScale);
    const adjustmentScale = Number.isFinite(numericScale) && numericScale > 0 ? clamp(numericScale, 0.25, 1.5) : 1;
    const adjustmentDifficulty = adjustment.difficulty || 'same';
    const energyCaps = {low: 10, medium: 20, high: 40};
    const suppliedDuration = Number(input.duration);
    const requested = Number.isFinite(suppliedDuration) && suppliedDuration > 0 ? clamp(Math.round(suppliedDuration), 3, 120) : energyCaps[energy];
    const adjustedDuration = Math.max(3, Math.round(requested * adjustmentScale));
    const target = Math.min(adjustedDuration, energyCaps[energy]);
    if (adjustmentScale !== 1 || adjustmentDifficulty !== 'same') {
      trace.push({agent: 'Agent 2', action: '应用上次反馈', detail: '时长系数 ' + adjustmentScale + '；' + (adjustmentDifficulty === 'easier' ? '把练习拆成更简单的小动作。' : adjustmentDifficulty === 'slightly-harder' ? '时长保持受精力限制，只加一个小挑战。' : '保持已有难度。')});
    }
    const longest = free.reduce((best, slot) => !best || slot[1] - slot[0] > best[1] - best[0] ? slot : best, null);
    const longestMinutes = longest ? longest[1] - longest[0] : 0;
    if (longestMinutes < 3) {
      const rationale = longestMinutes === 0 ? '这一段时间已经被忙碌安排占满了。今天先休息，也可以换一个空闲时段。' : '这段时间太碎，最长只有 ' + longestMinutes + ' 分钟。先休息，或换一段至少 3 分钟的空闲，好吗？';
      trace.push({agent: 'Agent 2', action: '建议休息并等待确认', detail: rationale});
      return {source: SOURCE, ok: false, error: rationale, tasks: [], rationale, trace, requiresConfirmation: true, confirmationQuestion: '今天先休息，还是换一个时间？', nextAdvice: '不塞满你的日程；留一点空白也是计划的一部分。'};
    }
    const budget = Math.min(target, longestMinutes);
    const chosen = free.find(slot => slot[1] - slot[0] >= budget) || longest;
    const profile = profileFor(idea);
    let descriptions = profile[level].slice();
    if (adjustmentDifficulty === 'easier') {
      descriptions = [profile.beginner[0], profile.tiny + ' 这次只做这一件事，不急着完成整套练习。', '用一句话记下感觉，下次再决定要不要多走一步。'];
    } else if (adjustmentDifficulty === 'slightly-harder') {
      const nextLevel = level === 'beginner' ? 'some' : 'advanced';
      descriptions[1] = profile[nextLevel][1] + ' 只增加一个小挑战，不同时增加练习数量。';
    }
    const goal = clean(input.goal);
    const query = (profile.key === 'general' ? title + ' ' + profile.query : profile.query) + (level === 'beginner' ? '' : level === 'some' ? ' 进阶' : ' 专项练习');
    const resources = searchLinks(query);
    let pieces;
    if (budget < 8) {
      pieces = [{title: '做一个迷你尝试', description: profile.tiny + ' 最后用一句话记下感觉。', duration: budget}];
    } else {
      const warmup = budget <= 12 ? 2 : 3;
      const reflection = budget <= 12 ? 1 : 2;
      pieces = [
        {title: '轻轻开始', description: descriptions[0], duration: warmup},
        {title: '只练一小步', description: descriptions[1] + (goal ? ' 你的目标是：' + goal + '。' : ''), duration: budget - warmup - reflection},
        {title: '留下一点收获', description: descriptions[2], duration: reflection}
      ];
    }
    let taskCursor = chosen[0];
    const tasks = pieces.map((piece, index) => {
      const taskStart = taskCursor;
      taskCursor += piece.duration;
      return {
        id: stepId(taskStart, index), title: piece.title, description: piece.description,
        start: formatTime(taskStart), end: formatTime(taskCursor), date: clean(input.date),
        duration: piece.duration, resources: index === (pieces.length === 1 ? 0 : 1) ? resources : [], status: 'proposed'
      };
    });
    const reasons = [];
    if (energy === 'low') reasons.push('你选择了低精力，所以先把行动控制在 10 分钟以内');
    else reasons.push(energy === 'high' ? '你现在精力充足，也给行动留一个明确的结束点' : '按适中的精力，先完成一个小练习');
    if (target < requested) reasons.push('你原本想练 ' + requested + ' 分钟，结合精力与上次反馈，这次先缩小到 ' + target + ' 分钟');
    if (adjustmentDifficulty === 'easier') reasons.push('根据上次的困难，先用更简单的小动作');
    if (adjustmentDifficulty === 'slightly-harder') reasons.push('根据上次轻松完成的反馈，只增加一个小挑战');
    if (budget < target) reasons.push('最长连续空闲只有 ' + budget + ' 分钟，先用一个更小的行动');
    if (merged.length) reasons.push('已避开你填写的忙碌时段');
    const rationale = reasons.join('；') + '。安排在 ' + formatTime(chosen[0]) + '—' + formatTime(taskCursor) + '，总共 ' + budget + ' 分钟。';
    trace.push({agent: 'Agent 2', action: '生成待确认的小计划', detail: rationale});
    trace.push({agent: 'Agent 4', action: '准备接收行动反馈', detail: '接受计划后，可以反馈完成、做了一部分或暂时没做，再调整下次行动。'});
    return {
      source: SOURCE, ok: true, title, tasks, rationale, trace,
      freeSlots: free.map(slot => ({start: formatTime(slot[0]), end: formatTime(slot[1])})),
      requestedDuration: requested, adjustedDuration, actualDuration: budget, adjustmentApplied: adjustmentScale !== 1 || adjustmentDifficulty !== 'same', requiresConfirmation: true,
      confirmationQuestion: budget < requested || energy === 'low' ? '先试这个更小的行动，或者今天休息，哪一种更适合你？' : '这个时间和强度合适吗？接受后我再保存。',
      nextAdvice: (clean(adjustment.advice) ? clean(adjustment.advice) + ' ' : '') + '教程链接会打开搜索结果，请自己选合适的教程。下次有空时从你的反馈继续，不必连续打卡。'
    };
  }

  function exploreIdea(input) {
    input = input || {};
    const idea = clean(input.idea);
    const title = shortTitle(idea);
    const resources = clean(input.resources);
    const numericBudget = Number(input.timeBudget);
    const originalBudget = Number.isFinite(numericBudget) && numericBudget > 0 ? clamp(Math.round(numericBudget), 3, 120) : 15;
    const feedback = input.feedback || input.previousFeedback;
    const feedbackText = clean(typeof feedback === 'string' ? feedback : feedback && (feedback.observation || feedback.result || feedback.summary || feedback.reason));
    const feedbackAdjustment = feedback && typeof feedback === 'object' ? feedback.nextAdjustment || feedback : {};
    const feedbackScale = Number(feedbackAdjustment.durationScale);
    const timeBudget = Number.isFinite(feedbackScale) && feedbackScale > 0 ? Math.max(3, Math.round(originalBudget * clamp(feedbackScale, 0.25, 1))) : originalBudget;
    const campus = /校园|学校|同学|社团|组织|分享会|活动|音乐会|聚会|展览|市集/u.test(idea);
    const product = /工具|产品|应用|app|网站|平台|程序|自动|助手|AI|智能体|机器人/i.test(idea);
    const creation = /创作|小说|故事|漫画|绘本|短片|视频|音乐|写作|摄影|作品/u.test(idea);
    let assumptions, paths, firstStep, successSignal, questions, query;
    if (campus) {
      assumptions = ['可能有一小群同学愿意参加；现在还没有证据。', '场地、时间和组织方式需要确认，先做小规模尝试。'];
      paths = [
        {title: '先找同伴', description: '把活动写成一句邀请，问 3 位目标同学最想参与哪一部分。'},
        {title: '做一次小试场', description: '用现有空间办一个很短的试活动，先看参与意愿和体验。'},
        {title: '再扩大一点', description: '有明确参加意愿后，再确认场地规则、时间和分工。'}
      ];
      firstStep = '用 ' + timeBudget + ' 分钟写出“一起做什么、谁会来、需要多久”的短邀请，先准备问 3 位同学。';
      successSignal = '至少 2 位目标同学明确表示愿意参加，并能说出自己期待的内容。';
      questions = ['你最想邀请哪一类同学？', '一次小活动需要哪些许可或场地条件？', '如果只有 3 人来，什么体验仍值得办？'];
      query = title + ' 小型校园活动 策划';
    } else if (product) {
      assumptions = ['你想解决的困扰可能有人真实遇到；先确认它发生的频率。', '第一个版本可能只需手动流程或一张页面。'];
      paths = [
        {title: '找到具体困扰', description: '问 3 位目标用户：上次遇到这件事是什么时候，当前怎么解决。'},
        {title: '手动跑一遍', description: '先用纸笔、表格或简单页面提供一次服务，看是否真的省事。'},
        {title: '只做一个功能', description: '确认最有价值的一步后，再做能跑通它的小原型。'}
      ];
      firstStep = '用 ' + timeBudget + ' 分钟写下一个真实场景：“谁在什么时候遇到什么困难”，画出最少 3 步的使用流程。';
      successSignal = '至少 1 位目标用户能独立走完流程，并明确指出它对自己有什么帮助。';
      questions = ['谁最需要它？', '他们现在怎么解决，最费劲的是哪一步？', '最小版本做到什么就值得试一次？'];
      query = title + ' 需求验证 最小原型';
    } else if (creation) {
      assumptions = ['你想表达的主题值得先做一个短片段，再观察读者或观众能否理解。', '先利用已有素材与工具，避免第一步过大。'];
      paths = [
        {title: '定一个小主题', description: '只写下你希望观众记住的一句话。'},
        {title: '做一个片段', description: '写一页、画一格、录 30 秒，先完成最小表达。'},
        {title: '听一条真实反馈', description: '请一个人看完，说说他理解到什么，再决定怎么改。'}
      ];
      firstStep = '用 ' + timeBudget + ' 分钟写一句主题，再做一个能表达它的小片段。';
      successSignal = '一位看过片段的人能说出你想表达的核心感受或意思。';
      questions = ['你最想表达什么？', '作品给谁看？', '最小可以完成的片段是什么？'];
      query = title + ' 创作 入门 小作品';
    } else {
      assumptions = ['这个方向目前是一个待验证的想法，还不能断定可行。', '可以先通过低成本的小行动收集一条证据。'];
      paths = [
        {title: '把愿望变具体', description: '写明希望发生什么变化，以及谁会受益。'},
        {title: '找一个最小实验', description: '选一个今天就能尝试、成本很低的行动。'},
        {title: '看结果再调整', description: '对照提前写好的成功标准，决定继续、改变或先收藏。'}
      ];
      firstStep = '用 ' + timeBudget + ' 分钟补完：“我希望帮谁做什么；今天能先验证的是……”';
      successSignal = '得到一条具体观察或反馈，能帮助你决定下一步，而不是只觉得这个想法很好。';
      questions = ['这个想法希望改变什么？', '哪一个条件如果不成立，就需要换一条路？', '你现在能用哪些材料、伙伴或工具？'];
      query = title + ' 可行性 小实验';
    }
    if (resources) assumptions.push('你填写的现有资源：' + resources + '；以上路径仍需你确认条件。');
    if (feedbackText) {
      assumptions.push('你报告的上次观察：' + feedbackText + '。这是你提供的反馈，仍需结合实际证据判断。');
      questions.unshift('上次的观察支持了哪一个假设，又让哪个条件需要调整？');
      if (feedbackAdjustment.difficulty === 'easier' || feedback && feedback.completion === 'skipped' || /暂未开始|没做|未完成/u.test(feedbackText)) {
        paths[0] = {title: '先找到卡点', description: '回看上次没有行动的原因，删掉一个不必要条件，保留最容易尝试的一步。'};
        firstStep = '先写下上次卡住的一件事，再用 ' + timeBudget + ' 分钟只做一个准备动作：' + (campus ? '完成一条邀请草稿。' : product ? '写下一个目标用户的具体困扰。' : creation ? '写下作品想表达的一句话。' : '写下今天能验证的一个小问题。');
        successSignal = campus ? '完成一条写清“做什么、邀请谁、需要多久”的邀请草稿。' : product ? '写下一个包含目标用户、发生场景与具体困难的短描述。' : creation ? '写下一句话，清楚表达作品想传达的主题或感受。' : '写下一个足够具体的小问题，说明准备如何观察它。';
      }
    }
    return {
      source: SOURCE, title, assumptions, paths, firstStep, successSignal, questions,
      searchLinks: searchLinks(query), timeBudget, feedbackApplied: Boolean(feedbackText),
      trace: [
        {agent: 'Agent 1', action: '读取创意', detail: title},
        {agent: 'Agent 3', action: '拆出待验证假设', detail: '用本地模板提供探索路径；这些是假设，没有查询外部资料。' + (feedbackText ? '已把上次文字反馈加入下一轮问题。' : '')},
        {agent: 'Agent 3', action: '给出最小尝试', detail: firstStep},
        {agent: 'Agent 4', action: '约定反馈信号', detail: successSignal}
      ]
    };
  }

  function reflect(input) {
    input = input || {};
    const task = input.task || {};
    const taskTitle = clean(typeof task === 'string' ? task : task.title) || '这次小行动';
    const completion = ['done', 'partial', 'skipped'].includes(input.completion) ? input.completion : 'skipped';
    const feeling = ['easy', 'right', 'hard'].includes(input.feeling) ? input.feeling : 'right';
    const reason = clean(input.reason);
    const available = clean(input.nextAvailable);
    const rawMinutes = Number(input.minutes);
    const minutes = Number.isFinite(rawMinutes) ? Math.max(0, Math.round(rawMinutes)) : 0;
    let response, emotion, durationScale, difficulty, advice;
    if (completion === 'done') {
      emotion = 'happy';
      response = '接住你的收获啦！“' + taskTitle + '”已经留下了一次真实尝试。';
      if (feeling === 'hard') {
        durationScale = 0.7; difficulty = 'easier';
        advice = '下次把动作或练习拆得更小，时长先缩到本次的约七成，再确认你的精力。';
        response += ' 做完也可以觉得难，我们下次放轻一点。';
      } else if (feeling === 'easy') {
        durationScale = 1; difficulty = 'slightly-harder';
        advice = '时长先保持，只增加一个小挑战；仍由你决定是否愿意。';
        response += ' 既然很轻松，下次可以只加一个小挑战。';
      } else {
        durationScale = 1; difficulty = 'same';
        advice = '保持这次的时长与难度，下次有空时接着走一小步。';
      }
    } else if (completion === 'partial') {
      emotion = feeling === 'hard' ? 'sorry' : 'proud';
      durationScale = 0.6;
      difficulty = feeling === 'hard' ? 'easier' : 'same';
      response = '做了一部分也算一次尝试' + (minutes > 0 ? '，这 ' + minutes + ' 分钟已经有价值' : '') + '。谢谢你告诉我真实情况。';
      if (feeling === 'hard') response += ' 是我刚才安排得有点着急了，下次一起把这一步拆小。';
      advice = '下次先安排本次约六成的时长' + (feeling === 'hard' ? '，并降低一点难度' : '') + '；只保留最重要的一步。';
    } else {
      emotion = 'sorry'; durationScale = 0.5; difficulty = 'easier';
      response = '刚才有点着急了，是我没先问清你的情况。' + (reason ? '谢谢你解释原因，我听到了。' : '今天没做也没关系，我们可以重新安排。');
      const changedInterest = /不想|没兴趣|换|别的|其他|厌|不喜欢/u.test(reason);
      const tired = /累|困|疲|精力|不舒服|休息/u.test(reason);
      advice = changedInterest ? '先暂停这条计划，保留已有记录。你可以收藏它，或切换到新的兴趣。' : tired ? '先休息。下次你愿意且有精力时，从 3—5 分钟的小行动开始。' : '下次先缩成约一半时长，只做一个 3—5 分钟的小行动；也可以选择休息。';
      if (changedInterest) response += ' 兴趣可以变化，进度会留着。';
      else if (tired) response += ' 那今天先好好休息。';
    }
    if (reason && completion !== 'skipped') response += ' 你补充的原因也会一起留在反馈里。';
    if (available) advice += ' 你说的下次空闲是“' + available + '”，重新排程时再检查是否有冲突。';
    const summary = (completion === 'done' ? '完成' : completion === 'partial' ? '部分完成' : '暂未开始') + ' · ' + taskTitle + (minutes > 0 ? ' · ' + minutes + ' 分钟' : '') + (reason ? ' · ' + reason : '');
    return {
      source: SOURCE, response, emotion, summary,
      nextAdjustment: {durationScale, difficulty, advice},
      trace: [
        {agent: 'Agent 4', action: '记录你的文字反馈', detail: summary},
        {agent: 'Agent 4', action: '提出下一次调整', detail: advice},
        {agent: 'Agent 2 / Agent 3', action: '等待你选择下一步', detail: '调整建议尚未自动改写日程；继续时需要你确认时间与方向。'}
      ]
    };
  }

  global.SparkEngine = Object.freeze({classifyIdea, planLearning, exploreIdea, reflect, source: SOURCE, version: '1.0.0'});
})(typeof window !== 'undefined' ? window : globalThis);
