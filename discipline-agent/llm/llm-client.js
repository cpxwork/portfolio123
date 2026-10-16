'use strict';
/**
 * llm/llm-client.js —— OpenAI 兼容多模型客户端（零第三方依赖）
 *
 * 一个客户端带多个"角色"（extractor / observer / planner / strategist），
 * 每个角色可以指向不同模型、不同 base、不同 key，实现"多模型合作"。
 *
 * 设计要点：
 *   1. 只用 Node 内置 http/https，不引 openai SDK。
 *   2. 传输函数可注入 → 测试用桩，不发真实请求。
 *   3. 强制 JSON 输出：优先用 response_format=json_object，失败则从文本里抠 JSON。
 *   4. 失败不抛到业务层：返回 { ok:false, error }，由调用方决定怎么处理
 *      （本项目按用户选择"纯模型、不兜底"，所以调用方会直接把不确定性上抛）。
 *   5. 所有调用记审计行（谁、用什么模型、花了多久、成功没有），可事后核对。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/** 角色 → 默认模型（可被 opts.roles 覆盖） */
const DEFAULT_ROLES = Object.freeze({
  extractor: { model: 'gpt-4o-mini', temperature: 0 },
  observer: { model: 'gpt-4o-mini', temperature: 0 },
  planner: { model: 'gpt-4o-mini', temperature: 0.3 },
  strategist: { model: 'gpt-4o', temperature: 0 }
});

function defaultTransport(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('URL 不合法: ' + url)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers),
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + String(data).slice(0, 400)));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时 ' + timeoutMs + 'ms')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 从模型回复里抠 JSON：容忍 ```json 围栏与前后废话 */
function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* 继续 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* 继续 */ }
  }
  // 数组形态
  const aStart = s.indexOf('[');
  const aEnd = s.lastIndexOf(']');
  if (aStart >= 0 && aEnd > aStart) {
    try { return JSON.parse(s.slice(aStart, aEnd + 1)); } catch (e3) { /* 继续 */ }
  }
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoOffset(date) {
  const s = new Date((date instanceof Date ? date.getTime() : date) + 8 * 3600000);
  return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate()) +
    'T' + pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes()) + ':' + pad(s.getUTCSeconds()) + '+08:00';
}

/**
 * createLlmClient
 * @param {object} opts
 * @param {string} [opts.apiBase] 默认 env.LLM_API_BASE（如 https://api.openai.com/v1）
 * @param {string} [opts.apiKey]  默认 env.LLM_API_KEY
 * @param {object} [opts.roles]   角色覆盖：{ extractor: { model, base, key, temperature } }
 * @param {number} [opts.timeoutMs] 默认 30000
 * @param {Function} [opts.transport] 注入传输（测试用）
 * @param {string} [opts.auditPath] 调用审计 JSONL
 * @param {(...a:any[])=>void} [opts.log]
 */
function createLlmClient(opts) {
  const options = opts || {};
  const apiBase = options.apiBase || process.env.LLM_API_BASE || '';
  const apiKey = options.apiKey || process.env.LLM_API_KEY || '';
  const timeoutMs = Number(options.timeoutMs || process.env.LLM_TIMEOUT_MS || 30000);
  const transport = options.transport || defaultTransport;
  const log = options.log || function () { };
  const roles = Object.assign({}, DEFAULT_ROLES, options.roles || {});
  const auditPath = options.auditPath || null;
  if (auditPath) fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  function audit(entry) {
    if (!auditPath) return;
    try { fs.appendFileSync(auditPath, JSON.stringify(Object.assign({ ts: isoOffset(Date.now()) }, entry)) + '\n', 'utf8'); } catch (e) { /* 日志失败不影响主流程 */ }
  }

  function roleConfig(role) {
    const base = roles[role] || DEFAULT_ROLES.extractor;
    return {
      model: base.model || DEFAULT_ROLES.extractor.model,
      temperature: base.temperature === undefined ? 0 : base.temperature,
      base: base.base || apiBase,
      key: base.key || apiKey
    };
  }

  function isReady(role) {
    const c = roleConfig(role);
    return !!(c.base && c.key && c.model);
  }

  function readinessReport() {
    const out = {};
    for (const r of Object.keys(roles)) {
      const c = roleConfig(r);
      out[r] = { ready: !!(c.base && c.key && c.model), model: c.model, missing: !c.base ? 'base' : !c.key ? 'key' : !c.model ? 'model' : null };
    }
    return out;
  }

  /**
   * chatJson —— 让某个角色返回 JSON
   * @param {string} role 角色名
   * @param {string} system 系统提示词
   * @param {string|Array} user 用户提示词；数组时按多模态 content 段处理
   *        （元素 { type:'text'|'image_url', ... }）
   * @returns {Promise<{ok:true, data:object, raw:string, model:string, ms:number}|{ok:false, error:string}>}
   */
  async function chatJson(role, system, user) {
    const cfg = roleConfig(role);
    const started = Date.now();
    if (!cfg.base || !cfg.key) {
      const err = '角色 ' + role + ' 未配置完整（' + (!cfg.base ? 'base ' : '') + (!cfg.key ? 'key' : '') + '）';
      audit({ event: 'llm_call', role, ok: false, error: err, model: cfg.model, ms: 0 });
      return { ok: false, error: err };
    }
    const content = Array.isArray(user) ? user : [{ type: 'text', text: String(user) }];
    const body = JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ]
    });
    const url = String(cfg.base).replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key };
    let text;
    try {
      text = await transport(url, body, headers, timeoutMs);
    } catch (e) {
      audit({ event: 'llm_call', role, ok: false, error: String(e && e.message), model: cfg.model, ms: Date.now() - started });
      return { ok: false, error: String(e && e.message) };
    }
    let content2 = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message) content2 = parsed.choices[0].message.content;
    } catch (e) { /* 网关可能直接回纯文本 */ }
    const data = parseJsonLoose(content2);
    if (data === null) {
      const err = '模型输出不是合法 JSON';
      audit({ event: 'llm_call', role, ok: false, error: err, model: cfg.model, ms: Date.now() - started });
      return { ok: false, error: err, raw: String(content2).slice(0, 500) };
    }
    audit({ event: 'llm_call', role, ok: true, model: cfg.model, ms: Date.now() - started });
    return { ok: true, data, raw: String(content2), model: cfg.model, ms: Date.now() - started };
  }

  return { chatJson, roleConfig, isReady, readinessReport, roles, auditPath };
}

module.exports = { createLlmClient, parseJsonLoose, defaultTransport, isoOffset, DEFAULT_ROLES };
