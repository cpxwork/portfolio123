'use strict';
/**
 * executor.js —— 客户端本地执行层（A-M0 交付）
 *
 * 职责：quarantine_files / shuffle_desktop / restore / restoreAll。
 * 前端动作（notify / popup_countdown / spawn_bugs）原样返回"非本地动作"。
 *
 * 安全边界（A任务提示词 8.2）：
 *   1. 只操作 workRoot 之内；workRoot 拒绝系统目录 / 盘符根 / 用户主目录本身。
 *   2. 永不删除：quarantine=移动，shuffle=重命名，全部记 manifest。
 *   3. 先写 manifest 再动手，逐条回写（崩溃也可还原）。
 *   4. restore 幂等；原位被占记 conflict，不覆盖。
 *   5. 跳过符号链接；shuffle 跳过目录与点开头文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createManifestStore } = require('./manifest');
const { createVault } = require('./crypto-vault');

/** 内部目录名：隔离区与账本都在 workRoot 内，shuffle 不得触碰 */
const QUARANTINE_DIR = '.quarantine';
const DISCIPLINE_DIR = '.discipline';

/**
 * 系统/高危目录（Windows 视角，大小写不敏感）。
 * PREFIX_DENY：命中前缀即拒——这些目录不允许 agent 写入。
 * EXACT_DENY：仅路径本身才拒（如 C:\Users 是用户目录根，但其下的
 *             AppData\Local\Temp 是合法位置，不能按前缀一棒子打死）。
 */
const PREFIX_DENY = [
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata',
  'c:\\$recycle.bin', 'c:\\system volume information', 'c:\\boot', 'c:\\recovery', 'c:\\perflogs'
];
const EXACT_DENY = [
  'c:\\users', 'c:\\users\\default', 'c:\\users\\public', 'c:\\users\\all users',
  'c:\\documents and settings'
];

function normalizeForCompare(p) {
  return p.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
}

function isSystemPath(resolved) {
  const norm = normalizeForCompare(resolved);
  if (EXACT_DENY.indexOf(norm) !== -1) return true;
  return PREFIX_DENY.some(dir => norm === dir || norm.startsWith(dir + '\\'));
}

function sha256OfFile(abs) {
  if (!fs.existsSync(abs)) return null;
  const st = fs.lstatSync(abs);
  if (!st.isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function isDriveRoot(p) {
  return /^[a-zA-Z]:\\?$/.test(p) || /^[a-zA-Z]:$/.test(p) || p === '\\';
}

/**
 * 校验 workRoot。不合法直接抛错。
 */
function validateWorkRoot(workRoot) {
  if (typeof workRoot !== 'string' || !workRoot.trim()) {
    throw new Error('workRoot 必须是非空字符串');
  }
  const resolved = path.resolve(workRoot);
  if (isDriveRoot(resolved)) {
    throw new Error('workRoot 不允许是盘符根: ' + resolved);
  }
  if (isSystemPath(resolved)) {
    throw new Error('workRoot 不允许是系统目录: ' + resolved);
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) {
    throw new Error('workRoot 不允许是用户主目录本身: ' + resolved);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('workRoot 不存在: ' + resolved);
  }
  const st = fs.lstatSync(resolved);
  if (!st.isDirectory()) {
    throw new Error('workRoot 不是目录: ' + resolved);
  }
  return resolved;
}

/** 判断目标是否在 workRoot 之内（不越界、不跟随 ..） */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 跨盘/跨卷时 rename 会失败，退化为 copy+unlink（仍是"移动"，且 manifest 已先写） */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return 'rename';
  } catch (e) {
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM')) {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return 'copy';
    }
    throw e;
  }
}

/** 随机文件名（保留扩展名） */
function randomName(ext) {
  const rand = crypto.randomBytes(6).toString('hex');
  return 'shuffled-' + rand + (ext || '');
}

function existingNames(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch (e) {
    return new Set();
  }
}

/**
 * createExecutor
 * @param {object} opts
 * @param {string} opts.workRoot 执行范围根（同时是隔离区所在）
 * @param {() => Date} [opts.nowFn] 可注入时钟
 * @param {string} [opts.auditPath] 覆盖审计日志路径（测试用）
 * @param {(prefix:string)=>string} [opts.idFn] 覆盖 manifestId 生成器（测试用）
 */
