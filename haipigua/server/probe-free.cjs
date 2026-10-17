'use strict';
// Optional account/network diagnostic. Reads a key once; never prints it or provider text.
const readline = require('node:readline');
const {configuration} = require('./providers.cjs');
async function main() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('等待秘密配置，不回显；只测试当前明确选择的平台与型号。\n');
  const reader = readline.createInterface({input: process.stdin, terminal: false});
  const line = await new Promise(resolve => {reader.once('line', resolve); reader.once('close', () => resolve(''));}); reader.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  let config;
  try { config = JSON.parse(line); } catch { throw Error('INVALID_CONFIG'); }
  if (typeof config.MODEL_API_KEY !== 'string' || !config.MODEL_API_KEY || config.MODEL_API_KEY.length > 1000) throw Error('INVALID_CONFIG');
  const env = {MODEL_PROVIDER: config.MODEL_PROVIDER, MODEL_API_KEY: config.MODEL_API_KEY, MODEL_NAME: config.MODEL_NAME, MODEL_TOOLS: '0', MODEL_JSON_MODE: '1'};
  const selected = configuration(env);
  if (!selected.ready) {
    console.log(JSON.stringify({ready: false, provider: selected.provider, requestedModel: selected.model, reason: selected.reason}));
    return;
  }
  try {
    const body = {model: selected.model, messages: [{role: 'user', content: '仅回复JSON：{"ok":true}'}], max_tokens: 64, temperature: 0, response_format: {type: 'json_object'}, stream: false};
    if (selected.thinking === 'disabled') body.thinking = {type: 'disabled'};
    const response = await fetch(selected.url, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MODEL_API_KEY}, body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
    const data = await response.json().catch(() => ({}));
    const code = String(data.error?.code || '');
    console.log(JSON.stringify({ready: true, provider: selected.provider, providerLabel: selected.providerLabel, requestedModel: selected.model, status: response.status, providerCode: /^\d{3,6}$/.test(code) ? code : undefined, returnedModel: typeof data.model === 'string' ? data.model : undefined, hasContent: typeof data.choices?.[0]?.message?.content === 'string', usage: data.usage ? {prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens} : undefined}));
  } catch {
    console.log(JSON.stringify({ready: true, provider: selected.provider, requestedModel: selected.model, error: 'NETWORK_OR_TIMEOUT'}));
  }
}
main().catch(() => {process.stderr.write('诊断未启动，秘密配置不完整。\n'); process.exitCode = 1;});
