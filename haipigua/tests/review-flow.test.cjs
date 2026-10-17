'use strict';
// Offline review-loop coverage: synthetic text, mocked provider output, and the
// real browser-side validation/renderer loaded in a VM. No network or secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHandler} = require('../server/agent.cjs');

const ORIGIN = 'http://127.0.0.1:8877';
const TODAY = '2026-10-17';
const request = body => ({method: 'POST', path: '/api/agent', headers: {origin: ORIGIN}, body});
const clean = value => JSON.parse(JSON.stringify(value));
function input(text, context, extra = {}) {
  return {text, today: TODAY, clockMinutes: 600, requestId: 'review-' + Math.random().toString(36).slice(2), context, ...extra};
}
function idea(id, title, type = 'skill', extra = {}) {
  return {id, text: title, title, type, preferences: {duration: 10, energy: 'medium', level: 'beginner'}, ...extra};
}
function serverContext(overrides = {}) {
  return {ideas: [idea('idea-1', '画画')], tasks: [], feedback: [], availability: {}, notes: [], reviews: [], chatContext: {lastIdeaId: 'idea-1'}, ...overrides};
}
function provider(outputs) {
  const calls = [];
  return {calls, fetch: async (url, options) => {
    calls.push({url, headers: options.headers, ...JSON.parse(options.body)});
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    if (typeof output === 'function') return output(options);
    return {ok: true, status: 200, text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify(output)}}], usage: {prompt_tokens: 100, completion_tokens: 50}})};
  }};
}
function reviewOutput(overrides = {}) {
  return {reviews: {'idea-1': {
    response: '你把这次经历说清楚了。',
    summary: '画了两张排线，线条还是抖。',
    progress: [{point: '实际画了两张', evidence: '画了两张'}],
    problems: [{point: '线条还是抖', evidence: '线条还是抖'}],
    missingEvidence: ['没有看到画，无法判断线条抖动的具体原因'],
    hasArtifact: false,
    needsEvidence: false,
    question: '',
    nextStep: '只画两组短线，固定方向与间距，拍下来对照。',
    durationScale: 0.8,
    difficulty: 'easier',
    emotion: 'thinking',
    advice: '先固定方向与间距，减少同时变化的东西。',
    ...overrides
  }}};
}
function planOutput(title = '两组排线对照') {
  return {plans: {'idea-1': {title, steps: [{title: '画两组短线', description: '固定方向与间距，各画一组。'}], successCriterion: '留下两张可对照的短线练习。', rationale: '回回指出线条抖，先减少变量。', nextStep: '下次只改间距再画一组。'}}};
}
const routeReview = ideaId => ({intents: [{kind: 'review', ...(ideaId ? {ideaId} : {}), data: {canApply: true}}]});

test('unbooked practice is reviewed and hands off to the planner in the same turn, without creating a task', async () => {
  const context = serverContext(), p = provider([routeReview(), reviewOutput(), planOutput()]);
  const result = await createHandler()(request(input('今天练了排线，画了两张，线条还是抖', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls[1].messages[0].content.includes('Agent 4'), true);
  assert.match(p.calls[2].messages[0].content, /Agent 2/);
  const plannerTarget = JSON.parse(p.calls[2].messages[1].content).targets[0];
  assert.equal(plannerTarget.review.problems[0].point, '线条还是抖');
  assert.equal(result.body.content.reviews['idea-1'].needsEvidence, false);
  assert.equal(result.body.content.plans['idea-1'].title, '两组排线对照');
  assert.ok(result.body.analysis.intents.some(i => i.kind === 'plan' && i.ideaId === 'idea-1'));
  assert.ok(result.body.trace.some(t => t.agent === 'Agent 4' && t.action === 'handoff_review'));
  assert.ok(result.body.trace.some(t => t.agent === 'Agent 2' && t.kind === 'model' && t.status === 'ok'));
  assert.equal(context.tasks.length, 0);
  assert.equal(context.feedback.length, 0);
});

test('fifteen minutes with no content asks once, keeps the real duration, and invents no completion or task', async () => {
  const context = serverContext(), p = provider([routeReview(), reviewOutput({
    response: '今天这十五分钟先记下了。',
    summary: '你提到今天学了十五分钟。',
    progress: [{point: '投入了十五分钟', evidence: '十五分钟'}],
    problems: [],
    missingEvidence: ['这十五分钟具体做了什么，或留下了什么产出'],
    hasArtifact: false,
    needsEvidence: true,
    question: '这十五分钟具体学了什么，或贴一小段产出？',
    nextStep: '先补一句具体内容，再决定下一步。',
    durationScale: null,
    difficulty: null
  })]);
  const result = await createHandler()(request(input('今天学了十五分钟相关的', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 2);
  const review = result.body.content.reviews['idea-1'];
  assert.equal(review.needsEvidence, true);
  assert.match(review.question, /具体|产出/);
  assert.equal(review.minutes, 15);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'feedback'), false);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'plan'), false);
  assert.deepEqual(Object.keys(result.body.content.plans), []);
  assert.equal(context.tasks.length, 0);
  assert.equal(context.feedback.length, 0);
  assert.equal(result.body.trace.some(t => t.action === 'handoff_review'), false);
});

