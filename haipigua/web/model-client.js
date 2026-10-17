(function (global) {
  'use strict';
  async function status() {
    try {
      const result = await fetch('/api/health', {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000)});
      if (!result.ok) return {ready: false, message: '模型服务未启动'};
      const data = await result.json();
      return {...data, ready: data.ready === true || data.configured === true};
    } catch { return {ready: false, message: '模型服务未启动'}; }
  }
  async function turn(payload) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110000);
    try {
      const response = await fetch('/api/agent', {method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'omit', body: JSON.stringify(payload), signal: controller.signal});
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Error(result?.error?.message || '模型服务暂时不可用，这次内容尚未写入。');
      if (!result || result.source !== 'model') throw Error('没有收到完整的模型结果，原文还留在输入框。');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('模型这次等得有点久，原文还在。可以稍后重试，或手动切换本地体验。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  global.HaipiguaModel = Object.freeze({status, turn});
})(window);
