'use strict';
/**
 * llm-client.test.js —— LLM 客户端测试（OpenAI 兼容，零第三方依赖）
 * 运行：node llm-client.test.js
 *
 * 测：
 *   - 多角色配置（每个角色可不同模型/base/key）
 *   - chatJson 的请求体构造（response_format、Authorization、messages）
 *   - OpenAI 响应外壳解析 + 松散 JSON 解析（```json 围栏、前后废话）
 *   - 传输可注入（不发真实请求）
 *   - 审计 JSONL 落盘
 *   - 失败路径：HTTP 错误、超时、非 JSON 输出、未配置
 *   - isReady / readinessReport
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLlmClient, parseJsonLoose } = require('./llm/llm-client');
const { ok, equal, contains, createSuite } = require('./test-util');

const suite = createSuite('llm-client.test.js');

/** 桩传输：记录请求，按给定脚本返回 */
function stubTransport(handler) {
  const calls = [];
  return {
    calls,
    async post(url, body, headers, timeoutMs) {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      calls.push({ url, body: parsed, headers, timeoutMs, raw: body });
      return handler(calls.length - 1, parsed);
    }
  };
}

/** OpenAI 风格响应外壳 */
function openAiReply(obj) {
  return JSON.stringify({
    id: 'chatcmpl-stub',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof obj === 'string' ? obj : JSON.stringify(obj) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  });
}

function makeClient(transport, extra) {
  const auditPath = extra && extra.auditPath;
  return createLlmClient({
    apiBase: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    roles: {
      extractor: { model: 'gpt-4o-mini', temperature: 0 },
      planner: { model: 'gpt-4o-mini', temperature: 0.3 },
      strategist: { model: 'gpt-4o', temperature: 0 }
    },
    transport: (url, body, headers, timeoutMs) => transport.post(url, body, headers, timeoutMs),
    auditPath,
    log() {}
  });
}

// ---------- 请求构造 ----------

suite.test('chatJson 发 POST 到 /chat/completions，带鉴权头与 JSON 模式', async () => {
  const tr = stubTransport(() => openAiReply({ ok: true }));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', '你是提取器', '帮我提取');
  ok(res.ok, '成功');
  equal(tr.calls.length, 1, '一次请求');
  const c = tr.calls[0];
  equal(c.url, 'https://api.openai.com/v1/chat/completions', 'URL');
  equal(c.headers.Authorization, 'Bearer sk-test', '鉴权头');
  equal(c.body.model, 'gpt-4o-mini', 'extractor 用 gpt-4o-mini');
  equal(c.body.temperature, 0, 'temperature 透传');
  equal(c.body.response_format.type, 'json_object', '强制 JSON 模式');
  equal(c.body.messages.length, 2, 'system + user');
  equal(c.body.messages[0].role, 'system', '第一条 system');
  equal(c.body.messages[1].role, 'user', '第二条 user');
  contains(JSON.stringify(c.body.messages[1].content), '帮我提取', 'user 内容');
});

suite.test('不同角色可用不同模型（多模型合作）', async () => {
  const tr = stubTransport(() => openAiReply({ level: 'L1' }));
  const client = makeClient(tr);
  await client.chatJson('planner', 'sys', 'u');
  equal(tr.calls[0].body.model, 'gpt-4o-mini', 'planner 模型');
  await client.chatJson('strategist', 'sys', 'u');
  equal(tr.calls[1].body.model, 'gpt-4o', 'strategist 用 gpt-4o');
});

suite.test('base 带尾斜杠也能拼对 URL', async () => {
  const tr = stubTransport(() => openAiReply({}));
  const client = createLlmClient({
    apiBase: 'https://api.openai.com/v1/', apiKey: 'k',
    transport: (u, b) => tr.post(u, b, {}, 0), log() {}
  });
  await client.chatJson('extractor', 's', 'u');
  equal(tr.calls[0].url, 'https://api.openai.com/v1/chat/completions', '尾斜杠被吃掉');
});

suite.test('角色级 base/key 覆盖全局', async () => {
  const tr = stubTransport(() => openAiReply({}));
  const client = createLlmClient({
    apiBase: 'https://api.openai.com/v1', apiKey: 'global-key',
    roles: { observer: { model: 'qwen-vl-max', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: 'ali-key', temperature: 0 } },
    transport: (u, b, h) => tr.post(u, b, h, 0), log() {}
  });
  await client.chatJson('observer', 's', 'u');
  equal(tr.calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '角色自己的 base');
  equal(tr.calls[0].headers.Authorization, 'Bearer ali-key', '角色自己的 key');
});

suite.test('多模态：user 传数组时按 content 段透传', async () => {
  const tr = stubTransport(() => openAiReply({ person: true }));
  const client = makeClient(tr);
  await client.chatJson('observer', 'sys', [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
  ]);
  const content = tr.calls[0].body.messages[1].content;
  ok(Array.isArray(content), 'content 是段数组');
  equal(content[0].type, 'text', '文本段');
  equal(content[1].type, 'image_url', '图片段');
  contains(content[1].image_url.url, 'base64,AAAA', 'data URL');
});

// ---------- 响应解析 ----------

