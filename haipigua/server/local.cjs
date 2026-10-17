'use strict';
const http = require('node:http');
const {createHandler, LIMIT} = require('./agent.cjs');

function startServer({port = 8878, env = {}, handler = createHandler(), options = {}} = {}) {
  const configuration = {MODEL_PROVIDER: env.MODEL_PROVIDER, MODEL_API_KEY: env.MODEL_API_KEY, MODEL_NAME: env.MODEL_NAME, MODEL_API_URL: env.MODEL_API_URL, MODEL_TOOLS: env.MODEL_TOOLS, MODEL_JSON_MODE: env.MODEL_JSON_MODE, MODEL_BUDGET_CNY: env.MODEL_BUDGET_CNY, MODEL_MAX_TURNS: env.MODEL_MAX_TURNS};
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    const localPort = server.address()?.port;
    const allowedHosts = new Set(['127.0.0.1:' + localPort, 'localhost:' + localPort]);
    const send = (status, body, headers = {}) => { if (!res.destroyed) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}); res.end(body == null ? undefined : JSON.stringify(body)); } };
    if (!allowedHosts.has(host)) return send(403, {error: {code: 'HOST_DENIED', message: '只接受本机连接。'}});
    let length = 0, finished = false;
    const chunks = [];
    req.on('data', chunk => {
      if (finished) return;
      length += chunk.length;
      if (length > LIMIT) { finished = true; send(413, {error: {code: 'BODY_TOO_LARGE', message: '这次记录太长，请缩短后重试。'}}); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!finished) { finished = true; send(400, {error: {code: 'REQUEST_INTERRUPTED', message: '请求未完整发送。'}}); } });
    req.on('end', async () => {
      if (finished) return;
      finished = true;
      try {
        const result = await handler({method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')}, configuration, options);
        send(result.status, result.body, result.headers);
      } catch { send(500, {error: {code: 'INTERNAL_ERROR', message: '这次请求暂时未完成。'}}); }
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(105000, socket => socket.destroy());
  server.listen(port, '127.0.0.1');
  return server;
}
module.exports = {startServer};
