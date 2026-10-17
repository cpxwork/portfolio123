'use strict';
/**
 * server.cjs —— discipline-agent 的本机 HTTP 桥（A 侧对外连接层）
 *
 * 定位：前端（haipigua 8877）把"用户当前状态 / 回执"发进来，把"该下发什么指令"拿回去。
 * **前端只读，不做文件操作**；文件操作一律在 A 侧 executor 内、workRoot 范围内完成。
 *
 * 边界对齐 haipigua 本机服务风格（便于前端复用同一套 fetcher）：
 *   只监听 127.0.0.1；Host 必须匹配本机端口；Origin 白名单；
 *   请求体上限 128KiB；错误统一 {error:{code,message}}；不返回任意 JS。
 *
 * 端口默认 8879（避开 haipigua 后端 8878 与预览 8877）。
 */

const http = require('node:http');
const { createDisciplineService, BRIDGE_VERSION } = require('./service.cjs');

const LIMIT = 128 * 1024;
const DEFAULT_PORT = 8879;
const ALLOWED_ORIGIN_PORTS = [8877, 8879, 8880];

const ERRORS = {
  HOST_DENIED: ['只接受本机连接。', 403],
  ORIGIN_DENIED: ['来源未被允许。', 403],
  BODY_TOO_LARGE: ['请求内容过长。', 413],
  BAD_JSON: ['请求体不是合法 JSON。', 400],
  NOT_FOUND: ['没有这条指令。', 404],
  BAD_ROUTE: ['没有这个接口。', 404],
  VALIDATION: ['请求字段不合法。', 400],
  WORK_ROOT_REQUIRED: ['缺少受控工作目录 workRoot。', 400],
  INTERNAL_ERROR: ['这次请求暂时未完成。', 500]
};

function errorBody(code, extra) {
  const [message, status] = ERRORS[code] || ERRORS.INTERNAL_ERROR;
  return { status, body: { error: Object.assign({ code, message }, extra || {}) } };
}

/**
 * createBridgeHandler —— 可单测的 handler（不起真实 HTTP）
 * @param {object} ctx { service } 固定实例，或 { getService(req) } 按请求取实例
 */
function createBridgeHandler(ctx) {
  const context = ctx || {};
  const service = req => (context.service || (context.getService && context.getService(req))) || null;

  return async function handle(req) {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = String(req.path || '/').split('?')[0];

    // 路由匹配优先于 body 解析：未知路由一律 404，不因空 body 被误判成 BAD_JSON
    const KNOWN = new Set([
      '/api/health', '/api/discipline/start', '/api/discipline/tick', '/api/discipline/ack',
      '/api/discipline/complete', '/api/discipline/revoke', '/api/discipline/restore',
      '/api/discipline/state', '/api/discipline/audit'
    ]);
    if (!KNOWN.has(pathname)) return errorBody('BAD_ROUTE');

    let payload = null;
    if (req.body && req.body.length) {
      try { payload = JSON.parse(req.body); } catch (e) { return errorBody('BAD_JSON'); }
    }
    const p = payload || {};

    // ---- GET /api/health：能力自述（对齐 haipigua /api/health 形状）----
    if (pathname === '/api/health') {
      if (method !== 'GET') return errorBody('BAD_ROUTE');
      const svc = service(req);
      const caps = svc ? svc.capabilities() : { ready: false, version: BRIDGE_VERSION };
      return {
        status: 200,
        body: {
          ready: !!svc,
          model: null,                    // 本桥不直连模型
          mode: 'local-bridge',
          version: caps.version || BRIDGE_VERSION,
          capabilities: {
            discipline: !!svc,
            camera: false,
            llm: false,
            fileOps: !!svc,
            restore: !!svc,
            audit: !!svc
          },
          detail: caps
        }
      };
    }

    const svc = service(req);
    if (!svc) return errorBody('WORK_ROOT_REQUIRED');

    // ---- POST /api/discipline/start：启动升级链（下发 L0）----
    if (pathname === '/api/discipline/start') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.start(p) };
    }

    // ---- POST /api/discipline/tick：推进一次升级判断 ----
    if (pathname === '/api/discipline/tick') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.tick(p) };
    }

    // ---- POST /api/discipline/ack：前端已展示该指令 ----
    if (pathname === '/api/discipline/ack') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      if (!p.instructionId) return errorBody('VALIDATION', { field: 'instructionId' });
      const out = svc.ack(p.instructionId);
      return out.ok ? { status: 200, body: out } : errorBody('NOT_FOUND');
    }

    // ---- POST /api/discipline/complete：该步已完成（触发撤销+还原）----
    if (pathname === '/api/discipline/complete') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      if (p.instructionId && svc.bus.get(p.instructionId)) svc.complete(p.instructionId);
      return { status: 200, body: svc.completeStep(p.reason) };
    }

    // ---- POST /api/discipline/revoke：无条件全量还原 ----
    if (pathname === '/api/discipline/revoke') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.revoke(p.reason) };
    }

    // ---- POST /api/discipline/restore：只做文件还原 ----
    if (pathname === '/api/discipline/restore') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.restore() };
    }

    // ---- GET /api/discipline/state：前端轮询 ----
    if (pathname === '/api/discipline/state') {
      if (method !== 'GET') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.state() };
    }

    // ---- POST /api/discipline/audit：审计查询 ----
    if (pathname === '/api/discipline/audit') {
      if (method !== 'POST') return errorBody('BAD_ROUTE');
      return { status: 200, body: svc.auditQuery(p) };
    }

    return errorBody('BAD_ROUTE');
  };
}