test('answering the follow-up uses the pending interest and does not repeat the question', async () => {
  const context = serverContext({
    notes: [{text: '今天学了十五分钟相关的', reply: '这十五分钟具体学了什么？'}],
    chatContext: {lastIdeaId: 'idea-1', pending: {kind: 'review', ideaId: 'idea-1', question: '这十五分钟具体学了什么？'}}
  });
  const p = provider([routeReview(), reviewOutput(), planOutput()]);
  const result = await createHandler()(request(input('就是练排线，画了两张，线条还是抖', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(result.body.analysis.intents.find(i => i.kind === 'review').ideaId, 'idea-1');
  assert.equal(result.body.content.reviews['idea-1'].question, '');
  const reviewPayload = JSON.parse(p.calls[1].messages[1].content);
  assert.equal(reviewPayload.pending.ideaId, 'idea-1');
  assert.equal(reviewPayload.pending.question, '这十五分钟具体学了什么？');
  assert.ok(result.body.content.plans['idea-1']);
  assert.equal(p.calls.length, 3);
});

test('form overall easy plus text “排线好难” keeps both signals and hands off a targeted plan', async () => {
  const context = serverContext({
    tasks: [{id: 'task-1', ideaId: 'idea-1', title: '画排线', date: TODAY, start: '11:00', end: '11:10', duration: 10, status: 'accepted'}],
    chatContext: {lastIdeaId: 'idea-1', lastTaskId: 'task-1'}
  });
  const text = '关于“画排线”（2026-10-17 11:00）的行动反馈：完成了，实际10分钟，难度挺轻松。排线好难';
  const p = provider([reviewOutput({
    response: '总体轻松，但排线这个局部卡住了。',
    summary: '完成了10分钟，整体轻松；排线仍然难。',
    progress: [{point: '完成了10分钟，整体感觉轻松', evidence: '难度挺轻松'}],
    problems: [{point: '排线好难', evidence: '排线好难'}],
    nextStep: '只画两组间距一致的短线，拍下来对照。',
    durationScale: 0.8
  }), planOutput('两组排线对照')]);
  const result = await createHandler()(request(input(text, context, {reportedFeedback: {taskId: 'task-1', completion: 'done', minutes: 10, feeling: 'easy', reason: '排线好难'}})), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 2);
  const review = result.body.content.reviews['idea-1'];
  assert.equal(review.progress.length, 1);
  assert.equal(review.problems.length, 1);
  assert.match(review.progress[0].point, /轻松/);
  assert.match(review.problems[0].point, /排线/);
  assert.ok(result.body.content.reflections['task-1']);
  assert.ok(result.body.content.plans['idea-1']);
  assert.match(result.body.content.plans['idea-1'].rationale, /线条|排线/);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'schedule'), false);
  assert.equal(context.tasks[0].status, 'accepted');
  assert.equal(context.tasks.length, 1);
});

test('two similar interests are not silently bound; the user is asked once and old records stay unchanged', async () => {
  const context = serverContext({
    ideas: [idea('idea-1', '排线练习'), idea('idea-2', '排线基础')],
    chatContext: {lastIdeaId: null}
  });
  const before = JSON.stringify(context);
  const p = provider([routeReview()]);
  const result = await createHandler()(request(input('今天学了十五分钟相关的', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 1, 'no review model call is spent before the target is clear');
  assert.match(result.body.analysis.clarification.question, /排线练习|排线基础/);
  assert.deepEqual(Object.keys(result.body.content.reviews), []);
  assert.deepEqual(Object.keys(result.body.content.plans), []);
  assert.equal(JSON.stringify(context), before);
  assert.equal(context.tasks.length, 0);
  assert.equal(context.feedback.length, 0);
});

test('a pasted text work is evaluated with exact quotes and explicit missing evidence, not a score', async () => {
  const text = '我写了一段：“雨停在窗沿上，像谁忘了收的线。”帮我看看这段文字。';
  const context = serverContext({ideas: [idea('idea-1', '写作')], chatContext: {lastIdeaId: 'idea-1'}});
  const p = provider([routeReview(), reviewOutput({
    response: '这两句有具体的画面，但还缺上下文。',
    summary: '你贴出了一句话，意象具体，完整段落还没看到。',
    progress: [{point: '句子有可指出的具体画面', evidence: '雨停在窗沿上，像谁忘了收的线'}],
    problems: [{point: '还看不出这段文字在整篇里的作用', evidence: '帮我看看这段文字'}],
    missingEvidence: ['完整段落', '想写给谁看或想表达什么'],
    hasArtifact: true,
    needsEvidence: false,
    nextStep: '把前后各补一句，保留这句作为开头或结尾，再读一遍。',
    durationScale: null,
    difficulty: null
  }), planOutput('补出前后两句')]);
  const result = await createHandler()(request(input(text, context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  const review = result.body.content.reviews['idea-1'];
  assert.equal(review.hasArtifact, true);
  assert.equal(review.progress[0].evidence, '雨停在窗沿上，像谁忘了收的线');
  assert.ok(review.missingEvidence.length);
  assert.equal('score' in review, false);
  assert.equal('grade' in review, false);
  assert.match(review.response, /画面|上下文/);
  assert.ok(result.body.content.plans['idea-1']);
});

test('explicitly saying there is no work never fabricates a score, completion, or plan', async () => {
  const context = serverContext(), p = provider([routeReview(), reviewOutput({
    response: '今天没有作品，我不会据此猜你的水平。',
    summary: '今天没有做，也没有留下作品。',
    progress: [],
    problems: [],
    missingEvidence: ['今天没有练习或作品记录'],
    hasArtifact: false,
    needsEvidence: true,
    question: '今天是什么让你没做成？想从两分钟的小动作开始，还是先休息？',
    nextStep: '先照看一下今天的实际情况，不急着补作业。',
    durationScale: null,
    difficulty: null
  })]);
  const result = await createHandler()(request(input('今天没做，什么也没写，加班到很晚', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  const review = result.body.content.reviews['idea-1'];
  assert.equal(review.hasArtifact, false);
  assert.equal(review.needsEvidence, true);
  assert.equal(review.progress.length, 0);
  assert.equal(review.problems.length, 0);
  assert.equal('score' in review, false);
  assert.match(review.response, /不会.*(?:猜|判断|评分)/);
  assert.deepEqual(Object.keys(result.body.content.plans), []);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'feedback'), false);
  assert.equal(context.tasks.length, 0);
  assert.equal(context.feedback.length, 0);
});

test('supplementary feedback on an already-finished task becomes a review, not a second completion write', async () => {
  const context = serverContext({
    tasks: [{id: 'task-1', ideaId: 'idea-1', title: '画排线', date: TODAY, start: '11:00', end: '11:10', duration: 10, status: 'done'}],
    feedback: [{ideaId: 'idea-1', taskId: 'task-1', completion: 'done', minutes: 10, feeling: 'easy', reason: '第一次记录'}],
    chatContext: {lastIdeaId: 'idea-1', lastTaskId: 'task-1'}
  });
  const before = JSON.stringify(context.tasks);
  const p = provider([{intents: [{kind: 'feedback', taskId: 'task-1', data: {canApply: true, completion: 'done', minutes: 10, feeling: 'easy', reason: '补充'}}]}, reviewOutput({
    response: '补充的排线困难也记下了。',
    summary: '之前已完成，这次补充说排线好难。',
    progress: [{point: '之前已经完成过10分钟', evidence: '做完了'}],
    problems: [{point: '排线好难', evidence: '排线好难'}]
  }), planOutput()]);
  const result = await createHandler()(request(input('补充一下，昨天其实做完了，练了10分钟，排线好难', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'feedback'), false);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'review'), true);
  assert.equal(JSON.stringify(context.tasks), before);
  assert.equal(context.feedback.length, 1);
  assert.equal(result.body.content.reviews['idea-1'].taskId, 'task-1');
  assert.deepEqual(Object.keys(result.body.content.reflections), []);
  assert.ok(result.body.content.plans['idea-1']);
});

test('a form with only a duration asks 回回’s question, still records the task feedback, and does not hand off', async () => {
  const context = serverContext({
    tasks: [{id: 'task-1', ideaId: 'idea-1', title: '画排线', date: TODAY, start: '11:00', end: '11:10', duration: 10, status: 'accepted'}],
    chatContext: {lastIdeaId: 'idea-1', lastTaskId: 'task-1'}
  });
  const text = '关于“画排线”（2026-10-17 11:00）的行动反馈：完成了，实际10分钟，难度挺轻松。';
  const p = provider([reviewOutput({
    response: '这次先记下10分钟的投入。',
    summary: '只有时长，没有具体内容。',
    progress: [{point: '投入了10分钟', evidence: '实际10分钟'}],
    problems: [],
    missingEvidence: ['这10分钟具体画了什么，或留下的一小段产出'],
    hasArtifact: false,
    needsEvidence: true,
    question: '这10分钟具体画了什么，或贴一小段产出？',
    nextStep: '先补一句具体内容。',
    durationScale: 0.8,
    difficulty: 'easier'
  })]);
  const result = await createHandler()(request(input(text, context, {reportedFeedback: {taskId: 'task-1', completion: 'done', minutes: 10, feeling: 'easy', reason: ''}})), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 1, 'no planner call without content');
  assert.equal(result.body.content.reviews['idea-1'].needsEvidence, true);
  assert.match(result.body.content.reviews['idea-1'].question, /具体/);
  assert.ok(result.body.content.reflections['task-1'], 'the explicit form facts still produce a task reflection');
  assert.deepEqual(Object.keys(result.body.content.plans), []);
  assert.equal(context.tasks[0].status, 'accepted', 'the server never writes task completion');
});

test('a natural-language “没完成” cannot be silently saved as done by the model', async () => {
  const context = serverContext({
    tasks: [{id: 'task-1', ideaId: 'idea-1', title: '画排线', date: TODAY, start: '11:00', end: '11:10', duration: 10, status: 'accepted'}],
    chatContext: {lastIdeaId: 'idea-1', lastTaskId: 'task-1'}
  });
  const p = provider([{intents: [{kind: 'feedback', taskId: 'task-1', data: {canApply: true, completion: 'done', minutes: 10, feeling: 'easy', reason: '没完成'}}]}, reviewOutput({
    response: '你说没完成，这次先按真实情况记录，不标成完成。',
    summary: '练了10分钟，但没有完成。',
    progress: [{point: '练了10分钟', evidence: '只练了10分钟'}],
    problems: [{point: '排线好难', evidence: '排线好难'}]
  }), planOutput()]);
  const result = await createHandler()(request(input('没完成，只练了10分钟，排线好难', context)), {MODEL_API_KEY: 'x'}, p);
  assert.equal(result.status, 200);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'feedback'), false);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'review'), true);
  assert.equal(context.tasks[0].status, 'accepted');
  assert.equal(context.feedback.length, 0);
});

test('a downstream planner failure rolls back the whole turn and leaves the original context unchanged', async () => {
  const context = serverContext(), before = JSON.stringify(context);
  const p = provider([routeReview(), reviewOutput(), () => { throw Error('synthetic planner outage'); }]);
  const result = await createHandler()(request(input('今天练了排线，画了两张，线条还是抖', context)), {MODEL_API_KEY: 'x'}, p);
  assert.ok(result.status >= 500);
  assert.equal(result.body.source, undefined);
  assert.equal(result.body.content, undefined);
  assert.equal(JSON.stringify(context), before);
  assert.ok(result.body.trace.some(t => t.agent === 'Agent 4' && t.kind === 'model' && t.status === 'ok'));
  assert.ok(result.body.trace.some(t => t.agent === 'Agent 2' && t.kind === 'model' && t.status === 'error'));
});

// ---- Browser-side protocol, persistence, context, undo, and rendering ----
function browserFixture() {
  let serial = 0;
  const saved = new Map();
  const storage = {getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value)};
  const context = {console, Date, Intl, crypto: {randomUUID: () => 'review-client-' + ++serial}, localStorage: storage};
  context.window = context;
  vm.createContext(context);
  for (const name of ['engine.js', 'ramble.js', 'pocket.js', 'studio-core.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', name), 'utf8'), context, {filename: name});
  const app = context.HaipiguaCore.create(storage, () => new Date('2026-10-17T01:00:00Z'));
  app.submit('我想学画画');
  return {app, context, storage, saved};
}
function clientReview(ideaId, overrides = {}) {
  return {source: 'model', ideaId, response: '你练了排线，也看到了线条抖。', summary: '画了两张排线，线条还是抖。', progress: [{point: '画了两张', evidence: '画了两张'}], problems: [{point: '线条还是抖', evidence: '线条还是抖'}], missingEvidence: ['没有看到画'], hasArtifact: false, needsEvidence: false, question: '', nextStep: '只画两组短线。', durationScale: .8, difficulty: 'easier', emotion: 'thinking', advice: '先固定方向。', taskId: null, minutes: null, fromForm: false, ...overrides};
}
const clientPlan = () => ({title: '两组短线', steps: [{title: '画两组', description: '固定方向与间距。'}], successCriterion: '留下两张。', rationale: '回回指出线条抖。', nextStep: '下次只改间距。', resources: []});

