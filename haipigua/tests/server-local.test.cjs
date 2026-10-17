'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createHandler, DEFAULT_MODEL, DEFAULT_URL} = require('../server/agent.cjs');
const {startServer} = require('../server/local.cjs');
const ORIGIN = 'http://127.0.0.1:8877';
const ENV = {MODEL_API_KEY: 'mock-provider-secret'};
const input = extra => ({text: '我想学Python，明天中午十二点试十分钟', today: '2026-10-17', clockMinutes: 600, requestId: 'request-1', context: {ideas: [], tasks: [], feedback: [], availability: {}, notes: [], chatContext: {}}, ...extra});
const request = body => ({method: 'POST', path: '/api/agent', headers: {origin: ORIGIN}, body});
function provider(outputs) {
  const calls = [];
  return {calls, fetch: async (url, options) => {
    calls.push({url, headers: options.headers, ...JSON.parse(options.body)});
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    if (typeof output === 'function') return output(options);
    return {ok: true, status: 200, text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify(output)}}], usage: {prompt_tokens: 11, completion_tokens: 7}})};
  }};
}
const note = () => ({intents: [{kind: 'note', data: {canApply: true, text: '今天忙于比赛'}}]});
const ideaRoute = () => ({intents: [{kind: 'idea', newIdeaKey: 'new-0', agents: ['made-up'], data: {canApply: true, text: '学Python', title: 'Python', type: 'skill'}}, {kind: 'schedule', newIdeaKey: 'new-0', data: {canApply: true, date: '2026-10-18', start: '12:00', duration: 10}}]});
const plan = () => ({plans: {'new-0': {title: '写出一次输出', steps: [{title: '修改一个值', description: '把示例中的名字改成自己的名字。'}], successCriterion: '保存一张运行截图。', rationale: '仅十分钟，先运行一个例子。', nextStep: '下次再修改第二个值。'}}});
const context = () => ({ideas: [{id: 'idea-1', text: '学唱歌', title: '唱歌', type: 'skill', preferences: {duration: 10, energy: 'low'}}], tasks: [{id: 'task-1', ideaId: 'idea-1', title: '跟唱十分钟', date: '2026-10-17', start: '11:00', end: '11:10', duration: 10, status: 'accepted'}], feedback: [], availability: {}, notes: [], chatContext: {lastIdeaId: 'idea-1', lastTaskId: 'task-1'}});
const feedbackRoute = () => ({intents: [{kind: 'feedback', taskId: 'task-1', data: {canApply: true, completion: 'partial', minutes: 5, feeling: 'hard', reason: '高音困难'}}]});
const reflection = () => ({reflections: {'task-1': {response: '下一次先缩小到舒适音域。', summary: '实际唱了5分钟，高音困难。', emotion: 'thinking', nextAdjustment: {durationScale: 0.5, difficulty: 'easier', advice: '减少音高跨度，一次练一小句。', nextStep: '用舒适音高轻唱一句并录下10秒。'}}}});

test('health has truthful capability flags and no config names or secrets; paid model and alternate endpoints stay unready', async () => {
  const handler = createHandler();
  for (const env of [{}, {MODEL_API_KEY: 'x', MODEL_NAME: 'glm-5'}, {MODEL_API_KEY: 'x', MODEL_API_URL: 'https://attacker.example'}]) {
    const result = await handler({method: 'GET', path: '/api/health'}, env);
    assert.equal(result.body.ready, false);
    assert.equal(result.body.capabilities.mediaAnalysis, false);
    assert.equal(result.body.capabilities.accountMemory, false);
    assert.equal(JSON.stringify(result.body).includes('MODEL_API_KEY'), false);
  }
  const ready = await handler({method: 'GET', path: '/api/health'}, ENV);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.model, DEFAULT_MODEL);
  assert.equal(JSON.stringify(ready.body).includes(ENV.MODEL_API_KEY), false);
});

