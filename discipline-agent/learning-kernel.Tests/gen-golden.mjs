#!/usr/bin/env node
'use strict';
/**
 * gen-golden.mjs —— 金样期望值生成器（M-K 步骤③）
 *
 * 独立实现：按 FSRS-6 论文公式 / Astral-Path FormulaConstants 注释 / 任务书公式
 * 用 JS 重写一遍，期望值绝不取自 C# 内核输出（红线：不能拿被测代码的输出当期望）。
 * 常量值本身（w0-w20、FormulaConstants）是定义，与上游一致是前提而非巧合。
 *
 * 用法：node gen-golden.mjs   → 写 golden/{review,interval,score,transition,scanDebts,optimize}.json
 * errors.json 手工维护（无需数值计算）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'golden');
mkdirSync(OUT, { recursive: true });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════ FSRS-6（ReciteHelper 口径，w0-w20） ═══════════════
// 公式（FsrsAlgorithm.cs 头注释）：
//   R(t,S) = (1 + F·t/S)^decay，decay=-w20，F=0.9^(1/decay)-1（R(S,S)=0.9）
//   S0(G)=w[G-1]；D0(G)=w4-e^(w5(G-1))+1
//   D' = w7·D0(Easy) + (1-w7)·(D + ΔD(10-D)/9)，ΔD=-w6(G-3)
//   S'_rec = S(1+e^w8(11-D)S^-w9(e^(w10(1-R))-1)·hard·easy)
//   S'_lap = min(w11·D^-w12·((S+1)^w13-1)·e^(w14(1-R)), S/e^(w17·w18))
//   S'_day = S·f，f=e^(w17(G-3+w18))·S^-w19，G≥Hard 时 f 下限 1
const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const MIN_S = 0.001, MAX_S = 36500, MIN_D = 1.0, MAX_D = 10.0;
const DECAY = -W[20];
const F = Math.pow(0.9, 1 / DECAY) - 1;

const fsrsRetrievability = (S, t) => (t <= 0 ? 1.0 : Math.pow(1 + F * t / Math.max(S, MIN_S), DECAY));
const fsrsInterval = (S, r) => Math.max(S, MIN_S) / F * (Math.pow(r, 1 / DECAY) - 1);
const fsrsD0 = g => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, MIN_D, MAX_D);
function fsrsNextDifficulty(d, g) {
  const damped = d + (-W[6] * (g - 3)) * (10 - d) / 9;
  const target = W[4] - Math.exp(W[5] * (4 - 1)) + 1; // raw D0(Easy)，不 clamp（C# NextDifficulty 行为）
  return W[7] * target + (1 - W[7]) * damped;
}
function fsrsSRecall(s, d, r, g) {
  const hardPenalty = g === 2 ? W[15] : 1;  // Hard=2
  const easyBonus = g === 4 ? W[16] : 1;    // Easy=4
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hardPenalty * easyBonus);
}
function fsrsSLapse(s, d, r) {
  const lapse = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(lapse, s / Math.exp(W[17] * W[18]));
}
function fsrsSSameDay(s, g) {
  let sinc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
  if (g >= 2) sinc = Math.max(sinc, 1); // G≥Hard 保底不缩
  return s * sinc;
}
/** state=null → InitialState；否则 NextState。返回 {stability, difficulty, retrievability, intervalDays} */
function fsrsReview(state, elapsedDays, grade, retention = 0.9) {
  let s, d;
  if (state) {
    s = state.stability; d = state.difficulty;
    const el = Math.max(elapsedDays, 0);
    const r = fsrsRetrievability(s, el);
    const newS = el < 1 ? fsrsSSameDay(s, grade) : (grade > 1 ? fsrsSRecall(s, d, r, grade) : fsrsSLapse(s, d, r));
    s = clamp(newS, MIN_S, MAX_S);
    d = clamp(fsrsNextDifficulty(d, grade), MIN_D, MAX_D);
    return { stability: s, difficulty: d, retrievability: r, intervalDays: fsrsInterval(s, retention) };
  }
  s = clamp(W[grade - 1], MIN_S, MAX_S);
  d = fsrsD0(grade); // InitialState 内已 clamp
  return { stability: s, difficulty: d, retrievability: 1.0, intervalDays: fsrsInterval(s, retention) };
}

