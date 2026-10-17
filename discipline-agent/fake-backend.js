'use strict';
/**
 * fake-backend.js —— 可注入的假摄像头/假推理后端（仅测试与联调用）
 *
 * 真实后端（onnxruntime-node + YOLOv8n-pose，或 @mediapipe/tasks-vision
 * Pose Landmarker）的接入方式见 assets/README.md；本文件只读 fixtures
 * 里的序列帧 JSON，按调用次序返回预定关键点，不碰真实摄像头。
 */

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** 读取一个 fixture 场景文件 */
function loadFixture(name) {
  const abs = path.join(FIXTURES_DIR, name);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/** 列出所有 fixture 场景 */
function listFixtures() {
  return fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

/**
 * createFakeBackend —— 按 fixture 帧序列依次返回
 * @param {object} fixture loadFixture 的结果
 * @param {object} [opts] { failAtFrame: 第几帧开始失败, failReason: 失败原因 }
 * @returns {{ captureFrame, inferPose, context, calls }}
 */
function createFakeBackend(fixture, opts) {
  const options = opts || {};
  const failAtFrame = typeof options.failAtFrame === 'number' ? options.failAtFrame : Infinity;
  const failReason = options.failReason || 'permission_denied';
  const unavailable = fixture.cameraUnavailable || null;
  const frames = fixture.frames || [];
  const context = fixture.context || { inactiveMin: 0, locked: false, hour: 12 };

  let frameIndex = 0;
  const calls = { capture: 0, infer: 0, reasons: [] };

  /** 抓一帧：返回 { ok, frame, reason }；frame 是 fixture 里那一帧的引用副本 */
  async function captureFrame(reason) {
    calls.capture++;
    calls.reasons.push(reason || 'poll');
    if (unavailable) return { ok: false, reason: unavailable };
    if (frameIndex >= failAtFrame) return { ok: false, reason: failReason };
    // 帧序列耗尽时循环回放最后一帧：真实摄像头在"人没动"时会反复给出同一姿态，
    // 这里用循环回放模拟"静止场景"，避免把"帧播完"误当成"摄像头被拔掉"。
    const idx = Math.min(frameIndex, Math.max(0, frames.length - 1));
    if (frames.length === 0) return { ok: false, reason: 'no_camera' };
    frameIndex++;
    const f = frames[idx];
    return { ok: true, frame: Object.assign({ index: idx }, f), reason: null };
  }

  /** 姿态推理：直接把帧里预定关键点回传（真实后端这里是跑模型） */
  async function inferPose(frameList) {
    calls.infer++;
    const f = frameList && frameList[0];
    if (!f) {
      return { person: false, posture: 'absent', zone: 'none', confidence: 0, quality: 0 };
    }
    return {
      person: f.person,
      posture: f.posture,
      zone: f.zone,
      confidence: f.confidence,
      quality: f.quality,
      keypoints: f.keypoints || null
    };
  }

  return { captureFrame, inferPose, context, calls, frames };
}

/**
 * createFakeClock —— 可前进的假时钟（配合 setTimeoutFn 手动触发定时采样）
 */
function createFakeClock(startIso) {
  let now = startIso ? new Date(startIso) : new Date('2026-10-16T07:42:00+08:00');
  const timers = [];
  let seq = 0;

  function nowFn() { return now.getTime(); } // 全项目时钟契约：返回 epoch 毫秒数

  function setTimeoutFn(fn, ms) {
    const id = ++seq;
    timers.push({ id, fn, at: now.getTime() + (ms || 0) });
    return id;
  }

  function clearTimeoutFn(id) {
    const i = timers.findIndex(t => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  }

  /** 推进毫秒数并触发到期定时器 */
  function advance(ms) {
    const target = now.getTime() + ms;
    for (;;) {
      const due = timers
        .filter(t => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = new Date(due.at);
      const i = timers.indexOf(due);
      timers.splice(i, 1);
      due.fn();
    }
    now = new Date(target);
  }

  function pending() {
    return timers.map(t => ({ id: t.id, at: new Date(t.at).toISOString(), inMs: t.at - now.getTime() }));
  }

  return { now: nowFn, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, advance, pending, seq: () => seq };
}

module.exports = { FIXTURES_DIR, loadFixture, listFixtures, createFakeBackend, createFakeClock };