/**
 * startBridge —— 起真实 HTTP 服务
 * @param {object} opts { port, workRoot, service, options, clock }
 */
function startBridge(opts) {
  const options = opts || {};
  // 注意 port=0 表示"由系统分配空闲端口"，是合法值，不能用 || 兜底（会把 0 变成默认端口）
  const rawPort = options.port === undefined ? (process.env.DISCIPLINE_BRIDGE_PORT || DEFAULT_PORT) : options.port;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');

  const service = options.service || createDisciplineService({
    workRoot: options.workRoot,
    auditPath: options.auditPath,
    options: options.options,
    clock: options.clock
  });

  const handler = createBridgeHandler({ getService: () => service });

  const server = http.createServer((req, res) => {
    const localPort = server.address() ? server.address().port : port;
    const allowedHosts = new Set(['127.0.0.1:' + localPort, 'localhost:' + localPort]);
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': req.headers.origin || ''
      });
      res.end(body == null ? undefined : JSON.stringify(body));
    };

    const origin = req.headers.origin;
    const allowedOrigins = ALLOWED_ORIGIN_PORTS.map(p => 'http://127.0.0.1:' + p)
      .concat(ALLOWED_ORIGIN_PORTS.map(p => 'http://localhost:' + p));

    // CORS 预检：前端从 8877 到 8879 会先发 OPTIONS
    if (req.method === 'OPTIONS') {
      if (origin && !allowedOrigins.includes(origin)) return send(403, errorBody('ORIGIN_DENIED').body);
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || '',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600'
      });
      return res.end();
    }

    if (!allowedHosts.has(req.headers.host || '')) return send(403, errorBody('HOST_DENIED').body);
    if (origin && !allowedOrigins.includes(origin)) return send(403, errorBody('ORIGIN_DENIED').body);

    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > LIMIT) {
        rejected = true;
        chunks.length = 0;
        send(413, errorBody('BODY_TOO_LARGE').body);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!rejected) { rejected = true; send(400, errorBody('BAD_JSON').body); } });
    req.on('end', async () => {
      if (rejected) return;
      rejected = true;
      try {
        const out = await handler({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
        send(out.status, out.body);
      } catch (e) {
        // 校验类异常回 400 并带 errors，其余一律 INTERNAL_ERROR（不泄漏堆栈）
        if (e && Array.isArray(e.errors)) return send(400, errorBody('VALIDATION', { errors: e.errors }).body);
        send(500, errorBody('INTERNAL_ERROR').body);
      }
    });
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.listen(port, '127.0.0.1');
  server.bridgeService = service;
  return server;
}

module.exports = { createBridgeHandler, startBridge, LIMIT, DEFAULT_PORT, ALLOWED_ORIGIN_PORTS, ERRORS };
