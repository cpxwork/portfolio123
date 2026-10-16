'use strict';
/**
 * test-util.js —— A 侧测试辅助（A-M0 交付）
 *
 * 只做四件事：造临时目录、断言、sha256、汇总退出码。
 * 严禁用真实桌面/真实用户文件/系统目录做测试：所有夹具都由 mkdtemp 生成。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 在系统临时目录下创建一个唯一的测试根目录 */
function tmpDir(prefix) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsc-'));
  return p;
}

/** 同步递归删除（仅用于测试临时目录；带路径守卫，拒绝删临时目录之外的东西） */
function rmrf(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(os.tmpdir());
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('rmrf 拒绝删除临时目录之外的路径: ' + resolved);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** 在临时目录里写一个文件，自动建父目录，返回绝对路径 */
function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** 读取文件内容（utf8） */
function readFile(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** 文件 sha256 十六进制；文件不存在返回 null */
function sha256(abs) {
  if (!fs.existsSync(abs)) return null;
  const st = fs.statSync(abs);
  if (!st.isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** 读取 JSONL 文件为对象数组；空文件返回 [] */
function readJsonl(abs) {
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message);
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error('断言失败(不相等): ' + message + '\n  期望: ' + JSON.stringify(expected) + '\n  实际: ' + JSON.stringify(actual));
  }
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error('断言失败(深层不等): ' + message + '\n  期望: ' + b + '\n  实际: ' + a);
  }
}

function ok(cond, message) {
  assert(cond, message);
}

function contains(haystack, needle, message) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error('断言失败(未包含): ' + message + '\n  在: ' + String(haystack).slice(0, 400) + '\n  中找不到: ' + needle);
  }
}

function throws(fn, message) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; return e; }
  if (!threw) throw new Error('断言失败(未抛错): ' + message);
  return null;
}

/** 极简测试收集器：node xxx.test.js 直跑 */
function createSuite(name) {
  const cases = [];
  // beforeAll/afterAll：整套跑一次；before/after：每个用例跑一次。
  // 注意：早期版本只有 before/after 且被当作"每个用例"执行，导致跨用例
  // 累积状态（如同一份审计日志）在下一个用例里被全新目录替换而丢失。
  const hooks = { beforeAll: [], afterAll: [], before: [], after: [] };
  return {
    test(title, fn) { cases.push({ title, fn }); },
    before(fn) { hooks.before.push(fn); },
    after(fn) { hooks.after.push(fn); },
    beforeAll(fn) { hooks.beforeAll.push(fn); },
    afterAll(fn) { hooks.afterAll.push(fn); },
    /**
     * run() 同步执行。**警告**：若用例返回 Promise（async fn），同步 run()
     * 不会等待它，失败不计入、退出码仍是 0 —— 这就是"假绿"。
     * 有异步用例请用 runAsync()，或给用例包一层同步等待。
     */
    run() {
      let pass = 0;
      const failures = [];
      for (const h of hooks.beforeAll) {
        try { h(); } catch (e) { console.log('  ✗ beforeAll 失败: ' + e.message); process.exitCode = 1; return { pass: 0, total: cases.length, failures: [{ title: 'beforeAll', error: e }] }; }
      }
      for (const c of cases) {
        for (const h of hooks.before) h();
        try {
          const ret = c.fn();
          if (ret && typeof ret.then === 'function') {
            // 同步 run 遇到 async 用例：明确标记，不静默放过
            console.log('  ⚠ ' + c.title + ' 返回 Promise，同步 run 无法等待——请改用 runAsync()');
            failures.push({ title: c.title, error: new Error('async 用例在同步 run 中被跳过') });
            continue;
          }
          pass++;
          console.log('  ✓ ' + c.title);
        } catch (e) {
          failures.push({ title: c.title, error: e });
          console.log('  ✗ ' + c.title);
          console.log('    ' + String(e && e.message).split('\n').join('\n    '));
        } finally {
          for (const h of hooks.after) h();
        }
      }
      for (const h of hooks.afterAll) {
        try { h(); } catch (e) { console.log('  ✗ afterAll 失败: ' + e.message); process.exitCode = 1; }
      }
      console.log('\n' + name + ': ' + pass + '/' + cases.length + ' 通过');
      if (failures.length) {
        console.log(name + ': ' + failures.length + ' 失败');
        process.exitCode = 1;
      }
      return { pass, total: cases.length, failures };
    },
    /** runAsync()：支持 async 用例；同步用例照常执行 */
    async runAsync() {
      let pass = 0;
      const failures = [];
      for (const h of hooks.beforeAll) {
        try { await h(); } catch (e) { console.log('  ✗ beforeAll 失败: ' + e.message); process.exitCode = 1; return { pass: 0, total: cases.length, failures: [{ title: 'beforeAll', error: e }] }; }
      }
      for (const c of cases) {
        for (const h of hooks.before) await h();
        try {
          await c.fn();
          pass++;
          console.log('  ✓ ' + c.title);
        } catch (e) {
          failures.push({ title: c.title, error: e });
          console.log('  ✗ ' + c.title);
          console.log('    ' + String(e && e.message).split('\n').join('\n    '));
        } finally {
          for (const h of hooks.after) await h();
        }
      }
      for (const h of hooks.afterAll) {
        try { await h(); } catch (e) { console.log('  ✗ afterAll 失败: ' + e.message); process.exitCode = 1; }
      }
      console.log('\n' + name + ': ' + pass + '/' + cases.length + ' 通过');
      if (failures.length) {
        console.log(name + ': ' + failures.length + ' 失败');
        process.exitCode = 1;
      }
      return { pass, total: cases.length, failures };
    }
  };
}

module.exports = {
  tmpDir, rmrf, writeFile, readFile, sha256, readJsonl,
  assert, equal, deepEqual, ok, contains, throws, createSuite
};
