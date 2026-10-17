#!/usr/bin/env node
'use strict';
// Product smoke test. Default mode is free: it only reads /api/health.
// Live mode makes one small real review turn and requires CONFIRM_LIVE=1.
const fs = require('node:fs');
const path = require('node:path');
const {loadEnvFile} = require('../server/app.cjs');

loadEnvFile();
const port = Number(process.env.PORT || 8877);
const base = String(process.env.PRODUCT_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const live = process.argv.includes('--live');
const report = {synthetic: true, url: base, live, startedAt: new Date().toISOString()};
const output = path.join(__dirname, '..', '.local', 'product-verification.json');
function save() { fs.mkdirSync(path.dirname(output), {recursive: true}); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
function shanghaiNow() {
  const date = new Date(Date.now() + 8 * 3600000);
  return {today: date.toISOString().slice(0, 10), clockMinutes: date.getUTCHours() * 60 + date.getUTCMinutes(), now: new Date().toISOString()};
}
async function request(method, pathname, body) {
  const response = await fetch(base + pathname, {
    method,
    headers: {'Content-Type': 'application/json', Origin: base},
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(120000)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { throw Error(`HTTP ${response.status} returned non-JSON`); }
  return {status: response.status, data};
}
async function main() {
  const health = await request('GET', '/api/health');
  report.health = health;
  console.log(JSON.stringify({step: 'health', status: health.status, ready: health.data.ready, provider: health.data.provider, providerLabel: health.data.providerLabel, model: health.data.model, modelLabel: health.data.modelLabel, price: health.data.price, budget: health.data.budget, reason: health.data.reason}));
  if (!health.data.ready) {
    report.success = false;
    report.why = '模型尚未配置或型号不在允许列表；请检查 haipigua/.env。';
    save();
    console.error('FAIL: ' + report.why);
    process.exitCode = 1;
    return;
  }
  if (!live) {
    report.success = true;
    report.why = '仅健康检查；未调用模型，未产生费用。加 --live 和 CONFIRM_LIVE=1 才会做一次真实调用。';
    save();
    console.log(JSON.stringify({step: 'done', success: true, note: report.why}));
    return;
  }
  if (process.env.CONFIRM_LIVE !== '1') {
    report.success = false;
    report.why = '真实调用需要显式设置 CONFIRM_LIVE=1，避免误扣费。';
    save();
    console.error('FAIL: ' + report.why);
    process.exitCode = 1;
    return;
  }
  const now = shanghaiNow();
  const payload = {
    requestId: 'product-verify-' + Date.now(),
    ...now,
    text: '今天练了排线，画了两张，线条还是抖，帮我看看下一步。',
    context: {
      ideas: [{id: 'idea-product-check', text: '画画', title: '画画', type: 'skill', preferences: {duration: 10, energy: 'medium', level: 'beginner'}}],
      tasks: [], feedback: [], reviews: [], availability: {}, notes: [],
      chatContext: {lastIdeaId: 'idea-product-check', lastTaskId: null},
      confirmedFacts: []
    }
  };
  report.request = payload;
  const result = await request('POST', '/api/agent', payload);
  report.response = result;
  const body = result.data;
  const calls = Array.isArray(body.trace) ? body.trace.filter(item => item.kind === 'model' && ['ok', 'success'].includes(item.status)) : [];
  const review = body.content?.reviews?.['idea-product-check'];
  const checks = {
    httpOk: result.status === 200,
    modelSource: body.source === 'model',
    reviewSaved: !!review,
    reviewHasEvidence: (review?.progress || []).length + (review?.problems || []).length > 0,
    sameTurnHandoff: !!body.content?.plans?.['idea-product-check'] || !!body.content?.explorations?.['idea-product-check'],
    noServerAppointment: !body.analysis?.intents?.some(intent => intent.kind === 'schedule')
  };
  report.checks = checks;
  report.success = Object.values(checks).every(Boolean);
  report.usage = body.usage;
  report.traceCalls = calls.map(item => ({agent: item.agent, action: item.action, model: item.model, provider: item.provider, durationMs: item.durationMs}));
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({step: 'live', status: result.status, success: report.success, checks, provider: body.usage?.provider, model: body.usage?.model, calls: body.usage?.calls, inputTokens: body.usage?.inputTokens, outputTokens: body.usage?.outputTokens, estimatedCostCny: body.usage?.estimatedCostCny, resultFile: output}));
  if (!report.success) process.exitCode = 1;
}
main().catch(error => {
  report.success = false;
  report.fatal = String(error.message || 'verification failed').slice(0, 600);
  report.finishedAt = new Date().toISOString();
  save();
  console.error('Verification stopped: ' + report.fatal);
  process.exitCode = 1;
});
