(() => {
  'use strict';
  const M = window.CoffeeModel, $ = id => document.getElementById(id);
  const KEY = 'cpx-corner-coffee-v1';
  const fmt = n => '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const pct = n => (100 * n).toFixed(1) + '%';
  let game = M.createGame(), previous = null, busy = false, timer;
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(timer); timer = setTimeout(() => $('toast').classList.remove('visible'), 3500); }
  function storageWarning(message) { $('storageWarning').hidden = false; $('storageWarning').textContent = message; }
  try { const saved = localStorage.getItem(KEY); if (saved) game = M.replay(JSON.parse(saved)); } catch (_) { storageWarning('未能恢复本机记录，已开启新实验。可以通过 JSON 导出保留当前记录。'); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(M.exportGame(game))); } catch (_) { storageWarning('浏览器存储不可用；本次操作仍在内存中，请导出 JSON 备份。'); } }
  function decision() { return Object.fromEntries(['price', 'stock', 'staff', 'marketing'].map(k => [k, Number($(k).value)])); }
  function setControls(d) { for (const k of ['price', 'stock', 'staff', 'marketing']) $(k).value = d[k]; }
  function signed(n) { return (n >= 0 ? '+' : '−') + fmt(Math.abs(n)); }
  function paintForecast() {
    const d = decision();
    $('priceValue').textContent = fmt(d.price); $('stockValue').textContent = d.stock + ' 杯'; $('staffValue').textContent = d.staff + ' 人'; $('marketingValue').textContent = fmt(d.marketing);
    if (game.day > 14 || game.cash < 230) return;
    const r = M.simulateDay(game, d);
    $('upfront').textContent = fmt(r.totalCost);
    $('budgetError').hidden = r.affordable;
    $('budgetError').textContent = r.affordable ? '' : '营业前费用超过现金，请减少备货、人手或营销。';
    $('operateButton').disabled = !r.affordable;
    const items = [['到店', r.arrivals, '潜在顾客', ''], ['价格流失', r.priceLost, '不愿购买', 'loss'], ['排队流失', r.queueLost, '超服务能力', 'loss'], ['缺货流失', r.stockLost, '库存不足', 'loss'], ['成交', r.sold, '完成购买', 'success']];
    $('flowGrid').innerHTML = items.map(([name, value, note, cls]) => `<div class="flow-item ${cls}"><span>${name}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
    $('previewProfit').textContent = fmt(r.profit); $('previewProfit').className = r.profit < 0 ? 'negative' : 'positive';
    $('previewWaste').textContent = r.waste + ' 杯'; $('previewService').textContent = pct(r.serviceRate);
    $('previewExplain').innerHTML = M.explain(r).map(s => '<li>' + s + '</li>').join('');
    const alternatives = M.recommendations(game, d);
    $('alternatives').innerHTML = alternatives.map((a, i) => `<div class="alternative"><span>${a.label}</span><div><strong class="${a.delta >= 0 ? 'positive' : 'negative'}">${signed(a.delta)}</strong><button type="button" data-alternative="${i}">试试看</button></div></div>`).join('');
    $('alternatives').querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { setControls(alternatives[i].decision); updateDecision(); }));
  }
  function chart() {
    const current = [0, ...game.records.map(r => r.cashAfter - 2500)];
    const old = previous && previous.seed === game.seed ? [0, ...previous.records.map(r => r.cashAfter - 2500)] : [];
    const all = [...current, ...old], low = Math.min(0, ...all), high = Math.max(300, ...all), range = high - low || 1;
    const x = i => 70 + i / 14 * 945, y = v => 161 - (v - low) / range * 125;
    let svg = '';
    for (let i = 0; i <= 4; i++) { const value = low + range * i / 4; svg += `<line x1="70" y1="${y(value)}" x2="1015" y2="${y(value)}" stroke="#dce4d4"/><text x="56" y="${y(value) + 4}" text-anchor="end" font-size="11" fill="#89967b">${Math.round(value)}</text>`; }
    for (const i of [0, 3, 7, 10, 14]) svg += `<text x="${x(i)}" y="189" text-anchor="middle" font-size="11" fill="#89967b">${i} 天</text>`;
    const poly = (vals, color, dash) => `<polyline points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3" ${dash ? 'stroke-dasharray="5 5"' : ''}/>`;
    if (old.length) svg += poly(old, '#c9955d', true);
    svg += poly(current, '#28634f', false); $('profitChart').innerHTML = svg;
    $('comparisonLegend').innerHTML = '<span>本轮累计利润</span>' + (old.length ? '<span class="previous">上一轮 · 同事件种子</span>' : '');
  }
  function render() {
    const t = M.totals(game), ended = game.day > 14 || game.cash < 230;
    $('cash').textContent = fmt(game.cash); $('profit').textContent = fmt(t.profit); $('profit').className = t.profit < 0 ? 'negative' : '';
    $('sold').textContent = t.sold + ' 杯'; $('rep').textContent = game.reputation + ' /100';
    $('profitTip').textContent = game.records.length + ' 天已结算'; $('serviceTip').textContent = '满足率 ' + pct(t.serviceRate) + ' · 损耗率 ' + pct(t.wasteRate);
    $('seed').value = game.seed; $('dayTag').textContent = ended ? 'EXPERIMENT COMPLETE' : `DAY ${String(game.day).padStart(2, '0')} / 14`;
    const event = M.eventFor(game.seed, Math.min(game.day, 14));
    $('weekday').textContent = event.weekday; $('eventIcon').textContent = ({ sun: '☀', rain: '☂', cloud: '☁' })[event.weather.icon];
    $('eventTitle').textContent = event.weather.name + ' · ' + event.scene.name; $('eventNote').textContent = event.weather.note + ' ' + event.scene.note;
    $('eventBase').textContent = '该环境基础客流 ' + event.baseVisitors + ' 人（未计营销与声誉）';
    $('dayTitle').textContent = ended ? '本轮经营已结束' : '准备今天的营业';
    setControls(game.preferences);
    for (const k of ['price', 'stock', 'staff', 'marketing']) $(k).disabled = ended;
    $('operateButton').disabled = ended; $('operateButton').innerHTML = ended ? '本轮结束 · 请查看总结' : '开始今天的营业 <span>→</span>';
    if (!ended) paintForecast();
    const last = game.records.at(-1); $('resultPanel').hidden = !last;
    if (last) { $('resultTitle').textContent = `第 ${last.day} 天经营复盘`; $('resultSummary').innerHTML = `<span>成交 <strong>${last.sold} 杯</strong></span><span>利润 <strong>${fmt(last.profit)}</strong></span><span>损耗 <strong>${last.waste} 杯</strong></span>`; $('resultExplain').innerHTML = M.explain(last).map(s => '<p>' + s + '</p>').join(''); }
    $('ledgerBody').innerHTML = game.records.length ? game.records.map((r, i) => `<tr class="${i === game.records.length - 1 ? 'latest' : ''}"><td>第 ${r.day} 天</td><td>${r.decision.price}</td><td>${r.decision.stock}</td><td>${r.decision.staff}</td><td>${r.decision.marketing}</td><td>${r.arrivals}</td><td>${r.sold}</td><td>${r.queueLost}</td><td>${r.stockLost}</td><td>${r.waste}</td><td class="${r.profit < 0 ? 'negative' : 'positive'}">${r.profit}</td><td>${r.reputationAfter}</td></tr>`).join('') : '<tr><td colspan="12" class="empty">开始第一天营业，留下第一条实验记录。</td></tr>';
    $('endCard').hidden = !ended;
    if (ended) $('endCard').innerHTML = `<strong>${game.day > 14 ? '14 天经营完成' : '现金不足，实验提前结束'}</strong>累计利润 ${fmt(t.profit)}，成交 ${t.sold} 杯，原料损耗 ${t.waste} 杯。<br>排队流失 ${t.queueLost} 人，缺货流失 ${t.stockLost} 人。用相同种子重开，比较你下一轮的资源取舍。`;
    chart();
  }
  function updateDecision() { game.preferences = decision(); save(); paintForecast(); }
  for (const k of ['price', 'stock', 'staff', 'marketing']) $(k).addEventListener('input', updateDecision);
  $('decisionForm').addEventListener('submit', e => { e.preventDefault(); if (busy) return; busy = true; try { game = M.operate(game, decision()); save(); render(); toast('当日已结算，记录已写入经营账本。'); } catch (err) { toast(err.message); } finally { busy = false; } });
  $('restartButton').addEventListener('click', () => { try { const next = M.createGame(Number($('seed').value)); previous = game; game = next; save(); render(); toast(previous.seed === game.seed ? '已保留上一轮，同一事件种子可做策略对照。' : '已用新种子重开；外部事件不同，不展示同条件对照线。'); } catch (err) { toast(err.message); } });
  function download(name, content, type) { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); }
  $('exportCsv').addEventListener('click', () => download(`街角咖啡_${game.seed}_账本.csv`, M.csv(game), 'text/csv;charset=utf-8'));
  $('exportJson').addEventListener('click', () => download(`街角咖啡_${game.seed}_实验.json`, JSON.stringify(M.exportGame(game), null, 2), 'application/json;charset=utf-8'));
  $('importButton').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async () => { const file = $('importFile').files[0]; if (!file) return; try { if (file.size > 1000000) throw new Error('实验文件过大。'); const restored = M.replay(JSON.parse(await file.text())); previous = game; game = restored; save(); render(); toast('实验已按决策重新计算恢复。'); } catch (err) { toast('导入失败：' + err.message); } finally { $('importFile').value = ''; } });
  $('helpButton').addEventListener('click', () => $('helpDialog').showModal()); $('closeHelp').addEventListener('click', () => $('helpDialog').close());
  $('helpDialog').addEventListener('click', e => { if (e.target === $('helpDialog')) $('helpDialog').close(); });
  render();
  window.CoffeeApp = { snapshot: () => M.exportGame(game), reset: seed => { game = M.createGame(seed); previous = null; save(); render(); } };
})();