// ═══════════════ score-v2（Astral-Path MasteryCalculator 口径） ═══════════════
const SC = { WEmp: 0.50, WRet: 0.30, WPre: 0.20, Floor: 0.55, PS: 0.5, PF: 0.5, S0: 2.5, SA: 0.45, SB: 0.25, Mix: 0.65, Conf: 5 };
const clamp01 = v => clamp(v, 0, 1);
function scEmpirical(n, s) {
  s = clamp(s, 0, Math.max(n, 0));
  const f = Math.max(n, 0) - s;
  return (s + SC.PS) / (s + f + SC.PS + SC.PF);
}
const scStability = (streak, n) => SC.S0 * (1 + SC.SA * Math.max(streak, 0)) * (1 + SC.SB * Math.log(1 + Math.max(n, 1)));
const scRetention = (age, streak, n) => Math.exp(-Math.max(age, 0) / scStability(streak, n));
function scPrereqSupport(list) {
  if (!list || list.length === 0) return 0.5;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return (1 - SC.Mix) * mean + SC.Mix * Math.min(...list);
}
const scPrereqCeiling = list => (!list || list.length === 0 ? 1.0 : SC.Floor + (1 - SC.Floor) * Math.min(...list));
function scCompute({ attempts, successes, confidence, ageDays, streak, prereqScores }) {
  const emp = scEmpirical(attempts, successes);
  const confNorm = clamp01(confidence / SC.Conf);
  const know = 0.85 * emp + 0.15 * confNorm;
  const ret = scRetention(ageDays, streak, attempts);
  const pre = scPrereqSupport(prereqScores);
  const raw = SC.WEmp * know + SC.WRet * ret + SC.WPre * pre;
  return clamp01(Math.min(raw, scPrereqCeiling(prereqScores)));
}
const scFull = i => ({
  score: scCompute(i),
  emp: scEmpirical(i.attempts, i.successes),
  know: 0.85 * scEmpirical(i.attempts, i.successes) + 0.15 * clamp01(i.confidence / SC.Conf),
  stability: scStability(i.streak, i.attempts),
  retention: scRetention(i.ageDays, i.streak, i.attempts),
  prereqSupport: scPrereqSupport(i.prereqScores),
  prereqCeiling: scPrereqCeiling(i.prereqScores),
  degraded: !i.prereqScores || i.prereqScores.length === 0
});

// ═══════════════ sale-v2（Astral-Path SaleStateMachine 口径） ═══════════════
const SALE = { StreakReq: 2, MinAttempts: 3, Bar: 0.65, AccMin: 0.7, ConfMin: 3 };
const saleWeighted = a => 0.7 * clamp01(a.accuracy) + 0.3 * clamp01(a.selfConf / 5);
const saleMeetsBar = a => saleWeighted(a) >= SALE.Bar && a.accuracy >= SALE.AccMin && a.selfConf >= SALE.ConfMin;
function saleTransition(state, a) {
  if (state.status === 'Cleared') return { ...state };
  const attempts = state.attempts + 1;
  const streak = saleMeetsBar(a) ? state.streak + 1 : 0;
  const pct = Math.round(saleWeighted(a) * 100);
  let status = state.status;
  if (streak >= SALE.StreakReq && attempts >= SALE.MinAttempts) status = 'Cleared';
  else if (streak > 0 || attempts > 0) status = 'Repairing';
  return { status, streak, attempts, weightedScorePct: pct, cleared: status === 'Cleared' };
}
function saleProbe(history) {
  let streak = 0;
  for (const h of history) streak = (h.acc >= SALE.AccMin && h.conf >= SALE.ConfMin) ? streak + 1 : 0;
  const saleable = streak >= SALE.StreakReq;
  let need = null;
  if (!saleable) {
    const n = Math.max(1, SALE.StreakReq - streak);
    need = n <= 1 ? '再完成 1 次达标小测（acc≥0.7 且 conf≥3）' : `再完成 ${n} 次达标小测（acc≥0.7 且 conf≥3）`;
  }
  return { mode: 'probe', saleable, streak, need };
}