test('the browser persists the review, applies the same-turn plan, exposes context, and undoes both atomically', async () => {
  const {app, context} = browserFixture();
  const ideaId = app.state.ideas[0].id;
  const note = await app.submitModel('今天练了排线，画了两张，线条还是抖', async () => ({
    source: 'model', trace: [{agent: 'Agent 1', kind: 'model', status: 'ok'}, {agent: 'Agent 4', kind: 'model', status: 'ok'}, {agent: 'Agent 2', kind: 'model', status: 'ok'}],
    analysis: {intents: [{kind: 'review', ideaId, agents: ['Agent 4'], data: {canApply: true}}, {kind: 'plan', ideaId, agents: ['Agent 2'], data: {canApply: true, duration: 8}}]},
    content: {reviews: {[ideaId]: clientReview(ideaId)}, plans: {[ideaId]: clientPlan()}}
  }));
  assert.equal(app.state.reviews.length, 1);
  assert.equal(app.state.reviews[0].noteId, note.id);
  assert.deepEqual(Array.from(note.reviewIds), [app.state.reviews[0].id]);
  assert.equal(app.state.ideas[0].aiPlan.title, '两组短线');
  assert.equal(app.state.tasks.length, 0, 'the handoff updates advice only, never an appointment');
  assert.equal(app.state.chatContext.pending, null);
  assert.equal(context.HaipiguaCore.validate(JSON.parse(app.exportData())), true);
  assert.equal(app.state.reviews[0].problems[0].evidence, '线条还是抖');
  assert.equal(app.undo(note.id), true);
  assert.equal(app.state.reviews.length, 0);
  assert.equal(app.state.ideas[0].aiPlan, undefined);
  assert.equal(app.state.notes.at(-1).text, '今天练了排线，画了两张，线条还是抖', 'undo keeps the original words');
});

