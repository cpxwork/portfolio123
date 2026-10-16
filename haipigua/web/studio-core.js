(function (global) {
  'use strict';
  const KEY = 'little-spark.v1';
  const uid = () => global.crypto?.randomUUID?.() || 'hp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  function clock(at = new Date()) {
    const date = new Date(+at + 8 * 3600000);
    return {today: date.toISOString().slice(0, 10), clockMinutes: date.getUTCHours() * 60 + date.getUTCMinutes(), now: at.toISOString()};
  }
  const minute = value => /^\d{2}:\d{2}$/.test(value || '') && +value.slice(0, 2) < 24 && +value.slice(3) < 60 ? +value.slice(0, 2) * 60 + +value.slice(3) : NaN;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  function validate(data) {
    if (!data || data.version !== 1 || !['ideas', 'tasks', 'feedback'].every(k => Array.isArray(data[k]))) return false;
    if (data.ideas.length > 2000 || data.tasks.length > 5000 || data.feedback.length > 5000) return false;
    const str = (s, max) => typeof s === 'string' && s.length <= max;
    const strings = (list, max = 100) => list === undefined || Array.isArray(list) && list.length <= 100 && list.every(s => str(s, max));
    const links = list => list === undefined || Array.isArray(list) && list.length <= 100 && list.every(r => r && str(r.label, 300) && str(r.url, 5000));
    const timestamp = value => value === undefined || str(value, 40) && Number.isFinite(Date.parse(value));
    const facts = list => list === undefined || Array.isArray(list) && list.length <= 10 && list.every(f => f && str(f.text, 600) && str(f.evidence, 800));
    const ids = new Set(), tasks = new Map();
    for (const i of data.ideas) {
      if (!i || !str(i.id, 100) || ids.has(i.id) || !str(i.text, 8000) || !str(i.title, 200) || !['skill', 'creative', 'park'].includes(i.type)) return false;
      const r = i.exploration;
      if (r && (typeof r !== 'object' || !links(r.searchLinks) || !strings(r.questions, 2000) || r.assumptions && (!Array.isArray(r.assumptions) || r.assumptions.some(a => typeof a !== 'string' && (!a || typeof a !== 'object'))) || r.paths && (!Array.isArray(r.paths) || r.paths.some(p => !p || typeof p !== 'object')))) return false;
      if (i.aiPlan && (!Array.isArray(i.aiPlan.steps) || i.aiPlan.steps.length > 10 || i.aiPlan.steps.some(s => !s || !str(s.title, 1000) || !str(s.description, 3000)) || !links(i.aiPlan.resources))) return false;
      ids.add(i.id);
    }
    for (const t of data.tasks) {
      if (!t || !str(t.id, 100) || tasks.has(t.id) || !ids.has(t.ideaId) || !str(t.title, 1000) || !validDate(t.date) || !Number.isInteger(t.duration) || t.duration < 1 || t.duration > 480 || t.duration !== minute(t.end) - minute(t.start) || !['accepted', 'done', 'partial', 'skipped'].includes(t.status)) return false;
      if (!links(t.resources)) return false;
      tasks.set(t.id, t);
    }
    const feedbackIds = new Set();
    for (const f of data.feedback) {
      if (!f || !str(f.id, 100) || feedbackIds.has(f.id) || !tasks.has(f.taskId) || tasks.get(f.taskId).ideaId !== f.ideaId || !['done', 'partial', 'skipped'].includes(f.completion) || !Number.isFinite(Number(f.minutes)) || +f.minutes < 0 || +f.minutes > 480 || !timestamp(f.createdAt)) return false;
      feedbackIds.add(f.id);
    }
    if (data.notes && (!Array.isArray(data.notes) || data.notes.length > 2000 || data.notes.some(n => !n || !str(n.id, 100) || !str(n.text, 8000) || !str(n.reply, 16000) || !Array.isArray(n.agents) || n.agents.some(a => ![1, 2, 3, 4].includes(a))))) return false;
    if (data.notes?.some(n => !strings(n.ideaIds) || !strings(n.taskIds) || !timestamp(n.createdAt))) return false;
    if (data.notes?.some(n => n.trace && (!Array.isArray(n.trace) || n.trace.length > 100 || n.trace.some(t => !t || typeof t !== 'object')) || n.understanding && (!facts(n.understanding.facts) || !facts(n.understanding.constraints) || !strings(n.understanding.unknowns, 500)))) return false;
    if (data.availability) {
      if (typeof data.availability !== 'object' || Array.isArray(data.availability)) return false;
      for (const [date, slots] of Object.entries(data.availability)) if (!validDate(date) || !Array.isArray(slots) || slots.length > 100 || slots.some(s => !s || !Number.isFinite(minute(s.start)) || !Number.isFinite(minute(s.end)) || minute(s.end) <= minute(s.start))) return false;
    }
    if (data.studio && (typeof data.studio !== 'object' || Array.isArray(data.studio) || data.studio.facts && (!Array.isArray(data.studio.facts) || data.studio.facts.length > 100 || data.studio.facts.some(f => !f || !str(f.id, 100) || !str(f.text, 300))))) return false;
    return true;
  }
  function defaults() { return {version: 1, ideas: [], tasks: [], feedback: [], availability: {}, notes: [], chatContext: {}, createdAt: new Date().toISOString()}; }
  function normalize(state) {
    global.PocketFlow.normalize(state);
    for (const feedback of state.feedback) {
      if (!feedback.createdAt) feedback.createdAt = state.createdAt || new Date().toISOString();
      if (!feedback.media && feedback.attachment) feedback.media = {id: feedback.id, ...feedback.attachment, analysis: 'not-analyzed'};
    }
    const old = state.studio || {};
    state.studio = {
      facts: Array.isArray(old.facts) ? old.facts : [],
      preference: {duration: [5, 10, 15, 20, 30].includes(+old.preference?.duration) ? +old.preference.duration : 10, energy: ['low', 'medium', 'high'].includes(old.preference?.energy) ? old.preference.energy : 'medium', level: ['beginner', 'some', 'advanced'].includes(old.preference?.level) ? old.preference.level : 'beginner'},
      mode: ['strict', 'reward'].includes(old.mode?.name) && validDate(old.mode.date) ? old.mode : {name: 'gentle', date: clock().today, bugs: false},
      rewards: Array.isArray(old.rewards) ? old.rewards.filter(r => r && typeof r.feedbackId === 'string' && typeof r.ideaId === 'string' && validDate(r.date) && [2, 5].includes(r.points) && r.status === 'pending').slice(-5000) : [],
      dismissals: old.dismissals && typeof old.dismissals === 'object' && !Array.isArray(old.dismissals) ? old.dismissals : {}
    };
    return state;
  }
  function create(storage = global.localStorage, at = () => new Date()) {
      let state = defaults(), storageError = '', dbPromise, unreadable = false;
    const listeners = new Set();
    try { const raw = storage.getItem(KEY); if (raw) { const parsed = JSON.parse(raw); if (!validate(parsed)) throw Error(); state = parsed; } }
    catch { unreadable = true; storageError = '无法读取旧记录，暂不覆盖保存。请先导出原始备份。'; }
    normalize(state);
    const current = () => clock(at());
    const mode = () => state.studio.mode.date === current().today ? state.studio.mode.name : 'gentle';
    function save() {
      if (unreadable) return false;
      try { storage.setItem(KEY, JSON.stringify(state)); storageError = ''; } catch { storageError = '浏览器保存失败，请立即导出备份。'; }
      for (const listener of listeners) listener(state);
      return !storageError;
    }
    function submit(raw, remote = null, expectedFeedback = null) {
      const text = String(raw || '').trim(); if (!text) return null;
      if (text.length > 8000) throw Error('一次最多 8000 字，请分两次说；这一段还留在输入框里。');
      const before = new Set(state.tasks.map(t => t.id)), contracts = new Map(state.tasks.filter(t => t.contract).map(t => [t.id, t.contract])), beforeFeedback = new Set(state.feedback.map(f => f.id));
      const note = global.PocketFlow.submit(text, state, {...current(), preferences: state.studio.preference, ...(remote || {})});
      if (expectedFeedback) {
        // An empty form reason is still an explicit fact. PocketFlow's free-text
        // fallback must not replace it with the whole generated feedback sentence.
        for (const feedback of state.feedback) if (!beforeFeedback.has(feedback.id) && feedback.taskId === expectedFeedback.taskId) feedback.reason = expectedFeedback.reason;
        if (note.beforeAfter) note.beforeAfter.actual.reason = expectedFeedback.reason;
      }
      for (const task of state.tasks) if (!before.has(task.id) && task.date === current().today) task.contract = {mode: mode(), date: current().today, bugs: mode() === 'strict' && !!state.studio.mode.bugs};
      for (const task of state.tasks) if (contracts.has(task.id)) task.contract = contracts.get(task.id);
      for (const feedback of state.feedback) if (!beforeFeedback.has(feedback.id)) recordReward(feedback);
      global.PocketFlow.checkpoint(state, note.id);
      save(); return note;
    }
    function modelContext() {
      const trim = (value, max) => String(value || '').slice(0, max);
      const prefs = value => ({duration: Number(value?.duration) || 10, energy: ['low', 'medium', 'high'].includes(value?.energy) ? value.energy : 'medium', level: ['beginner', 'some', 'advanced'].includes(value?.level) ? value.level : 'beginner', ...(value?.goal ? {goal: trim(value.goal, 300)} : {})});
      const ideas = state.ideas.slice(0, 20).map(i => ({id: i.id, text: trim(i.text, 350), title: trim(i.title, 100), type: i.type, archived: !!i.archived, preferences: prefs(i.preferences)}));
      const ids = new Set(ideas.map(i => i.id));
      const tasks = state.tasks.filter(t => ids.has(t.ideaId)).slice(-20).map(t => ({id: t.id, ideaId: t.ideaId, title: trim(t.title, 120), date: t.date, start: t.start, end: t.end, duration: t.duration, status: t.status, successCriterion: trim(t.successCriterion, 300), nextStep: trim(t.nextStep, 300)}));
      const taskIds = new Set(tasks.map(t => t.id));
      return {
        ideas, tasks,
        feedback: state.feedback.filter(f => ids.has(f.ideaId) && taskIds.has(f.taskId)).slice(-10).map(f => ({ideaId: f.ideaId, taskId: f.taskId, completion: f.completion, minutes: f.minutes, feeling: f.feeling, reason: trim(f.reason, 350), summary: trim(f.summary, 350), nextAdjustment: f.nextAdjustment ? {durationScale: Number(f.nextAdjustment.durationScale) || 1, difficulty: trim(f.nextAdjustment.difficulty, 30), advice: trim(f.nextAdjustment.advice, 350), nextStep: trim(f.nextAdjustment.nextStep, 300)} : null})),
        notes: state.notes.slice(-4).map(n => ({text: trim(n.text, 800), reply: trim(n.reply, 400)})),
        availability: Object.fromEntries(Object.entries(state.availability).filter(([day]) => day >= current().today).sort(([a], [b]) => a.localeCompare(b)).slice(0, 14).map(([day, slots]) => [day, slots.slice(0, 20).map(s => ({start: s.start, end: s.end, label: trim(s.label, 100)}))])),
        chatContext: {lastIdeaId: ids.has(state.chatContext.lastIdeaId) ? state.chatContext.lastIdeaId : null, lastTaskId: taskIds.has(state.chatContext.lastTaskId) ? state.chatContext.lastTaskId : null, ...(state.chatContext.pending ? {pending: {kind: trim(state.chatContext.pending.kind, 30), field: trim(state.chatContext.pending.field, 30), question: trim(state.chatContext.pending.question, 300), ...(state.chatContext.pending.intent ? {intent: {kind: trim(state.chatContext.pending.intent.kind, 30), ideaId: trim(state.chatContext.pending.intent.ideaId, 100), taskId: trim(state.chatContext.pending.intent.taskId, 100), data: Object.fromEntries(['date', 'start', 'end', 'duration', 'replaceTaskId'].filter(k => state.chatContext.pending.intent.data?.[k] !== undefined).map(k => [k, state.chatContext.pending.intent.data[k]]))}} : {})}} : {})},
        confirmedFacts: state.studio.facts.slice(-15).map(f => ({id: f.id, text: trim(f.text, 300), source: 'user-confirmed'})),
        studio: {preference: {duration: Number(state.studio.preference.duration) || 10, energy: state.studio.preference.energy, level: state.studio.preference.level}}
      };
    }
    async function submitModel(raw, request, focusTaskId = null, options = {}) {
      const text = String(raw || '').trim(); if (!text) return null;
      if (text.length > 8000) throw Error('一次最多 8000 字，请分两次说。');
      let expected = null;
      if (options.expectedFeedback !== undefined) {
        const value = options.expectedFeedback;
        if (!focusTaskId || !value || !['done', 'partial', 'skipped'].includes(value.completion) || !['right', 'hard', 'easy'].includes(value.feeling) || !Number.isInteger(Number(value.minutes)) || Number(value.minutes) < 0 || Number(value.minutes) > 480 || typeof value.reason !== 'string' || value.reason.length > 2000 || value.completion === 'skipped' && Number(value.minutes) !== 0) throw Error('反馈表单信息不完整，请检查后再发送。');
        expected = {taskId: focusTaskId, completion: value.completion, minutes: Number(value.minutes), feeling: value.feeling, reason: value.reason.trim()};
      }
      const before = JSON.stringify(state), sentAt = current();
      const context = modelContext();
      if (focusTaskId) {
        const task = state.tasks.find(t => t.id === focusTaskId && t.status === 'accepted');
        if (!task) throw Error('这次行动已经反馈过，请重新选择。');
        context.chatContext = {lastIdeaId: task.ideaId, lastTaskId: task.id};
      }
      const response = await request({text, ...sentAt, requestId: uid(), mode: mode(), context, ...(expected ? {reportedFeedback: {...expected}} : {})});
      if (JSON.stringify(state) !== before) throw Error('等待期间记录发生了变化，这次回复尚未写入。请检查后重试。');
      if (response?.source !== 'model' || !response.analysis || !Array.isArray(response.trace) || !response.trace.some(t => t.kind === 'model' && ['ok', 'success'].includes(t.status))) throw Error('服务没有返回可验证的模型结果，记录尚未改动。');
      if (focusTaskId && response.analysis.intents.some(i => i.kind === 'feedback' && i.taskId !== focusTaskId)) throw Error('反馈关联的行动不一致，尚未写入。请再确认一次。');
      if (focusTaskId && !response.analysis.intents.some(i => i.kind === 'feedback' && i.taskId === focusTaskId && i.data?.canApply !== false)) throw Error(response.analysis.clarification?.question || '模型尚未确认这次反馈，文字和记录都保留着，请再说明具体情况。');
      if (expected) {
        const feedbacks = response.analysis.intents.filter(i => i.kind === 'feedback' && i.data?.canApply !== false);
        if (feedbacks.length !== 1 || feedbacks.some(i => i.data.completion !== expected.completion || i.data.minutes !== expected.minutes || i.data.feeling !== expected.feeling || (i.data.reason ?? '') !== expected.reason)) throw Error('模型改动了你填写的完成情况、时长、感受或原因。这次反馈尚未保存，原表单仍在，请检查后重试。');
      }
      return submit(text, {...response, now: sentAt.now}, expected);
    }
    function undo(id) {
      if (!global.PocketFlow.undo(state, id)) return false;
      state.studio.rewards = state.studio.rewards.filter(r => state.feedback.some(f => f.id === r.feedbackId));
      save(); return true;
    }
    function feedback(input) {
      const task = state.tasks.find(t => t.id === input.taskId && t.status === 'accepted');
      if (!task) throw Error('这次行动已经反馈过，或尚未创建。');
      if (!['done', 'partial', 'skipped'].includes(input.completion) || !['right', 'hard', 'easy'].includes(input.feeling)) throw Error('请选择完成情况和感受。');
      const minutes = input.completion === 'skipped' ? 0 : Number(input.minutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) throw Error('实际时长请填写 0—480 的整数。');
      const reason = String(input.reason || '').trim().slice(0, 2000);
      const result = global.SparkEngine.reflect({task, completion: input.completion, feeling: input.feeling, minutes, reason});
      const item = {id: uid(), taskId: task.id, ideaId: task.ideaId, taskTitle: task.title, completion: input.completion, feeling: input.feeling, minutes, reason, createdAt: current().now, summary: result.summary, response: result.response, nextAdjustment: result.nextAdjustment, origin: 'studio', media: input.media || null};
      state.feedback.push(item); task.status = input.completion;
      recordReward(item);
      state.chatContext = {lastIdeaId: task.ideaId, lastTaskId: task.id};
      state.notes.push({id: uid(), text: '我的行动反馈：' + task.title + '；' + ({done: '完成', partial: '做了一部分', skipped: '暂时没做'}[input.completion]) + '，' + minutes + ' 分钟。' + reason, reply: result.response + '\n\n下次建议：' + result.nextAdjustment.advice, agents: [4, 1], taskIds: [task.id], ideaIds: [task.ideaId], links: [], createdAt: current().now, source: 'local-demo', feedbackId: item.id, emotion: result.emotion, changed: true});
      if (state.notes.length > 2000) state.notes.shift(); save(); return item;
    }
    function setMode(name, consent) {
      if (['strict', 'reward'].includes(name) && consent?.accepted !== true) throw Error('请先确认今天的陪伴约定。');
      state.studio.mode = {name: ['strict', 'reward'].includes(name) ? name : 'gentle', date: current().today, bugs: name === 'strict' && consent?.bugs === true, consentAt: current().now}; save();
    }
    function recordReward(feedback) {
      const task = state.tasks.find(t => t.id === feedback.taskId), day = current().today;
      if (!task?.contract || task.contract.date !== day || feedback.completion === 'skipped' || Number(feedback.minutes) < 3) return;
      const ledger = state.studio.rewards;
      // Only a demo queue. Browser state/self-reports cannot authorize financial credits.
      if (ledger.some(r => r.feedbackId === feedback.id || r.ideaId === task.ideaId && r.date === day)) return;
      const daily = ledger.filter(r => r.date === day).reduce((sum, r) => sum + r.points, 0);
      const points = feedback.completion === 'done' ? 5 : 2;
      if (daily + points > 15) return;
      ledger.push({id: uid(), feedbackId: feedback.id, ideaId: task.ideaId, taskId: task.id, date: day, points, status: 'pending', basis: 'self-report', financialValue: 0});
    }
    function overdue() {
      if (mode() !== 'strict') return [];
      const now = current();
      return state.tasks.filter(t => t.status === 'accepted' && t.contract?.mode === 'strict' && t.contract?.date === now.today && t.date === now.today && minute(t.end) <= now.clockMinutes && !(state.studio.dismissals[t.id] > +at()));
    }
    function dismiss(id, minutes = 30) { state.studio.dismissals[id] = +at() + minutes * 60000; save(); }
    function preference(value) {
      if (![5, 10, 15, 20, 30].includes(+value.duration) || !['low', 'medium', 'high'].includes(value.energy) || !['beginner', 'some', 'advanced'].includes(value.level)) throw Error('偏好格式不正确。');
      state.studio.preference = {duration: +value.duration, energy: value.energy, level: value.level}; save();
    }
    function fact(text, id) {
      text = String(text).trim(); if (!text || text.length > 300) throw Error('记忆请写 1—300 字。');
      const found = state.studio.facts.find(f => f.id === id);
      if (found) { found.text = text; found.updatedAt = current().now; }
      else { if (state.studio.facts.length >= 100) throw Error('记忆口袋装满啦，先整理一下。'); state.studio.facts.push({id: uid(), text, createdAt: current().now, source: 'user-confirmed'}); }
      save();
    }
    function forget(id) { state.studio.facts = state.studio.facts.filter(f => f.id !== id); save(); }
    function continueIdea(id) {
      if (!state.ideas.some(i => i.id === id)) return;
      state.chatContext = {lastIdeaId: id, lastTaskId: state.tasks.filter(t => t.ideaId === id && t.status === 'accepted').at(-1)?.id || null}; save();
    }
    function importData(raw) {
      if (raw.length > 12000000) throw Error('备份文件太大，请使用嗨皮瓜导出的 JSON。');
      const parsed = JSON.parse(raw); if (!validate(parsed)) throw Error('这份备份格式不正确，当前记录没有改动。');
      state = normalize(parsed); unreadable = false;
      // A backup cannot grant consent for reminders or visual effects.
      state.studio.mode = {name: 'gentle', date: current().today, bugs: false}; save();
    }
    function mediaDB() {
      if (!global.indexedDB) return Promise.reject(Error('这个浏览器不支持保存视频。'));
      if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
        const q = global.indexedDB.open('little-spark-media', 1);
        q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('files')) q.result.createObjectStore('files'); };
        q.onsuccess = () => resolve(q.result); q.onerror = () => { dbPromise = null; reject(Error('无法打开本机视频存储。')); };
      });
      return dbPromise;
    }
    async function putMedia(id, file) {
      if (!(file.size > 0 && file.size <= 25 * 1024 * 1024) || !/^video\//.test(file.type)) throw Error('请选择 25 MB 以内的视频文件。');
      const db = await mediaDB();
      await new Promise((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(file, id); tx.oncomplete = resolve; tx.onerror = () => reject(Error('视频保存失败，请检查浏览器空间。')); });
      return {id, name: file.name, type: file.type, size: file.size, analysis: 'not-analyzed'};
    }
    async function getMedia(id) {
      const db = await mediaDB();
      return new Promise((resolve, reject) => { const q = db.transaction('files').objectStore('files').get(id); q.onsuccess = () => resolve(q.result || null); q.onerror = () => reject(Error('视频读取失败。')); });
    }
    return {get state() { return state; }, get storageError() { return storageError; }, exportData() { return unreadable ? storage.getItem(KEY) : JSON.stringify(state, null, 2); }, current, mode, save, submit, submitModel, modelContext, undo, feedback, setMode, overdue, dismiss, preference, fact, forget, continueIdea, importData, putMedia, getMedia, uid, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  }
  global.HaipiguaCore = Object.freeze({create, validate, clock, minute, validDate});
})(typeof window !== 'undefined' ? window : globalThis);
