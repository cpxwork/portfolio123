'use strict';
/**
 * crypto-vault.js —— 隔离区加密（A-M0 增补）
 *
 * 隔离区里的文件以 AES-256-GCM 密文落盘：文件被复制出去、被同步、被别的软件
 * 翻看时都只是一段无法解读的字节。GCM 自带认证标签，密文被改动会在还原时
 * 被发现，不会把损坏的数据写回用户的原位置。
 *
 * 设计约束（不可随意更改）：
 *   1. 零第三方依赖，只用 Node 内置 crypto。
 *   2. 一把 manifest 一把密钥：密钥文件放在 <workRoot>/.discipline/keys/<keyId>.key，
 *      与密文分目录存放；manifest 里只记 keyId / iv / authTag，绝不记密钥本身。
 *   3. 还原必须"一键"完成（revoke_all 不能要求用户输口令），所以密钥由本机保管，
 *      不用口令派生——口令会把"随时可撤销"变成"先想起来密码"。
 *   4. 每个文件独立随机 IV；禁止复用 IV。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;   // AES-256
const IV_BYTES = 12;    // GCM 推荐 96 bit
const CHUNK = 1024 * 64;

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function unb64(str) { return Buffer.from(String(str), 'base64'); }

/**
 * createVault
 * @param {object} opts
 * @param {string} opts.keyDir 密钥目录
 */
function createVault(opts) {
  const options = opts || {};
  const keyDir = options.keyDir;
  if (!keyDir) throw new Error('createVault 需要 opts.keyDir');
  fs.mkdirSync(keyDir, { recursive: true });

  function keyPath(keyId) { return path.join(keyDir, keyId + '.key'); }

  /** 生成一把新密钥并落盘（keyId 用 manifestId，一把 manifest 一把） */
  function ensureKey(keyId) {
    if (!keyId || typeof keyId !== 'string') throw new Error('ensureKey 需要 keyId');
    const abs = keyPath(keyId);
    if (fs.existsSync(abs)) return loadKey(keyId);
    const key = crypto.randomBytes(KEY_BYTES);
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, key);
    fs.renameSync(tmp, abs);
    try { fs.chmodSync(abs, 0o600); } catch (e) { /* Windows 上 chmod 近似无效，忽略 */ }
    return { keyId, key };
  }

  function loadKey(keyId) {
    const abs = keyPath(keyId);
    if (!fs.existsSync(abs)) return null;
    const key = fs.readFileSync(abs);
    if (key.length !== KEY_BYTES) throw new Error('密钥长度异常: ' + keyId + ' (' + key.length + ' bytes)');
    return { keyId, key };
  }

  function hasKey(keyId) { return fs.existsSync(keyPath(keyId)); }

  function deleteKey(keyId) {
    const abs = keyPath(keyId);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }

  /**
   * 加密 src → dest，返回可写入 manifest 的元数据。
   * 明文的 sha256 在加密过程中同步算出（供还原后校验），由调用方记入 manifest。
   */
  function encryptFile(src, dest, key) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const hash = crypto.createHash('sha256');
    const fdIn = fs.openSync(src, 'r');
    let fdOut = null;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fdOut = fs.openSync(dest, 'w');
      const buf = Buffer.allocUnsafe(CHUNK);
      let plainSize = 0;
      for (;;) {
        const bytes = fs.readSync(fdIn, buf, 0, buf.length, null);
        if (bytes === 0) break;
        const chunk = buf.subarray(0, bytes);
        hash.update(chunk);
        const out = cipher.update(chunk);
        if (out.length > 0) fs.writeSync(fdOut, out, 0, out.length);
        plainSize += bytes;
      }
      const tail = cipher.final();
      if (tail.length > 0) fs.writeSync(fdOut, tail, 0, tail.length);
      return {
        alg: ALG,
        iv: b64(iv),
        authTag: b64(cipher.getAuthTag()),
        keyId: null,             // 由调用方回填
        plainSize,
        plainSha256: hash.digest('hex')
      };
    } catch (e) {
      // 半截密文没有价值，删掉避免误当完整文件
      try { if (fdOut !== null) fs.closeSync(fdOut); } catch (e2) { /* 忽略 */ }
      try { fs.unlinkSync(dest); } catch (e2) { /* 可能还没创建 */ }
      throw e;
    } finally {
      try { fs.closeSync(fdIn); } catch (e) { /* 忽略 */ }
      try { if (fdOut !== null) fs.closeSync(fdOut); } catch (e) { /* 已关闭则忽略 */ }
    }
  }

  /**
   * 解密 src → dest，并校验明文 sha256 与 manifest 记录一致。
   * 校验失败或认证失败时抛错，且不留下半截 dest。
   * @returns {{plainSha256:string, plainSize:number}}
   */
  function decryptFile(src, dest, key, meta, expectSha256) {
    const iv = unb64(meta.iv);
    const authTag = unb64(meta.authTag);
    if (iv.length !== IV_BYTES) throw new Error('IV 长度异常');
    if (authTag.length !== 16) throw new Error('authTag 长度异常');
    const decipher = crypto.createDecipheriv(meta.alg || ALG, key, iv);
    decipher.setAuthTag(authTag);
    const hash = crypto.createHash('sha256');
    const fdIn = fs.openSync(src, 'r');
    let fdOut = null;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fdOut = fs.openSync(dest, 'w');
      const buf = Buffer.allocUnsafe(CHUNK);
      let plainSize = 0;
      for (;;) {
        const bytes = fs.readSync(fdIn, buf, 0, buf.length, null);
        if (bytes === 0) break;
        const chunk = buf.subarray(0, bytes);
        const out = decipher.update(chunk);
        if (out.length > 0) {
          fs.writeSync(fdOut, out, 0, out.length);
          hash.update(out);
          plainSize += out.length;
        }
      }
      const tail = decipher.final();   // 认证失败在这里抛错
      if (tail.length > 0) {
        fs.writeSync(fdOut, tail, 0, tail.length);
        hash.update(tail);
        plainSize += tail.length;
      }
      const plainSha256 = hash.digest('hex');
      if (expectSha256 && plainSha256 !== expectSha256) {
        throw new Error('解密后 sha256 与 manifest 记录不一致（期望 ' + expectSha256 + '，实际 ' + plainSha256 + '）');
      }
      return { plainSha256, plainSize };
    } catch (e) {
      try { if (fdOut !== null) fs.closeSync(fdOut); } catch (e2) { /* 忽略 */ }
      try { fs.unlinkSync(dest); } catch (e2) { /* 可能还没创建 */ }
      throw e;
    } finally {
      try { fs.closeSync(fdIn); } catch (e) { /* 忽略 */ }
      try { if (fdOut !== null) fs.closeSync(fdOut); } catch (e) { /* 已关闭则忽略 */ }
    }
  }

  return { keyDir, ALG, ensureKey, loadKey, hasKey, deleteKey, encryptFile, decryptFile };
}

module.exports = { createVault, ALG, KEY_BYTES, IV_BYTES };
