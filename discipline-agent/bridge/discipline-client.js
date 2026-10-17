'use strict';
/**
 * discipline-client.js —— 前端接入 discipline-agent 的封装（可被 haipigua web/ 直接引入）
 *
 * 用法（浏览器，与 haipigua 的 model-client.js 同风格）：
 *   const dc = createDisciplineClient({ base: '' });          // 同源（经 preview 反代）
 *   const dc = createDisciplineClient({ base: 'http://127.0.0.1:8879' });  // 直连
 *
 *   await dc.health();
 *   const r = await dc.start({ state: {...} });   // 启动，下发 L0
 *   const r = await dc.tick({ state: {...} });    // 推进一次
 *   await dc.ack(r.instructionId);                // 已展示
 *   await dc.complete(r.instructionId);           // 该步完成 → 自动撤销还原
 *   await dc.restore();                           // 一键还原（只动文件）
 *   await dc.state();                             // 轮询状态
 *   await dc.audit({ action: 'byTask', taskId }); // 审计查询
 *
 * 边界：前端只读。所有文件操作都由 A 侧在 workRoot 内完成，前端不碰文件系统。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createDisciplineClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /** 前端可识别是"哪一级该演什么"，与 A 侧契约一致 */
  const LEVEL_ACTION = Object.freeze({
    L0: 'notify',
    L1: 'popup_countdown',
    L2: 'spawn_bugs',
    L3: 'screen_flash',
    L4: 'shuffle_desktop',
    L5: 'quarantine_files'
  });

  /** 前端动作（B 侧自己渲染）；其余是本地动作，A 侧执行，前端只展示 */
  const FRONTEND_ACTIONS = Object.freeze(['notify', 'popup_countdown', 'spawn_bugs', 'screen_flash']);
  const LOCAL_ACTIONS = Object.freeze(['shuffle_desktop', 'quarantine_files', 'revoke_all']);

  function createDisciplineClient(opts) {
    const o = opts || {};
    const base = (o.base === undefined ? '' : o.base).replace(/\/$/, '');
    const timeout = o.timeout || 15000;

    async function req(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
      let out = null;
      try { out = await res.json(); } catch (e) { out = null; }
      if (!res.ok || (out && out.error)) {
        const err = new Error((out && out.error && out.error.message) || ('请求未完成（HTTP ' + res.status + '）'));
        err.code = (out && out.error && out.error.code) || 'HTTP_' + res.status;
        err.status = res.status;
        err.detail = out && out.error;
        throw err;
      }
      return out;
    }

    /** 把一条指令翻译成前端该做的事（B 侧渲染入口） */
    function describe(res) {
      if (!res || !res.action) return { kind: 'none', level: res && res.level, text: res && res.reason };
      const isFrontend = FRONTEND_ACTIONS.indexOf(res.action) !== -1;
      const text = {
        notify: '轻提醒（角标/提示音）',
        popup_countdown: '弹窗 + 倒计时 + 开始按钮',
        spawn_bugs: '满屏虫子（带关闭倒计时）',
        screen_flash: '整机闪屏（全屏表现，可立即退出）',
        shuffle_desktop: '已打乱桌面文件名（可在审计里看清单，一键可还原）',
        quarantine_files: '已把指定文件移入隔离区（加密保存，一键可还原）',
        revoke_all: '已撤销全部强制并还原文件'
      }[res.action] || res.action;
      return {
        kind: isFrontend ? 'frontend' : 'local',
        level: res.level,
        action: res.action,
        payload: res.payload || null,
        reversible: res.reversible === true,
        instructionId: res.instructionId,
        explain: res.reason,
        text
      };
    }

    return {
      LEVEL_ACTION,
      FRONTEND_ACTIONS,
      LOCAL_ACTIONS,
      describe,

      health: () => req('GET', '/api/health'),
      start: input => req('POST', '/api/discipline/start', input || {}),
      tick: input => req('POST', '/api/discipline/tick', input || {}),
      ack: instructionId => req('POST', '/api/discipline/ack', { instructionId }),
      complete: (instructionId, reason) => req('POST', '/api/discipline/complete', { instructionId, reason }),
      revoke: reason => req('POST', '/api/discipline/revoke', { reason }),
      restore: () => req('POST', '/api/discipline/restore', {}),
      state: () => req('GET', '/api/discipline/state'),
      audit: filter => req('POST', '/api/discipline/audit', filter || {})
    };
  }

  return createDisciplineClient;
});