suite.test('解析 OpenAI 外壳', async () => {
  const tr = stubTransport(() => openAiReply({ todos: [{ subject: '数学' }] }));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.data.todos[0].subject, '数学', '解析出 JSON');
  equal(res.model, 'gpt-4o-mini', '带模型名');
});

suite.test('模型回 ```json 围栏也能解析', async () => {
  const tr = stubTransport(() => openAiReply('```json\n{"a":1,"b":[2,3]}\n```'));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.data.a, 1, '围栏内 JSON');
  equal(res.data.b[1], 3, '数组');
});

suite.test('模型回废话+JSON 混合也能抠出来', async () => {
  const tr = stubTransport(() => openAiReply('好的，结果是：\n{"x":"y"}\n希望对你有帮助'));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.data.x, 'y', '抠出 JSON');
});

suite.test('模型回纯数组也能解析', async () => {
  const tr = stubTransport(() => openAiReply('[1,2,3]'));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  ok(Array.isArray(res.data), '数组');
  equal(res.data.length, 3, '3 个元素');
});

suite.test('模型输出不是 JSON → ok:false 带 raw 片段', async () => {
  const tr = stubTransport(() => openAiReply('我不知道怎么回答这个问题'));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.ok, false, '失败');
  contains(res.error, 'JSON', '错误说明');
  ok(res.raw && res.raw.indexOf('不知道') !== -1, '带原文片段');
});

suite.test('网关直接回纯 JSON（无 OpenAI 外壳）也能用', async () => {
  const tr = stubTransport(() => JSON.stringify({ direct: true }));
  const client = makeClient(tr);
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.data.direct, true, '直连 JSON');
});

// ---------- 失败路径 ----------

suite.test('传输抛错 → ok:false 不崩', async () => {
  const client = createLlmClient({
    apiBase: 'https://api.openai.com/v1', apiKey: 'k', log() {},
    transport: async () => { throw new Error('HTTP 429: Too Many Requests'); }
  });
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.ok, false, '失败');
  contains(res.error, '429', '错误原因');
});

suite.test('未配置 base/key → ok:false 且不发请求', async () => {
  const tr = stubTransport(() => openAiReply({}));
  const client = createLlmClient({
    apiBase: '', apiKey: '', log() {},
    transport: (u, b) => tr.post(u, b, {}, 0)
  });
  const res = await client.chatJson('extractor', 's', 'u');
  equal(res.ok, false, '失败');
  contains(res.error, 'base', '提示缺 base');
  equal(tr.calls.length, 0, '没发请求');
});

// ---------- 配置查询 ----------

suite.test('isReady / readinessReport 反映配置状态', () => {
  const client = makeClient(stubTransport(() => openAiReply({})));
  equal(client.isReady('extractor'), true, 'extractor 就绪');
  equal(client.isReady('observer'), true, 'observer 有默认模型也算就绪');
  const report = client.readinessReport();
  ok(report.strategist.ready, 'strategist 就绪');
  equal(report.strategist.model, 'gpt-4o', '模型名');
  const bare = createLlmClient({ apiBase: '', apiKey: '', log() {} });
  equal(bare.isReady('extractor'), false, '空配置不就绪');
  equal(bare.readinessReport().extractor.missing, 'base', '缺 base');
});

// ---------- 审计 ----------

suite.test('调用写审计 JSONL（成功与失败都记）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-audit-'));
  const auditPath = path.join(root, 'audit.jsonl');
  const tr = stubTransport(() => openAiReply({ ok: 1 }));
  const client = makeClient(tr, { auditPath });
  await client.chatJson('extractor', 's', 'u');
  await client.chatJson('planner', 's', 'u');
  ok(fs.existsSync(auditPath), '审计文件存在');
  const rows = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  equal(rows.length, 2, '两条');
  equal(rows[0].role, 'extractor', '角色');
  equal(rows[0].ok, true, '成功');
  equal(rows[1].role, 'planner', '第二个角色');
  ok(rows[0].ts, '带时间戳');
  ok(typeof rows[0].ms === 'number', '带耗时');
  fs.rmSync(root, { recursive: true, force: true });
});

suite.test('审计失败也记（含 error）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-audit2-'));
  const auditPath = path.join(root, 'audit.jsonl');
  const client = createLlmClient({
    apiBase: 'https://api.openai.com/v1', apiKey: 'k', auditPath, log() {},
    transport: async () => { throw new Error('boom'); }
  });
  await client.chatJson('strategist', 's', 'u');
  const rows = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  equal(rows[0].ok, false, '失败');
  contains(rows[0].error, 'boom', '错误内容');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- parseJsonLoose 单元 ----------

suite.test('parseJsonLoose 处理各种形态', () => {
  equal(parseJsonLoose('{"a":1}').a, 1, '纯 JSON');
  equal(parseJsonLoose('```json\n{"a":1}\n```').a, 1, '围栏');
  equal(parseJsonLoose('x{"a":1}y').a, 1, '夹带');
  equal(parseJsonLoose('[1,2]')[0], 1, '数组');
  equal(parseJsonLoose(null), null, 'null → null');
  equal(parseJsonLoose('', ), null, '空串 → null');
  equal(parseJsonLoose('完全不是json'), null, '无 JSON → null');
});

suite.runAsync().then(result => {
  process.exit(result.failures.length ? 1 : 0);
});
