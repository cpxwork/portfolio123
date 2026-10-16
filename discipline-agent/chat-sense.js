'use strict';
/**
 * chat-sense.js —— 聊天记录接入 + 待办提取（A-M1 交付，架构变更后）
 *
 * 认知判断（科目/日期/时间/歧义）全部交给 extractor 模型（见 llm/roles.js）；
 * 本文件保留两块**确定性**代码：
 *   1. 数据管道：txt/json 导入、去噪、去重（不是"判断"，是工程）
 *   2. 模型输出归一化：confidence 裁剪、date/time 格式校验、pending_confirm 分流
 *
 * 原规则版提取实现（extractTodos/extractOne 等约 500 行）已按用户决定**物理删除**，
 * 生产路径纯模型，模型不可用不静默兜底。
 */

/** 置信度阈值：低于它进 pending_confirm */
const CONFIRM_THRESHOLD = 0.6;

function pad(n) { return String(n).padStart(2, '0'); }

/** 基准日期（+08:00 的 YYYY-MM-DD 与星期） */
function baseDate(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const s = new Date(d.getTime() + 8 * 3600000);
  return {
    date: s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate()),
    weekday: s.getUTCDay() || 7
  };
}

function validDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
  const p = str.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() + 1 === p[1] && d.getUTCDate() === p[2];
}

/** 去掉明显非待办的行（表情、纯符号、过短） */
function isNoise(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (t.length < 4) return true;
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return true;
  if (/^\[?(图片|视频|语音|表情|动画表情|文件|链接)\]?$/.test(t)) return true;
  return false;
}

/**
 * 导入 txt 导出。支持两种常见格式：
 *  A) "昵称 时间\n内容" 的多行块
 *  B) 每行一条
 * 返回 [{ speaker, ts, text }]
 */
