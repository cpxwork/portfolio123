(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoffeeModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const RULES = Object.freeze({ days: 14, initialCash: 2500, initialReputation: 50, ingredientCost: 5, staffCost: 80, rent: 100 });
  const DEFAULTS = Object.freeze({ price: 18, stock: 90, staff: 2, marketing: 40 });
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const money = n => Math.round(n * 100) / 100;
  function normalizeSeed(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 999999) throw new Error('实验种子须为 1–999999 的整数。');
    return n;
  }
  function random(seed) {
    let s = seed >>> 0;
    return function () { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function eventFor(seed, day) {
    seed = normalizeSeed(seed);
    if (!Number.isInteger(day) || day < 1 || day > RULES.days) throw new Error('运营日须为 1–14。');
    const rng = random(seed + day * 9173);
    const weatherRoll = rng();
    const weather = weatherRoll < .22 ? { name: '小雨', icon: 'rain', factor: .78, note: '雨天步行客流减少 22%。' } : weatherRoll > .8 ? { name: '晴朗', icon: 'sun', factor: 1.08, note: '晴天步行客流增加 8%。' } : { name: '多云', icon: 'cloud', factor: 1, note: '天气未额外改变客流。' };
    const sceneRoll = rng();
    const scene = sceneRoll < .18 ? { name: '社区集市', factor: 1.2, note: '社区活动带来 20% 额外客流。' } : sceneRoll > .82 ? { name: '周边办公室远程日', factor: .86, note: '办公客减少，场景客流下降 14%。' } : { name: '街区日常', factor: 1, note: '普通街区，没有活动加成。' };
    const weekday = (day - 1) % 7;
    const weekend = weekday >= 5;
    const baseline = 70 + (weekend ? 16 : 0);
    const jitter = .93 + rng() * .14;
    return { day, weekday: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekday], weekend, weather, scene, baseline, jitter: Number(jitter.toFixed(6)), baseVisitors: Math.round(baseline * weather.factor * scene.factor * jitter) };
  }
  function validateDecision(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('请完整填写经营决策。');
    const limits = { price: [8, 30], stock: [10, 220], staff: [1, 4], marketing: [0, 160] };
    const out = {};
    for (const key of Object.keys(limits)) {
      if (raw[key] === null || raw[key] === undefined || (typeof raw[key] === 'string' && !raw[key].trim())) throw new Error('经营决策字段不能为空。');
      const n = Number(raw[key]);
      if (!Number.isInteger(n) || n < limits[key][0] || n > limits[key][1]) throw new Error(`${{ price: '售价', stock: '备货', staff: '店员数', marketing: '营销预算' }[key]}超出允许范围。`);
      out[key] = n;
    }
    return out;
  }
  function createGame(seed = 202610) {
    return { version: VERSION, seed: normalizeSeed(seed), day: 1, cash: RULES.initialCash, reputation: RULES.initialReputation, records: [], preferences: { ...DEFAULTS } };
  }
  function simulateDay(game, decision) {
    const d = validateDecision(decision);
    if (!game || !Number.isFinite(game.cash) || !Number.isFinite(game.reputation) || !Array.isArray(game.records)) throw new Error('实验存档格式无效。');
    if (game.day > RULES.days) throw new Error('14 天运营已结束，请重开一轮。');
    const event = eventFor(game.seed, game.day);
    const reputationFactor = .8 + clamp(game.reputation, 0, 100) / 250;
    const marketingVisitors = Math.round(d.marketing * .2);
    const arrivals = Math.round(event.baseVisitors * reputationFactor) + marketingVisitors;
    const acceptance = clamp(1.1 - (d.price - 12) * .033, .35, 1);
    const willing = Math.round(arrivals * acceptance);
    const priceLost = arrivals - willing;
    const capacity = 55 + 45 * (d.staff - 1);
    const queueLost = Math.max(0, willing - capacity);
    const reachable = Math.min(willing, capacity);
    const stockLost = Math.max(0, reachable - d.stock);
    const sold = Math.min(reachable, d.stock);
    const waste = d.stock - sold;
    const costs = { ingredients: d.stock * RULES.ingredientCost, staff: d.staff * RULES.staffCost, rent: RULES.rent, marketing: d.marketing };
    const totalCost = costs.ingredients + costs.staff + costs.rent + costs.marketing;
    const revenue = d.price * sold;
    const profit = money(revenue - totalCost);
    const serviceRate = willing ? sold / willing : 1;
    const reputationChange = serviceRate >= .9 ? 2 : -Math.ceil((1 - serviceRate) * 12);
    const reputationAfter = clamp(game.reputation + reputationChange, 0, 100);
    const affordable = game.cash >= totalCost;
    return { day: game.day, seed: game.seed, decision: d, event, reputationBefore: game.reputation, reputationFactor, marketingVisitors, acceptance, arrivals, willing, priceLost, capacity, queueLost, stockLost, sold, waste, costs, totalCost, revenue, profit, cashBefore: game.cash, cashAfter: money(game.cash + profit), serviceRate, reputationChange: reputationAfter - game.reputation, reputationAfter, affordable };
  }
  function operate(game, decision) {
    const result = simulateDay(game, decision);
    if (!result.affordable) throw new Error(`营业前支出 ¥${result.totalCost} 超过当前现金 ¥${game.cash}，请降低备货、人手或营销预算。`);
    return { ...game, day: game.day + 1, cash: result.cashAfter, reputation: result.reputationAfter, records: game.records.concat(result), preferences: { ...result.decision } };
  }
  function totals(game) {
    const out = { sold: 0, arrivals: 0, willing: 0, waste: 0, priceLost: 0, queueLost: 0, stockLost: 0, revenue: 0, totalCost: 0, profit: 0 };
    for (const r of game.records) for (const key of Object.keys(out)) out[key] += r[key];
    out.profit = money(out.profit);
    out.serviceRate = out.willing ? out.sold / out.willing : 0;
    out.wasteRate = out.sold + out.waste ? out.waste / (out.sold + out.waste) : 0;
    return out;
  }
  function explain(r) {
    const messages = [`今天有 ${r.arrivals} 人到店，${r.priceLost} 人因价格放弃购买；其余 ${r.willing} 人有购买意愿。`];
    if (r.queueLost) messages.push(`${r.decision.staff} 名店员一天可服务 ${r.capacity} 杯，${r.queueLost} 人因排队流失。`);
    else messages.push(`服务能力 ${r.capacity} 杯覆盖购买需求，没有排队流失。`);
    if (r.stockLost) messages.push(`备货仅 ${r.decision.stock} 杯，另有 ${r.stockLost} 人遇到缺货。`);
    else messages.push(`备货覆盖可服务需求，未发生缺货；剩余 ${r.waste} 杯原料按当日损耗处理。`);
    messages.push(`成交 ${r.sold} 杯，收入 ¥${r.revenue}，支出 ¥${r.totalCost}，当日${r.profit >= 0 ? '利润' : '亏损'} ¥${Math.abs(r.profit)}。`);
    messages.push(`满足率 ${(r.serviceRate * 100).toFixed(1)}%，声誉${r.reputationChange >= 0 ? '增加' : '下降'} ${Math.abs(r.reputationChange)} 点，下次客流会受到影响。`);
    return messages;
  }
  function recommendations(game, decision) {
    const current = simulateDay(game, decision);
    const alternatives = [];
    const candidates = [
      { name: '少备 10 杯', change: { stock: decision.stock - 10 } },
      { name: '多备 10 杯', change: { stock: decision.stock + 10 } },
      { name: '少一位店员', change: { staff: decision.staff - 1 } },
      { name: '多一位店员', change: { staff: decision.staff + 1 } },
      { name: '售价降低 ¥1', change: { price: decision.price - 1 } },
      { name: '售价提高 ¥1', change: { price: decision.price + 1 } },
      { name: '营销减少 ¥20', change: { marketing: decision.marketing - 20 } },
      { name: '营销增加 ¥20', change: { marketing: decision.marketing + 20 } }
    ];
    for (const c of candidates) {
      try {
        const p = simulateDay(game, { ...decision, ...c.change });
        if (p.affordable) alternatives.push({ label: c.name, delta: p.profit - current.profit, soldChange: p.sold - current.sold, wasteChange: p.waste - current.waste, decision: p.decision });
      } catch (_) { /* Alternatives outside valid bounds are intentionally omitted. */ }
    }
    return alternatives.sort((a, b) => b.delta - a.delta).slice(0, 3);
  }
  function exportGame(game) {
    return { project: '街角咖啡经营实验室', simulation: true, version: VERSION, exportedAt: new Date().toISOString(), seed: game.seed, assumptions: { ...RULES, priceAcceptance: 'clamp(1.1-(price-12)*0.033,0.35,1)', staffCapacity: '55+45*(staff-1)', arrivals: 'round(baseVisitors*(0.8+reputation/250))+round(marketing*0.2)' }, decisions: game.records.map(r => ({ ...r.decision })), records: game.records, totals: totals(game), preferences: game.preferences };
  }
  function replay(data) {
    if (!data || data.version !== VERSION || data.simulation !== true || !Array.isArray(data.decisions) || data.decisions.length > RULES.days) throw new Error('仅支持本 Demo 1.0.0 版导出的实验文件。');
    let game = createGame(data.seed);
    for (const d of data.decisions) game = operate(game, d);
    if (data.preferences) game.preferences = validateDecision(data.preferences);
    return game;
  }
  function csv(game) {
    const fields = ['运营日','售价_元','备货_杯','店员_人','营销_元','到店_人','价格流失_人','排队流失_人','缺货流失_人','成交_杯','损耗_杯','收入_元','支出_元','利润_元','现金_元','声誉'];
    const lines = [fields.join(',')];
    for (const r of game.records) lines.push([r.day,r.decision.price,r.decision.stock,r.decision.staff,r.decision.marketing,r.arrivals,r.priceLost,r.queueLost,r.stockLost,r.sold,r.waste,r.revenue,r.totalCost,r.profit,r.cashAfter,r.reputationAfter].join(','));
    return '\uFEFF' + lines.join('\r\n');
  }
  return { VERSION, RULES, DEFAULTS, createGame, eventFor, validateDecision, simulateDay, operate, totals, explain, recommendations, exportGame, replay, csv };
});