test('native router parameters propose advice without an appointment and planner sees whitelisted earlier advice', async () => {
  const route = {intents: [{kind: 'plan', ideaId: 'idea-1', data: {canApply: true, duration: 5, goal: '只练一个舒适音'}}]};
  const previous = plan().plans['new-0'];
  const state = context(); state.ideas[0].aiPlan = {...previous, resources: [{url: 'PRIVATE_LINK'}], secret: 'DO_NOT_FORWARD'};
  const before = JSON.stringify(state);
  const p = provider([() => ({ok: true, text: async () => JSON.stringify({choices: [{message: {content: null, tool_calls: [{type: 'function', function: {name: 'route_intents', arguments: JSON.stringify(route)}}]}}]})}), {plans: {'idea-1': previous}}]);
  const result = await createHandler()(request(input({text: '只修改唱歌建议，五分钟，只练一个音，不预约', context: state})), ENV, p);
  assert.equal(result.status, 200); assert.equal(p.calls.length, 2);
  assert.equal(result.body.analysis.intents[0].kind, 'plan'); assert.equal(result.body.analysis.clarification, undefined);
  assert.equal(p.calls[0].tools[0].function.name, 'route_intents'); assert.equal(p.calls[0].tool_choice, 'auto');
  assert.equal(p.calls[0].response_format, undefined);
  assert.equal(result.body.trace[0].format, 'function_arguments');
  const target = JSON.parse(p.calls[1].messages[1].content).targets[0];
  assert.equal(target.duration, 5); assert.equal(target.idea.aiPlan.steps[0].description, previous.steps[0].description);
  assert.equal(JSON.stringify(target).includes('PRIVATE_LINK'), false); assert.equal(JSON.stringify(target).includes('DO_NOT_FORWARD'), false);
  assert.equal(JSON.stringify(state), before, 'server must not mutate caller context or existing appointment');
});

test('unrecognized, multiple or malformed native tool calls never execute or fall through to plaintext', async () => {
  const valid = {type: 'function', function: {name: 'route_intents', arguments: JSON.stringify(note())}};
  for (const calls of [[{...valid, function: {...valid.function, name: 'delete_records'}}], [valid, valid], [{...valid, function: {...valid.function, arguments: '{'}}]]) {
    const p = provider([() => ({ok: true, text: async () => JSON.stringify({choices: [{message: {content: JSON.stringify(note()), tool_calls: calls}}]})})]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.status, 502); assert.equal(result.body.error.code, 'MODEL_FORMAT'); assert.equal(p.calls.length, 1);
  }
});

test('question-only representation variants preserve the real model question without creating a domain operation', async () => {
  for (const route of [{clarification: {question: '你说的是哪一天？'}}, {intents: [{kind: 'clarification', data: {question: '你说的是哪一天？'}}]}, {intents: [{kind: 'question', data: {text: '你说的是哪一天？'}}]}]) {
    const p = provider([route]);
    const result = await createHandler()(request(input({text: '下午六点呢'})), ENV, p);
    assert.equal(result.status, 200); assert.deepEqual(result.body.analysis.intents, []);
    assert.equal(result.body.analysis.clarification.question, '你说的是哪一天？'); assert.equal(p.calls.length, 1);
    assert.deepEqual(Object.keys(result.body.content.plans), []);
  }
  const p = provider([{intents: [{kind: 'question', data: {text: '按这个日期保存', date: '2026-10-18'}}]}, note()]);
  const result = await createHandler()(request(input()), ENV, p);
  assert.equal(p.calls.length, 2, 'an action-bearing unknown kind is not accepted as a harmless question');
  assert.equal(result.body.analysis.intents[0].kind, 'note');
});

test('complete busy facts remain applicable despite a colliding appointment and do not reschedule it on the server', async () => {
  const state = context(), before = JSON.stringify(state);
  const p = provider([{intents: [{kind: 'busy', data: {canApply: true, date: '2026-10-17', start: '11:00', end: '12:00', label: '实验'}}]}]);
  const result = await createHandler()(request(input({text: '今天十一点到十二点有实验，没空练唱歌。', context: state})), ENV, p);
  assert.equal(result.status, 200); assert.equal(result.body.analysis.intents[0].data.canApply, true); assert.equal(p.calls.length, 1);
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'schedule'), false);
});

test('an omitted time range gets a real bounded model review while uncertain busy time is not invented', async () => {
  for (const confirmed of [true, false]) {
    const first = {intents: [{kind: 'plan', ideaId: 'idea-1', data: {canApply: true, duration: 5}}]};
    const second = {intents: confirmed ? [{kind: 'busy', data: {canApply: true, date: '2026-10-18', start: '14:00', end: '15:00', label: '实验'}}] : []};
    const p = provider([first, second, {plans: {'idea-1': plan().plans['new-0']}}]);
    const text = confirmed ? '只改唱歌建议，不预约。明天14:00–15:00有实验。' : '只改唱歌建议。如果明天14:00–15:00有实验会没空，但没确定，先别记。';
    const result = await createHandler()(request(input({text, context: context()})), ENV, p);
    assert.equal(result.status, 200); assert.equal(p.calls.length, 3);
    assert.equal(result.body.analysis.intents.some(i => i.kind === 'busy'), confirmed);
    assert.equal(result.body.trace.some(t => t.action === 'check_information_coverage'), true);
    assert.equal(result.body.trace.filter(t => t.kind === 'model').length, 3);
    assert.deepEqual(p.calls[1].response_format, {type: 'json_object'});
    assert.equal(p.calls[1].tools, undefined);
    assert.match(p.calls[1].messages[0].content, /\{"intents":\[\]\}/);
    assert.equal(result.body.analysis.intents.some(i => i.kind === 'schedule'), false);
  }
});