// ═══════════════ impact-v2（Astral-Path DebtScanner 口径） ═══════════════
const IMP = { Base: 0.55, TG: 1.15, PGate: 0.55, CGate: 0.50, Steep: 8, Hit: 0.08, CA: 0.12, VB: 0.08 };
const sigmoid = x => 1 / (1 + Math.exp(-x));
function debtImpact(e) {
  if (e.freq <= 0) return 0;
  const cross = e.edgeType === 'transferGap' ? IMP.TG : 1;
  const readiness = sigmoid((e.scoreFrom - IMP.PGate) * IMP.Steep);
  const gap = sigmoid((IMP.CGate - e.scoreTo) * IMP.Steep);
  const cascade = 1 + IMP.CA * Math.log(1 + Math.max(e.downstreamCount || 0, 0));
  const volume = 1 + IMP.VB * Math.log(1 + Math.max(e.freq, 0));
  return IMP.Base * readiness * gap * Math.max(e.weight, 0) * cross * cascade * volume;
}
const debtFull = e => { const impact = debtImpact(e); return { impact, hit: e.freq > 0 && impact >= IMP.Hit }; };

// ═══════════════ 用例表 ═══════════════
const round = v => (typeof v === 'number' ? Number(v.toPrecision(12)) : v); // JSON 往返稳定

const review = [
  { name: 'new-again', args: { grade: 1 }, expect: fsrsReview(null, 0, 1) },
  { name: 'new-hard', args: { grade: 2 }, expect: fsrsReview(null, 0, 2) },
  { name: 'new-good', args: { grade: 3 }, expect: fsrsReview(null, 0, 3) },
  { name: 'new-easy-d0-clamped-to-1', args: { grade: 4 }, expect: fsrsReview(null, 0, 4) },
  { name: 'recall-good-3d', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 3, grade: 3 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 3, 3) },
  { name: 'lapse-again-3d', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 3, grade: 1 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 3, 1) },
  { name: 'recall-hard-3d', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 3, grade: 2 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 3, 2) },
  { name: 'recall-easy-3d', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 3, grade: 4 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 3, 4) },
  { name: 'same-day-good', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 0, grade: 3 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 0, 3) },
  { name: 'same-day-again-no-floor', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 0, grade: 1 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 0, 1) },
  { name: 'min-stability-boost', args: { state: { stability: 0.001, difficulty: 1 }, elapsedDays: 0, grade: 4 }, expect: fsrsReview({ stability: 0.001, difficulty: 1 }, 0, 4) },
  { name: 'max-stability-clamp', args: { state: { stability: 36500, difficulty: 1 }, elapsedDays: 100, grade: 1 }, expect: fsrsReview({ stability: 36500, difficulty: 1 }, 100, 1) },
  { name: 'negative-elapsed-clamped', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: -5, grade: 3 }, expect: fsrsReview({ stability: 5, difficulty: 5 }, 0, 3) },
  { name: 'custom-w-args', args: { state: { stability: 5, difficulty: 5 }, elapsedDays: 3, grade: 3, w: [0.5, 1.5, 3, 9, 6, 0.8, 3, 0.001, 1.9, 0.17, 0.8, 1.5, 0.06, 0.27, 1.65, 0.6, 1.9, 0.54, 0.09, 0.066, 0.15] }, expect: (() => { const w2 = [...W]; w2[0] = 0.5; w2[2] = 3; w2[8] = 1.9; return null; })() },
];
// custom-w 用单独计算（上面占位，这里重算）
review[13].expect = (() => {
  const decay = -0.15, Fc = Math.pow(0.9, 1 / decay) - 1;
  const s = 5, d = 5, el = 3, g = 3;
  const r = Math.pow(1 + Fc * el / s, decay);
  const w = [0.5, 1.5, 3, 9, 6, 0.8, 3, 0.001, 1.9, 0.17, 0.8, 1.5, 0.06, 0.27, 1.65, 0.6, 1.9, 0.54, 0.09, 0.066, 0.15];
  const newS = s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1));
  const damped = d + (-w[6] * (g - 3)) * (10 - d) / 9;
  const newD = w[7] * (w[4] - Math.exp(w[5] * 3) + 1) + (1 - w[7]) * damped;
  return { stability: clamp(newS, MIN_S, MAX_S), difficulty: clamp(newD, MIN_D, MAX_D), retrievability: r, intervalDays: clamp(newS, MIN_S, MAX_S) / Fc * (Math.pow(0.9, 1 / decay) - 1) };
})();

const intervals = [
  [5, 0.9], [2.3065, 0.9], [0.212, 0.9], [13.404752151836563, 0.9], [36500, 0.9],
  [5, 0.8], [5, 0.85], [5, 0.95], [5, 0.99], [0.001, 0.9], [0.001, 0.8], [36500, 0.5], [100, 0.75], [1, 0.7],
].map(([stability, retention]) => ({
  name: `s${stability}-r${retention}`,
  args: { stability, retention },
  expect: { intervalDays: fsrsInterval(stability, retention), stability, retention }
}));