function createExecutor(opts) {
  const options = opts || {};
  if (!options.workRoot) throw new Error('createExecutor 需要 opts.workRoot');
  const workRoot = validateWorkRoot(options.workRoot);
  const nowFn = options.nowFn || (() => new Date());

  const disciplineRoot = path.join(workRoot, DISCIPLINE_DIR);
  const manifestsRoot = path.join(disciplineRoot, 'manifests');
  const quarantineRoot = path.join(workRoot, QUARANTINE_DIR);
  fs.mkdirSync(manifestsRoot, { recursive: true });
  // 隔离区目录提前建好：内部目录判定（isInternalPath）依赖它已存在，
  // 这样 shuffle 永远不会把 agent 自己的账本/隔离区当作用户文件。
  fs.mkdirSync(quarantineRoot, { recursive: true });
  // 审计日志目录同样算内部资产：账本被打乱改名会让"全流程可审计"直接失效。
  const auditDir = path.dirname(options.auditPath || path.join(disciplineRoot, 'audit', 'audit.jsonl'));
  fs.mkdirSync(auditDir, { recursive: true });
  // 隔离区加密：一把 manifest 一把密钥，密钥与密文分目录存放
  const keyDir = options.keyDir || path.join(disciplineRoot, 'keys');
  const vault = createVault({ keyDir });
  const store = createManifestStore({
    root: manifestsRoot,
    auditPath: options.auditPath,
    nowFn: () => {
      const d = nowFn();
      const s = new Date(d.getTime() + 8 * 3600000);
      const pad = n => String(n).padStart(2, '0');
      return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate()) +
        'T' + pad(s.getUTCHours()) + ':' + pad(s.getUTCMinutes()) + ':' + pad(s.getUTCSeconds()) + '+08:00';
    },
    idFn: options.idFn
  });

  /** executor 侧动作日志（与 manifest store 的审计共用同一文件） */
  function log(entry) {
    const iso = new Date(nowFn().getTime() + 8 * 3600000).toISOString().replace('Z', '+00:00');
    fs.appendFileSync(store.auditPath, JSON.stringify(Object.assign({ ts: iso }, entry)) + '\n', 'utf8');
  }

  /**
   * 是否是内部目录（隔离区 / 账本 / 审计日志），任何 shuffle 都不得碰。
   * 账本一旦被打乱改名，"全流程可审计"直接失效，所以必须整体排除。
   */
  function isInternalPath(abs) {
    return isInside(quarantineRoot, abs) || isInside(disciplineRoot, abs) || isInside(auditDir, abs);
  }

  /**
   * quarantine_files
   * @param {object} params { instructionId, taskId, targets: [绝对路径], note }
   * @returns {{ok, manifestId, moved, skipped}}
   */
  function quarantineFiles(params) {
    const targets = (params && params.targets) || [];
    if (!Array.isArray(targets) || !targets.length) {
      throw new Error('quarantine_files 需要非空 targets 数组');
    }
    // 先规范化 items（from/to 预填），再创建 manifest，再动手
    const items = [];
    const skipped = [];
    for (const raw of targets) {
      if (typeof raw !== 'string' || !raw.trim()) {
        skipped.push({ from: String(raw), reason: 'target 不是有效路径字符串' });
        continue;
      }
      const abs = path.resolve(raw);
      if (!isInside(workRoot, abs)) {
        skipped.push({ from: abs, reason: 'target 不在 workRoot 之内' });
        continue;
      }
      if (isInternalPath(abs)) {
        skipped.push({ from: abs, reason: 'target 是 agent 内部目录（隔离区/账本/审计日志），拒绝操作' });
        continue;
      }
      if (!fs.existsSync(abs)) {
        skipped.push({ from: abs, reason: 'target 不存在' });
        continue;
      }
      let st;
      try { st = fs.lstatSync(abs); } catch (e) {
        skipped.push({ from: abs, reason: '无法读取 target 状态: ' + e.message });
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ from: abs, reason: '符号链接，跳过' });
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ from: abs, reason: 'target 不是普通文件（目录不隔离）' });
        continue;
      }
      items.push({
        from: abs,
        to: null,
        sha256: sha256OfFile(abs),
        size: st.size
      });
    }

    // 先写 manifest（哪怕没有任何可执行项，也留下记录）
    const manifest = store.create({
      kind: 'quarantine',
      instructionId: (params && params.instructionId) || null,
      taskId: (params && params.taskId) === undefined ? null : params.taskId,
      workRoot,
      items,
      note: (params && params.note) || null
    });

    const destDir = path.join(quarantineRoot, manifest.manifestId);
    const used = new Set();
    let moved = 0;
    // 加密隔离：每个文件独立随机 IV；明文 sha256 由加密过程算出，还原后据此校验
    let key = null;
    try { key = vault.ensureKey(manifest.manifestId); } catch (e) { key = null; }
    for (let i = 0; i < manifest.items.length; i++) {
      const item = manifest.items[i];
      // 目标名：保留原名；重名则加序号后缀
      let name = path.basename(item.from);
      let candidate = name;
      let n = 1;
      while (used.has(candidate) || fs.existsSync(path.join(destDir, candidate))) {
        const ext = path.extname(name);
        candidate = path.basename(name, ext) + '.' + n + ext;
        n++;
      }
      used.add(candidate);
      const dest = path.join(destDir, candidate);
      if (!key) {
        store.updateItem(manifest.manifestId, i, {
          to: dest, status: 'skipped',
          reason: '无法准备加密密钥，未隔离（保持原位不动）'
        });
        continue;
      }
      try {
        fs.mkdirSync(destDir, { recursive: true });
        // 1) 先加密成密文到隔离区
        const meta = vault.encryptFile(item.from, dest, key.key);
        // 2) 密文落盘后再删原件：加密失败时原件始终在原位，不会两头空
        fs.unlinkSync(item.from);
        // 3) 立即回写 manifest
        moved++;
        store.updateItem(manifest.manifestId, i, {
          to: dest,
          status: 'done',
          reason: '已加密移入隔离区',
          sha256: meta.plainSha256,
          size: meta.plainSize,
          crypto: {
            alg: meta.alg, iv: meta.iv, authTag: meta.authTag, keyId: manifest.manifestId,
            plainSize: meta.plainSize, plainSha256: meta.plainSha256
          }
        });
      } catch (e) {
        // 加密失败时清理可能的半截密文，确保原位原件不动
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e2) { /* 忽略 */ }
        store.updateItem(manifest.manifestId, i, {
          to: dest,
          status: 'skipped',
          reason: '加密隔离失败: ' + e.message
        });
      }
    }
    const final = store.get(manifest.manifestId);
    const doneCount = final.items.filter(it => it.status === 'done').length;
    store.setStatus(manifest.manifestId, doneCount === final.items.length ? 'complete' : 'partial');
    log({ event: 'executor_quarantine', manifestId: manifest.manifestId, moved: doneCount, skipped: skipped.length, instructionId: manifest.instructionId, taskId: manifest.taskId });
    return { ok: true, action: 'quarantine_files', manifestId: manifest.manifestId, moved: doneCount, skipped, manifest: store.get(manifest.manifestId) };
  }

  /**
   * shuffle_desktop：执行范围顶层普通文件随机重命名（保留扩展名）
   * @param {object} params { instructionId, taskId, targetDir?, note }
   */
  function shuffleDesktop(params) {
    const targetDir = params && params.targetDir ? path.resolve(params.targetDir) : workRoot;
    if (!isInside(workRoot, targetDir)) {
      throw new Error('shuffle_desktop 的 targetDir 必须在 workRoot 之内: ' + targetDir);
    }
    if (!fs.existsSync(targetDir) || !fs.lstatSync(targetDir).isDirectory()) {
      throw new Error('shuffle_desktop 的 targetDir 不是目录: ' + targetDir);
    }

    // 收集：顶层普通文件；跳过目录、点开头文件、符号链接、agent 内部目录
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = [];
    const skipped = [];
    for (const ent of entries) {
      const abs = path.join(targetDir, ent.name);
      // agent 自己的内部目录（隔离区/账本/审计日志）整体跳过，与目录规则合并报一条
      if (ent.name === QUARANTINE_DIR || ent.name === DISCIPLINE_DIR || isInside(auditDir, abs)) {
        skipped.push({ from: abs, reason: 'agent 内部目录，跳过' });
        continue;
      }
      if (ent.isSymbolicLink()) { skipped.push({ from: abs, reason: '符号链接，跳过' }); continue; }
      if (ent.isDirectory()) { skipped.push({ from: abs, reason: '目录，跳过' }); continue; }
      if (!ent.isFile()) { skipped.push({ from: abs, reason: '非常规文件，跳过' }); continue; }
      if (ent.name.startsWith('.')) { skipped.push({ from: abs, reason: '点开头文件，跳过' }); continue; }
      if (isInternalPath(abs)) { skipped.push({ from: abs, reason: 'agent 内部目录内容，跳过' }); continue; }
      const st = fs.lstatSync(abs);
      items.push({ from: abs, to: null, sha256: sha256OfFile(abs), size: st.size });
    }

    const manifest = store.create({
      kind: 'shuffle',
      instructionId: (params && params.instructionId) || null,
      taskId: (params && params.taskId) === undefined ? null : params.taskId,
      workRoot,
      items,
      note: (params && params.note) || null
    });

    const used = existingNames(targetDir);
    let shuffled = 0;
    for (let i = 0; i < manifest.items.length; i++) {
      const item = manifest.items[i];
      const ext = path.extname(item.from);
      let candidate = randomName(ext);
      while (used.has(candidate)) candidate = randomName(ext);
      used.add(candidate);
      used.delete(path.basename(item.from));
      const dest = path.join(targetDir, candidate);
      try {
        const mode = moveFile(item.from, dest);
        shuffled++;
        store.updateItem(manifest.manifestId, i, {
          to: dest,
          status: 'done',
          reason: '已重命名（' + mode + '）',
          sha256: sha256OfFile(dest),
          size: fs.statSync(dest).size
        });
      } catch (e) {
        store.updateItem(manifest.manifestId, i, {
          to: dest,
          status: 'skipped',
          reason: '重命名失败: ' + e.message
        });
      }
    }
    const final = store.get(manifest.manifestId);
    const doneCount = final.items.filter(it => it.status === 'done').length;
    store.setStatus(manifest.manifestId, doneCount === final.items.length ? 'complete' : 'partial');
    log({ event: 'executor_shuffle', manifestId: manifest.manifestId, shuffled: doneCount, skipped: skipped.length, instructionId: manifest.instructionId, taskId: manifest.taskId, targetDir });
    return { ok: true, action: 'shuffle_desktop', manifestId: manifest.manifestId, shuffled: doneCount, skipped, manifest: store.get(manifest.manifestId) };
  }

  /**
   * restore(manifestId)：按 manifest 反向还原，幂等。
   * - shuffle 项：直接 rename 回原名（原位被占 → conflict，绝不覆盖）。
   * - quarantine 项：密文先解密到临时文件，校验 sha256 一致后才落到原位；
   *   校验失败不落盘（避免把损坏数据写回用户位置）。
   * 原位被占 → conflict；to 缺失且 from 已存在 → 视为已还原（幂等）；两者都缺 → lost。
   */
  function restore(manifestId) {
    const manifest = store.get(manifestId);
    if (!manifest) throw new Error('manifest 不存在: ' + manifestId);
    let restored = 0, conflicts = 0, lost = 0, already = 0;
    // quarantine manifest 用 keyId=manifestId 的密钥；缺密钥时无法还原，记 lost
    let key = null;
    if (manifest.kind === 'quarantine') {
      try { key = vault.loadKey(manifestId); } catch (e) { key = null; }
    }
    for (let i = 0; i < manifest.items.length; i++) {
      const item = manifest.items[i];
      if (item.status === 'restored') { already++; continue; }
      if (item.status === 'skipped' || item.status === 'pending') continue; // 从未执行过，无需还原
      const fromExists = fs.existsSync(item.from);
      const toExists = item.to ? fs.existsSync(item.to) : false;
      if (!toExists && fromExists) { already++; continue; }         // 已还原过
      if (!toExists && !fromExists) {
        lost++;
        store.updateItem(manifestId, i, { status: 'lost', reason: '原路径与新路径都不存在' });
        continue;
      }
      if (fromExists) {
        conflicts++;
        store.updateItem(manifestId, i, { status: 'conflict', reason: '原位已被占用，拒绝覆盖用户文件' });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(item.from), { recursive: true });
        if (manifest.kind === 'quarantine') {
          if (!key) throw new Error('找不到该 manifest 的密钥（keyId=' + manifestId + '），无法解密');
          if (!item.crypto || !item.crypto.iv || !item.crypto.authTag) {
            throw new Error('manifest item 缺少加密元数据（iv/authTag）');
          }
          // 先解密到同目录临时文件，校验通过再 rename 到原位：中途失败不会留下坏文件
          const tmp = item.from + '.restore-tmp';
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
          const out = vault.decryptFile(item.to, tmp, key.key, item.crypto, item.sha256);
          const mode = moveFile(tmp, item.from);
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* 已移走 */ }
          restored++;
          store.updateItem(manifestId, i, {
            status: 'restored',
            reason: '已解密还原（' + mode + '，' + out.plainSize + ' bytes，sha256 校验通过）',
            size: out.plainSize
          });
        } else {
          const mode = moveFile(item.to, item.from);
          restored++;
          store.updateItem(manifestId, i, { status: 'restored', reason: '已还原（' + mode + '）' });
        }
      } catch (e) {
        // 清理可能的半截临时文件，绝不把损坏数据留在原位
        try { const tmp = item.from + '.restore-tmp'; if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
        store.updateItem(manifestId, i, { status: 'lost', reason: '还原失败: ' + e.message });
        lost++;
      }
    }
    const final = store.get(manifestId);
    const status = final.items.some(it => it.status === 'lost') ? 'partial'
      : final.items.some(it => it.status === 'conflict') ? 'partial'
        : 'restored';
    store.setStatus(manifestId, status);
    log({ event: 'executor_restore', manifestId, restored, conflicts, lost, already });
    return {
      ok: conflicts === 0 && lost === 0,
      manifestId, restored, conflicts, lost, already,
      items: store.get(manifestId).items
    };
  }

  /** restoreAll：按 manifest 创建时间倒序全部还原（后执行的先还原） */
  function restoreAll() {
    const all = store.list();
    const results = [];
    for (const m of all.slice().reverse()) {
      if (m.status === 'restored') continue;
      if (m.kind !== 'quarantine' && m.kind !== 'shuffle') continue;
      if (m.items.every(it => it.status === 'restored' || it.status === 'skipped' || it.status === 'pending')) {
        store.setStatus(m.manifestId, 'restored');
        continue;
      }
      results.push(restore(m.manifestId));
    }
    const summary = {
      ok: results.every(r => r.ok),
      manifests: results.length,
      restored: results.reduce((s, r) => s + r.restored, 0),
      conflicts: results.reduce((s, r) => s + r.conflicts, 0),
      lost: results.reduce((s, r) => s + r.lost, 0)
    };
    log({ event: 'executor_restore_all', ...summary });
    return summary;
  }

  /**
   * 指令入口：按 action 分发。
   * 前端动作原样返回"非本地动作"。
   */
  function execute(instruction) {
    if (!instruction || typeof instruction !== 'object') throw new Error('execute 需要指令对象');
    switch (instruction.action) {
      case 'quarantine_files':
        return quarantineFiles({
          instructionId: instruction.id,
          taskId: instruction.taskId,
          targets: (instruction.payload && instruction.payload.targets) || [],
          note: instruction.reason || null
        });
      case 'shuffle_desktop':
        return shuffleDesktop({
          instructionId: instruction.id,
          taskId: instruction.taskId,
          targetDir: instruction.payload && instruction.payload.targetDir,
          note: instruction.reason || null
        });
      case 'revoke_all':
        return restoreAll();
      case 'notify':
      case 'popup_countdown':
      case 'spawn_bugs':
        return { ok: true, action: instruction.action, local: false, note: '非本地动作，由前端表现层执行' };
      default:
        throw new Error('executor 不支持的 action: ' + instruction.action);
    }
  }

  return {
    workRoot, store, vault,
    quarantineFiles, shuffleDesktop, restore, restoreAll, execute,
    listManifests() { return store.list(); },
    readAudit() { return store.readAudit(); },
    keyDir: vault.keyDir,
    /** 彻底销毁一个 manifest 的密钥（仅在 manifest 已完全还原、用户要求抹除密文时调用） */
    deleteKey(keyId) { return vault.deleteKey(keyId); }
  };
}

module.exports = { createExecutor, validateWorkRoot, QUARANTINE_DIR, DISCIPLINE_DIR, sha256OfFile };