test('the coverage review cannot expand its authority into appointments or new interests', async () => {
  const p = provider([{intents: [{kind: 'plan', ideaId: 'idea-1', data: {canApply: true, duration: 5}}]}, {intents: [{kind: 'schedule', ideaId: 'idea-1', data: {canApply: true, date: '2026-10-18', start: '14:00', duration: 10}}]}]);
  const result = await createHandler()(request(input({text: '只改唱歌建议，另外明天14:00–15:00有实验。', context: context()})), ENV, p);
  assert.equal(result.status, 502); assert.equal(p.calls.length, 2);
  assert.equal(result.body.source, undefined);
});

test('advice carrying appointment edits is rejected even after the single format repair', async () => {
  for (const forbidden of [{taskId: 'task-1'}, {date: '2026-10-18'}, {start: '13:00'}, {end: '13:10'}, {replaceTaskId: 'task-1'}]) {
    const item = {kind: 'plan', ideaId: 'idea-1', data: {canApply: true, duration: 5, ...forbidden}};
    if (forbidden.taskId) { item.taskId = forbidden.taskId; delete item.data.taskId; }
    const p = provider([{intents: [item]}, {intents: [item]}]);
    const result = await createHandler()(request(input({text: '只修改建议，不动预约', context: context()})), ENV, p);
    assert.equal(result.status, 502); assert.equal(result.body.error.formatIssue, 'PLAN_HAS_SCHEDULE_FIELDS'); assert.equal(p.calls.length, 2);
  }
});

test('creative advice uses the existing idea and calls the explorer without creating an appointment proposal', async () => {
  const state = context(); state.ideas[0].type = 'creative';
  const exploration = {title: '纸上验证', assumptions: ['愿意交换的同学存在，待验证'], paths: [{title: '先问一人', description: '询问一位自愿同学的真实经历'}], firstStep: {title: '写一个问题', description: '写下上一次怎么处理闲置书'}, successSignal: '留下一条有来源的回答', questions: [], timeBudget: 10};
  const p = provider([{intents: [{kind: 'plan', ideaId: 'idea-1', data: {canApply: true, duration: 10}}]}, {explorations: {'idea-1': exploration}}]);
  const result = await createHandler()(request(input({text: '只给这个创意一个验证动作', context: state})), ENV, p);
  assert.equal(result.status, 200); assert.equal(p.calls.length, 2); assert.match(p.calls[1].messages[0].content, /Agent 3/);
  assert.deepEqual(result.body.analysis.intents[0].agents, ['Agent 3']); assert.equal(result.body.content.explorations['idea-1'].firstStep.title, '写一个问题');
});

test('origin allowlist blocks foreign/missing/unlisted local port; no bearer token needed on allowed origin', async () => {
  for (const origin of ['', 'https://attacker.example', 'http://localhost:5555', 'http://127.0.0.1.attacker.example:8877']) {
    const p = provider([note()]);
    const result = await createHandler()({...request(input()), headers: {origin}}, ENV, p);
    assert.equal(result.status, 403);
    assert.equal(p.calls.length, 0);
  }
  const handler = createHandler();
  assert.equal((await handler({method: 'OPTIONS', path: '/api/agent', headers: {origin: ORIGIN}}, ENV)).status, 204);
  assert.equal((await handler(request(input()), ENV, provider([note()]))).status, 200);
});

