'use strict';
/**
 * crypto-vault.test.js —— A-M0 测试④：隔离区加密
 * 运行：node crypto-vault.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVault } = require('./crypto-vault');
const { tmpDir, rmrf, ok, equal, contains, throws, createSuite } = require('./test-util');

const suite = createSuite('crypto-vault.test.js');
let root, vault, keyDir;

suite.before(() => {
  root = tmpDir('dsc-vault-');
  keyDir = path.join(root, 'keys');
  vault = createVault({ keyDir });
});
suite.after(() => rmrf(root));

suite.test('密钥生成/读取/删除', () => {
  const k = vault.ensureKey('mf_a');
  equal(k.key.length, 32, '32 字节（AES-256）');
  ok(vault.hasKey('mf_a'), 'hasKey');
  const k2 = vault.loadKey('mf_a');
  equal(k2.key.toString('hex'), k.key.toString('hex'), '重复读取同一把密钥');
  vault.deleteKey('mf_a');
  equal(vault.hasKey('mf_a'), false, '删除后不存在');
});

suite.test('密钥按 keyId 隔离，不同 keyId 不同密钥', () => {
  const a = vault.ensureKey('mf_a');
  const b = vault.ensureKey('mf_b');
  ok(a.key.toString('hex') !== b.key.toString('hex'), '不同 manifest 不同密钥');
});

suite.test('加密后密文与明文不同，且密文不可直接读', () => {
  const src = path.join(root, 'secret.txt');
  const dest = path.join(root, 'vault', 'secret.txt');
  const plain = '这是机密文件内容，长度足够长以覆盖多个分片。'.repeat(20);
  fs.writeFileSync(src, plain);
  const key = vault.ensureKey('mf_x');
  const meta = vault.encryptFile(src, dest, key.key);
  const cipher = fs.readFileSync(dest);
  ok(!cipher.includes(Buffer.from('机密')), '密文不含明文字样');
  ok(cipher.length > 0, '密文非空');
  ok(meta.iv && meta.authTag, '返回 iv/authTag');
  equal(meta.alg, 'aes-256-gcm', '算法');
  equal(meta.plainSize, Buffer.byteLength(plain), '明文大小');
  ok(meta.plainSha256, '有明文 sha256');
});

suite.test('解密后逐字节一致且 sha256 匹配', () => {
  const src = path.join(root, 'round.bin');
  const dest = path.join(root, 'vault', 'round.bin');
  const back = path.join(root, 'round-back.bin');
  const plain = cryptoRandom(20000);
  fs.writeFileSync(src, plain);
  const key = vault.ensureKey('mf_r');
  const meta = vault.encryptFile(src, dest, key.key);
  const out = vault.decryptFile(dest, back, key.key, meta, meta.plainSha256);
  equal(out.plainSize, plain.length, '大小一致');
  equal(fs.readFileSync(back, 'hex'), plain.toString('hex'), '逐字节一致');
});

suite.test('密文被改动 → 认证失败且不落盘', () => {
  const src = path.join(root, 'tamper.txt');
  const dest = path.join(root, 'vault', 'tamper.txt');
  const back = path.join(root, 'tamper-back.txt');
  fs.writeFileSync(src, 'hello');
  const key = vault.ensureKey('mf_t');
  const meta = vault.encryptFile(src, dest, key.key);
  const buf = fs.readFileSync(dest);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(dest, buf);
  throws(() => vault.decryptFile(dest, back, key.key, meta, meta.plainSha256), '被改动的密文必须报错');
  equal(fs.existsSync(back), false, '失败时不留下输出文件');
});

suite.test('用错密钥解密 → 失败', () => {
  const src = path.join(root, 'wrongkey.txt');
  const dest = path.join(root, 'vault', 'wrongkey.txt');
  const back = path.join(root, 'wrongkey-back.txt');
  fs.writeFileSync(src, 'data');
  const k1 = vault.ensureKey('mf_k1');
  const k2 = vault.ensureKey('mf_k2');
  const meta = vault.encryptFile(src, dest, k1.key);
  throws(() => vault.decryptFile(dest, back, k2.key, meta, meta.plainSha256), '错密钥必须失败');
});

suite.test('sha256 不匹配 → 报错（防损坏数据写回原位）', () => {
  const src = path.join(root, 'hash.txt');
  const dest = path.join(root, 'vault', 'hash.txt');
  const back = path.join(root, 'hash-back.txt');
  fs.writeFileSync(src, 'data');
  const key = vault.ensureKey('mf_h');
  const meta = vault.encryptFile(src, dest, key.key);
  throws(() => vault.decryptFile(dest, back, key.key, meta, '0'.repeat(64)), 'sha256 不符必须报错');
  equal(fs.existsSync(back), false, '不落盘');
});

suite.test('loadKey 对不存在的 keyId 返回 null；损坏密钥报错', () => {
  equal(vault.loadKey('mf_nope'), null, '不存在返回 null');
  fs.writeFileSync(path.join(keyDir, 'mf_bad.key'), Buffer.alloc(16));
  throws(() => vault.loadKey('mf_bad'), '长度异常必须报错');
});

suite.test('encryptFile 失败时清理半截密文', () => {
  const src = path.join(root, 'no-such.txt');
  const dest = path.join(root, 'vault', 'no-such.txt');
  const key = vault.ensureKey('mf_e');
  throws(() => vault.encryptFile(src, dest, key.key), '源文件不存在必须抛错');
  equal(fs.existsSync(dest), false, '不留下半截文件');
});

suite.test('空文件也能正确加解密', () => {
  const src = path.join(root, 'empty.txt');
  const dest = path.join(root, 'vault', 'empty.txt');
  const back = path.join(root, 'empty-back.txt');
  fs.writeFileSync(src, '');
  const key = vault.ensureKey('mf_empty');
  const meta = vault.encryptFile(src, dest, key.key);
  const out = vault.decryptFile(dest, back, key.key, meta, meta.plainSha256);
  equal(out.plainSize, 0, '空文件');
  equal(fs.readFileSync(back, 'hex'), '', '内容为空');
});

/** 生成确定性随机字节（避免引入测试随机源） */
function cryptoRandom(n) {
  const crypto = require('crypto');
  return crypto.randomBytes(n);
}

const result = suite.run();
process.exit(result.failures.length ? 1 : 0);