test('a duration-only review stores a pending question and the next request carries it back', async () => {
  const {app} = browserFixture();
  const ideaId = app.state.ideas[0].id;
  const note = await app.submitModel('今天学了十五分钟相关的', async () => ({
    source: 'model', trace: [{agent: 'Agent 1', kind: 'model', status: 'ok'}, {agent: 'Agent 4', kind: 'model', status: 'ok'}],
    analysis: {intents: [{kind: 'review', ideaId, agents: ['Agent 4'], data: {canApply: true}}]},
    content: {reviews: {[ideaId]: clientReview(ideaId, {response: '这十五分钟先记下了。', summary: '只有投入时长。', progress: [{point: '投入十五分钟', evidence: '十五分钟'}], problems: [], missingEvidence: ['具体练习内容或产出'], needsEvidence: true, question: '这十五分钟具体学了什么？', nextStep: '先补一句具体内容。', durationScale: null, difficulty: null})}}
  }));
  assert.equal(app.state.reviews[0].needsEvidence, true);
  assert.equal(note.reviewQuestion, '这十五分钟具体学了什么？');
  assert.equal(app.state.chatContext.pending.kind, 'review');
  assert.equal(app.state.chatContext.pending.ideaId, ideaId);
  assert.deepEqual(Array.from(note.reviewIds).length, 1);
  assert.equal(app.state.tasks.length, 0);
  let sent = null;
  await app.submitModel('就是练排线，画了两张', async payload => {
    sent = JSON.parse(JSON.stringify(payload));
    return {source: 'model', trace: [{agent: 'Agent 1', kind: 'model', status: 'ok'}, {agent: 'Agent 4', kind: 'model', status: 'ok'}], analysis: {intents: [{kind: 'review', ideaId, agents: ['Agent 4'], data: {canApply: true}}]}, content: {reviews: {[ideaId]: clientReview(ideaId)}}};
  });
  assert.equal(sent.context.chatContext.pending.ideaId, ideaId);
  assert.equal(sent.context.chatContext.pending.question, '这十五分钟具体学了什么？');
  assert.equal(sent.context.reviews.length, 1, 'the previous review is available as bounded context');
});