test('separate router and planner use pinned free model and official endpoint, with sanitized safe resources', async () => {
  const p = provider([ideaRoute(), plan()]);
  const result = await createHandler()(request(input()), ENV, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 2);
  assert.ok(p.calls.every(c => c.url === DEFAULT_URL && c.model === DEFAULT_MODEL));
  assert.deepEqual(p.calls[0].thinking, {type: 'disabled'});
  assert.match(p.calls[0].messages[0].content, /Agent 1/);
  assert.match(p.calls[1].messages[0].content, /Agent 2/);
  assert.deepEqual(result.body.analysis.intents[0].agents, ['Agent 1']);
  assert.ok(result.body.content.plans['new-0'].resources.every(r => r.url.startsWith('https://')));
  assert.equal(result.body.usage.calls, 2);
  assert.equal(JSON.stringify(result.body).includes(ENV.MODEL_API_KEY), false);
});

test('explicitly selected second free model is used as requested and does not receive unsupported thinking settings', async () => {
  const env = {...ENV, MODEL_NAME: 'glm-4-flash-250414'}, handler = createHandler(), p = provider([note()]);
  const health = await handler({method: 'GET', path: '/api/health'}, env);
  assert.equal(health.body.ready, true);
  assert.equal(health.body.model, 'glm-4-flash-250414');
  const result = await handler(request(input()), env, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls[0].model, 'glm-4-flash-250414');
  assert.equal(p.calls[0].url, DEFAULT_URL);
  assert.equal('thinking' in p.calls[0], false);
  for (const model of ['glm-4.7', 'glm-5', 'glm-5.3', 'glm-4.5-flash']) {
    const blockedProvider = provider([note()]);
    const blocked = await createHandler()(request(input()), {...ENV, MODEL_NAME: model}, blockedProvider);
    assert.equal(blocked.status, 503);
    assert.equal(blockedProvider.calls.length, 0);
  }
});

test('provider 1305 capacity, 1113 balance and 1000 authentication errors are distinct without diagnostic text or auto fallback', async () => {
  for (const [providerCode, expectedCode, phrase] of [['1305', 'MODEL_OVERLOADED', '访问量过大'], ['1113', 'MODEL_QUOTA', '余额不足'], ['1000', 'MODEL_AUTH', '验证未通过']]) {
    const p = provider([() => ({ok: false, status: 429, text: async () => JSON.stringify({error: {code: providerCode, message: 'raw-diagnostic-' + ENV.MODEL_API_KEY}})})]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.body.error.code, expectedCode);
    assert.equal(result.body.error.providerCode, providerCode);
    assert.equal(result.body.error.providerStatus, 429);
    assert.ok(result.body.error.message.includes(phrase));
    assert.equal(JSON.stringify(result).includes('raw-diagnostic-'), false);
    assert.equal(JSON.stringify(result).includes(ENV.MODEL_API_KEY), false);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].model, DEFAULT_MODEL);
  }
});

test('full 8000-character ramble reaches router and personal facts are bounded, while ungrounded evidence is removed', async () => {
  const text = '我是一名大学生，理科背景，今天忙于比赛。' + '想'.repeat(7978);
  const p = provider([{...note(), understanding: {goal: '寻找实习准备方向', facts: [{text: '大学生', evidence: '我是一名大学生'}, {text: '已有大厂实习', evidence: '已有大厂实习'}], constraints: [{text: '今天比赛忙', evidence: '今天忙于比赛'}], unknowns: ['你想申请什么岗位？']}}]);
  const result = await createHandler()(request(input({text, context: {confirmedFacts: [{text: '应用物理学大四，已保研'}], studio: {preference: {duration: 10, energy: 'low'}}}})), ENV, p);
  assert.equal(result.status, 200);
  const payload = JSON.parse(p.calls[0].messages[1].content);
  assert.equal(payload.text, text);
  assert.deepEqual(payload.context.confirmedFacts, ['应用物理学大四，已保研']);
  assert.equal(result.body.analysis.understanding.facts.length, 1);
  assert.equal(result.body.analysis.understanding.constraints.length, 1);
  assert.match(p.calls[0].messages[0].content, /不得凭理科背景默认Python/);
});

test('internship goal without a date gets a preparatory plan, not an invented appointment', async () => {
  const p = provider([{intents: [{kind: 'idea', newIdeaKey: 'new-0', data: {canApply: true, text: '准备AI产品经理或产品运营实习', title: 'AI行业实习准备', type: 'skill'}}], clarification: {question: '实验和健身通常占用什么时间？'}}, plan()]);
  const result = await createHandler()(request(input({text: '应用物理学大四，已保研，想AI产品经理或产品运营，每天至少可学习5小时', context: {confirmedFacts: ['目标AI产品经理或产品运营']}})), ENV, p);
  assert.equal(result.status, 200);
  assert.equal(result.body.analysis.intents.some(i => i.kind === 'schedule'), false);
  assert.ok(result.body.content.plans['new-0']);
  const payload = JSON.parse(p.calls[1].messages[1].content);
  assert.deepEqual(payload.confirmedFacts, ['目标AI产品经理或产品运营']);
  assert.match(p.calls[1].messages[0].content, /尚无完整日程时/);
});

