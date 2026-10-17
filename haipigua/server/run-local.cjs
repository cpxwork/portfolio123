'use strict';
// Key arrives only through this process's environment or one stdin line. Never log it.
const readline = require('node:readline');
const {startServer} = require('./local.cjs');
const {DEFAULT_MODEL, FREE_MODELS} = require('./agent.cjs');

async function main() {
  let env = {MODEL_API_KEY: process.env.MODEL_API_KEY || '', MODEL_NAME: process.env.MODEL_NAME || DEFAULT_MODEL};
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
    env = {MODEL_API_KEY: typeof config.MODEL_API_KEY === 'string' ? config.MODEL_API_KEY.trim() : '', MODEL_NAME: config.MODEL_NAME || DEFAULT_MODEL};
  }
  if (!env.MODEL_API_KEY || /[\r\n]/.test(env.MODEL_API_KEY) || env.MODEL_API_KEY.length > 1000 || !FREE_MODELS.includes(env.MODEL_NAME)) throw Error('INVALID_CONFIG');
  // Do not retain a second copy on process.env after capturing configuration.
  delete process.env.MODEL_API_KEY;
  const server = startServer({env});
  server.once('listening', () => process.stdout.write('嗨皮瓜本机文本服务就绪：http://127.0.0.1:8878（仅本机；免费模型固定；每次启动最多60段）\n'));
  server.once('error', () => { process.stderr.write('本机服务无法启动，请检查8878端口是否占用。\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
if (require.main === module) main().catch(() => { process.stderr.write('秘密配置不完整：需要MODEL_API_KEY，模型须为glm-4.7-flash或glm-4-flash-250414。未输出秘密。\n'); process.exitCode = 1; });
module.exports = {main};