test('an invalid or evidence-free review rejects the turn atomically', async () => {
  const {app} = browserFixture();
  const ideaId = app.state.ideas[0].id;
  const before = app.exportData();
  await assert.rejects(app.submitModel('今天练了排线', async () => ({
    source: 'model', trace: [{agent: 'Agent 4', kind: 'model', status: 'ok'}],
    analysis: {intents: [{kind: 'review', ideaId, agents: ['Agent 4'], data: {canApply: true}}]},
    content: {reviews: {[ideaId]: clientReview(ideaId, {hasArtifact: false, missingEvidence: []})}}
  })), /缺少什么证据|尚未改动/);
  assert.equal(app.exportData(), before);
  assert.equal(app.state.reviews.length, 0);
});

test('import validation rejects a review with a forged task or unusable evidence', () => {
  const {app, context} = browserFixture();
  const ideaId = app.state.ideas[0].id;
  const base = JSON.parse(app.exportData());
  base.reviews = [{id: 'r1', ideaId, taskId: 'missing-task', response: 'r', summary: 's', progress: [], problems: [], missingEvidence: ['x'], hasArtifact: false, needsEvidence: true, question: 'q', nextStep: 'n', durationScale: null, difficulty: null, minutes: null, createdAt: '2026-10-17T01:00:00Z'}];
  assert.equal(context.HaipiguaCore.validate(base), false);
  base.reviews[0].taskId = null;
  base.reviews[0].progress = [{point: 'p', evidence: ''}];
  assert.equal(context.HaipiguaCore.validate(base), false);
});