test('incomplete times and unavailable slots never become applied schedules', async () => {
  for (const data of [{canApply: true, start: '12:00'}, {canApply: true, date: '2026-10-17', start: '11:00', duration: 10}]) {
    const p = provider([{intents: [{kind: 'schedule', ideaId: 'idea-1', data}]}]);
    const result = await createHandler()(request(input({text: data.start === '11:00' ? '今天上午十一点练十分钟' : '今天中午十二点', context: context()})), ENV, p);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.intents[0].data.canApply, false);
    assert.ok(result.body.analysis.clarification);
    assert.equal(p.calls.length, 1);
  }
});

test('explicit tomorrow is anchored to supplied Shanghai today even when now is on the previous UTC date', async () => {
  const state = context(); state.tasks = []; state.chatContext = {lastIdeaId: 'idea-1'};
  const p = provider([
    {intents: [{kind: 'schedule', ideaId: 'idea-1', data: {canApply: true, date: '2026-10-17', start: '12:00', duration: 10}}]},
    {plans: {'idea-1': plan().plans['new-0']}}
  ]);
  const result = await createHandler()(request(input({text: '明天中午十二点唱十分钟', today: '2026-10-17', clockMinutes: 450, now: '2026-10-16T23:30:00.000Z', context: state})), ENV, p);
  assert.equal(result.status, 200);
  const schedule = result.body.analysis.intents.find(i => i.kind === 'schedule');
  assert.equal(schedule.data.date, '2026-10-18');
  assert.equal(schedule.data.canApply, true);
  const target = JSON.parse(p.calls[1].messages[1].content).targets[0];
  assert.equal(target.date, '2026-10-18', 'planner must receive the corrected date, never the model-invented today');
});

test('ambiguous twelve oclock asks for the missing date before repeating a model-invented today question', async () => {
  for (const canApply of [true, false]) {
    const state = context(); state.tasks = []; state.chatContext = {lastIdeaId: 'idea-1'};
    const p = provider([{intents: [{kind: 'schedule', ideaId: 'idea-1', data: {canApply, date: '2026-10-17', start: '12:00', duration: 10}}], clarification: {question: '你说的是今天中午十二点还是今天晚上十二点？'}}]);
    const result = await createHandler()(request(input({text: '那十二点', context: state})), ENV, p);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.intents[0].data.canApply, false);
    assert.match(result.body.analysis.clarification.question, /哪一天|哪天|日期/);
    assert.doesNotMatch(result.body.analysis.clarification.question, /今天/);
    assert.equal(p.calls.length, 1, 'no appointment or planner may run before clarifying the day');
  }
});

test('optional null IDs and missing new-idea keys normalize safely without guessing another intent association', async () => {
  for (const alias of [undefined, 'safe-new']) {
    const route = {intents: [
      {kind: 'idea', ideaId: null, taskId: '', newIdeaKey: null, data: {canApply: true, text: '准备实习', title: '实习准备', type: 'park', ...(alias ? {newIdeaKey: alias} : {})}},
      {kind: 'schedule', ideaId: null, taskId: null, newIdeaKey: '', data: {canApply: true, date: '2026-10-18', start: '12:00', duration: 10}}
    ]};
    const p = provider([route]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.intents[0].newIdeaKey, alias || 'new-0');
    assert.equal('ideaId' in result.body.analysis.intents[0], false);
    assert.equal('taskId' in result.body.analysis.intents[0], false);
    assert.equal(result.body.analysis.intents[1].data.canApply, false);
    assert.equal('newIdeaKey' in result.body.analysis.intents[1], false);
    assert.match(result.body.analysis.clarification.question, /哪个兴趣/);
    assert.equal(p.calls.length, 1);
    assert.equal(route.intents[0].ideaId, null, 'normalization must not mutate provider data');
  }
});

test('new-idea key normalization does not allow existing or invented domain IDs to become new ideas', async () => {
  for (const id of ['idea-1', 'invented-idea']) {
    const p = provider([{intents: [{kind: 'idea', ideaId: id, newIdeaKey: null, data: {canApply: true, text: '准备实习', type: 'park'}}]}]);
    const result = await createHandler()(request(input({context: context()})), ENV, p);
    assert.equal(result.status, 502);
    assert.equal(p.calls.length, 1);
    assert.equal(result.body.error.code, id === 'idea-1' ? 'MODEL_FORMAT' : 'UNKNOWN_ID');
  }
});