const score = [
  { name: 'no-records', args: { attempts: 0, successes: 0, confidence: 3, lastAgeDays: 0, streak: 0 }, expect: scFull({ attempts: 0, successes: 0, confidence: 3, ageDays: 0, streak: 0 }) },
  { name: 'baseline-6of8', args: { attempts: 8, successes: 6, confidence: 4, lastAgeDays: 2, streak: 2 }, expect: scFull({ attempts: 8, successes: 6, confidence: 4, ageDays: 2, streak: 2 }) },
  { name: 'with-prereqs', args: { attempts: 8, successes: 6, confidence: 4, lastAgeDays: 2, streak: 2, prereqScores: [0.9, 0.3] }, expect: scFull({ attempts: 8, successes: 6, confidence: 4, ageDays: 2, streak: 2, prereqScores: [0.9, 0.3] }) },
  { name: 'all-perfect', args: { attempts: 10, successes: 10, confidence: 5, lastAgeDays: 0, streak: 10 }, expect: scFull({ attempts: 10, successes: 10, confidence: 5, ageDays: 0, streak: 10 }) },
  { name: 'all-failed', args: { attempts: 5, successes: 0, confidence: 1, lastAgeDays: 5, streak: 0 }, expect: scFull({ attempts: 5, successes: 0, confidence: 1, ageDays: 5, streak: 0 }) },
  { name: 'successes-clamped-to-attempts', args: { attempts: 5, successes: 10, confidence: 5, lastAgeDays: 1, streak: 3 }, expect: scFull({ attempts: 5, successes: 5, confidence: 5, ageDays: 1, streak: 3 }) },
  { name: 'negative-age-clamped', args: { attempts: 4, successes: 3, confidence: 4, lastAgeDays: -7, streak: 2 }, expect: scFull({ attempts: 4, successes: 3, confidence: 4, ageDays: 0, streak: 2 }) },
  { name: 'confidence-clamped-high', args: { attempts: 6, successes: 5, confidence: 9, lastAgeDays: 1, streak: 1 }, expect: scFull({ attempts: 6, successes: 5, confidence: 5, ageDays: 1, streak: 1 }) },
  { name: 'confidence-clamped-low', args: { attempts: 6, successes: 5, confidence: -2, lastAgeDays: 1, streak: 1 }, expect: scFull({ attempts: 6, successes: 5, confidence: 0, ageDays: 1, streak: 1 }) },
  { name: 'single-failure', args: { attempts: 1, successes: 0, confidence: 2, lastAgeDays: 1, streak: 0 }, expect: scFull({ attempts: 1, successes: 0, confidence: 2, ageDays: 1, streak: 0 }) },
  { name: 'ceiling-binds', args: { attempts: 12, successes: 12, confidence: 5, lastAgeDays: 0, streak: 5, prereqScores: [0.1] }, expect: scFull({ attempts: 12, successes: 12, confidence: 5, ageDays: 0, streak: 5, prereqScores: [0.1] }) },
  { name: 'prereq-perfect', args: { attempts: 6, successes: 4, confidence: 3, lastAgeDays: 3, streak: 1, prereqScores: [1, 1, 1] }, expect: scFull({ attempts: 6, successes: 4, confidence: 3, ageDays: 3, streak: 1, prereqScores: [1, 1, 1] }) },
  { name: 'long-forgetting', args: { attempts: 8, successes: 8, confidence: 4, lastAgeDays: 60, streak: 2 }, expect: scFull({ attempts: 8, successes: 8, confidence: 4, ageDays: 60, streak: 2 }) },
];

