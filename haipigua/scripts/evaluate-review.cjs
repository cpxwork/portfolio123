#!/usr/bin/env node
'use strict';
// Real review-loop evaluation with synthetic data only. Requires the local
// server at 8878 to be explicitly configured with a provider and model.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, '.local', 'review-evaluation.json');
const ENDPOINT = 'http://127.0.0.1:8878/api/agent';
const ORIGIN = 'http://127.0.0.1:8877';
const copy = value => JSON.parse(JSON.stringify(value));
const report = {synthetic: true, startedAt: new Date().toISOString(), endpoint: ENDPOINT, cases: []};
function persist() { fs.mkdirSync(path.dirname(OUTPUT), {recursive: true}); fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
function memoryApp() {
  const values = new Map(), context = {Date, Intl, console, crypto: {randomUUID: () => crypto.randomUUID()}};
  context.window = context; vm.createContext(context);
  for (const file of ['engine.js', 'ramble.js', 'pocket.js', 'studio-core.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', file), 'utf8'), context, {filename: file});
  return context.HaipiguaCore.create({getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)}, () => new Date());
}
async function request(payload) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110000);
  try {
    const response = await fetch(ENDPOINT, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN}, body: JSON.stringify(payload), signal: controller.signal});
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { throw Error('HTTP ' + response.status + ' returned invalid JSON'); }
    if (!response.ok) throw Error('HTTP ' + response.status + ' ' + String(body.error?.code || 'REQUEST_FAILED'));
    return body;
  } finally { clearTimeout(timer); }
}
async function run(name, text, prepare, inspect, form = null) {
  const entry = {case: name, input: text, success: false, checks: {}, request: null, response: null};
  const app = memoryApp();
  const started = Date.now();
  try {
    const prepared = prepare(app);
    const taskId = form ? form.taskId || prepared?.taskId : null;
    const options = form ? {expectedFeedback: form.feedback} : {};
    const note = await app.submitModel(text, async payload => { entry.request = copy(payload); entry.response = await request(payload); return entry.response; }, taskId, options);
    entry.modelCalls = Array.isArray(entry.response.trace) ? entry.response.trace.filter(t => t.kind === 'model').length : 0;
    entry.provider = entry.response.usage?.provider;
    entry.model = entry.response.usage?.model;
    entry.estimatedCostCny = entry.response.usage?.estimatedCostCny;
    entry.checks = inspect(app, note, entry.response);
    entry.success = Object.values(entry.checks).every(value => value === true);
    entry.note = copy(note);
    entry.state = JSON.parse(app.exportData());
  } catch (error) {
    entry.error = String(error.message || 'request failed').slice(0, 600);
    entry.stateUnchanged = true;
  }
  entry.elapsedMs = Date.now() - started;
  report.cases.push(entry); persist();
  console.log(JSON.stringify({case: name, success: entry.success, checks: entry.checks, error: entry.error, modelCalls: entry.modelCalls, provider: entry.provider, model: entry.model, estimatedCostCny: entry.estimatedCostCny}));
  return entry;
}
async function main() {
  await run('unbooked-review-handoff',
    '今天练了排线，画了两张，线条还是抖，帮我看看下一步。',
    app => { app.submit('我想学画画'); app.continueIdea(app.state.ideas[0].id); },
    (app, note, response) => ({
      realModel: note.source === 'model',
      reviewSaved: app.state.reviews.length === 1,
      reviewHasEvidence: (app.state.reviews[0]?.problems || []).length > 0,
      sameTurnHandoff: response.trace.some(t => t.agent === 'Agent 4' && t.action === 'handoff_review') && ['Agent 2', 'Agent 3'].some(agent => response.trace.some(t => t.agent === agent && t.kind === 'model' && t.status === 'ok')),
      adviceUpdated: !!app.state.ideas[0]?.aiPlan || !!app.state.ideas[0]?.exploration,
      noAppointmentCreated: app.state.tasks.length === 0
    }));
  await run('duration-only-asks',
    '今天学了十五分钟相关的',
    app => { app.submit('我想学画画'); app.continueIdea(app.state.ideas[0].id); },
    (app, note) => ({
      realModel: note.source === 'model',
      reviewSaved: app.state.reviews.length === 1,
      asksForContent: app.state.reviews[0]?.needsEvidence === true && !!app.state.reviews[0]?.question,
      noFabricatedCompletion: app.state.feedback.length === 0 && app.state.tasks.length === 0,
      noHandoff: !app.state.ideas[0]?.aiPlan && !app.state.ideas[0]?.exploration
    }));
  await run('form-easy-text-hard',
    '关于“画排线”（今天 11:00）的行动反馈：完成了，实际10分钟，难度挺轻松。排线好难',
    app => { app.submit('我想学画画，今天上午十一点练十分钟'); return {taskId: app.state.tasks[0]?.id}; },
    (app, note, response) => {
      const review = app.state.reviews[0], task = app.state.tasks[0];
      return {
        realModel: note.source === 'model',
        reviewSaved: !!review,
        keptOverallEasy: (review?.progress || []).some(item => /轻松|完成/.test(item.point + item.evidence)),
        keptTextDifficulty: (review?.problems || []).some(item => /排线/.test(item.point + item.evidence)),
        sameTurnHandoff: response.trace.some(t => t.agent === 'Agent 4' && t.action === 'handoff_review') && ['Agent 2', 'Agent 3'].some(agent => response.trace.some(t => t.agent === agent && t.kind === 'model' && t.status === 'ok')),
        noNewAppointment: app.state.tasks.length === 1 && task.date === app.current().today
      };
    },
    {taskId: null, feedback: {completion: 'done', minutes: 10, feeling: 'easy', reason: '排线好难'}});
  await run('two-similar-asks-once',
    '今天学了十五分钟相关的',
    app => {
      app.submit('我想学排线练习'); app.submit('我想学排线基础');
      app.state.chatContext.lastIdeaId = null; app.save();
    },
    (app, note) => ({
      realModel: note.source === 'model',
      askedOnce: !!note.clarification,
      noMisbind: app.state.reviews.length === 0,
      noRecordChange: app.state.tasks.length === 0
    }));
  await run('no-work-no-score',
    '今天没做，什么也没写，加班到很晚',
    app => { app.submit('我想学画画'); app.continueIdea(app.state.ideas[0].id); },
    (app, note) => {
      const review = app.state.reviews[0];
      return {
        realModel: note.source === 'model',
        reviewSaved: !!review,
        noArtifact: review?.hasArtifact === false,
        noFabricatedScore: review && !('score' in review) && !('grade' in review),
        noFabricatedCompletion: app.state.feedback.length === 0 && app.state.tasks.length === 0
      };
    });
  report.finishedAt = new Date().toISOString();
  report.success = report.cases.every(item => item.success === true);
  persist();
  console.log('Synthetic results: ' + OUTPUT);
  if (!report.success) process.exitCode = 1;
}
main().catch(error => { report.finishedAt = new Date().toISOString(); report.success = false; report.fatal = String(error.message || 'evaluation failed').slice(0, 600); persist(); console.error('Evaluation stopped: ' + report.fatal); process.exitCode = 1; });
