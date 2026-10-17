'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHandler} = require('../server/agent.cjs');
const ORIGIN = 'http://127.0.0.1:8877';
const ENV = {MODEL_PROVIDER: 'aiping', MODEL_API_KEY: 'mock-aiping-secret', MODEL_NAME: 'GLM-4.7-Flash'};
const input = extra => ({text: '今天学了十五分钟相关的', today: '2026-10-17', clockMinutes: 600, requestId: 'aiping-' + Math.random().toString(36).slice(2), context: {ideas: [{id: 'idea-1', text: '画画', title: '画画', type: 'skill', preferences: {duration: 10}}], tasks: [], feedback: [], availability: {}, notes: [], chatContext: {lastIdeaId: 'idea-1'}}, ...extra});
const request = body => ({method: 'POST', path: '/api/agent', headers: {origin: ORIGIN}, body});
function provider(outputs) {
  const calls = [];
  return {calls, fetch: async (url, options) => {
    calls.push({url, headers: options.headers, ...JSON.parse(options.body)});
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    if (typeof output === 'function') return output(options);
    return {ok: true, status: 200, text: async () => JSON.stringify({model: 'GLM-4.7-Flash', choices: [{message: {content: JSON.stringify(output)}}], usage: {prompt_tokens: 100, completion_tokens: 50}})};
  }};
}

test('AI Ping is an explicit provider with its documented endpoint, model ID, price and JSON mode', async () => {
  const handler = createHandler(), p = provider([{intents: [{kind: 'note', data: {canApply: true, text: '今天有练习'}}]}]);
  const health = await handler({method: 'GET', path: '/api/health'}, ENV);
  assert.equal(health.body.ready, true);
  assert.equal(health.body.provider, 'aiping');
  assert.equal(health.body.providerLabel, 'AI Ping');
  assert.equal(health.body.model, 'GLM-4.7-Flash');
  assert.equal(health.body.modelLabel, 'GLM-4.7-Flash');
  assert.deepEqual(health.body.price.input, [0.5, 1]);
  assert.deepEqual(health.body.price.output, [1.5, 3]);
  assert.equal(health.body.capabilities.jsonMode, true);
  assert.equal(JSON.stringify(health.body).includes(ENV.MODEL_API_KEY), false);
  const result = await handler(request(input()), ENV, p);
  assert.equal(result.status, 200);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].url, 'https://aiping.cn/api/v1/chat/completions');
  assert.equal(p.calls[0].model, 'GLM-4.7-Flash');
  assert.equal(p.calls[0].headers.Authorization, 'Bearer ' + ENV.MODEL_API_KEY);
  assert.deepEqual(p.calls[0].response_format, {type: 'json_object'});
  assert.equal(p.calls[0].tools, undefined, 'native tools are opt-in for AI Ping');
  assert.equal(result.body.usage.provider, 'aiping');
  assert.equal(result.body.usage.model, 'GLM-4.7-Flash');
  assert.ok(result.body.usage.estimatedCostCny > 0, 'the response labels a conservative estimate, not a bill');
});

test('AI Ping rejects unlisted models, case mismatches and endpoint overrides without spending a call', async () => {
  for (const env of [
    {...ENV, MODEL_NAME: 'GLM-5'},
    {...ENV, MODEL_NAME: 'glm-4.7-flash'},
    {...ENV, MODEL_NAME: 'Kimi-K3'},
    {...ENV, MODEL_API_URL: 'https://attacker.example/api/v1/chat/completions'},
    {...ENV, MODEL_PROVIDER: 'openai'}
  ]) {
    const p = provider([{intents: [{kind: 'note', data: {canApply: true, text: 'x'}}]}]);
    const result = await createHandler()(request(input()), env, p);
    assert.equal(result.status, 503);
    assert.equal(p.calls.length, 0);
  }
});

test('AI Ping HTTP errors map to stable codes without upstream text or credentials', async () => {
  const cases = [
    [401, {error: {message: 'bad key mock-aiping-secret'}}, 'MODEL_AUTH'],
    [402, {error: {message: 'balance mock-aiping-secret'}}, 'MODEL_QUOTA'],
    [404, {error: {message: 'no model mock-aiping-secret'}}, 'MODEL_NOT_FOUND'],
    [422, {error: {message: 'unsupported parameter mock-aiping-secret'}}, 'MODEL_PARAMETERS'],
    [429, {error: {message: 'rate mock-aiping-secret'}}, 'MODEL_RATE_LIMIT'],
    [503, {error: {message: 'busy mock-aiping-secret'}}, 'MODEL_OVERLOADED']
  ];
  for (const [status, body, code] of cases) {
    const p = provider([() => ({ok: false, status, text: async () => JSON.stringify(body)})]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.body.error.code, code, status + ' -> ' + code);
    assert.equal(result.body.error.providerStatus, status);
    assert.equal(JSON.stringify(result).includes('mock-aiping-secret'), false);
    assert.equal(JSON.stringify(result).includes('bad key'), false);
    assert.equal(p.calls.length, 1);
  }
});

test('AI Ping provider codes 1113/1000/1305 keep their existing distinct meanings', async () => {
  for (const [providerCode, code] of [['1113', 'MODEL_QUOTA'], ['1000', 'MODEL_AUTH'], ['1305', 'MODEL_OVERLOADED']]) {
    const p = provider([() => ({ok: false, status: 429, text: async () => JSON.stringify({error: {code: providerCode, message: 'secret'}})})]);
    const result = await createHandler()(request(input()), ENV, p);
    assert.equal(result.body.error.code, code);
    assert.equal(result.body.error.providerCode, providerCode);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('an explicit local budget stops further AI Ping turns and is reported as an estimate', async () => {
  const handler = createHandler(), env = {...ENV, MODEL_BUDGET_CNY: '0.000001'};
  const p = provider([{intents: [{kind: 'note', data: {canApply: true, text: 'one'}}]}, {intents: [{kind: 'note', data: {canApply: true, text: 'two'}}]}]);
  const first = await handler(request(input()), env, p);
  assert.equal(first.status, 200);
  assert.ok(first.body.usage.estimatedCostCny > 0);
  const second = await handler(request(input()), env, p);
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'BUDGET_EXCEEDED');
  assert.equal(p.calls.length, 1);
  const health = await handler({method: 'GET', path: '/api/health'}, env);
  assert.equal(health.body.budget.limitCny, 0.000001);
  assert.ok(health.body.budget.estimatedSpentCny > 0);
  assert.equal(health.body.budget.estimated, true);
});

test('native tools can be explicitly enabled, while JSON mode can be explicitly disabled', async () => {
  const toolsProvider = provider([{intents: [{kind: 'note', data: {canApply: true, text: 'x'}}]}]);
  const toolsResult = await createHandler()(request(input()), {...ENV, MODEL_TOOLS: '1'}, toolsProvider);
  assert.equal(toolsResult.status, 200);
  assert.equal(toolsProvider.calls[0].tools[0].function.name, 'route_intents');
  assert.equal(toolsProvider.calls[0].tool_choice, 'auto');
  assert.equal(toolsProvider.calls[0].response_format, undefined);

  const jsonOff = provider([{intents: [{kind: 'note', data: {canApply: true, text: 'x'}}]}]);
  const jsonResult = await createHandler()(request(input()), {...ENV, MODEL_JSON_MODE: '0'}, jsonOff);
  assert.equal(jsonResult.status, 200);
  assert.equal(jsonOff.calls[0].response_format, undefined);
});