const transitions = [
  { name: 'first-perfect', args: { attempt: { correct: true, accuracy: 1.0, selfConf: 5 } }, expect: saleTransition({ status: 'Open', streak: 0, attempts: 0 }, { correct: true, accuracy: 1.0, selfConf: 5 }) },
  { name: 'first-fail', args: { attempt: { correct: false, accuracy: 0.5, selfConf: 2 } }, expect: saleTransition({ status: 'Open', streak: 0, attempts: 0 }, { correct: false, accuracy: 0.5, selfConf: 2 }) },
  { name: 'acc-ok-conf-low', args: { attempt: { correct: true, accuracy: 0.9, selfConf: 2 } }, expect: saleTransition({ status: 'Open', streak: 0, attempts: 0 }, { correct: true, accuracy: 0.9, selfConf: 2 }) },
  { name: 'weighted-ok-acc-low', args: { attempt: { correct: true, accuracy: 0.6, selfConf: 5 } }, expect: saleTransition({ status: 'Open', streak: 0, attempts: 0 }, { correct: true, accuracy: 0.6, selfConf: 5 }) },
  { name: 'cleared-on-third', args: { state: { status: 'open', streak: 1, attempts: 2 }, attempt: { correct: true, accuracy: 0.9, selfConf: 4 } }, expect: saleTransition({ status: 'Open', streak: 1, attempts: 2 }, { correct: true, accuracy: 0.9, selfConf: 4 }) },
  { name: 'streak-2-but-attempts-2', args: { state: { status: 'repairing', streak: 1, attempts: 1 }, attempt: { correct: true, accuracy: 0.9, selfConf: 4 } }, expect: saleTransition({ status: 'Repairing', streak: 1, attempts: 1 }, { correct: true, accuracy: 0.9, selfConf: 4 }) },
  { name: 'cleared-idempotent', args: { state: { status: 'cleared', streak: 2, attempts: 3 }, attempt: { correct: false, accuracy: 0.1, selfConf: 1 } }, expect: { status: 'Cleared', streak: 2, attempts: 3, weightedScorePct: 0, cleared: true } },
  { name: 'streak-reset-on-fail', args: { state: { status: 'repairing', streak: 1, attempts: 5 }, attempt: { correct: false, accuracy: 0.4, selfConf: 2 } }, expect: saleTransition({ status: 'Repairing', streak: 1, attempts: 5 }, { correct: false, accuracy: 0.4, selfConf: 2 }) },
  { name: 'exact-bar-acc0.7-conf3', args: { attempt: { correct: true, accuracy: 0.7, selfConf: 3 } }, expect: saleTransition({ status: 'Open', streak: 0, attempts: 0 }, { correct: true, accuracy: 0.7, selfConf: 3 }) },
  { name: 'probe-empty', args: { mode: 'probe', history: [] }, expect: saleProbe([]) },
  { name: 'probe-two-pass', args: { mode: 'probe', history: [{ acc: 0.8, conf: 4 }, { acc: 0.85, conf: 4 }] }, expect: saleProbe([{ acc: 0.8, conf: 4 }, { acc: 0.85, conf: 4 }]) },
  { name: 'probe-broken-streak', args: { mode: 'probe', history: [{ acc: 0.8, conf: 4 }, { acc: 0.5, conf: 4 }] }, expect: saleProbe([{ acc: 0.8, conf: 4 }, { acc: 0.5, conf: 4 }]) },
  { name: 'probe-three-pass', args: { mode: 'probe', history: [{ acc: 0.8, conf: 4 }, { acc: 0.8, conf: 4 }, { acc: 0.8, conf: 4 }] }, expect: saleProbe([{ acc: 0.8, conf: 4 }, { acc: 0.8, conf: 4 }, { acc: 0.8, conf: 4 }]) },
  { name: 'probe-one-pass', args: { mode: 'probe', history: [{ acc: 0.8, conf: 4 }] }, expect: saleProbe([{ acc: 0.8, conf: 4 }]) },
  { name: 'cleared-idempotent-pct-check', args: { state: { status: 'cleared', streak: 2, attempts: 3, weightedScorePct: 90 }, attempt: { correct: true, accuracy: 0.8, selfConf: 4 } }, expect: { status: 'Cleared', streak: 2, attempts: 3, weightedScorePct: 90, cleared: true } },
];

