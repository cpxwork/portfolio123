'use strict';
/**
 * chat-sense.test.js —— A-M1 测试（模型路径版）
 * 运行：node chat-sense.test.js
 *
 * 架构变更后：认知判断（科目/日期/时间/歧义）全部交给 extractor 模型。
 * 本测试用**桩 LLM**（不发真实请求）验证：
 *   1. extractTodosWithLlm 的调用契约（system prompt、user prompt 含今天日期）
 *   2. 模型输出的归一化（confidence 裁剪、date/time 格式校验）
 *   3. 低置信度 / ambiguous / 无日期 → pending_confirm
 *   4. 模型不可用时不静默兜底（返回 ok:false）
 *   5. 导入/去噪这类纯工程逻辑仍然可用（它们不是"判断"，是数据管道）
 *
 * 规则版实现（extractTodos/extractOne）已从生产路径移除，不再测试。
 */

const {
  extractTodosWithLlm, importTxt, importJson, importChat, dedupeSegments, isNoise
} = require('./chat-sense');
const { createLlmClient } = require('./llm/llm-client');
const { roles } = require('./llm/roles');
const { ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('chat-sense.test.js');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/**
 * 造一个桩 LLM：不发请求，按给定回复返回。
 * @param {object|Function} reply 对象则固定返回；函数则接收 (role, system, user) 后返回
 */
function stubLlm(reply) {
  const calls = [];
  return {
    calls,
    async chatJson(role, system, user) {
      calls.push({ role, system, user });
      const out = typeof reply === 'function' ? reply(role, system, user) : reply;
      if (out && out.__throw) return { ok: false, error: out.__throw };
      return { ok: true, data: out, raw: JSON.stringify(out), model: 'stub-model', ms: 1 };
    }
  };
}

const GOOD_REPLY = {
  todos: [
    { subject: '数学', content: '写数学作业', date: '2026-10-17', time: null, quote: '明天要交数学作业', confidence: 0.95, ambiguous: false, ambiguousNote: '' },
    { subject: '英语', content: '背单词', date: '2026-10-23', time: null, quote: '英语单词周五前背完', confidence: 0.85, ambiguous: false, ambiguousNote: '' },
    { subject: '数学', content: '不确定', date: null, time: null, quote: '数学作业是明天还是后天？', confidence: 0.35, ambiguous: true, ambiguousNote: '明天或后天二选一' }
  ]
};

// ---------- 调用契约 ----------

suite.test('extractTodosWithLlm 用 extractor 角色，prompt 含今天日期与聊天原文', async () => {
  const llm = stubLlm(GOOD_REPLY);
  const res = await extractTodosWithLlm('小明: 明天要交数学作业', { llm, now: NOW });
  ok(res.ok, '返回 ok');
  equal(llm.calls.length, 1, '只调一次模型');
  const c = llm.calls[0];
  equal(c.role, 'extractor', '用 extractor 角色');
  equal(c.system, roles.extractor.system, 'system prompt 用 roles 定义');
  contains(c.user, '2026-10-16', 'user prompt 带今天日期');
  contains(c.user, '明天要交数学作业', 'user prompt 带聊天原文');
  contains(c.user, '只输出 JSON', 'user prompt 要求 JSON');
});

suite.test('extractTodosWithLlm 缺 llm 参数直接抛错（不静默兜底）', async () => {
  let threw = 0;
  try { await extractTodosWithLlm('x', { now: NOW }); } catch (e) { threw++; contains(e.message, 'opts.llm', '错误说明缺 llm'); }
  equal(threw, 1, '必须抛错');
});

suite.test('模型不可用 → 返回 ok:false，不退回规则实现', async () => {
  const llm = stubLlm({ __throw: 'HTTP 401: 无效的 API Key' });
  const res = await extractTodosWithLlm('明天要交数学作业', { llm, now: NOW });
  equal(res.ok, false, 'ok=false');
  contains(res.error, '401', '带错误原因');
  equal(res.todos.length, 0, '不产出待办（不兜底）');
});

// ---------- 输出归一化 ----------

suite.test('模型输出 → 结构化待办（ready / pending_confirm 分流）', async () => {
  const llm = stubLlm(GOOD_REPLY);
  const res = await extractTodosWithLlm('小明: 明天要交数学作业', { llm, now: NOW });
  equal(res.todos.length, 2, '2 条 ready');
  equal(res.pendingConfirm.length, 1, '1 条待确认');
  const math = res.todos.find(t => t.subject === '数学');
  equal(math.date, '2026-10-17', '日期');
  equal(math.confidence, 0.95, '置信度');
  equal(math.quote, '明天要交数学作业', '保留原话引用');
  equal(math.source, 'chat_llm', '来源标记 chat_llm');
  ok(math.ddl, '有 ddl');
});

suite.test('有时间的待办 ddl 拼成 ISO（带 +08:00）', async () => {
  const llm = stubLlm({ todos: [{ subject: '物理', content: '交实验数据', date: '2026-10-18', time: '16:00', quote: '后天下午四点交', confidence: 0.9, ambiguous: false }] });
  const res = await extractTodosWithLlm('后天下午四点交物理实验数据', { llm, now: NOW });
  equal(res.todos[0].ddl, '2026-10-18T16:00:00+08:00', 'ddl ISO 带时区');
});

suite.test('confidence 越界被裁剪到 0~1', async () => {
  const llm = stubLlm({ todos: [
    { subject: '数学', content: 'a', date: '2026-10-17', confidence: 5, quote: 'q', ambiguous: false },
    { subject: '语文', content: 'b', date: '2026-10-17', confidence: -2, quote: 'q', ambiguous: false }
  ] });
  const res = await extractTodosWithLlm('x', { llm, now: NOW });
  equal(res.all[0].confidence, 1, '5 → 1');
  equal(res.all[1].confidence, 0, '-2 → 0');
  equal(res.all[1].status, 'pending_confirm', '置信度 0 必须待确认');
});

suite.test('date/time 格式不合法 → 当 null，并因此进待确认', async () => {
  const llm = stubLlm({ todos: [
    { subject: '数学', content: 'a', date: '下周五', time: '晚上', quote: 'q', confidence: 0.9, ambiguous: false },
    { subject: '语文', content: 'b', date: '2026-13-45', time: '25:99', quote: 'q', confidence: 0.9, ambiguous: false }
  ] });
  const res = await extractTodosWithLlm('x', { llm, now: NOW });
  for (const t of res.all) {
    equal(t.date, null, '非法日期当 null: ' + JSON.stringify(t.date));
    equal(t.time, null, '非法时间当 null');
    equal(t.status, 'pending_confirm', '无日期必须待确认');
  }
});

suite.test('歧义样例必须进 pending_confirm（模型标 ambiguous）', async () => {
  const llm = stubLlm({ todos: [{ subject: '数学', content: '写作业', date: null, time: null, quote: '明天还是后天交数学作业？', confidence: 0.3, ambiguous: true, ambiguousNote: '明天或后天' }] });
  const res = await extractTodosWithLlm('明天还是后天交数学作业？', { llm, now: NOW });
  equal(res.pendingConfirm.length, 1, '进待确认');
  equal(res.all[0].ambiguous, true, '标记 ambiguous');
  equal(res.all[0].ambiguousNote, '明天或后天', '保留歧义说明');
  ok(res.all[0].confidence < 0.6, '置信度低');
});

suite.test('模型返回空 todos → 空结果，不编造', async () => {
  const llm = stubLlm({ todos: [] });
  const res = await extractTodosWithLlm('哈哈哈今天天气不错', { llm, now: NOW });
  equal(res.todos.length, 0, '无 ready');
  equal(res.pendingConfirm.length, 0, '无待确认');
});

suite.test('模型返回缺字段的 todos 不崩（有默认值）', async () => {
  const llm = stubLlm({ todos: [{ quote: 'q' }, null, '不是对象', { subject: '', content: 'x', date: '2026-10-17', confidence: 0.8 }] });
  const res = await extractTodosWithLlm('x', { llm, now: NOW });
  ok(Array.isArray(res.all), '返回数组');
  ok(res.all.every(t => t && typeof t.subject === 'string' && t.subject.length > 0), 'subject 都有非空默认值');
});

suite.test('模型返回的 todos 不是数组 → 当空处理', async () => {
  const llm = stubLlm({ todos: '我全都做完了' });
  const res = await extractTodosWithLlm('x', { llm, now: NOW });
  equal(res.all.length, 0, '非数组按空处理');
});

suite.test('数组输入（已结构化片段）也能喂给模型', async () => {
  const llm = stubLlm(GOOD_REPLY);
  const segs = [
    { speaker: '小明', ts: '2026-10-16 20:30', text: '明天要交数学作业' },
    { speaker: '小红', ts: '2026-10-16 20:31', text: '英语单词周五前背完' }
  ];
  const res = await extractTodosWithLlm(segs, { llm, now: NOW });
  ok(res.ok, 'ok');
  contains(llm.calls[0].user, '小明: 明天要交数学作业', '片段带说话人拼进 prompt');
  contains(llm.calls[0].user, '小红: 英语单词周五前背完', '第二条也在');
});

suite.test('opts.today 可覆盖今天日期', async () => {
  const llm = stubLlm(GOOD_REPLY);
  await extractTodosWithLlm('x', { llm, now: NOW, today: '2030-01-01' });
  contains(llm.calls[0].user, '2030-01-01', '用覆盖的今天日期');
});

// ---------- 数据管道（纯工程，不涉及判断） ----------

suite.test('txt 导入：块格式与单行格式', () => {
  const block = '小明 2026-10-16 20:30\n明天要交数学作业\n小红 2026-10-16 20:31\n英语单词也别忘了\n';
  const segs = importTxt(block);
  equal(segs.length, 2, '两条');
  equal(segs[0].speaker, '小明', '说话人');
  contains(segs[0].text, '数学作业', '内容');
});

suite.test('json 导入：多种字段名', () => {
  equal(importJson('[{"speaker":"小明","ts":"1","text":"x"}]').length, 1, 'text 字段');
  equal(importJson('[{"name":"小红","time":"1","content":"x"}]').length, 1, 'content 字段');
  equal(importJson('{"messages":[{"text":"x"}]}').length, 1, 'messages 包装');
  equal(importJson('不是json').length, 0, '坏 JSON 返回空');
});

suite.test('importChat 自动识别 + dedupeSegments 去空去重', () => {
  const raw = importChat('[{"text":"明天要交数学作业"},{"text":"明天要交数学作业"},{"text":""},{"text":"[图片]"}]');
  equal(raw.length, 4, 'importChat 原样切出 4 条');
  equal(dedupeSegments(raw).length, 1, '去重去噪后 1 条');
});

suite.test('isNoise 过滤空/过短/占位符', () => {
  equal(isNoise(''), true, '空');
  equal(isNoise('嗯'), true, '过短');
  equal(isNoise('[图片]'), true, '图片占位');
  equal(isNoise('明天要交数学作业'), false, '正常句子');
});

// ---------- 角色定义完整性 ----------

suite.test('extractor 角色的 system prompt 定义了输出 schema', () => {
  contains(roles.extractor.system, 'todos', '要求 todos 字段');
  contains(roles.extractor.system, 'confidence', '要求 confidence');
  contains(roles.extractor.system, 'ambiguous', '要求 ambiguous');
  contains(roles.extractor.system, 'quote', '要求原话引用');
  contains(roles.extractor.system, '只输出 JSON', '要求只输出 JSON');
});

suite.test('extractor 的 buildUser 拼今天日期 + 聊天原文', () => {
  const u = roles.extractor.buildUser({ chat: '测试聊天', today: '2026-10-16', now: '2026-10-16T20:30:00+08:00' });
  contains(u, '2026-10-16', '今天日期');
  contains(u, '测试聊天', '聊天原文');
});

// 异步用例必须走 runAsync：同步 run 遇到 Promise 用例会显式报错（防假绿机制）
suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});