test('unknown IDs and fabricated dates reject before specialists run', async () => {
  for (const item of [{kind: 'feedback', taskId: 'invented', data: {canApply: true}}, {kind: 'schedule', ideaId: 'idea-1', data: {canApply: true, date: '2026-02-30', start: '12:00', duration: 10}}]) {
    const p = provider([{intents: [item]}]);
    assert.equal((await createHandler()(request(input({context: context()})), ENV, p)).status, 502);
    assert.equal(p.calls.length, 1);
  }
});

test('actual feedback reaches Agent 4, and next-turn planner sees the resulting adjustment with no server domain writes', async () => {
  const state = context();
  const p = provider([{intents: [{kind: 'feedback', taskId: 'task-1', data: {canApply: true, completion: 'partial', minutes: 5, feeling: 'hard', reason: '高音困难'}}]}, {reflections: {'task-1': {response: '先缩小难度。', summary: '练了5分钟，高音困难。', emotion: 'thinking', nextAdjustment: {durationScale: 0.5, difficulty: 'easier', advice: '下次先练舒适音域。', nextStep: '轻声跟唱一小句并录10秒。'}}}}]);
  const first = await createHandler()(request(input({text: '我只唱了5分钟，高音很难', context: state})), ENV, p);
  assert.equal(first.status, 200);
  assert.match(p.calls[1].messages[1].content, /高音困难/);
  assert.equal(state.tasks[0].status, 'accepted');
  const reflection = first.body.content.reflections['task-1'];
  state.tasks[0].status = 'partial';
  state.feedback.push({ideaId: 'idea-1', taskId: 'task-1', completion: 'partial', minutes: 5, feeling: 'hard', reason: '高音困难', summary: reflection.summary, nextAdjustment: reflection.nextAdjustment});
  const secondProvider = provider([{intents: [{kind: 'schedule', ideaId: 'idea-1', data: {canApply: true, date: '2026-10-18', start: '12:00', duration: 5}}]}, {plans: {'idea-1': plan().plans['new-0']}}]);
  const second = await createHandler()(request(input({text: '明天中午十二点唱5分钟', context: state})), ENV, secondProvider);
  assert.equal(second.status, 200);
  const plannerInput = JSON.parse(secondProvider.calls[1].messages[1].content);
  assert.equal(plannerInput.targets[0].duration, 3);
  assert.equal(plannerInput.targets[0].requestedDuration, 5);
  assert.equal(plannerInput.targets[0].appliedAdjustment.durationScale, 0.5);
  assert.equal(plannerInput.targets[0].appliedAdjustment.difficulty, 'easier');
  assert.equal(plannerInput.targets[0].memory.feedback[0].nextAdjustment.durationScale, 0.5);
});

test('each eligible router representation error gets one genuine model repair and complete revalidation', async () => {
  for (const malformed of ['not-an-object', {kind: 'skill', data: {canApply: true, text: '唱歌'}}, {kind: 'note', text: '今天忙于比赛'}]) {
    const candidate = {intents: [malformed]}, p = provider([candidate, note()]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.status, 200);
    assert.equal(p.calls.length, 2);
    assert.equal(result.body.usage.calls, 2);
    assert.equal(result.body.trace.filter(t => t.kind === 'model').length, 2);
    assert.equal(result.body.trace.filter(t => t.action === '修复一次结构并重新校验').length, 1);
    assert.deepEqual(result.body.analysis.intents[0].agents, ['Agent 1']);
    const repairPayload = JSON.parse(p.calls[1].messages[1].content);
    assert.deepEqual(repairPayload.candidate, candidate);
    assert.equal(repairPayload.text, input().text);
    assert.ok(repairPayload.context);
    assert.match(p.calls[1].messages[0].content, /不能创造已有ID/);
  }
});

