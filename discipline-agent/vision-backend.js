'use strict';
/**
 * vision-backend.js —— 多模态大模型后端（OpenAI 兼容格式）
 *
 * 用途：作为 `state-sensor.js` 的可选推理后端，替代本地 YOLOv8n-pose。
 * 它把抓到的帧（base64 图片）发给多模态模型，让模型回答
 * "画面里是什么姿态、在哪个区域、质量如何"，再转成 state-sensor 的
 * `inferPose` 返回形状。
 *
 * 为什么单独放一个文件：
 *   - `state-sensor.js` 保持零依赖、可插拔（测试用假后端，不联网）。
 *   - 这个文件只在真实部署时被宿主 require；它自己也是零第三方依赖
 *     （用 Node 内置 http/https，不用 openai SDK），避免为一次 HTTP
 *     调用拖进整个 SDK。
 *   - 契约不变：仍是 `{ person, posture, zone, confidence, quality }`。
 *
 * 配置（全部来自环境变量或调用参数，不写死）：
 *   VISION_API_BASE   例如 https://api.openai.com/v1  （必填）
 *   VISION_API_KEY    API Key（必填）
 *   VISION_MODEL      模型名，例如 gpt-4o-mini / qwen-vl-max（必填）
 *   VISION_TIMEOUT_MS 超时，默认 20000
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** posture 合法值（与 state-sensor 契约一致） */
const POSTURES = ['lying', 'sitting', 'standing', 'absent', 'unknown'];
/** zone 合法值 */
const ZONES = ['bed', 'desk', 'other', 'none'];

/** 发给模型的指令：要求只回 JSON，字段固定 */
const PROMPT = [
  '你是姿态识别器。看这张图片，判断画面中人物的状态。',
  '只输出 JSON，不要任何解释、不要 markdown 代码块。',
  '字段：',
  '  person: 布尔，画面中有没有人',
  '  posture: 只能是 lying/sitting/standing/absent/unknown 之一',
  '  zone: 只能是 bed/desk/other/none 之一（人在床上填 bed，在书桌/电脑桌前填 desk）',
  '  confidence: 0~1 小数，你对这个判断的把握',
  '  quality: 0~1 小数，画面质量（1=清晰，低分=太暗/遮挡/模糊）',
  '如果画面里没有人，posture 填 absent，zone 填 none，confidence 给 0.8 以上。',
  '如果看不清（太暗、被挡住、没有全身），confidence 要低于 0.5。'
].join('\n');

/**
 * createVisionBackend
 * @param {object} opts
 * @param {string} [opts.apiBase] 默认取 env.VISION_API_BASE
 * @param {string} [opts.apiKey]  默认取 env.VISION_API_KEY
 * @param {string} [opts.model]   默认取 env.VISION_MODEL
 * @param {number} [opts.timeoutMs] 默认 20000
 * @param {(url:string, body:string, headers:object, timeoutMs:number)=>Promise<string>} [opts.transport]
 *        可注入的 HTTP 传输（测试用，不发真实请求）
 * @param {(...a:any[])=>void} [opts.log] 日志注入
 */
function createVisionBackend(opts) {
  const options = opts || {};
  const apiBase = options.apiBase || process.env.VISION_API_BASE || '';
  const apiKey = options.apiKey || process.env.VISION_API_KEY || '';
  const model = options.model || process.env.VISION_MODEL || '';
  const timeoutMs = Number(options.timeoutMs || process.env.VISION_TIMEOUT_MS || 20000);
  const log = options.log || function () { };
  const transport = options.transport || defaultTransport;

  function isConfigured() {
    return !!(apiBase && apiKey && model);
  }

  /** 说明当前缺什么（供降级时写 explain） */
  function configProblem() {
    if (!apiBase) return '未配置 VISION_API_BASE';
    if (!apiKey) return '未配置 VISION_API_KEY';
    if (!model) return '未配置 VISION_MODEL';
    return null;
  }

  /**
   * 抓一帧：从 captureFrame 拿到的帧里取 base64 图。
   * 帧形状不做强约定：支持 { jpeg/base64/dataUrl/image } 任意一种。
   * @returns {string|null} data URL 形式的图片，或 null
   */
  function frameToDataUrl(frame) {
    if (!frame || typeof frame !== 'object') return null;
    let raw = frame.dataUrl || frame.data_url || frame.image || frame.jpeg || frame.base64 || frame.imageBase64;
    if (!raw || typeof raw !== 'string') return null;
    if (raw.indexOf('data:') === 0) return raw;
    return 'data:image/jpeg;base64,' + raw;
  }

  /** 从模型回复里抠出 JSON（容忍 ```json 包裹和前后废话） */
  function parseModelJson(text) {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim();
    // 去掉 markdown 代码块围栏
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // 直接解析失败时，抓第一个 { ... } 块
    try {
      return JSON.parse(s);
    } catch (e) {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { return null; }
      }
      return null;
    }
  }

  /** 归一化模型输出为 state-sensor 的 inferPose 形状 */
  function normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const posture = POSTURES.indexOf(obj.posture) !== -1 ? obj.posture : 'unknown';
    const zone = ZONES.indexOf(obj.zone) !== -1 ? obj.zone : 'none';
    const clamp = v => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0.5;
      return n < 0 ? 0 : n > 1 ? 1 : Math.round(n * 100) / 100;
    };
    return {
      person: obj.person === true,
      posture,
      zone,
      confidence: clamp(obj.confidence),
      quality: clamp(obj.quality),
      keypoints: null
    };
  }

  /**
   * inferPose —— 与 state-sensor 的 inferPose 契约完全一致
   * @param {Array} frames state-sensor 传来的帧数组（1~3 帧）
   */
  async function inferPose(frames) {
    if (!isConfigured()) {
      // 未配置 → 返回低质量 unknown，让 state-sensor 走降级路径，
      // 而不是抛异常把整条链路搞崩。
      log('[vision] 未配置，跳过推理:', configProblem());
      return { person: false, posture: 'unknown', zone: 'none', confidence: 0, quality: 0 };
    }
    const arr = Array.isArray(frames) ? frames : [frames];
    const img = frameToDataUrl(arr[0]);
    if (!img) {
      return { person: false, posture: 'unknown', zone: 'none', confidence: 0, quality: 0 };
    }
    const body = JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: img } }
        ]
      }],
      max_tokens: 200,
      temperature: 0
    });
    const url = apiBase.replace(/\/+$/, '') + '/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    };
    let text;
    try {
      const resp = await transport(url, body, headers, timeoutMs);
      text = resp;
    } catch (e) {
      // 网络/超时错误：同样退 unknown，交降级路径处理
      log('[vision] 请求失败:', e && e.message);
      return { person: false, posture: 'unknown', zone: 'none', confidence: 0, quality: 0 };
    }
    // 解析 OpenAI 响应外壳
    let content = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
        content = parsed.choices[0].message.content;
      }
    } catch (e) { /* 有些网关直接回纯文本 */ }
    const obj = parseModelJson(content);
    const norm = normalize(obj);
    if (!norm) {
      log('[vision] 模型输出无法解析，按 unknown 处理');
      return { person: false, posture: 'unknown', zone: 'none', confidence: 0, quality: 0 };
    }
    return norm;
  }

  return { inferPose, isConfigured, configProblem, PROMPT, frameToDataUrl, parseModelJson, normalize };
}

/** 默认 HTTP 传输：Node 内置 http/https，不发真实请求时由测试注入 */
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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时 ' + timeoutMs + 'ms')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { createVisionBackend, PROMPT, POSTURES, ZONES, defaultTransport };
