'use strict';
/**
 * learning/store.js —— 学习记录 JSON 持久化（M-K §3.8，Node 侧）
 *
 * 红线：
 *  - 算法无状态（状态随请求传入），持久化留 Node 侧——本文件不写任何调度/评分/销账数字。
 *  - `cleared` 只由 C# 侧 SaleStateMachine 写（transition 结果落盘即视为 C# 已判）。
 *    本层只做存储，不自行改写状态字段。
 *  - 原子写（tmp + rename）；损坏文件拒绝加载（抛错，不静默重置）。
 *  - 迁移器保留接口不实现历史迁移（§3.1）。
 *
 * 记录结构（version 1）：
 * {
 *   "version": 1,
 *   "wVersion": "w0-w20-default",
 *   "kps": {
 *     "<kpId>": {
 *       "name": "知识点名",
 *       "memory": {"stability": 5, "difficulty": 4.99} | null,
 *       "sale": {"status": "Open", "streak": 0, "attempts": 0, "weightedScorePct": 0} | null,
 *       "attempts": [{"correct": true, "accuracy": 0.9, "selfConf": 4, "at": "<ISO>"}],
 *       "dueAt": "<ISO>" | null
 *     }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const CURRENT_VERSION = 1;

/** 迁移器接口占位：历史迁移不实现（§3.1），仅保留注册点 */
const MIGRATORS = {
  // 1: (data) => ({ ...data, version: 2 }),
};

function emptyData() {
  return { version: CURRENT_VERSION, wVersion: 'w0-w20-default', kps: {} };
}

/**
 * 创建学习记录存储。filePath 不存在 → 首次 load 返回空结构（save 时创建）。
 * 文件损坏 / 版本不识别 → load 抛错（拒绝静默重置）。
 */
function createLearningStore(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('createLearningStore(filePath): filePath 必须非空字符串');
  let data = null;

  function ensureLoaded() {
    if (data) return;
    if (!fs.existsSync(filePath)) { data = emptyData(); return; }
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); }
    catch (e) { throw new Error('learning-store 读取失败: ' + e.message); }
    if (!text.trim()) throw new Error('learning-store 文件为空（损坏）: ' + filePath);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error('learning-store JSON 损坏（拒绝静默重置）: ' + filePath + ' — ' + e.message); }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.version !== 'number')
      throw new Error('learning-store 版本字段缺失（损坏）: ' + filePath);
    // 迁移链（当前仅 v1；未来版本在此走 MIGRATORS[prev]）
    while (parsed.version < CURRENT_VERSION) {
      const step = MIGRATORS[parsed.version];
      if (!step) throw new Error(`learning-store 无法迁移 v${parsed.version} → v${CURRENT_VERSION}（迁移器未实现，§3.1）`);
      parsed = step(parsed);
    }
    if (parsed.version > CURRENT_VERSION)
      throw new Error(`learning-store 版本过新（v${parsed.version} > 支持 v${CURRENT_VERSION}），拒绝加载`);
    if (typeof parsed.kps !== 'object' || parsed.kps === null) parsed.kps = {};
    data = parsed;
  }

  function save() {
    ensureLoaded();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath); // Windows MoveFileEx 替换已有文件
  }

  function ensureKp(kpId, name) {
    ensureLoaded();
    if (typeof kpId !== 'string' || !kpId) throw new TypeError('kpId 必须非空字符串');
    if (!data.kps[kpId]) data.kps[kpId] = {
      name: name || kpId,
      memory: null,
      sale: null,
      attempts: [],
      dueAt: null
    };
    return data.kps[kpId];
  }

  return {
    // ── 整体 ──
    load() { ensureLoaded(); return JSON.parse(JSON.stringify(data)); },
    save,

    // ── FSRS 记忆状态（来自 kernel review/interval 结果，Node 只存取）──
    getMemory(kpId) { ensureLoaded(); return data.kps[kpId] ? JSON.parse(JSON.stringify(data.kps[kpId].memory)) : null; },
    setMemory(kpId, state) {
      // state 由 kernel review 输出，字段名与协议一致
      const kp = ensureKp(kpId);
      if (state === null) { kp.memory = null; return; }
      if (typeof state.stability !== 'number' || typeof state.difficulty !== 'number')
        throw new TypeError('setMemory(kpId, {stability, difficulty}): 字段缺失');
      kp.memory = { stability: state.stability, difficulty: state.difficulty };
    },

    // ── 销账状态（来自 kernel transition 结果，含 cleared——只读落盘）──
    getSale(kpId) { ensureLoaded(); return data.kps[kpId] ? JSON.parse(JSON.stringify(data.kps[kpId].sale)) : null; },
    setSale(kpId, state) {
      const kp = ensureKp(kpId);
      if (state === null) { kp.sale = null; return; }
      const { status, streak, attempts, weightedScorePct } = state;
      if (typeof status !== 'string') throw new TypeError('setSale: status 必须为字符串');
      kp.sale = {
        status,
        streak: Number(streak) || 0,
        attempts: Number(attempts) || 0,
        weightedScorePct: Number(weightedScorePct) || 0
      };
    },

    // ── 作答流水（probe / transition 原始输入留档）──
    appendAttempt(kpId, attempt, name) {
      const kp = ensureKp(kpId, name);
      if (!attempt || typeof attempt !== 'object') throw new TypeError('appendAttempt(kpId, attempt): attempt 对象必填');
      kp.attempts.push({
        correct: !!attempt.correct,
        accuracy: Number(attempt.accuracy) || 0,
        selfConf: Number(attempt.selfConf) || 0,
        at: attempt.at || new Date().toISOString()
      });
      return kp.attempts.length;
    },
    listAttempts(kpId) { ensureLoaded(); return data.kps[kpId] ? data.kps[kpId].attempts.slice() : []; },

    // ── 到期复习队列（due_review 义务来源）──
    setDue(kpId, isoDate, name) {
      const kp = ensureKp(kpId, name);
      kp.dueAt = isoDate || null;
    },
    listDue(nowMs) {
      ensureLoaded();
      const now = nowMs || Date.now();
      return Object.entries(data.kps)
        .filter(([, kp]) => kp.dueAt && new Date(kp.dueAt).getTime() <= now)
        .map(([kpId, kp]) => ({ kpId, name: kp.name, dueAt: kp.dueAt }));
    },
    clearDue(kpId) { ensureLoaded(); if (data.kps[kpId]) data.kps[kpId].dueAt = null; },

    // ── 元数据 ──
    meta() { ensureLoaded(); return { version: data.version, wVersion: data.wVersion, kpCount: Object.keys(data.kps).length }; }
  };
}

module.exports = { createLearningStore, CURRENT_VERSION };
