'use strict';

// Explicit provider catalogue. A key alone never changes the platform: the
// provider, endpoint and model must all be named and allowed here.
const PRICE_NOTE = '元/百万 tokens，取平台展示区间；实际以 AI Ping / 智谱账单为准';

const PROVIDERS = Object.freeze({
  zhipu: Object.freeze({
    id: 'zhipu',
    label: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4.7-flash',
    supportsTools: true,
    supportsJson: true,
    models: Object.freeze({
      'glm-4.7-flash': Object.freeze({label: 'GLM-4.7-Flash', free: true, price: {input: [0, 0], output: [0, 0], currency: 'CNY/1M tokens'}, supportsTools: true, supportsJson: true, thinking: 'disabled'}),
      'glm-4-flash-250414': Object.freeze({label: 'GLM-4-Flash-250414', free: true, price: {input: [0, 0], output: [0, 0], currency: 'CNY/1M tokens'}, supportsTools: true, supportsJson: true})
    })
  }),
  aiping: Object.freeze({
    id: 'aiping',
    label: 'AI Ping',
    url: 'https://aiping.cn/api/v1/chat/completions',
    defaultModel: 'GLM-4.7-Flash',
    supportsTools: false,
    supportsJson: true,
    models: Object.freeze({
      'GLM-4.7-Flash': Object.freeze({label: 'GLM-4.7-Flash', price: {input: [0.5, 1], output: [1.5, 3], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true}),
      'GLM-5.3-Flash': Object.freeze({label: 'GLM-5.3-Flash', price: {input: [0.8, 0.8], output: [1.4, 2.8], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true}),
      'Qwen3.5-Flash': Object.freeze({label: 'Qwen3.5-Flash', price: {input: [0.2, 0.2], output: [2, 2], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true}),
      'DeepSeek-V4-Flash': Object.freeze({label: 'DeepSeek-V4-Flash', price: {input: [1, 1], output: [2, 2], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true}),
      'DeepSeek-V4.1-Flash': Object.freeze({label: 'DeepSeek-V4.1-Flash', price: {input: [0, 1], output: [0, 2], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true}),
      'Step-3.5-Flash': Object.freeze({label: 'Step-3.5-Flash', price: {input: [0.7, 0.7], output: [2.1, 2.1], currency: 'CNY/1M tokens'}, supportsTools: false, supportsJson: true})
    })
  })
});

const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const number = (value, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

function configuration(env = {}) {
  const providerId = clean(env.MODEL_PROVIDER, 30) || 'zhipu';
  const provider = PROVIDERS[providerId];
  const missing = [];
  let reason = '';
  if (!provider) {
    reason = 'PROVIDER_NOT_ALLOWED';
  } else if (env.MODEL_API_URL && env.MODEL_API_URL !== provider.url) {
    reason = 'ENDPOINT_OVERRIDE_NOT_ALLOWED';
  } else if (!env.MODEL_API_KEY) {
    reason = 'KEY_MISSING';
  }
  const modelName = clean(env.MODEL_NAME, 120) || (provider ? provider.defaultModel : '');
  const model = provider?.models[modelName];
  if (provider && !model && !reason) reason = 'MODEL_NOT_ALLOWED';
  const tools = provider ? (env.MODEL_TOOLS === '1' ? true : env.MODEL_TOOLS === '0' ? false : provider.supportsTools) : false;
  const jsonMode = env.MODEL_JSON_MODE === '0' ? false : !!provider?.supportsJson;
  const budgetLimit = number(env.MODEL_BUDGET_CNY, 0, 10000);
  const maxTurns = number(env.MODEL_MAX_TURNS, 1, 60) ?? 60;
  const ready = !reason && !!provider && !!model && !!env.MODEL_API_KEY;
  return {
    ready,
    reason,
    provider: providerId,
    providerLabel: provider?.label || providerId,
    model: modelName,
    modelLabel: model?.label || modelName,
    url: provider?.url || '',
    price: model?.price || null,
    priceNote: PRICE_NOTE,
    supportsTools: tools,
    supportsJson: jsonMode,
    thinking: model?.thinking || null,
    budgetLimitCny: budgetLimit,
    maxTurns
  };
}

// Conservative estimate: use the highest price in the published range so a
// displayed number never claims to be lower than the possible bill.
function estimateCostCny(config, inputTokens, outputTokens) {
  const price = config?.price;
  if (!price || config?.provider === 'zhipu') return 0;
  const input = Math.max(0, Number(inputTokens) || 0) * (Number(price.input?.[1]) || 0);
  const output = Math.max(0, Number(outputTokens) || 0) * (Number(price.output?.[1]) || 0);
  return Math.round(((input + output) / 1000000) * 1e6) / 1e6;
}

function providerError(status, rawBody) {
  let providerCode = '';
  try {
    const body = JSON.parse(rawBody);
    const value = String(body?.error?.code ?? body?.code ?? '');
    if (/^\d{3,6}$/.test(value)) providerCode = value;
  } catch {}
  const http = Number(status) || 0;
  if (providerCode === '1305') return {status: 429, code: 'MODEL_OVERLOADED', message: '模型当前访问量过大（1305）。请稍后重试，或手动选择另一个允许的型号。', providerStatus: http, providerCode};
  if (providerCode === '1113') return {status: 402, code: 'MODEL_QUOTA', message: '模型账户余额不足（1113），请检查账户状态。本服务不会自动切换型号。', providerStatus: http, providerCode};
  if (providerCode === '1000') return {status: 502, code: 'MODEL_AUTH', message: '模型身份或权限验证未通过，请检查密钥所属账户与模型权限。', providerStatus: http, providerCode};
  if (http === 401 || http === 403) return {status: 502, code: 'MODEL_AUTH', message: '模型身份或权限验证未通过，请检查密钥所属账户与模型权限。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 402) return {status: 402, code: 'MODEL_QUOTA', message: '模型账户余额不足或该型号需要付费额度，请检查平台账户。本服务不会自动切换型号。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 404) return {status: 502, code: 'MODEL_NOT_FOUND', message: '平台没有找到这个型号，请核对模型 ID 是否与平台列表完全一致（区分大小写）。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 413) return {status: 413, code: 'MODEL_INPUT_TOO_LARGE', message: '这次请求超过模型输入上限，请缩短原话或减少历史记录。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 422) return {status: 502, code: 'MODEL_PARAMETERS', message: '平台不接受这次请求参数，请核对型号能力、JSON/工具支持和 max_tokens 设置。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 429) return {status: 429, code: 'MODEL_RATE_LIMIT', message: '平台当前限制了请求频率，请稍后重试。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  if (http === 503) return {status: 429, code: 'MODEL_OVERLOADED', message: '平台服务器繁忙，请稍后重试。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
  return {status: 502, code: 'MODEL_UNAVAILABLE', message: '模型服务没有接受这次请求，请检查型号权限与参数。', providerStatus: http, ...(providerCode ? {providerCode} : {})};
}

function publicHealth(config, budget = {}) {
  return {
    ready: config.ready,
    ...(config.reason ? {reason: config.reason} : {}),
    provider: config.provider,
    providerLabel: config.providerLabel,
    model: config.model,
    modelLabel: config.modelLabel,
    mode: config.ready ? 'model' : 'unconfigured',
    capabilities: {textAgent: config.ready, tools: !!config.supportsTools, jsonMode: !!config.supportsJson, retrieval: false, mediaAnalysis: false, accountMemory: false, rewardLedger: false},
    price: config.price,
    priceNote: config.priceNote,
    budget: {
      limitCny: config.budgetLimitCny,
      ...(Number.isFinite(budget.estimatedSpentCny) ? {estimatedSpentCny: budget.estimatedSpentCny} : {}),
      ...(config.budgetLimitCny !== null && Number.isFinite(budget.estimatedSpentCny) ? {remainingCny: Math.max(0, Math.round((config.budgetLimitCny - budget.estimatedSpentCny) * 100) / 100)} : {}),
      estimated: true,
      note: '按平台价格区间的最高值估算输入+输出成本，不是账单；余额与费用以平台为准。'
    },
    maxTurns: config.maxTurns,
    version: 'local-2'
  };
}

module.exports = {PROVIDERS, configuration, estimateCostCny, providerError, publicHealth};