const scanDebts = [
  { name: 'zero-freq', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 0 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 0, downstreamCount: 0 }) },
  { name: 'strong-parent-weak-child', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3, downstreamCount: 0 }) },
  { name: 'weak-parent', args: { edges: [{ scoreFrom: 0.3, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3 }] }, expect: debtFull({ scoreFrom: 0.3, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3, downstreamCount: 0 }) },
  { name: 'strong-child', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.9, weight: 1.0, edgeType: 'prerequisite', freq: 3 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.9, weight: 1.0, edgeType: 'prerequisite', freq: 3, downstreamCount: 0 }) },
  { name: 'transfer-gap-multiplier', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'transferGap', freq: 3 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'transferGap', freq: 3, downstreamCount: 0 }) },
  { name: 'cascade-downstream', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3, downstreamCount: 5 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 3, downstreamCount: 5 }) },
  { name: 'heavy-volume', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 20 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 20, downstreamCount: 0 }) },
  { name: 'negative-weight-zeroed', args: { edges: [{ scoreFrom: 0.9, scoreTo: 0.3, weight: -1, edgeType: 'prerequisite', freq: 3 }] }, expect: debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: -1, edgeType: 'prerequisite', freq: 3, downstreamCount: 0 }) },
  { name: 'batch-mixed', args: { edges: [
    { scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 4, downstreamCount: 2 },
    { scoreFrom: 0.4, scoreTo: 0.45, weight: 0.8, edgeType: 'transferGap', freq: 1 },
    { scoreFrom: 0.7, scoreTo: 0.7, weight: 1.2, edgeType: 'prerequisite', freq: 0 }] },
    expect: [
      debtFull({ scoreFrom: 0.9, scoreTo: 0.3, weight: 1.0, edgeType: 'prerequisite', freq: 4, downstreamCount: 2 }),
      debtFull({ scoreFrom: 0.4, scoreTo: 0.45, weight: 0.8, edgeType: 'transferGap', freq: 1, downstreamCount: 0 }),
      debtFull({ scoreFrom: 0.7, scoreTo: 0.7, weight: 1.2, edgeType: 'prerequisite', freq: 0, downstreamCount: 0 })
    ] },
  { name: 'all-mid-neutral', args: { edges: [{ scoreFrom: 0.55, scoreTo: 0.50, weight: 1.0, edgeType: 'prerequisite', freq: 1 }] }, expect: debtFull({ scoreFrom: 0.55, scoreTo: 0.50, weight: 1.0, edgeType: 'prerequisite', freq: 1, downstreamCount: 0 }) },
  { name: 'extreme-weak-parent', args: { edges: [{ scoreFrom: 0.0, scoreTo: 0.0, weight: 1.0, edgeType: 'prerequisite', freq: 2 }] }, expect: debtFull({ scoreFrom: 0.0, scoreTo: 0.0, weight: 1.0, edgeType: 'prerequisite', freq: 2, downstreamCount: 0 }) },
];

// optimize：结构断言金样（期望值非数值，由测试代码断言结构性质；精确数值期望仅 O1 空序列）
const optimize = [
  {
    name: 'empty-sequences-falls-back-to-default',
    args: { reviews: [] },
    expect: { kind: 'exact', data: { examples: 0, improved: false, usedDefault: true, weights: W, initialLoss: 0, finalLoss: 0 } }
  },
  {
    name: 'single-sequence-runs-adam',
    args: { reviews: [[{ elapsedDays: 0, grade: 3 }, { elapsedDays: 1, grade: 3 }, { elapsedDays: 2, grade: 2 }, { elapsedDays: 4, grade: 3 }]] },
    expect: { kind: 'invariants', data: { examples: 3, minIterations: 1 } }
  },
  {
    name: 'two-sequences-weights-in-bounds',
    args: { reviews: [
      [{ elapsedDays: 0, grade: 4 }, { elapsedDays: 1, grade: 3 }, { elapsedDays: 3, grade: 3 }, { elapsedDays: 7, grade: 2 }],
      [{ elapsedDays: 0, grade: 1 }, { elapsedDays: 1, grade: 3 }, { elapsedDays: 2, grade: 3 }, { elapsedDays: 5, grade: 4 }]] },
    expect: { kind: 'invariants', data: { examples: 6, minIterations: 1 } }
  },
  {
    name: 'same-day-only-not-scored',
    args: { reviews: [[{ elapsedDays: 0, grade: 3 }, { elapsedDays: 0, grade: 2 }, { elapsedDays: 0, grade: 4 }]] },
    expect: { kind: 'exact', data: { examples: 0, improved: false, usedDefault: true } }
  },
];

// 期望值数字规范化后写出
function dump(file, cases) {
  const clean = JSON.parse(JSON.stringify(cases, (k, v) => (typeof v === 'number' ? round(v) : v)));
  writeFileSync(join(OUT, file), JSON.stringify(clean, null, 2) + '\n');
  console.log(`${file}: ${Array.isArray(clean) ? clean.length : Object.keys(clean).length} cases`);
}
dump('review.json', review);
dump('interval.json', intervals);
dump('score.json', score);
dump('transition.json', transitions);
dump('scanDebts.json', scanDebts);
dump('optimize.json', optimize);
console.log('golden 生成完毕（期望值来自独立 JS 重实现的公式，未读取 C# 输出）');
