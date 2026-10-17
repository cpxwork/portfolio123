'use strict';
// Key arrives only through this process's environment or one stdin line. Never log it.
const readline = require('node:readline');
const {startServer} = require('./local.cjs');
const {DEFAULT_MODEL} = require('./agent.cjs');
const {configuration} = require('./providers.cjs');

const FIELDS = ['MODEL_PROVIDER', 'MODEL_API_KEY', 'MODEL_NAME', 'MODEL_TOOLS', 'MODEL_JSON_MODE', 'MODEL_BUDGET_CNY', 'MODEL_MAX_TURNS'];
async function main() {
  let env = Object.fromEntries(FIELDS.map(key => [key, process.env[key] || '']));
  env.MODEL_PROVIDER ||= 'zhipu';
  env.MODEL_NAME ||= process.env.MODEL_NAME || (env.MODEL_PROVIDER === 'aiping' ? 'GLM-4.7-Flash' : DEFAULT_MODEL);
  if (!env.MODEL_API_KEY) {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write('等待本机秘密配置（一行JSON，不会回显内容）\n');
    const reader = readline.createInterface({input: process.stdin, terminal: false});
    const line = await new Promise(resolve => { reader.once('line', resolve); reader.once('close', () => resolve('')); });
    reader.close();
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
    if (Buffer.byteLength(line) > 8192) throw Error('INVALID_CONFIG');
    let config;
    try { config = JSON.parse(line); } catch { throw Error('INVALID_CONFIG'); }
    env = {
      MODEL_PROVIDER: typeof config.MODEL_PROVIDER === 'string' ? config.MODEL_PROVIDER.trim() : env.MODEL_PROVIDER,
      MODEL_API_KEY: typeof config.MODEL_API_KEY === 'string' ? config.MODEL_API_KEY.trim() : '',
      MODEL_NAME: typeof config.MODEL_NAME === 'string' && config.MODEL_NAME.trim() ? config.MODEL_NAME.trim() : env.MODEL_NAME,
      MODEL_TOOLS: typeof config.MODEL_TOOLS === 'string' ? config.MODEL_TOOLS : env.MODEL_TOOLS,
      MODEL_JSON_MODE: typeof config.MODEL_JSON_MODE === 'string' ? config.MODEL_JSON_MODE : env.MODEL_JSON_MODE,
      MODEL_BUDGET_CNY: typeof config.MODEL_BUDGET_CNY === 'string' || typeof config.MODEL_BUDGET_CNY === 'number' ? String(config.MODEL_BUDGET_CNY) : env.MODEL_BUDGET_CNY,
      MODEL_MAX_TURNS: typeof config.MODEL_MAX_TURNS === 'string' || typeof config.MODEL_MAX_TURNS === 'number' ? String(config.MODEL_MAX_TURNS) : env.MODEL_MAX_TURNS
    };
  }
  const config = configuration(env);
  if (!env.MODEL_API_KEY || /[\r\n]/.test(env.MODEL_API_KEY) || env.MODEL_API_KEY.length > 1000 || !config.ready) throw Error('INVALID_CONFIG');
  // Do not retain a second copy on process.env after capturing configuration.
  delete process.env.MODEL_API_KEY;
  const server = startServer({env});
  const label = `${config.providerLabel} · ${config.modelLabel}`;
  server.once('listening', () => process.stdout.write(`嗨皮瓜本机文本服务就绪：http://127.0.0.1:8878（仅本机；${label}；每次启动最多${config.maxTurns}段）\n`));
  server.once('error', () => { process.stderr.write('本机服务无法启动，请检查8878端口是否占用。\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
if (require.main === module) main().catch(() => { process.stderr.write('秘密配置不完整或型号不在允许列表：需要MODEL_API_KEY，并明确MODEL_PROVIDER与允许的MODEL_NAME。未输出秘密。\n'); process.exitCode = 1; });
module.exports = {main};