test('missing feedback next step is repaired by a real extra call rather than a default local sentence', async () => {
  const incomplete = reflection(); delete incomplete.reflections['task-1'].nextAdjustment.nextStep;
  const state = context(), p = provider([feedbackRoute(), incomplete, reflection()]);
  const result = await createHandler()(request(input({text: '只练了五分钟，高音有点难', context: state})), ENV, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 3);
  assert.equal(result.body.usage.calls, 3);
  assert.equal(result.body.trace.filter(t => t.agent === 'Agent 4' && t.kind === 'model').length, 2);
  assert.equal(result.body.content.reflections['task-1'].nextAdjustment.nextStep, reflection().reflections['task-1'].nextAdjustment.nextStep);
  const repairPayload = JSON.parse(p.calls[2].messages[1].content);
  assert.equal(repairPayload.text, '只练了五分钟，高音有点难');
  assert.equal(repairPayload.targets[0].feedback.minutes, 5);
  assert.deepEqual(repairPayload.candidate, incomplete);
  assert.equal(state.tasks[0].status, 'accepted', 'only client may apply feedback domain writes');
});

test('a still-invalid repair stops and a turn never repairs twice across different roles', async () => {
  const badRouter = {intents: [{kind: 'skill', data: {}}]};
  const p = provider([badRouter, badRouter, note()]);
  const failedRouter = await createHandler()(request(input()), ENV, p);
  assert.equal(failedRouter.status, 502);
  assert.equal(failedRouter.body.error.stage, 'Agent 1');
  assert.equal(p.calls.length, 2);
  assert.equal(failedRouter.body.usage.calls, 2);
  assert.equal(failedRouter.body.trace.filter(t => t.kind === 'model').length, 2);
  const badFeedback = reflection(); badFeedback.reflections['task-1'].nextAdjustment.nextStep = '';
  const feedbackProvider = provider([feedbackRoute(), badFeedback, badFeedback, reflection()]);
  const failedFeedback = await createHandler()(request(input({context: context()})), ENV, feedbackProvider);
  assert.equal(failedFeedback.status, 502);
  assert.equal(failedFeedback.body.error.stage, 'Agent 4');
  assert.equal(feedbackProvider.calls.length, 3);
  assert.equal(failedFeedback.body.usage.calls, 3);
  const sharedProvider = provider([badRouter, feedbackRoute(), badFeedback, reflection()]);
  const oncePerTurn = await createHandler()(request(input({context: context()})), ENV, sharedProvider);
  assert.equal(oncePerTurn.status, 502);
  assert.equal(oncePerTurn.body.error.stage, 'Agent 4');
  assert.equal(sharedProvider.calls.length, 3, 'router repair already consumed the only repair for this turn');
  assert.equal(oncePerTurn.body.trace.filter(t => t.action === '修复一次结构并重新校验').length, 1);
});

test('unknown router or feedback IDs, illegal dates and upstream authentication never trigger repair', async () => {
  const cases = [
    [provider([{intents: [{kind: 'feedback', taskId: 'invented', data: {canApply: true}}]}, note()]), 1, 'UNKNOWN_ID'],
    [provider([{intents: [{kind: 'schedule', ideaId: 'idea-1', data: {canApply: true, date: '2026-02-30', start: '12:00', duration: 10}}]}, note()]), 1, 'MODEL_FORMAT'],
    [provider([feedbackRoute(), {reflections: {'invented': reflection().reflections['task-1']}}, reflection()]), 2, 'UNKNOWN_ID'],
    [provider([() => ({ok: false, status: 401, text: async () => JSON.stringify({error: {code: '1000'}})}), note()]), 1, 'MODEL_AUTH']
  ];
  for (const [p, count, code] of cases) {
    const result = await createHandler()(request(input({context: context()})), ENV, p);
    assert.equal(result.body.error.code, code);
    assert.equal(p.calls.length, count);
  }
});

test('all four normal role calls exhaust the call budget, so invalid feedback does not launch a fifth repair', async () => {
  const route = {intents: [
    {kind: 'preference', ideaId: 'idea-1', data: {canApply: true, energy: 'low'}},
    {kind: 'idea', newIdeaKey: 'new-0', data: {canApply: true, type: 'creative', text: '校园地图', title: '校园地图'}},
    ...feedbackRoute().intents
  ]};
  const exploration = {explorations: {'new-0': {title: '地图草图', assumptions: ['同学可能需要地图，待验证。'], paths: [{title: '画草图', description: '标记三个地点。'}], firstStep: {title: '标记三个地点', description: '在纸上画出熟悉的三个地点。'}, successSignal: '保存一张草图。', questions: []}}};
  const incomplete = reflection(); delete incomplete.reflections['task-1'].nextAdjustment.nextStep;
  const p = provider([route, {plans: {'idea-1': plan().plans['new-0']}}, exploration, incomplete, reflection()]);
  const result = await createHandler()(request(input({context: context()})), ENV, p);
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'MODEL_FORMAT');
  assert.equal(p.calls.length, 4);
});