function importTxt(content, opts) {
  const options = opts || {};
  const lines = String(content == null ? '' : content).split(/\r?\n/);
  const out = [];
  let cur = null;
  const headRe = /^\s*([^\s：:]{1,24})\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const inlineRe = /^\s*([^\s：:]{1,24})\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/;
  for (const line of lines) {
    if (!line || !line.trim()) { cur = null; continue; }
    const inline = line.match(inlineRe);
    if (inline) {
      out.push({ speaker: inline[1], ts: inline[2].replace(/\//g, '-'), text: inline[3].trim() });
      cur = null;
      continue;
    }
    const head = line.match(headRe);
    if (head) { cur = { speaker: head[1], ts: head[2].replace(/\//g, '-') }; continue; }
    if (cur) {
      out.push({ speaker: cur.speaker, ts: cur.ts, text: line.trim() });
      continue;
    }
    out.push({ speaker: options.speaker || null, ts: options.ts || null, text: line.trim() });
  }
  return out;
}

/**
 * 导入 json 导出。兼容几种常见结构：
 *  - [{ speaker, ts, text }]
 *  - [{ name, time, content }]
 *  - { messages: [...] }
 */
function importJson(content) {
  let data = content;
  if (typeof content === 'string') {
    try { data = JSON.parse(content); } catch (e) { return []; }
  }
  if (data && !Array.isArray(data) && Array.isArray(data.messages)) data = data.messages;
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const text = m.text !== undefined ? m.text : (m.content !== undefined ? m.content : m.message);
    if (text == null) continue;
    const speaker = m.speaker !== undefined ? m.speaker : (m.name !== undefined ? m.name : m.sender);
    const ts = m.ts !== undefined ? m.ts : (m.time !== undefined ? m.time : m.timestamp);
    out.push({ speaker: speaker == null ? null : String(speaker), ts: ts == null ? null : String(ts), text: String(text) });
  }
  return out;
}

/** 自动识别格式（不含去噪去重，由调用方决定） */
function importChat(content, opts) {
  const s = String(content == null ? '' : content).trim();
  if (!s) return [];
  if (s.startsWith('[') || s.startsWith('{')) {
    const j = importJson(content);
    if (j.length) return j;
  }
  return importTxt(content, opts);
}

/** 去空去重（同 speaker+同文本只留一条） */
function dedupeSegments(segments) {
  const seen = new Set();
  const out = [];
  for (const s of segments || []) {
    if (isNoise(s.text)) continue;
    const key = (s.speaker || '') + '|' + String(s.text).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ speaker: s.speaker || null, ts: s.ts || null, text: String(s.text).trim() });
  }
  return out;
}

/**
 * extractTodosWithLlm —— extractor 模型版待办提取（架构变更后的生产入口）
 *
 * 认知判断（科目/日期/时间/歧义）全部交给 extractor 模型（prompt 见 llm/roles.js）；
 * 本函数只做 schema 归一化与分流（confidence 裁剪、date/time 格式校验），
 * 这些是确定性校验，不算规则判断。
 * 用户选择"纯模型，删掉兜底"：模型不可用返回 ok:false，不退回规则实现。
 */
async function extractTodosWithLlm(input, opts) {
  const options = opts || {};
  const llm = options.llm;
  if (!llm || typeof llm.chatJson !== 'function') {
    throw new Error('extractTodosWithLlm 需要 opts.llm（createLlmClient 的返回值）');
  }
  const now = options.now || Date.now();
  const chatText = Array.isArray(input)
    ? input.map(s => (s.speaker ? s.speaker + ': ' : '') + String(s.text == null ? '' : s.text)).join('\n')
    : String(input == null ? '' : input);

  const today = options.today || baseDate(now).date;
  const roleDefs = require('./llm/roles').roles;
  const user = roleDefs.extractor.buildUser({ chat: chatText, today, now: isoNow(now) });
  const res = await llm.chatJson('extractor', roleDefs.extractor.system, user);
  if (!res.ok) {
    return { ok: false, error: res.error, todos: [], pendingConfirm: [], all: [], llm: res };
  }

  const rawTodos = Array.isArray(res.data.todos) ? res.data.todos : [];
  const out = [];
  for (const t of rawTodos) {
    if (!t || typeof t !== 'object') continue;
    const conf = Number(t.confidence);
    const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.3;
    const ambiguous = t.ambiguous === true;
    const date = typeof t.date === 'string' && validDate(t.date) ? t.date : null;
    const timeRaw = typeof t.time === 'string' && /^\d{1,2}:\d{2}$/.test(t.time) ? t.time : null;
    let time = null;
    if (timeRaw) {
      const ph = Number(timeRaw.split(':')[0]), pm = Number(timeRaw.split(':')[1]);
      time = (ph >= 0 && ph <= 23 && pm >= 0 && pm <= 59) ? timeRaw : null;
    }
    const ddl = date ? (time ? date + 'T' + time + ':00+08:00' : date) : null;
    out.push({
      subject: typeof t.subject === 'string' && t.subject.trim() ? t.subject.trim() : '杂项',
      content: typeof t.content === 'string' ? t.content : '',
      material: null,
      date, time, ddl,
      duration: null,
      source: 'chat_llm',
      confidence,
      quote: typeof t.quote === 'string' ? t.quote : '',
      status: (confidence < CONFIRM_THRESHOLD || ambiguous || !date) ? 'pending_confirm' : 'ready',
      ambiguous,
      ambiguousCandidates: [],
      ambiguousNote: typeof t.ambiguousNote === 'string' ? t.ambiguousNote : '',
      reasons: ['extractor 模型提取' + (ambiguous ? '；' + String(t.ambiguousNote || '') : '')]
    });
  }
  const todos = out.filter(r => r.status === 'ready');
  const pendingConfirm = out.filter(r => r.status === 'pending_confirm');
  return { ok: true, todos, pendingConfirm, all: out, llm: res };
}

/** ISO 串（+08:00），供 prompt 里的"当前时间" */
function isoNow(now) {
  const d = now instanceof Date ? new Date(now.getTime() + 8 * 3600000) : new Date(Number(now) + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+08:00';
}

module.exports = {
  extractTodosWithLlm,
  importTxt, importJson, importChat, dedupeSegments, isNoise,
  validDate, baseDate, pad, isoNow, CONFIRM_THRESHOLD
};
