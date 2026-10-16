'use strict';
/**
 * manifest.js —— 可逆账本（A-M0 交付）
 *
 * 铁律：
 *   1. 先写 manifest 再动手；每完成一条立即回写（崩溃也可还原）。
 *   2. 永不删除，只移动/重命名；一切以 manifest 为唯一事实来源。
 *   3. restore 幂等；原位被占记 conflict，绝不覆盖用户文件。
 *
 * 文件布局（都在 workRoot 内）：
 *   <workRoot>/.discipline/manifests/<manifestId>.json
 *   <workRoot>/.discipline/audit/audit.jsonl   （executor 侧动作日志）
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_VERSION = 1;

function pad(n) { return String(n).padStart(2, '0'); }

function nowIso() {
  const d = new Date();
  const s = new Date(d.getTime() + 8 * 3600000);
  return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate()) +
    'T' + pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes()) + ':' + pad(s.getUTCSeconds()) + '+08:00';
}

let counter = 0;
function newManifestId(prefix) {
  counter = (counter + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 8);
  return (prefix || 'mf') + '_' + Date.now().toString(36) + '_' + pad(counter) + rand;
}

/**
 * createManifestStore
 * @param {object} opts
 * @param {string} opts.root manifest 存储根目录（通常是 <workRoot>/.discipline/manifests）
 * @param {string} [opts.auditPath] executor 侧 JSONL 日志
 * @param {() => string} [opts.nowFn] 可注入时钟（返回 ISO 串）
 * @param {(id:string)=>string} [opts.idFn] 可注入 id 生成器（测试用）
 */
function createManifestStore(opts) {
  const options = opts || {};
  const root = options.root;
  const auditPath = options.auditPath || path.join(path.dirname(root), 'audit', 'audit.jsonl');
  const nowFn = options.nowFn || nowIso;
  const idFn = options.idFn || newManifestId;
  if (!root) throw new Error('createManifestStore 需要 opts.root');

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  function manifestPath(id) { return path.join(root, id + '.json'); }

  function appendAudit(entry) {
    fs.appendFileSync(auditPath, JSON.stringify(Object.assign({ ts: nowFn() }, entry)) + '\n', 'utf8');
  }

  /** 原子写：先写临时文件再 rename，避免半截 JSON */
  function writeJsonAtomic(abs, obj) {
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, abs);
  }

  function readJson(abs) {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }

  /**
   * create：新建 manifest（先落盘，再允许调用方动手）
   * @param {object} spec { kind: 'quarantine'|'shuffle', instructionId, taskId, workRoot, items: [{from, to}], note }
   *   items 的 to 可先留空，执行中回填
   */
  function create(spec) {
    const id = spec.id || idFn(spec.kind === 'shuffle' ? 'sh' : 'qt');
    const manifest = {
      manifestId: id,
      version: MANIFEST_VERSION,
      kind: spec.kind,
      instructionId: spec.instructionId || null,
      taskId: spec.taskId === undefined ? null : spec.taskId,
      workRoot: spec.workRoot,
      createdAt: nowFn(),
      closedAt: null,
      status: 'open',           // open | complete | partial | restored
      items: (spec.items || []).map(it => ({
        from: it.from,
        to: it.to === undefined ? null : it.to,
        status: 'pending',      // pending | done | skipped | restored | conflict | lost
        reason: null,
        sha256: it.sha256 === undefined ? null : it.sha256,
        size: it.size === undefined ? null : it.size,
        updatedAt: null
      })),
      note: spec.note || null
    };
    writeJsonAtomic(manifestPath(id), manifest);
    appendAudit({ event: 'manifest_create', manifestId: id, kind: spec.kind, instructionId: manifest.instructionId, taskId: manifest.taskId, items: manifest.items.length });
    return manifest;
  }

  function get(id) {
    const abs = manifestPath(id);
    if (!fs.existsSync(abs)) return null;
    return readJson(abs);
  }

  function list() {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson(path.join(root, f)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /** 更新某一条 item 的状态并立即回写（逐条回写） */
  function updateItem(id, index, patch) {
    const manifest = get(id);
    if (!manifest) throw new Error('manifest 不存在: ' + id);
    if (index < 0 || index >= manifest.items.length) throw new Error('item 下标越界: ' + id + '[' + index + ']');
    manifest.items[index] = Object.assign({}, manifest.items[index], patch, { updatedAt: nowFn() });
    writeJsonAtomic(manifestPath(id), manifest);
    return manifest;
  }

  function setStatus(id, status, extra) {
    const manifest = get(id);
    if (!manifest) throw new Error('manifest 不存在: ' + id);
    manifest.status = status;
    if (status === 'restored') manifest.closedAt = nowFn();
    if (extra && typeof extra === 'object') Object.assign(manifest, extra);
    writeJsonAtomic(manifestPath(id), manifest);
    appendAudit({ event: 'manifest_status', manifestId: id, status });
    return manifest;
  }

  return {
    root, auditPath,
    create, get, list, updateItem, setStatus,
    manifestPath,
    readAudit() {
      if (!fs.existsSync(auditPath)) return [];
      return fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
    }
  };
}

module.exports = { createManifestStore, MANIFEST_VERSION, newManifestId, nowIso };