test('a form preserves reported facts and calls only the feedback model; unsupported robot pose uses a neutral expression', async () => {
  const value = reflection(); value.reflections['task-1'].emotion = 'encouraging';
  const p = provider([value]), reason = '卡在高音，今天先停一下。'.repeat(60);
  const result = await createHandler()(request(input({context: context(), reportedFeedback: {taskId: 'task-1', completion: 'partial', minutes: 4, feeling: 'hard', reason}})), ENV, p);
  assert.equal(result.status, 200); assert.equal(p.calls.length, 1);
  assert.match(p.calls[0].messages[0].content, /Agent 4/);
  assert.equal(JSON.parse(p.calls[0].messages[1].content).targets[0].feedback.reason, reason);
  assert.deepEqual(result.body.analysis.intents[0].data, {canApply: true, completion: 'partial', minutes: 4, feeling: 'hard', reason});
  assert.equal(result.body.content.reflections['task-1'].emotion, 'thinking');
  assert.equal(result.body.trace.some(t => t.action === '修复一次结构并重新校验'), false);
});

test('invalid or stale feedback forms do not spend any model calls', async () => {
  for (const patch of [{taskId: 'missing'}, {completion: 'made-up'}, {minutes: '4'}, {completion: 'skipped', minutes: 4}]) {
    const p = provider([reflection()]);
    const result = await createHandler()(request(input({context: context(), reportedFeedback: {taskId: 'task-1', completion: 'partial', minutes: 4, feeling: 'hard', reason: '', ...patch}})), ENV, p);
    assert.equal(result.status, 400); assert.equal(p.calls.length, 0);
  }
});

test('same request ID concurrent retry and completed retry perform one provider call; reused ID different payload conflicts', async () => {
  const handler = createHandler(), p = provider([note()]), req = request(input());
  const [a, b] = await Promise.all([handler(req, ENV, p), handler(req, ENV, p)]);
  assert.equal(a.status, 200); assert.deepEqual(a, b);
  assert.equal((await handler(req, ENV, p)).status, 200);
  assert.equal(p.calls.length, 1);
  assert.equal((await handler(request(input({text: '另一段话'})), ENV, p)).status, 409);
});

test('model errors, invalid JSON and timeout stay explicit and do not return provider diagnostics', async () => {
  const outputs = [Error(ENV.MODEL_API_KEY), () => ({ok: false, status: 500, text: async () => ENV.MODEL_API_KEY}), () => ({ok: true, text: async () => ENV.MODEL_API_KEY})];
  for (const output of outputs) {
    const result = await createHandler()(request(input()), ENV, provider([output]));
    assert.equal(result.status, 502);
    assert.equal(JSON.stringify(result).includes(ENV.MODEL_API_KEY), false);
  }
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await createHandler()(request(input()), ENV, {...provider([() => new Promise(() => {})]), timeoutMs: 10});
    assert.equal(result.status, 504);
    assert.equal(result.body.error.code, 'MODEL_TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

test('request bounds and per-minute session limits stop extra provider calls', async () => {
  const handler = createHandler();
  assert.equal((await handler(request('{'), ENV)).status, 400);
  assert.equal((await handler(request('x'.repeat(131073)), ENV)).status, 413);
  assert.equal((await handler(request(input({text: 'x'.repeat(8001)})), ENV)).status, 400);
  const fresh = createHandler(), p = provider(Array.from({length: 12}, note));
  for (let i = 0; i < 12; i++) assert.equal((await fresh(request(input({requestId: 'req-' + i})), ENV, p)).status, 200);
  assert.equal((await fresh(request(input({requestId: 'req-13'})), ENV, p)).status, 429);
  assert.equal(p.calls.length, 12);
});

test('loopback HTTP adapter checks Host and never exposes key in anonymous health', async () => {
  const server = startServer({port: 0, env: ENV});
  await new Promise(resolve => server.once('listening', resolve));
  const get = headers => new Promise((resolve, reject) => { http.get({host: '127.0.0.1', port: server.address().port, path: '/api/health', headers}, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status: res.statusCode, body})); }).on('error', reject); });
  try {
    const ok = await get({}); assert.equal(ok.status, 200); assert.equal(ok.body.includes(ENV.MODEL_API_KEY), false);
    const denied = await get({Host: 'attacker.example'}); assert.equal(denied.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
