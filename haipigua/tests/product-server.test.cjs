'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {startProductServer} = require('../server/app.cjs');

const ENV = {MODEL_PROVIDER: 'aiping', MODEL_API_KEY: 'product-test-secret', MODEL_NAME: 'GLM-4.7-Flash'};
function provider(outputs) {
  const calls = [];
  return {calls, fetch: async (url, options) => {
    calls.push({url, headers: options.headers, ...JSON.parse(options.body)});
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return {ok: true, status: 200, text: async () => JSON.stringify({model: 'GLM-4.7-Flash', choices: [{message: {content: JSON.stringify(output)}}], usage: {prompt_tokens: 80, completion_tokens: 40}})};
  }};
}
function request(port, method, pathname, {headers = {}, body = null} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: pathname, headers: {Host: `127.0.0.1:${port}`, ...headers, ...(body != null ? {'Content-Length': Buffer.byteLength(body)} : {})}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
function start(fetchImpl) {
  const server = startProductServer({port: 0, host: '127.0.0.1', env: ENV, fetchImpl, quiet: true});
  return new Promise(resolve => server.once('listening', () => resolve(server)));
}
const route = () => ({intents: [{kind: 'review', ideaId: 'idea-1', data: {canApply: true}}]});
const review = () => ({reviews: {'idea-1': {response: '你练了排线，也看到了线条抖。', summary: '画了两张排线，线条还是抖。', progress: [{point: '画了两张', evidence: '画了两张'}], problems: [{point: '线条还是抖', evidence: '线条还是抖'}], missingEvidence: ['没有看到画'], hasArtifact: false, needsEvidence: false, question: '', nextStep: '只画两组短线。', durationScale: 0.8, difficulty: 'easier', emotion: 'thinking', advice: '先固定方向。'}}});
const plan = () => ({plans: {'idea-1': {title: '两组短线', steps: [{title: '画两组', description: '固定方向与间距。'}], successCriterion: '留下两张。', rationale: '回回指出线条抖。', nextStep: '下次只改间距。'}}});
const body = () => JSON.stringify({requestId: 'product-req-1', text: '今天练了排线，画了两张，线条还是抖', today: '2026-10-17', clockMinutes: 600, context: {ideas: [{id: 'idea-1', text: '画画', title: '画画', type: 'skill', preferences: {duration: 10}}], tasks: [], feedback: [], reviews: [], availability: {}, notes: [], chatContext: {lastIdeaId: 'idea-1'}}});

test('the product server serves the real page, health, and a same-origin agent turn', async () => {
  const p = provider([route(), review(), plan()]);
  const server = await start(p.fetch);
  const port = server.address().port;
  try {
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /嗨皮瓜/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const js = await request(port, 'GET', '/studio.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const health = await request(port, 'GET', '/api/health');
    assert.equal(health.status, 200);
    const healthBody = JSON.parse(health.body);
    assert.equal(healthBody.ready, true);
    assert.equal(healthBody.provider, 'aiping');
    assert.equal(healthBody.model, 'GLM-4.7-Flash');
    assert.equal(health.body.includes(ENV.MODEL_API_KEY), false);
    const turn = await request(port, 'POST', '/api/agent', {headers: {Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json'}, body: body()});
    assert.equal(turn.status, 200);
    const result = JSON.parse(turn.body);
    assert.equal(result.source, 'model');
    assert.equal(result.content.reviews['idea-1'].problems[0].evidence, '线条还是抖');
    assert.ok(result.content.plans['idea-1']);
    assert.equal(result.usage.provider, 'aiping');
    assert.equal(p.calls.length, 3);
    assert.equal(p.calls[0].url, 'https://aiping.cn/api/v1/chat/completions');
    assert.equal(turn.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`);
  } finally { server.close(); }
});

test('the product server rejects foreign origins, wrong hosts, traversal, and oversized bodies', async () => {
  const server = await start(provider([]).fetch);
  const port = server.address().port;
  try {
    const foreign = await request(port, 'POST', '/api/agent', {headers: {Origin: 'https://attacker.example', 'Content-Type': 'application/json'}, body: body()});
    assert.equal(foreign.status, 403);
    const wrongHost = await request(port, 'GET', '/', {headers: {Host: 'attacker.example'}});
    assert.equal(wrongHost.status, 403);
    const traversal = await request(port, 'GET', '/../server/agent.cjs');
    assert.equal(traversal.status, 404);
    const tooLarge = await request(port, 'POST', '/api/agent', {headers: {Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json'}, body: 'x'.repeat(131073)});
    assert.equal(tooLarge.status, 413);
    const head = await request(port, 'HEAD', '/');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally { server.close(); }
});
