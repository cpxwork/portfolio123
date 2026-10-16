(function (global) {
  'use strict';

  // A deterministic, offline demo parser. It preserves the user's words and asks
  // about ambiguity rather than claiming a language model understood everything.
  const SOURCE = 'local-demo';
  const numeral = '零〇一二两三四五六七八九十';
  const pad = n => String(n).padStart(2, '0');
  const clean = value => String(value == null ? '' : value).trim();
  const clock = value => pad(Math.floor(value / 60)) + ':' + pad(value % 60);
  const minutes = value => /^\d{2}:\d{2}$/.test(value || '') && Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60 ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
  const clone = value => JSON.parse(JSON.stringify(value));
  const topics = [
    ['跳舞', /跳舞|舞蹈|街舞|爵士舞|芭蕾|hip.?hop/i],
    ['唱歌', /唱歌|演唱|声乐|歌唱/],
    ['画画', /画画|绘画|素描|插画|水彩|速写/],
    ['编程', /编程|写代码|python|javascript|前端|程序开发/i],
    ['英语', /英语|英文|english/i], ['日语', /日语|日文|japanese/i],
    ['韩语', /韩语|韩文/], ['法语', /法语|法文/], ['德语', /德语|德文/],
    ['校园活动', /校园|社团|音乐会|分享会|同学|展览/],
    ['网站', /网站|网页/], ['应用', /应用|app|小程序|平台/i],
    ['创作', /小说|故事|短片|视频作品|拍片/]
  ];

  function number(value) {
    if (/^\d+$/.test(value)) return Number(value);
    const digit = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9};
    if (/^[零〇一二两三四五六七八九]+$/.test(value)) return Number([...value].map(c => digit[c]).join(''));
    if (/^[一二两三四五六七八九]?十[一二两三四五六七八九]?$/.test(value)) {
      const [tens, units] = value.split('十');
      return (tens ? digit[tens] : 1) * 10 + (units ? digit[units] : 0);
    }
    return NaN;
  }

  function isDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const parts = value.split('-').map(Number), d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return d.getUTCFullYear() === parts[0] && d.getUTCMonth() + 1 === parts[1] && d.getUTCDate() === parts[2];
  }

  function addDays(date, count) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + count);
    return d.toISOString().slice(0, 10);
  }

  function current(context) {
    const d = new Date(context.now || 'invalid');
    if (!Number.isFinite(+d)) return {valid: false, date: '', minute: 0};
    const shanghai = new Date(+d + 8 * 3600000);
    return {valid: true, date: shanghai.toISOString().slice(0, 10), minute: shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()};
  }

  function dateFrom(text, now) {
    let match = text.match(/(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日|号)?/);
    if (match) {
      const date = match[1] + '-' + pad(Number(match[2])) + '-' + pad(Number(match[3]));
      return {date, explicit: true, valid: isDate(date), original: match[0]};
    }
    if (!now.valid) return {date: '', explicit: false, valid: false};
    match = text.match(/(明天|大后天|后天|今天|今晚|今早|明晚|明早|昨天)/);
    if (match) {
      const offset = {'今天': 0, '今晚': 0, '今早': 0, '明天': 1, '明晚': 1, '明早': 1, '后天': 2, '大后天': 3, '昨天': -1}[match[0]];
      return {date: addDays(now.date, offset), explicit: true, valid: true, original: match[0]};
    }
    match = text.match(/([\d零〇一二两三四五六七八九十]{1,3})月([\d零〇一二两三四五六七八九十]{1,3})(?:日|号)/);
    if (match) {
      let year = Number(now.date.slice(0, 4));
      let date = year + '-' + pad(number(match[1])) + '-' + pad(number(match[2]));
      if (isDate(date) && date < now.date) date = (year + 1) + date.slice(4);
      return {date, explicit: true, valid: isDate(date), original: match[0]};
    }
    match = text.match(/(?:下个?月)?([\d零〇一二两三四五六七八九十]{1,3})号/);
    if (match) {
      let year = Number(now.date.slice(0, 4)), month = Number(now.date.slice(5, 7));
      const day = number(match[1]), nextMonth = /^下/.test(match[0]);
      if (nextMonth || day < Number(now.date.slice(8))) month += 1;
      if (month > 12) {year += 1; month = 1;}
      const date = year + '-' + pad(month) + '-' + pad(day);
      return {date, explicit: true, valid: isDate(date), original: match[0]};
    }
    match = text.match(/(下周|下星期|本周|这周|周|星期|礼拜)([一二三四五六日天])/);
    if (match) {
      const weekday = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7}[match[2]];
      const thisWeekday = new Date(now.date + 'T00:00:00Z').getUTCDay() || 7;
      let offset = weekday - thisWeekday;
      if (/^下/.test(match[1])) offset += 7;
      else if (/^(周|星期|礼拜)$/.test(match[1]) && offset < 0) offset += 7;
      return {date: addDays(now.date, offset), explicit: true, valid: true, original: match[0]};
    }
    return {date: now.date, explicit: false, valid: true};
  }

  function timesFrom(text) {
    const result = [];
    const regex = new RegExp('(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚|明早|今早)?\\s*(\\d{1,2}[:：]\\d{1,2}|[\\d' + numeral + ']{1,3}(?:点|时)(?:半|一刻|三刻|[\\d' + numeral + ']{1,3}分?)?)', 'g');
    let match;
    while ((match = regex.exec(text))) {
      const original = match[0], period = match[1] || '', raw = match[2];
      const following = text.slice(regex.lastIndex), before = text.slice(0, match.index);
      if (/时兴|时间|时长/.test(raw + following.slice(0, 1))) continue;
      if (/^一点$/.test(raw) && (/^(?:点|想法|基础|经验|东西|力气|开心|收获|耐心)/.test(following) || /(?:学|学会|有|做|懂|练)$/.test(before))) continue;
      let hour, minute = 0;
      if (/[:：]/.test(raw)) {
        [hour, minute] = raw.split(/[:：]/).map(Number);
      } else {
        const parts = raw.split(/点|时/); hour = number(parts[0]);
        const tail = (parts[1] || '').replace(/分$/, '');
        minute = tail === '半' ? 30 : tail === '一刻' ? 15 : tail === '三刻' ? 45 : tail ? number(tail) : 0;
      }
      const rawHour = hour;
      if (/下午|傍晚|晚上|夜里|今晚|明晚/.test(period) && hour < 12) hour += 12;
      else if (/凌晨|早上|早晨|上午|今早|明早/.test(period) && hour === 12) hour = 0;
      else if (/中午/.test(period) && hour < 11) hour += 12;
      const ambiguous = !period && !/[:：]/.test(raw) && rawHour > 0 && rawHour < 12;
      const valid = Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60;
      result.push({original, index: match.index, endIndex: regex.lastIndex, rawHour, minute, period, ambiguous, valid, time: valid ? clock(hour * 60 + minute) : null});
    }
    return result;
  }

  function durationFrom(text) {
    if (/半(?:个)?小时/.test(text)) return 30;
    if (/一刻钟/.test(text)) return 15;
    const m = text.match(new RegExp('(\\d+(?:\\.\\d+)?|[' + numeral + ']{1,3})\\s*(?:个)?(小时|分钟|分(?:钟)?)(?!钟?后)'));
    if (!m) return undefined;
    const amount = /^\d/.test(m[1]) ? Number(m[1]) : number(m[1]);
    return Number.isFinite(amount) ? amount * (m[2] === '小时' ? 60 : 1) : undefined;
  }

  function preferences(text) {
    const data = {};
    if (/很累|太累|有点累|累了|好累|没(?:有)?精力|没力气|疲惫|困了|想休息|精力低|有点困/.test(text)) data.energy = 'low';
    else if (/精力(?:很|比较)?充沛|很有精力|精神(?:很|特别)?好|电量满|状态很好/.test(text)) data.energy = 'high';
    else if (/精力一般|状态一般|还行|不累/.test(text)) data.energy = 'medium';
    if (/零基础|小白|没(?:有)?基础|完全不会|刚入门|初学/.test(text)) data.level = 'beginner';
    else if (/进阶|深入|专业|熟练|很熟悉/.test(text)) data.level = 'advanced';
    else if (/有(?:一些|一点|点|一定)?基础|以前学过|学过一点|会一点/.test(text)) data.level = 'some';
    const duration = durationFrom(text);
    if (duration !== undefined) data.duration = duration;
    const goal = text.match(/(?:目标(?:是|想要)?|希望(?:能|可以)?|想(?:练|学)到)([^，,。；;！？!?]+)/);
    if (goal) data.goal = goal[1].trim().slice(0, 160);
    if (/先暂停|暂时不想学|不想学了|换个兴趣|先不学了/.test(text)) data.pause = true;
    return data;
  }

  function ideaType(text) {
    if (/不想(?:学|练|做)|别(?:学|练|做)|先不(?:学|练|做)/.test(text)) return null;
    if (/(?:我|突然|最近|还|又)?想(?:要)?(?:学(?:习|会|点|一下)?|练(?:习|一下)?|掌握|提高|提升|入门)/.test(text)) return 'skill';
    if (/(?:我|突然|最近|还|又)?想(?:要)?(?:做|制作|设计|开发|组织|办|搞|写|拍|建立|创建|弄)/.test(text) || /有(?:一|个|一个)?(?:创意|点子|想法)/.test(text)) return 'creative';
    if (/想/.test(text) && topics.slice(0, 9).some(([, match]) => match.test(text))) return 'skill';
    return null;
  }

  function ideaTitle(text, type) {
    let title = text.replace(/^(?:那|然后|还有|嗯|我|突然|最近|又|还|现在|有点|打算|希望|想要|想)+[，,\s]*/u, '');
    const stop = title.search(/(?:今天|明天|后天|下周|今晚|上午|下午|晚上|中午|凌晨|\d{1,2}[:：]|[\d零〇一二两三四五六七八九十]{1,3}点|希望|目标|因为|但(?:是)?|然后|要不)/);
    if (stop > 0) title = title.slice(0, stop);
    title = title.replace(/(?:吧|呢|啊|呀|，|,)$/u, '').trim();
    return title.length > 1 ? title.slice(0, 80) : type === 'skill' ? '想学的新技能' : '一个新创意';
  }

  function matchIdeas(text, context) {
    const ideas = (context.ideas || []).filter(i => i && !i.archived);
    const hits = ideas.map(idea => {
      const haystack = clean(idea.title) + ' ' + clean(idea.text);
      let score = 0;
      const title = clean(idea.title).replace(/^(?:想|学|练|做|试|学习|练习|一小段|一点|一个|一次|一场)+/, '');
      if (title.length > 1 && text.includes(title)) score = 100 + title.length;
      for (const [, match] of topics) if (match.test(text) && match.test(haystack)) score += 20;
      return {idea, score};
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    if (hits.length) {
      const best = hits.filter(item => item.score === hits[0].score).map(item => item.idea);
      return {selected: best.length === 1 ? best[0] : null, candidates: best, explicit: true};
    }
    const subject = text.match(/(?:学习|练习|学|练)([^，,。；;！？!?]*)/);
    if (subject) {
      const remainder = subject[1].replace(/^(?:了|完|好|一小段|一会儿|一下|一点点|一点|点)/, '').replace(/[吧啊呀呢啦]$/u, '').replace(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]+)(?:个)?(?:分钟|小时|分)/g, '').replace(/(?:今天|明天|后天|上午|下午|晚上|中午|凌晨).*$/, '').trim();
      if (remainder && !/^(?:习|得|到|过|着|完|了|好|一会|一会儿|下|一下)$/.test(remainder)) return {selected: null, candidates: [], explicit: true};
    }
    const last = ideas.find(i => i.id === context.lastIdeaId);
    if (last) return {selected: last, candidates: [last], explicit: false};
    return {selected: ideas.length === 1 ? ideas[0] : null, candidates: ideas, explicit: false};
  }

  function taskTarget(text, context, ideaId) {
    let tasks = (context.tasks || []).filter(t => t && t.status === 'accepted');
    const explicit = matchIdeas(text, {...context, lastIdeaId: undefined});
    if (explicit.explicit && explicit.selected) tasks = tasks.filter(t => t.ideaId === explicit.selected.id);
    else if (explicit.explicit && !explicit.selected) tasks = tasks.filter(t => explicit.candidates.some(i => i.id === t.ideaId));
    else if (ideaId) tasks = tasks.filter(t => t.ideaId === ideaId);
    const last = tasks.find(t => t.id === context.lastTaskId);
    return {selected: last || (tasks.length === 1 ? tasks[0] : null), candidates: tasks};
  }

  function isFutureTask(task, now) {
    return !!(task && task.status === 'accepted' && now.valid && isDate(task.date) && minutes(task.start) !== null && (task.date > now.date || task.date === now.date && minutes(task.start) > now.minute));
  }

  function clarification(intent, field, question, extra) {
    return {field, question, intentIndex: intent.index, pending: {intent: clone(intent), field, question, ...(extra || {})}};
  }

  function validateIntent(intent, context, now, allIntents) {
    const data = intent.data;
    data.canApply = true;
    const ask = (field, question, extra) => {data.canApply = false; intent.confidence = Math.min(intent.confidence, 0.55); return clarification(intent, field, question, extra);};
    if (['schedule', 'preference'].includes(intent.kind) && !intent.ideaId && !intent.newIdeaKey) {
      const target = matchIdeas(intent.original, context);
      if (target.selected) intent.ideaId = target.selected.id;
      else return ask('ideaId', target.candidates.length ? '这句话是接着哪一个想法说的？告诉我名字就好。' : '这是准备学什么或尝试哪个点子呢？');
    }
    if (intent.kind === 'feedback' && !intent.taskId) {
      const target = taskTarget(intent.original, context, intent.ideaId);
      if (target.selected) {intent.taskId = target.selected.id; intent.ideaId = target.selected.ideaId;}
      else return ask('taskId', target.candidates.length ? '你说的是哪一次小行动？告诉我兴趣名字或日期就好。' : '这段反馈对应哪件事呢？我还没找到可以对应的小行动。');
    }
    if (intent.kind !== 'schedule' && intent.kind !== 'busy') return null;
    if (!isDate(data.date)) return ask('date', '这个日期我还没认清，你想安排在哪一天？');
    if (!data.start) return ask('start', intent.kind === 'busy' ? '这段没空是从几点开始呢？' : '你想几点开始？比如“明天下午两点”。');
    if (data.invalidTime) return ask('start', '这个时间不太对，告诉我一个 0 到 23 点之间的开始时间吧。');
    if (data.timeAmbiguous) return ask('timePeriod', '你说的“' + (data.rawTime || data.start) + '”是上午还是下午／晚上？', {rawHour: data.rawHour});
    if (intent.kind === 'busy' && !data.end) return ask('end', '我收到了开始时间，没空到几点结束呢？');
    if (data.endAmbiguous) return ask('end', '这段时间的结束是几点呢？请加上上午、下午或晚上。');
    if (data.crossesMidnight || data.end && minutes(data.end) <= minutes(data.start)) return ask('end', '这段安排好像跨夜了。先告诉我当天几点结束，再分开记下一天好吗？');
    if (intent.kind === 'schedule') {
      if (data.replaceTaskId && !isFutureTask((context.tasks || []).find(task => task.id === data.replaceTaskId), now)) {
        delete data.replaceTaskId;
        data.notice = '之前那一步已经开始或结束，这次会记成新的安排，原来的进展继续保留。';
      }
      if (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 480) return ask('duration', '这次想留几分钟？可以说“学十分钟”。');
      const start = minutes(data.start);
      if (data.date < now.date || data.date === now.date && start <= now.minute) {
        if (data.dateExplicit) return ask('date', '你说的时间已经过去了，想改成明天还是另一个日期？');
        data.date = addDays(now.date, 1); data.rolledToTomorrow = true;
        data.notice = '今天 ' + data.start + ' 已经过去，我先按明天（' + data.date + '）' + data.start + ' 记下；你也可以直接说要改到哪天。';
      }
      const end = data.end ? minutes(data.end) : start + data.duration;
      if (end === null || end >= 1440) return ask('start', '这次会跨到第二天，想换个开始时间，还是缩短一点？');
      if (data.end && end - start < data.duration) {data.duration = end - start; data.notice = (data.notice ? data.notice + ' ' : '') + '按这段空闲，先留 ' + data.duration + ' 分钟。';}
      data.end = clock(start + data.duration);
      const occupied = [
        ...(context.tasks || []).filter(t => t.status === 'accepted' && t.id !== data.replaceTaskId && t.date === data.date).map(t => ({start: t.start, end: t.end, label: t.title || '已有小行动'})),
        ...((context.availability || {})[data.date] || []),
        ...(allIntents || []).filter(other => other.kind === 'busy' && other.data.date === data.date && other.data.start && other.data.end && !other.data.timeAmbiguous).map(other => other.data)
      ];
      const conflict = occupied.find(slot => minutes(slot.start) !== null && minutes(slot.end) !== null && minutes(slot.start) < minutes(data.end) && minutes(slot.end) > start);
      if (conflict) return ask('start', data.start + ' 和“' + clean(conflict.label || '已记录的忙碌时段') + '”重叠了，想改到几点？');
    }
    return null;
  }

  function pendingReply(text, context, now) {
    const pending = context.pending;
    if (!pending || !pending.intent || !pending.field) return null;
    const intent = clone(pending.intent), data = intent.data || (intent.data = {});
    intent.original = clean(intent.original) + '；补充：' + text;
    intent.source = SOURCE;
    intent.confidence = 0.9;
    if (pending.field === 'ideaId') {
      const matches = matchIdeas(text, {...context, lastIdeaId: undefined});
      if (matches.explicit && matches.selected) intent.ideaId = matches.selected.id;
      else if (ideaType(text)) return null; // A new explicit idea is a new ramble, never forced into the old question.
      else return {intent, unresolved: true};
    } else if (pending.field === 'taskId') {
      let target = taskTarget(text, {...context, lastTaskId: undefined, lastIdeaId: undefined});
      const date = dateFrom(text, now);
      if (date.explicit) {
        const candidates = target.candidates.filter(t => t.date === date.date);
        target = {selected: candidates.length === 1 ? candidates[0] : null, candidates};
      }
      if (target.selected) {intent.taskId = target.selected.id; intent.ideaId = target.selected.ideaId;}
      else return {intent, unresolved: true};
    } else if (pending.field === 'timePeriod') {
      const period = text.match(/凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里/);
      const explicitTime = timesFrom(text)[0];
      if (explicitTime) {
        Object.assign(data, {start: explicitTime.time, rawHour: explicitTime.rawHour, rawMinute: explicitTime.minute, rawTime: explicitTime.original, timeAmbiguous: explicitTime.ambiguous, invalidTime: !explicitTime.valid, end: intent.kind === 'schedule' ? undefined : data.end});
      } else if (period) {
        let hour = Number(data.rawHour);
        if (/下午|傍晚|晚上|夜里/.test(period[0]) && hour < 12) hour += 12;
        if (/凌晨|早上|早晨|上午/.test(period[0]) && hour === 12) hour = 0;
        data.start = clock(hour * 60 + Number(data.rawMinute || 0));
        data.timeAmbiguous = false; data.invalidTime = false;
        if (data.endAmbiguous && data.end) {
          let end = minutes(data.end), start = minutes(data.start);
          if (end <= start && end + 720 > start && end + 720 < 1440) end += 720;
          if (end > start && end - start <= 720) {data.end = clock(end); data.endAmbiguous = false;}
        }
      } else return {intent, unresolved: true};
    } else if (pending.field === 'date') {
      const parsed = dateFrom(text, now);
      if (!parsed.explicit || !parsed.valid) return {intent, unresolved: true};
      data.date = parsed.date; data.dateExplicit = true; data.rolledToTomorrow = false; data.notice = undefined;
      const time = timesFrom(text)[0];
      if (time) Object.assign(data, {start: time.time, timeAmbiguous: time.ambiguous, rawHour: time.rawHour, rawMinute: time.minute, rawTime: time.original, invalidTime: !time.valid, end: undefined});
    } else if (pending.field === 'start' || pending.field === 'end') {
      const parsed = timesFrom(text)[0];
      if (!parsed) return {intent, unresolved: true};
      if (pending.field === 'start') Object.assign(data, {start: parsed.time, rawHour: parsed.rawHour, rawMinute: parsed.minute, rawTime: parsed.original, timeAmbiguous: parsed.ambiguous, invalidTime: !parsed.valid, end: intent.kind === 'schedule' ? undefined : data.end});
      else Object.assign(data, {end: parsed.time, endAmbiguous: parsed.ambiguous, crossesMidnight: false});
      const date = dateFrom(text, now);
      if (date.explicit) {data.date = date.date; data.dateExplicit = true;}
    } else if (pending.field === 'duration') {
      const duration = durationFrom(text);
      if (duration === undefined) return {intent, unresolved: true};
      data.duration = duration;
    } else return null;
    Object.assign(data, preferences(text));
    return {intent, unresolved: false};
  }

  function analyze(rawText, rawContext) {
    const text = clean(rawText).slice(0, 8000), context = rawContext || {}, now = current(context);
    const result = {source: SOURCE, version: '1.0.0', text, intents: [], clarification: null, notes: [], contextUpdates: {}};
    if (!text) return result;
    const reply = pendingReply(text, context, now);
    if (reply) {
      const intent = reply.intent; intent.index = 0;
      result.intents.push(intent);
      result.clarification = validateIntent(intent, context, now, [intent]);
      if (reply.unresolved) {
        intent.data.canApply = false;
        result.clarification = clarification(intent, context.pending.field, context.pending.question || '再告诉我具体一点好吗？');
      }
      if (intent.ideaId) result.contextUpdates.lastIdeaId = intent.ideaId;
      if (intent.taskId) result.contextUpdates.lastTaskId = intent.taskId;
      if (intent.data.notice) result.notes.push(intent.data.notice);
      return result;
    }

    const clauses = text.split(/[，,。；;\n]+|(?=然后|还有|另外|但是|不过)/).map(clean).filter(Boolean);
    let recentNew = null, recentIdeaId = context.lastIdeaId;
    const emit = (kind, original, data, agents, target) => {
      const intent = {index: result.intents.length, kind, source: SOURCE, original, agents, confidence: 0.9, data: {canApply: true, ...data}, ...(target || {})};
      result.intents.push(intent); return intent;
    };
    for (const [clauseIndex, original] of clauses.entries()) {
      const times = timesFrom(original), date = dateFrom(original, now), prefs = preferences(original);
      const previousFeedback = result.intents.at(-1);
      const feedbackSupplement = /^(?:因为|由于|原因|临时|太难|好难|有点难|动作|学不懂|跟不上|很简单|太简单|好简单|轻松|容易|(?:难度)?刚(?:刚)?好|明天.*有空|后天.*有空|今天.*(?:累|课|会))/.test(original) || /^(?:我|其实|实际|总共|只|才|一共|就)*(?:学习|练习|尝试|学|练|试|做)(?:了|过)?[\d零〇一二两三四五六七八九十半]+(?:个)?(?:分钟|小时|分)/.test(original);
      const supplementTarget = previousFeedback?.kind === 'feedback' ? matchIdeas(original, context) : null;
      if (previousFeedback?.kind === 'feedback' && feedbackSupplement && (!supplementTarget?.explicit || supplementTarget.selected?.id === previousFeedback.ideaId)) {
        previousFeedback.original += '，' + original;
        previousFeedback.data.reason = previousFeedback.original;
        const reportedMinutes = durationFrom(original);
        if (reportedMinutes !== undefined) {
          previousFeedback.data.minutes = reportedMinutes;
          if (reportedMinutes > 0 && previousFeedback.data.completion === 'skipped') previousFeedback.data.completion = 'partial';
        }
        if (/太难|好难|有点难|困难|学不懂|跟不上|动作难/.test(original)) previousFeedback.data.feeling = 'hard';
        else if (/很简单|好简单|太简单|轻松|容易/.test(original)) previousFeedback.data.feeling = 'easy';
        else if (/(?:难度)?刚(?:刚)?好/.test(original)) previousFeedback.data.feeling = 'right';
        if (date.explicit && /有空/.test(original)) previousFeedback.data.nextAvailable = date.date;
        continue;
      }
      let busy = /上课|开会|工作|打工|没空|没(?:有)?时间|不能学|不方便|被占用|要出门|要吃饭|要睡觉|要考试|有课/.test(original) && times.length > 0;
      const partialCandidate = /只(?:学|练|做|完成|试)|一部分|一点(?:点)?(?:就|而已|没)|没(?:有)?全(?:部)?(?:做|练|学|完成)|没做完|没学完|没练完/.test(original);
      const pastAttempt = /(?:学习|练习|尝试|学|练|试|做|完成|落实)(?:完|好|过)?了|已经|刚才|刚刚|刚(?:学|练|试|做)|(?:学|练|试|做)过/.test(original);
      const prospective = /想|准备|打算|计划|先|下次|明天|后天|吧/.test(original);
      const outcome = /太难|好难|有点难|困难|学不懂|跟不上|动作难|很简单|好简单|太简单|轻松|容易/.test(original + '，' + (clauses[clauseIndex + 1] || ''));
      // A duration suggestion is not evidence of completed work. Result language
      // lets "只练五分钟，有点难" stay a reflection without requiring "了".
      const partial = /没(?:有)?全(?:部)?(?:做|练|学|完成)|没做完|没学完|没练完/.test(original) || partialCandidate && (pastAttempt || outcome && !prospective);
      const skipped = /没(?:有)?(?:做|学|练|完成|开始|落实)|还没(?:有)?(?:动|做|学|练)|今天不想学|没有行动|未完成/.test(original);
      const done = /(?:做|学|练|试|尝试|练习|学习|完成|落实)(?:完|好)?了|搞定|完成啦|完成了|做完啦/.test(original);
      const feedback = partial || skipped || done;
      if (feedback && times.length < 2) busy = false;
      let type = !feedback && !busy ? ideaType(original) : null;
      // "我想十二点学" is a timing continuation, not a nameless new interest.
      if (type && /^(?:那|我|就|想|要不|然后|还有|还是|再|先|明天|今天|后天|上午|下午|晚上|中午|凌晨|早上|[\d零〇一二两三四五六七八九十]+点|[:：\d]|学|练|做|学习|练习|吧|啊|呀|呢|\s)+$/.test(original)) type = null;
      const durationOnly = new RegExp('^(?:那|就|我|想|要|准备|打算|计划|先|只|再|今天|明天|后天|学习|练习|尝试|学|练|试|做|一下|一点|个|\\s)*(?:\\d+(?:\\.\\d+)?|[' + numeral + ']{1,3}|半)(?:个)?(?:分钟|小时|分)(?:吧|啊|呀|呢|就好|即可|就行|\\s)*$');
      if (type && durationOnly.test(original)) type = null;
      let target = recentNew ? {newIdeaKey: recentNew} : recentIdeaId ? {ideaId: recentIdeaId} : {};
      const explicit = matchIdeas(original, {...context, lastIdeaId: recentIdeaId});
      if (explicit.explicit && explicit.selected) target = {ideaId: explicit.selected.id};
      else if (explicit.explicit && !explicit.selected) target = {};
      if (type) {
        const existing = explicit.explicit && explicit.selected && /继续|接着|之前|上次|原来/.test(original);
        if (existing) target = {ideaId: explicit.selected.id};
        else {
          const newIdeaKey = 'new-' + result.intents.filter(i => i.kind === 'idea').length;
          const title = ideaTitle(original, type);
          emit('idea', original, {type, title, text: original, ...prefs}, ['Agent 1', type === 'skill' ? 'Agent 2' : 'Agent 3'], {newIdeaKey});
          recentNew = newIdeaKey; recentIdeaId = undefined; target = {newIdeaKey};
        }
      }
      if (busy) {
        const start = times[0], end = times[1];
        let endTime = end && end.time, endAmbiguous = !!(end && end.ambiguous);
        if (end && start.valid && end.valid && !start.ambiguous && end.ambiguous) {
          let endMinute = minutes(end.time), startMinute = minutes(start.time);
          if (endMinute <= startMinute && endMinute + 720 > startMinute && endMinute + 720 < 1440) endMinute += 720;
          if (endMinute > startMinute && endMinute - startMinute <= 720) {endTime = clock(endMinute); endAmbiguous = false;}
        }
        if (!end && start.valid && Number.isInteger(prefs.duration) && prefs.duration > 0 && minutes(start.time) + prefs.duration < 1440) endTime = clock(minutes(start.time) + prefs.duration);
        emit('busy', original, {date: date.date, dateExplicit: date.explicit, start: start.time, end: endTime, rawHour: start.rawHour, rawMinute: start.minute, rawTime: start.original, timeAmbiguous: start.ambiguous, endAmbiguous, invalidTime: !start.valid, label: original.replace(/^(?:今天|明天|后天)/, '').slice(0, 80)}, ['Agent 2']);
      }
      if (feedback) {
        const matchedTask = taskTarget(original, context, target.ideaId);
        let completion = partial ? 'partial' : skipped ? 'skipped' : 'done';
        const task = matchedTask.selected;
        const feeling = /太难|好难|有点难|困难|学不懂|跟不上|动作难/.test(original) ? 'hard' : /很简单|好简单|太简单|轻松|容易/.test(original) ? 'easy' : 'right';
        let spent = completion === 'skipped' ? 0 : durationFrom(original);
        if (completion === 'done' && spent !== undefined && task && spent < Number(task.duration) && !/做完|学完|练完|完成|搞定/.test(original)) completion = 'partial';
        if (spent === undefined && completion === 'done' && task) spent = Number(task.duration) || 10;
        const reasonMatch = original.match(/(?:因为|由于|原因是|临时)(.+)/);
        emit('feedback', original, {completion, minutes: spent, feeling, reason: reasonMatch ? reasonMatch[0] : original, nextAvailable: /(?:明天|后天|下周).*(?:有空|再|下次)/.test(original) ? date.date : undefined}, ['Agent 4'], task ? {taskId: task.id, ideaId: task.ideaId} : {ideaId: target.ideaId});
      }
      const timing = !busy && !feedback && (times.length > 0 || date.explicit && /(?:学|练|做|试|安排|改到|有空)/.test(original)) && (!!type || !!target.ideaId || !!target.newIdeaKey || /学|练|做|试|安排|改到|要不|就/.test(original));
      if (timing) {
        const start = times[0], end = times[1];
        let endTime = end && end.time, endAmbiguous = !!(end && end.ambiguous);
        if (start && end && start.valid && !start.ambiguous && end.valid && end.ambiguous) {
          let n = minutes(end.time), s = minutes(start.time);
          if (n <= s && n + 720 > s && n + 720 < 1440) n += 720;
          if (n > s && n - s <= 720) {endTime = clock(n); endAmbiguous = false;}
        }
        const defaultDuration = Number(context.defaultPreferences?.duration) || 10;
        const duration = prefs.duration === undefined ? (start && endTime && !endAmbiguous && minutes(endTime) > minutes(start.time) ? Math.min(defaultDuration, minutes(endTime) - minutes(start.time)) : defaultDuration) : prefs.duration;
        const nextSession = /下次|再安排|另一次|另一(?:次|场)|再(?:学|练|试|做)(?:一|1)?次|再来一次|新的一次/.test(original);
        const reschedule = !nextSession && (/改到|改成|挪到|移到|换到/.test(original) || /^(?:那(?:就|要不)|要不|还是)/.test(original));
        const candidate = reschedule && !target.newIdeaKey ? taskTarget(original, context, target.ideaId).selected : null;
        const currentTask = isFutureTask(candidate, now) ? candidate : null;
        emit('schedule', original, {date: date.explicit ? date.date : (currentTask ? currentTask.date : date.date), dateExplicit: date.explicit, start: start && start.time, end: endTime, duration, ...prefs, timeExplicit: !!start, rawHour: start && start.rawHour, rawMinute: start && start.minute, rawTime: start && start.original, timeAmbiguous: !!(start && start.ambiguous), endAmbiguous, invalidTime: !!(start && !start.valid), replaceTaskId: currentTask && currentTask.id}, ['Agent 2'], target);
      } else if (Object.keys(prefs).length && !feedback) emit('preference', original, prefs, ['Agent 2'], target);
      if (!type && !busy && !feedback && !timing && !Object.keys(prefs).length) emit('note', original, {text: original}, ['Agent 1']);
    }

    // Later clauses such as "零基础，有点累" belong to the same conversation,
    // so the proposed schedule gets them before any caller applies the intents.
    for (const intent of result.intents.filter(i => i.kind === 'schedule')) {
      const sameTarget = other => intent.ideaId ? other.ideaId === intent.ideaId : intent.newIdeaKey ? other.newIdeaKey === intent.newIdeaKey : false;
      const related = result.intents.filter(i => ['idea', 'preference'].includes(i.kind) && sameTarget(i));
      for (const other of related) for (const key of ['energy', 'level', 'goal', 'duration']) if (other.data[key] !== undefined) intent.data[key] = other.data[key];
    }
    for (const intent of result.intents) {
      const question = validateIntent(intent, context, now, result.intents);
      if (question && !result.clarification) result.clarification = question;
      if (intent.data.notice) result.notes.push(intent.data.notice);
      if (intent.ideaId) result.contextUpdates.lastIdeaId = intent.ideaId;
      if (intent.newIdeaKey) result.contextUpdates.newIdeaKey = intent.newIdeaKey;
      if (intent.taskId) result.contextUpdates.lastTaskId = intent.taskId;
    }
    return result;
  }

  global.RambleRouter = Object.freeze({analyze, source: SOURCE, version: '1.0.0'});
})(typeof window !== 'undefined' ? window : globalThis);
