/* Run: node --test --test-isolation=none haipigua/tests/studio.test.cjs
 * (or node --test --test-isolation=none tests/studio.test.cjs here).
 * These tests exercise user-visible state transitions. They do not call a model or a browser.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'little-spark.v1';
const INITIAL_NOW = '2026-10-17T01:00:00.000Z'; // 09:00 in Asia/Shanghai.
const copy = value => JSON.parse(JSON.stringify(value));
function fixture({seed, indexedDB, failSave = false} = {}) {
  let now = INITIAL_NOW, serial = 0;
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return +new Date(now); }
  }
  const values = new Map(seed === undefined ? [] : [[KEY, typeof seed === 'string' ? seed : JSON.stringify(seed)]]);
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { if (failSave) throw Error('QuotaExceededError'); values.set(key, value); }
  };
  const context = {console, Date: FrozenDate, crypto: {randomUUID: () => 'test-' + ++serial}, indexedDB};
  context.window = context;
  vm.createContext(context);
  for (const file of ['engine.js', 'ramble.js', 'pocket.js', 'studio-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8'), context, {filename: file});
  }
  const app = context.HaipiguaCore.create(storage, () => new Date(now));
  return {app, context, storage, values, setNow(value) { now = value; }};
}
function schedule(app, text = '我想学跳舞，今天下午三点练20分钟') {
  app.submit(text);
  assert.ok(app.state.tasks.length, 'example must create an actionable appointment');
  return app.state.tasks.at(-1);
}
function validBackup() {
  const {app} = fixture();
  const task = schedule(app);
  app.feedback({taskId: task.id, completion: 'partial', minutes: 5, feeling: 'hard', reason: '还没跟上节拍'});
  return copy(app.state);
}

test('one ramble preserves its original and routes two interests to separate actions', () => {
  const {app} = fixture();
  const original = '我想学跳舞，今天下午三点学20分钟。我想做一个小卫星，今天晚上八点试10分钟。';
  const note = app.submit(original);
  assert.equal(note.text, original);
  assert.deepEqual(Array.from(note.agents), [1, 2, 3]);
  assert.equal(app.state.ideas.length, 2);
  const dance = app.state.ideas.find(i => i.type === 'skill');
  const satellite = app.state.ideas.find(i => i.type === 'creative');
  assert.ok(dance && satellite);
  assert.ok(satellite.exploration.firstStep);
  assert.equal(app.state.tasks.find(t => t.ideaId === dance.id).start, '15:00');
  assert.equal(app.state.tasks.find(t => t.ideaId === satellite.id).start, '20:00');
  assert.equal(app.state.tasks.find(t => t.ideaId === satellite.id).kind, 'experiment');
});

test('new busy time asks before moving an existing appointment and the reply reschedules it', () => {
  const {app} = fixture();
  const original = schedule(app);
  const note = app.submit('今天下午三点到四点我有课');
  assert.match(note.clarification, /改到几点/);
  assert.equal(app.state.tasks[0].start, '15:00');
  assert.equal(app.state.availability['2026-10-17'][0].end, '16:00');
  app.submit('那改到下午五点吧');
  assert.equal(app.state.tasks.length, 1);
  assert.equal(app.state.tasks[0].id, original.id);
  assert.equal(app.state.tasks[0].start, '17:00');
});

test('ambiguous morning/evening time is clarified before an action is saved', () => {
  const {app} = fixture();
  const note = app.submit('我想学跳舞，明天三点练十分钟');
  assert.equal(app.state.tasks.length, 0);
  assert.match(note.clarification, /上午|下午|晚上/);
  app.submit('下午');
  assert.equal(app.state.tasks.length, 1);
  assert.equal(app.state.tasks[0].start, '15:00');
});

test('feedback closes the loop and makes the next hard practice shorter', () => {
  const {app} = fixture();
  const task = schedule(app);
  const feedback = app.feedback({taskId: task.id, completion: 'partial', minutes: 5, feeling: 'hard', reason: '基础动作跟不上'});
  assert.equal(task.status, 'partial');
  assert.equal(feedback.nextAdjustment.durationScale, 0.6);
  assert.deepEqual(Array.from(app.state.notes.at(-1).agents), [4, 1]);
  assert.equal(app.state.notes.at(-1).feedbackId, feedback.id);
  app.submit('下次明天下午三点再练20分钟');
  const next = app.state.tasks.at(-1);
  assert.equal(next.ideaId, task.ideaId);
  assert.equal(next.date, '2026-10-18');
  assert.equal(next.duration, 12);
  assert.equal(app.state.tasks.length, 2, 'keep the old action and its feedback');
  assert.throws(() => app.feedback({taskId: task.id, completion: 'done', minutes: 20, feeling: 'right'}), /已经反馈/);
});

test('8000 characters survive persistence and an oversize draft does not partly mutate state', () => {
  const {app, values} = fixture();
  const original = '记'.repeat(8000);
  app.submit(original);
  assert.equal(app.state.notes[0].text, original);
  assert.equal(JSON.parse(values.get(KEY)).notes[0].text, original);
  const snapshot = app.exportData();
  assert.throws(() => app.submit(original + '呀'), /8000/);
  assert.equal(app.exportData(), snapshot);
});

test('old version-1 data loads without studio metadata or notes', () => {
  const old = validBackup();
  delete old.studio; delete old.notes; delete old.chatContext;
  const {app} = fixture({seed: old});
  assert.equal(app.storageError, '');
  assert.equal(app.state.ideas.length, old.ideas.length);
  assert.equal(app.state.feedback.length, 1);
  assert.equal(app.mode(), 'gentle');
  assert.equal(app.state.studio.preference.duration, 10);
  assert.ok(Array.isArray(app.state.notes));
});

test('reschedule without an explicit date inherits tomorrow, explicit today overrides it', () => {
  const {app} = fixture();
  const task = schedule(app, '我想学跳舞，明天中午十二点练10分钟');
  app.submit('这个时间我有课，改到下午三点吧');
  assert.equal(app.state.tasks.length, 1);
  assert.equal(app.state.tasks[0].id, task.id);
  assert.equal(app.state.tasks[0].date, '2026-10-18');
  assert.equal(app.state.tasks[0].start, '15:00');
  app.submit('改到今天下午五点吧');
  assert.equal(app.state.tasks[0].date, '2026-10-17');
  assert.equal(app.state.tasks[0].start, '17:00');
});

test('strict reminders require explicit consent and do not enroll old appointments', () => {
  const {app, setNow} = fixture();
  const before = schedule(app);
  assert.throws(() => app.setMode('strict'), /确认/);
  assert.throws(() => app.setMode('strict', {accepted: false}), /确认/);
  assert.equal(app.mode(), 'gentle');
  app.setMode('strict', {accepted: true, bugs: true});
  assert.equal(app.mode(), 'strict');
  setNow('2026-10-17T08:00:00.000Z');
  assert.equal(app.overdue().length, 0, 'existing gentle appointment is not retroactively enrolled');
  assert.equal(before.contract.mode, 'gentle');
  app.submit('下次今天晚上八点再练十分钟');
  const after = app.state.tasks.at(-1);
  assert.equal(after.contract.mode, 'strict');
  assert.equal(after.contract.bugs, true);
  setNow('2026-10-17T13:00:00.000Z');
  assert.deepEqual(app.overdue().map(t => t.id).join(','), after.id);
});

test('strict mode expires at Shanghai midnight and does not leak reminders into tomorrow', () => {
  const {app, setNow} = fixture();
  app.setMode('strict', {accepted: true, bugs: false});
  schedule(app);
  setNow('2026-10-17T15:59:00.000Z');
  assert.equal(app.current().today, '2026-10-17');
  assert.equal(app.overdue().length, 1);
  setNow('2026-10-17T16:00:00.000Z');
  assert.equal(app.current().today, '2026-10-18');
  assert.equal(app.mode(), 'gentle');
  assert.equal(app.overdue().length, 0);
});

test('dismissing an overdue action postpones the reminder and gentle mode clears eligibility', () => {
  const {app, setNow} = fixture();
  app.setMode('strict', {accepted: true});
  const task = schedule(app);
  setNow('2026-10-17T08:00:00.000Z');
  assert.equal(app.overdue().length, 1);
  app.dismiss(task.id, 30);
  assert.equal(app.overdue().length, 0);
  setNow('2026-10-17T08:29:59.000Z');
  assert.equal(app.overdue().length, 0);
  setNow('2026-10-17T08:30:00.000Z');
  assert.equal(app.overdue().length, 1);
  app.setMode('gentle');
  assert.equal(app.overdue().length, 0);
});

test('a backup cannot grant strict consent or visual effects', () => {
  const source = fixture();
  source.app.setMode('strict', {accepted: true, bugs: true});
  schedule(source.app);
  const destination = fixture();
  destination.app.importData(source.app.exportData());
  destination.setNow('2026-10-17T08:00:00.000Z');
  assert.equal(destination.app.mode(), 'gentle');
  assert.equal(destination.app.state.studio.mode.bugs, false);
  assert.equal(destination.app.overdue().length, 0);
});

test('strict agreement survives a same-day natural-language reschedule', () => {
  const {app, setNow} = fixture();
  app.setMode('strict', {accepted: true, bugs: true});
  const before = schedule(app);
  const agreement = copy(before.contract);
  app.submit('改到下午五点吧');
  const after = app.state.tasks.find(t => t.id === before.id);
  assert.deepEqual(copy(after.contract), agreement);
  setNow('2026-10-17T10:00:00.000Z');
  assert.equal(app.overdue().length, 1);
});

test('unreadable browser data is retained for export instead of silently overwritten', () => {
  const raw = '{broken JSON';
  const {app, values} = fixture({seed: raw});
  assert.match(app.storageError, /备份/);
  app.submit('我想学跳舞');
  assert.equal(values.get(KEY), raw);
  assert.equal(app.exportData(), raw);
});

test('quota failure keeps the unsaved state exportable and surfaces a persistence error', () => {
  const {app, values} = fixture({failSave: true});
  app.submit('我想学跳舞');
  assert.match(app.storageError, /保存失败/);
  assert.equal(values.has(KEY), false);
  assert.equal(JSON.parse(app.exportData()).ideas.length, 1);
});

test('invalid import leaves the current record intact', () => {
  const {app} = fixture();
  schedule(app);
  const snapshot = app.exportData();
  const broken = validBackup();
  broken.tasks[0].ideaId = 'missing-idea';
  assert.throws(() => app.importData(JSON.stringify(broken)), /格式/);
  assert.equal(app.exportData(), snapshot);
});

test('import rejects non-array note references that would crash dialogue rendering', () => {
  const {context} = fixture();
  const data = validBackup();
  data.notes[0].ideaIds = {};
  assert.equal(context.HaipiguaCore.validate(data), false);
});

test('import rejects invalid feedback timestamps required by memory rendering', () => {
  const {context} = fixture();
  const data = validBackup();
  data.feedback[0].createdAt = 42;
  assert.equal(context.HaipiguaCore.validate(data), false);
});

test('import rejects non-array tutorial resources instead of crashing on filter', () => {
  const {context} = fixture();
  const data = validBackup();
  data.tasks[0].resources = {};
  assert.equal(context.HaipiguaCore.validate(data), false);
});

test('import rejects duplicate feedback identities to keep provenance unambiguous', () => {
  const {context} = fixture();
  const data = validBackup();
  data.feedback.push(copy(data.feedback[0]));
  assert.equal(context.HaipiguaCore.validate(data), false);
});

test('local media can be read with the original database, store, and feedback key', async () => {
  const calls = [], originalFile = {name: 'old-dance.mp4', type: 'video/mp4', size: 1024};
  const indexedDB = {
    open(name, version) {
      calls.push([name, version]);
      const request = {};
      queueMicrotask(() => {
        request.result = {
          transaction(store) {
            calls.push(['transaction', store]);
            return {objectStore(storeName) {
              assert.equal(storeName, 'files');
              return {get(id) {
                const query = {};
                queueMicrotask(() => { query.result = id === 'legacy-feedback' ? originalFile : undefined; query.onsuccess(); });
                return query;
              }};
            }};
          }
        };
        request.onsuccess();
      });
      return request;
    }
  };
  const {app} = fixture({indexedDB});
  assert.equal(await app.getMedia('legacy-feedback'), originalFile);
  assert.equal(await app.getMedia('not-on-this-device'), null);
  assert.deepEqual(calls[0], ['little-spark-media', 1]);
  assert.equal(calls.filter(c => c[0] === 'little-spark-media').length, 1, 'reuse the opened database');
});

test('unsupported or non-video uploads fail without claiming analysis or saving metadata', async () => {
  const {app} = fixture();
  await assert.rejects(app.putMedia('x', {type: 'image/png', size: 200}), /视频/);
  await assert.rejects(app.putMedia('x', {type: 'video/mp4', size: 26 * 1024 * 1024}), /25 MB/);
  await assert.rejects(app.putMedia('x', {type: 'video/mp4', size: 200}), /不支持保存视频/);
  assert.equal(app.state.feedback.length, 0);
});

test('legacy attachment metadata migrates to the same feedback-keyed local file', () => {
  const old = validBackup();
  const legacy = old.feedback[0];
  delete legacy.media;
  legacy.attachment = {name: '我的练习.mp4', type: 'video/mp4', size: 1024, local: true};
  const {app} = fixture({seed: old});
  assert.equal(app.storageError, '');
  assert.equal(app.state.feedback[0].media.id, legacy.id);
  assert.equal(app.state.feedback[0].media.name, '我的练习.mp4');
  assert.equal(app.state.feedback[0].media.analysis, 'not-analyzed');
});

test('reward mode requires a daily agreement and expires at Shanghai midnight', () => {
  const {app, setNow} = fixture();
  assert.throws(() => app.setMode('reward'), /确认/);
  assert.equal(app.mode(), 'gentle');
  app.setMode('reward', {accepted: true});
  assert.equal(app.mode(), 'reward');
  setNow('2026-10-17T16:00:00.000Z');
  assert.equal(app.mode(), 'gentle');
});

test('all modes may earn demo progress, once per interest per day, never financial credit', () => {
  for (const mode of ['gentle', 'reward', 'strict']) {
    const {app} = fixture();
    app.setMode(mode, {accepted: true});
    const first = schedule(app);
    app.feedback({taskId: first.id, completion: 'done', minutes: 10, feeling: 'right'});
    app.submit('下次今天下午五点再练十分钟');
    const second = app.state.tasks.at(-1);
    app.feedback({taskId: second.id, completion: 'done', minutes: 10, feeling: 'right'});
    assert.equal(app.state.studio.rewards.length, 1, mode + ': repeated appointments are not new interests');
    const reward = app.state.studio.rewards[0];
    assert.equal(reward.points, 5);
    assert.equal(reward.status, 'pending');
    assert.equal(reward.basis, 'self-report');
    assert.equal(reward.financialValue, 0);
  }
});

test('demo progress has a daily cap and a missed action never clears previous progress', () => {
  const {app} = fixture();
  app.setMode('reward', {accepted: true});
  for (const [interest, hour] of [['跳舞', '三'], ['唱歌', '四'], ['画画', '五'], ['编程', '六']]) {
    const task = schedule(app, '我想学' + interest + '，今天下午' + hour + '点练十分钟');
    app.feedback({taskId: task.id, completion: 'done', minutes: 10, feeling: 'right'});
  }
  assert.equal(app.state.studio.rewards.reduce((n, r) => n + r.points, 0), 15);
  const task = schedule(app, '我想学英语，今天晚上八点练十分钟');
  app.feedback({taskId: task.id, completion: 'skipped', minutes: 0, feeling: 'hard', reason: '临时有课'});
  assert.equal(app.state.studio.rewards.reduce((n, r) => n + r.points, 0), 15);
});

test('undo removes the natural-language feedback and its demo progress receipt together', () => {
  const {app, context} = fixture();
  app.setMode('reward', {accepted: true});
  const initial = schedule(app);
  const note = app.submit('跳舞练了十分钟，已经完成了');
  assert.equal(app.state.feedback.length, 1);
  assert.equal(app.state.studio.rewards.length, 1);
  assert.equal(context.PocketFlow.canUndo(note.id, app.state), true);
  assert.equal(app.undo(note.id), true);
  assert.equal(app.state.tasks.find(t => t.id === initial.id).status, 'accepted');
  assert.equal(app.state.feedback.length, 0);
  assert.equal(app.state.studio.rewards.length, 0);
  assert.equal(app.state.notes.at(-1).text, note.text, 'undo keeps the original ramble');
  assert.equal(app.state.notes.at(-1).undone, true);
});

test('a split spoken feedback reports the actual ten minutes and asks no redundant question', () => {
  const {app} = fixture();
  schedule(app);
  const note = app.submit('跳舞做完了，练了十分钟，难度刚好');
  assert.equal(app.state.feedback.length, 1);
  assert.equal(app.state.feedback[0].minutes, 10);
  assert.equal(app.state.feedback[0].completion, 'done');
  assert.equal(app.state.feedback[0].feeling, 'right');
  assert.equal(note.clarification, undefined);
});
