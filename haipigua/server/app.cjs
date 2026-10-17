'use strict';

// One-process Haipigua product server: static page + same-origin /api/agent.
// The browser never sees the model key; configuration comes from the server
// environment or a local .env file that is ignored by Git.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHandler, configuration} = require('./agent.cjs');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const ENV_FILE = path.join(__dirname, '..', '.env');
const LIMIT = 128 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'"
};
const RESPONSE_SECURITY = new WeakMap();

function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return false;
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(file); return true; } catch { /* fall through */ }
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
  return true;
}

function splitOrigins(value) {
  const result = new Set();
  for (const item of String(value || '').split(',')) {
    const raw = item.trim();
    if (!raw) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { throw Error('APP_ORIGIN must be an http(s) origin, e.g. https://haipigua.example.com'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') throw Error('APP_ORIGIN must be an http(s) origin without a path');
    result.add(parsed.origin);
  }
  return result;
}

function securityHeaders(env) {
  const headers = {...SECURITY};
  if (String(env.APP_ORIGIN || '').startsWith('https://')) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function send(res, status, body, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(status, {...(RESPONSE_SECURITY.get(res) || {}), ...headers});
  res.end(body == null ? undefined : body);
}

function startProductServer({
  port = 8877,
  host = '127.0.0.1',
  env = process.env,
  webRoot = WEB_ROOT,
  handler = null,
  fetchImpl = null,
  referenceFetch = null,
  allowedOrigins = null,
  quiet = false
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer between 0 and 65535');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && env.ALLOW_PUBLIC !== '1') throw Error('Refusing to bind a non-loopback HOST without ALLOW_PUBLIC=1. Put the public service behind an authenticated reverse proxy and set APP_ORIGIN.');
  const origins = new Set(allowedOrigins instanceof Set ? allowedOrigins : []);
  for (const origin of splitOrigins(env.APP_ORIGIN)) origins.add(origin);
  const hosts = new Set();
  const apiHandler = handler || createHandler();
  const security = securityHeaders(env);

  const server = http.createServer((req, res) => {
    RESPONSE_SECURITY.set(res, security);
    const hostHeader = String(req.headers.host || '');
    if (!hosts.has(hostHeader)) return send(res, 403, JSON.stringify({error: {code: 'HOST_DENIED', message: '只接受已配置的本机或站点 Host。'}}), {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    const url = String(req.url || '/');
    const pathname = (() => { try { return decodeURIComponent(new URL(url, 'http://localhost').pathname); } catch { return ''; } })();
    const api = ['/api/health', '/api/agent', '/api/turn', '/turn', '/health'].includes(pathname);
    if (api) {
      if (!['GET', 'POST', 'OPTIONS', 'HEAD'].includes(req.method)) return send(res, 405, JSON.stringify({error: {code: 'METHOD_NOT_ALLOWED', message: '方法不允许。'}}), {'Content-Type': 'application/json; charset=utf-8'});
      let size = 0, rejected = false;
      const chunks = [];
      req.on('data', chunk => {
        if (rejected) return;
        size += chunk.length;
        if (size > LIMIT) {
          rejected = true;
          chunks.length = 0;
          send(res, 413, JSON.stringify({error: {code: 'BODY_TOO_LARGE', message: '这次记录太长，请缩短后重试。'}}), {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => { if (!rejected) send(res, 400, JSON.stringify({error: {code: 'REQUEST_INTERRUPTED', message: '请求未完整发送。'}}), {'Content-Type': 'application/json; charset=utf-8'}); });
      req.on('end', async () => {
        if (rejected) return;
        try {
          const result = await apiHandler({method: req.method, path: url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')}, env, {fetch: fetchImpl || undefined, referenceFetch: referenceFetch || undefined, allowedOrigins: origins});
          if (result.body == null) return send(res, result.status, null, result.headers || {});
          const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
          return send(res, result.status, body, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(result.headers || {})});
        } catch {
          return send(res, 500, JSON.stringify({error: {code: 'INTERNAL_ERROR', message: '这次请求暂时未完成。'}}), {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
        }
      });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method not allowed', {'Content-Type': 'text/plain; charset=utf-8'});
    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !TYPES[path.extname(name)]) return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
    fs.readFile(path.join(webRoot, name), (error, data) => {
      if (error) return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
      const immutable = /\.(webp|png|svg)$/.test(name);
      send(res, 200, req.method === 'HEAD' ? undefined : data, {'Content-Type': TYPES[path.extname(name)], 'Cache-Control': immutable ? 'public, max-age=86400' : 'no-store', 'Content-Length': data.length});
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(125000, socket => socket.destroy());
  server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.listen(port, host, () => {
    const actual = server.address().port;
    for (const value of [`127.0.0.1:${actual}`, `localhost:${actual}`]) hosts.add(value);
    origins.add(`http://127.0.0.1:${actual}`);
    origins.add(`http://localhost:${actual}`);
    for (const origin of splitOrigins(env.APP_ORIGIN)) {
      origins.add(origin);
      try { hosts.add(new URL(origin).host); } catch {}
    }
    if (!quiet) {
      const config = configuration(env);
      process.stdout.write(`嗨皮瓜成品服务：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}/\n`);
      process.stdout.write(`模型：${config.providerLabel || config.provider} · ${config.modelLabel || config.model}${config.ready ? '' : '（未配置，页面仍可打开，但不能真实调用）'}\n`);
    }
  });
  return server;
}

function main() {
  loadEnvFile();
  const env = process.env;
  const port = Number(env.PORT || 8877);
  const host = env.HOST || '127.0.0.1';
  const config = configuration(env);
  const server = startProductServer({port, host, env});
  server.once('error', error => {
    process.stderr.write(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭旧服务或设置 PORT。\n` : '成品服务无法启动。\n');
    process.exitCode = 1;
  });
  if (!config.ready) process.stderr.write('模型尚未就绪：请创建 haipigua/.env（参考 .env.example），至少填写 MODEL_PROVIDER、MODEL_API_KEY、MODEL_NAME。页面仍会启动，但不会调用模型。\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections?.(); });
}

if (require.main === module) main();
module.exports = {startProductServer, loadEnvFile, splitOrigins, ENV_FILE, WEB_ROOT};
