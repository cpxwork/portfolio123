(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const app = HaipiguaCore.create();
  const robots = {
    1: {name: '皮皮', class: 'pipi', role: '灵感记录员', hello: '我听着呢，想到哪儿就说到哪儿。'},
    2: {name: '滴答', class: 'dida', role: '学习安排员', hello: '时间表不用填，告诉我哪段没空就好。'},
    3: {name: '啵啵', class: 'bobo', role: '创意探索员', hello: '脑洞可以很大，先找一个小问题试试！'},
    4: {name: '回回', class: 'huihui', role: '行动反馈员', hello: '做了多少都可以说，下一步由这一步长出来。'}
  };
  let view = 'chat', activeRobot = 1, olderNotes = false, recognition = null, recording = false;
  let pendingVideo = null, videoURL = null, bugTimer = null, bugTask = null;
  let modelHealth = {ready: false}, useModel = false, sending = false, modelValidated = false, feedbackPending = false;
  const seenReminders = new Set();
  const state = () => app.state;
  const text = value => esc(value).replace(/\n/g, '<br>');
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Number(value.slice(5, 7)) + '月' + Number(value.slice(8)) + '日' : '';
  const localDay = value => value && Number.isFinite(Date.parse(value)) ? HaipiguaCore.clock(new Date(value)).today : '';
  const status = value => ({accepted: '等你试一试', done: '完成啦', partial: '尝试了一点', skipped: '这次先暂停'}[value] || '待确认');
  const action = (name, label, id = '', noteId = '') => `<button class="bubble-action" data-action="${name}" data-id="${esc(id)}"${noteId ? ` data-note-id="${esc(noteId)}"` : ''}>${label}</button>`;
  const sprite = (id, cls = '') => `<span class="sprite ${robots[id].class} ${cls}" aria-hidden="true"></span>`;
  function toast(message, error = false) {
    const node = document.createElement('div'); node.className = 'toast' + (error ? ' error' : ''); node.textContent = message;
    $('#toasts').append(node); setTimeout(() => node.remove(), 6000);
  }
  function saveNotice() { if (app.storageError) toast(app.storageError, true); }
  function resources(items) {
    return `<div class="resource-links">${(items || []).filter(item => /^https:\/\/(search\.bilibili\.com|www\.bing\.com|docs\.python\.org|developer\.mozilla\.org)\//.test(item.url || '')).map(item => `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.label)} ↗</a>`).join('')}</div>`;
  }
  function modelReceipt(note) {
    if (note.source !== 'model') return '';
    const calls = (note.trace || []).filter(t => t.kind === 'model');
    return `<details class="model-receipt"><summary>真实模型接力 · ${calls.length} 次调用</summary><p class="small">这是执行记录，不是模型内部思考。API 返回成功后，再经过本地日期、关联与冲突校验写入。</p>${(note.trace || []).slice(0, 24).map(t => `<p class="small"><strong>${esc(t.agent)}</strong> · ${esc(t.action || t.tool)} · ${esc(t.status)}${t.model ? ' · ' + esc(t.model) : ''}${Number.isFinite(t.durationMs) ? ' · ' + (t.durationMs / 1000).toFixed(1) + '秒' : ''}<br>${text(t.detail || '')}</p>`).join('')}${note.usage ? `<p class="small">输入 ${Number(note.usage.inputTokens) || 0} tokens · 输出 ${Number(note.usage.outputTokens) || 0} tokens</p>` : ''}</details>`;
  }
  function bubble(id, content, caption = '') {
    return `<div class="message speaker-${id}"><div class="speaker-art">${sprite(id)}</div><div class="bubble-wrap"><div class="speaker-label"><strong>${robots[id].name}</strong>${caption || robots[id].role}</div><div class="bubble">${content}</div></div></div>`;
  }
  function reviewDetails(review) {
    const points = (items, title) => (items || []).length ? `<p><strong>${title}</strong></p><ul>${items.map(item => `<li>${text(item.point)} <span class="review-evidence">“${text(item.evidence)}”</span></li>`).join('')}</ul>` : '';
    const missing = (review.missingEvidence || []).length ? `<p><strong>还缺的证据：</strong>${review.missingEvidence.map(text).join('；')}</p>` : '';
    return `${review.summary && review.summary !== review.response ? `<p>${text(review.summary)}</p>` : ''}${points(review.progress, '有依据的进展')}${points(review.problems, '具体的卡点')}${review.hasArtifact === false ? '<p class="small">这次没有看到具体作品或内容，我不会据此判断你的水平，也不会给评分。</p>' : ''}${missing}${review.needsEvidence && review.question ? `<p class="review-question"><strong>回回想先问一句：</strong>${text(review.question)}</p>` : ''}${review.nextStep && !review.needsEvidence ? `<p><strong>下一步先这样试：</strong>${text(review.nextStep)}</p>` : ''}${review.media ? '<p class="small">视频已保存在本机 · 尚未分析</p>' : ''}${Number.isInteger(review.minutes) && review.minutes > 0 ? `<p class="small">你提到的投入：约 ${review.minutes} 分钟。时长只说明投入，不说明水平。</p>` : ''}`;
  }
  function reviewBubble(review) {
    return bubble(4, `<p>${text(review.response)}</p>${reviewDetails(review)}`);
  }
  function feedbackBubble(feedback, review = null) {
    const reward = state().studio.rewards.find(r => r.feedbackId === feedback.id);
    return `<p>${text(feedback.response)}</p><p><strong>下一次这样试：</strong>${text(feedback.nextAdjustment?.advice || '先告诉我下一次什么时候有空。')}</p>${review ? reviewDetails(review) : ''}${reward ? `<p class="reward-receipt">✦ +${reward.points} 成长值 · 演示待核验<br><span>来自你的自报反馈，不能抵现或抵扣费用。</span></p>` : ''}${feedback.media ? `<p class="small">视频已保存在本机 · 尚未分析</p>${action('play-video', '看看这次的记录 ↗', feedback.media.id)}` : ''}`;
  }
  function learningAdvice(note, tasks, learning) {
    const savedPlans = (note.advice || []).filter(a => a.kind === 'plan');
    const learningTasks = tasks.filter(t => t.kind !== 'experiment');
    const suggestions = savedPlans.length ? savedPlans.map(a => ({title: state().ideas.find(i => i.id === a.ideaId)?.title, value: a.value})) : note.advice === undefined && note.source !== 'model' ? learning.map(i => ({title: i.title, value: i.aiPlan})) : [];
    let line = learningTasks.length ? learningTasks.map(t => `<p><strong>${esc(t.title)}</strong><br><span class="time-sticker">${date(t.date)} ${esc(t.start)}—${esc(t.end)} · ${t.duration} 分钟</span></p><p>${text(t.description || '')}</p>${t.successCriterion ? `<p><strong>留下什么算有收获：</strong>${text(t.successCriterion)}</p>` : ''}${resources(t.resources)}${action('task-detail', '看看这一步 ↗', t.id)}`).join('<hr>') : suggestions.length ? suggestions.map(({title, value: p}) => p ? `<p><strong>${esc(p.title || title)}</strong></p><ol>${p.steps.map(s => `<li><strong>${esc(s.title)}</strong>：${text(s.description)}</li>`).join('')}</ol><p><strong>具体产出：</strong>${text(p.successCriterion)}</p><p class="small">为什么先做这一步：${text(p.rationale)}<br>这是本条消息的建议，没有预约时间。</p><p><strong>下一次从这里接着试：</strong>${text(p.nextStep)}</p>${resources(p.resources)}` : `<p>“${esc(title)}”我接住啦。日期和时间还没确定，我们先把下一小步问清楚。</p>`).join('<hr>') : note.source === 'model' && note.advice === undefined ? `<p>${text(note.reply)}</p>` : '<p>你的时间与偏好已经交给我处理。具体记录在上面的理解详情里；遇到撞期，我会先问你。</p>';
    if (learningTasks.length) line += '<p class="small">这里展示当前保存的安排。教程按钮是搜索入口，还没有替你筛选或核验视频。</p>';
    return line;
  }
  function creativeAdvice(note, creative) {
    const savedExplorations = (note.advice || []).filter(a => a.kind === 'exploration');
    const suggestions = savedExplorations.length ? savedExplorations.map(a => ({idea: state().ideas.find(i => i.id === a.ideaId), value: a.value, noteId: note.id})) : note.advice === undefined && note.source !== 'model' ? creative.map(i => ({idea: i, value: i.exploration || SparkEngine.exploreIdea({idea: i.text, timeBudget: 10})})) : [];
    let line = suggestions.length ? suggestions.map(({idea: i, value: r, noteId}) => {
      return `<p><strong>${esc(r.title || i?.title)}</strong></p><p>先试这一小步：${text(typeof r.firstStep === 'string' ? r.firstStep : r.firstStep?.title || '')}</p>${r.firstStep?.description ? `<p>${text(r.firstStep.description)}</p>` : ''}<p class="small">观察信号：${text(r.successSignal)}</p>${resources(r.searchLinks)}${action('continue', '接着聊这个脑洞 ↗', i?.id)}${action('explore-detail', '展开探索路径', i?.id, noteId)}`;
    }).join('<hr>') : note.source === 'model' && note.advice === undefined ? `<p>${text(note.reply)}</p>` : '<p>我已经接到这个小实验的时间。先试最小的一步，结果交给回回，我们再一起改路径。</p>';
    line += '<p class="small">这是待验证的探索方向，不代表已经查证可行。</p>';
    return line;
  }
  function noteMessages(note) {
    if (note.undone) return bubble(1, '<p>原话还收着，刚才的自动改动已经撤销。你可以重新说一个安排。</p>');
    const ideas = (note.ideaIds || []).map(id => state().ideas.find(i => i.id === id)).filter(Boolean);
    const tasks = (note.taskIds || []).map(id => state().tasks.find(t => t.id === id)).filter(Boolean);
    const reviews = (note.reviewIds || []).map(id => state().reviews.find(r => r.id === id)).filter(Boolean);
    const feedback = state().feedback.find(f => f.id === note.feedbackId) || [...state().feedback].reverse().find(f => note.agents.includes(4) && (note.taskIds || []).includes(f.taskId) && f.createdAt === note.createdAt);
    const learning = ideas.filter(i => i.type === 'skill'), creative = ideas.filter(i => i.type === 'creative');
    if (feedback) {
      const review = reviews.find(r => r.taskId === feedback.taskId) || reviews[0] || null;
      let result = bubble(4, feedbackBubble(feedback, review) + modelReceipt(note)) + '<div class="route-line">回回把行动结果交回皮皮</div>';
      if (note.agents.includes(2)) result += '<div class="route-line">回回 → 滴答 · 把这次卡点变成下一步</div>' + bubble(2, learningAdvice(note, tasks, learning));
      if (note.agents.includes(3)) result += '<div class="route-line">回回 → 啵啵 · 把这次发现变成小实验</div>' + bubble(3, creativeAdvice(note, creative));
      result += bubble(1, `<p>收好了：${esc(feedback.taskTitle)}，${feedback.minutes} 分钟。下次安排会参考这条反馈，之前的喜欢也留着。</p><p class="small">你的解释是记录，不是性格定论。想换一个兴趣也可以继续说。</p>`, '接住反馈，准备下一轮');
      return result;
    }
    if (reviews.length) {
      let result = reviews.map(reviewBubble).join('');
      if (note.reviewQuestion && !reviews.some(r => r.question === note.reviewQuestion)) result += bubble(4, `<p class="review-question"><strong>回回想先问一句：</strong>${text(note.reviewQuestion)}</p>`);
      if (note.agents.includes(2)) result += '<div class="route-line">回回 → 滴答 · 把这次卡点变成下一步</div>' + bubble(2, learningAdvice(note, tasks, learning));
      if (note.agents.includes(3)) result += '<div class="route-line">回回 → 啵啵 · 把这次发现变成小实验</div>' + bubble(3, creativeAdvice(note, creative));
      result += bubble(1, '<p>原话和这次分析都收好了。下一步建议只更新了计划，没有替你预约时间；信息不够时回回会接着问。</p>' + modelReceipt(note), '接住反馈，准备下一轮');
      return result;
    }
    const understanding = note.understanding;
    let content = understanding?.goal ? `<p><strong>我听到的主要目标：</strong>${text(understanding.goal)}</p>${(understanding.facts || []).length ? `<p>你已经告诉我的：</p><ul>${understanding.facts.map(f => `<li>${text(f.text)}</li>`).join('')}</ul>` : ''}${(understanding.constraints || []).length ? `<p>安排时要顾及：</p><ul>${understanding.constraints.map(f => `<li>${text(f.text)}</li>`).join('')}</ul>` : ''}<p class="small">这是皮皮对原话的理解，可以直接纠正；不会自动变成永久确认记忆。</p>` : '<p>' + (ideas.length ? `这段话关联到 ${ideas.length} 个目标或兴趣。` : '这段原话已经收进口袋。') + (learning.length ? '学习与准备交给滴答，' : '') + (creative.length ? '脑洞交给啵啵，' : '') + '不用你逐个搬过去。</p>';
    if (note.clarification) content += `<p><strong>有一处想问清楚：</strong>${text(note.clarification)}</p>`;
    if (understanding?.acknowledgement) content = `<p>${text(understanding.acknowledgement)}</p>` + content;
    content += `<details><summary>看看这次怎样记录的</summary><p>${text(note.reply)}</p><p class="small">${note.source === 'model' ? '模型理解后，经过本地业务校验。理解有误时直接更正。' : '本地规则体验，没有调用模型。复杂表达可能漏分或分错。'}</p></details>` + modelReceipt(note);
    let result = bubble(1, content);
    if (note.agents.includes(2)) result += '<div class="route-line">皮皮 → 滴答 · 学习与时间</div>' + bubble(2, learningAdvice(note, tasks, learning));
    if (note.agents.includes(3)) result += '<div class="route-line">皮皮 → 啵啵 · 创意与验证</div>' + bubble(3, creativeAdvice(note, creative));
    if (tasks.length) result += '<div class="route-line">行动之后，把发现带回来</div>' + bubble(4, `<p>约定已经收下。做完、做了一部分，或者临时不想做，都可以告诉我。我会把真实情况带回下一轮。</p>${action('feedback', '现在带回一点反馈 ↗', tasks[0].id)}`);
    return result;
  }
  function renderThread() {
    const thread = $('#thread'), scroll = thread.scrollTop, atBottom = thread.scrollHeight - thread.clientHeight - scroll < 90;
    const notes = state().notes || [], visible = olderNotes ? notes : notes.slice(-20);
    let html = `<div class="day-divider">一段喜欢，从这里开始</div>`;
    if (!notes.length) {
      html += bubble(1, '<p>嗨，我是皮皮。今天脑子里冒出了什么？<br>可以一口气说很多，我会先把原话收好。</p><p>比如想学跳舞、明天十二点有空，还想做一个小网站……我们会分着接住。</p>') + '<div class="route-line">不是四张表，是四个一起接话的朋友</div>' + bubble(2, '<p>我和啵啵会分头找小行动。先留一点时间，或者先验证一个脑洞，都可以。</p>') + bubble(4, '<p>行动以后，再回来告诉我发生了什么。下次从你的真实收获出发。</p>');
    } else {
      if (notes.length > 20 && !olderNotes) html += `<p class="day-divider"><button class="text-button" data-action="older">前面还有 ${notes.length - 20} 段碎碎念，展开看看</button></p>`;
      for (const note of visible) {
        html += `<div class="message user"><div class="bubble-wrap"><div class="speaker-label">你 · ${date(localDay(note.createdAt))}</div><div class="bubble original">${esc(note.text)}</div><div class="note-tools">${PocketFlow.canUndo(note.id, state()) ? `<button data-action="undo" data-id="${esc(note.id)}">撤销本次自动安排</button>` : ''}<button data-action="remember-note" data-id="${esc(note.id)}">提一句记忆</button></div></div></div>`;
        html += noteMessages(note);
      }
    }
    if (app.storageError) html = `<div class="storage-warning">${esc(app.storageError)}</div>` + html;
    thread.innerHTML = html;
    thread.scrollTop = atBottom || !notes.length ? thread.scrollHeight : scroll;
  }
  function taskRows(tasks) {
    return tasks.length ? tasks.map(t => `<article class="task-row"><div class="task-clock">${esc(t.start)}<small>${date(t.date)} · ${t.duration} 分钟</small></div><div class="task-detail"><h3>${esc(t.title)}</h3><p>${t.kind === 'experiment' ? '啵啵的创意小实验' : '滴答的学习小行动'}${t.contract?.date === app.current().today && app.mode() === 'strict' ? ' · 今天的认真约定' : ''}</p></div>${t.status === 'accepted' ? `<button data-action="feedback" data-id="${esc(t.id)}">带回反馈 ↗</button>` : `<span class="task-status">${status(t.status)}</span>`}<button data-action="task-detail" data-id="${esc(t.id)}">详情</button></article>`).join('') : '<p class="empty">这里还有空白。直接在对话里说“明天中午十二点练十分钟”，就能给喜欢留一点时间。</p>';
  }
  function renderAgenda() {
    const tasks = [...state().tasks].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    $('#agenda-view').innerHTML = `<div class="page-title">${sprite(2)}<div><p class="eyebrow">LITTLE PROMISES</p><h1>给喜欢，留一点时间。</h1><p>安排来自你的话；改期也直接说。还没收到反馈，不等于你没有努力。</p></div></div><div class="actions"><button class="primary" data-action="chat-focus">和滴答约个时间 ↗</button><button class="secondary" data-action="mode">今天怎么陪我？</button></div><div class="section-label">接下来要试的 <span>${tasks.filter(t => t.status === 'accepted').length} 个小行动</span></div>${taskRows(tasks.filter(t => t.status === 'accepted'))}<details><summary class="section-label">已经带回收获的行动</summary>${taskRows(tasks.filter(t => t.status !== 'accepted'))}</details><details><summary class="section-label">我告诉过你的忙碌时段</summary>${Object.entries(state().availability).sort(([a], [b]) => a.localeCompare(b)).map(([day, slots]) => slots.map(s => `<p class="hint">${date(day)} ${esc(s.start)}—${esc(s.end)} · ${esc(s.label || '这段没空')}</p>`).join('')).join('') || '<p class="hint">还没有忙碌记录。在对话里告诉皮皮“明天九点到十一点要上课”就好。</p>'}</details>`;
  }
  function renderMemory() {
    const p = state().studio.preference;
    $('#memory-view').innerHTML = `<div class="page-title">${sprite(1)}<div><p class="eyebrow">YOUR LITTLE POCKET</p><h1>记住你说过的，<br>也听你随时改口。</h1><p>记忆由你确认。我们会参考具体偏好，不给你贴性格标签。</p></div></div><div class="memory-layout"><div><h2>你亲自确认的记忆</h2><p>比如“工作日晚上容易累”“我更喜欢先跟做，再看理论”。自由文字先作为记录；下面的安排偏好会直接影响本地计划。</p><div>${state().studio.facts.map(f => `<div class="fact"><p>${text(f.text)}</p><button data-action="edit-fact" data-id="${esc(f.id)}">修改</button><button data-action="forget" data-id="${esc(f.id)}">忘掉</button></div>`).join('') || '<p class="empty">还没给你下任何定义。告诉我们一件安排时该记住的小事吧。</p>'}</div><button class="secondary" data-action="new-fact">＋ 放进一条记忆</button><h2 class="section-label">从真实反馈里认识你</h2>${state().feedback.slice(-5).reverse().map(f => `<p class="hint">${date(localDay(f.createdAt))} · 你自报“${esc(f.taskTitle)}”${f.minutes} 分钟，${({hard: '觉得有点难', easy: '觉得挺轻松', right: '难度刚好'}[f.feeling] || '留下一次反馈')}。${f.reason ? '<br>你的解释：' + text(f.reason) : ''}</p>`).join('') || '<p>行动反馈会留在这里。我们根据具体经历调整，而不是猜测你的性格。</p>'}</div><div><h2>安排时，先这样照顾我</h2><form class="pref-form" id="preference-form"><div class="field"><label for="pref-duration">一开始，我通常愿意试多久？</label><select id="pref-duration" name="duration">${[5, 10, 15, 20, 30].map(n => `<option value="${n}" ${p.duration === n ? 'selected' : ''}>${n} 分钟</option>`).join('')}</select></div><div class="field"><label for="pref-energy">默认精力</label><select id="pref-energy" name="energy"><option value="low" ${p.energy === 'low' ? 'selected' : ''}>最近容易累，轻一点</option><option value="medium" ${p.energy === 'medium' ? 'selected' : ''}>普通状态，留一点空白</option><option value="high" ${p.energy === 'high' ? 'selected' : ''}>精力不错，可以多试一点</option></select></div><div class="field"><label for="pref-level">新兴趣默认从哪里开始？</label><select id="pref-level" name="level"><option value="beginner" ${p.level === 'beginner' ? 'selected' : ''}>先按小白来</option><option value="some" ${p.level === 'some' ? 'selected' : ''}>通常有一点基础</option><option value="advanced" ${p.level === 'advanced' ? 'selected' : ''}>偏向深入一点</option></select></div><button class="primary" type="submit">记住这些偏好</button></form><p>对话里本次说的时间、基础和精力优先。修改偏好会用于后续新安排。</p><h2 class="section-label">把记录握在自己手里</h2><p>目前仅保存在这个浏览器，清理浏览器会丢失。跨设备长期记忆还需要连接账号与数据库。导出备份不包含视频文件。</p><div class="actions"><button class="secondary" data-action="export">导出文字记录</button><button class="secondary" data-action="import">导入备份</button></div></div></div><details><summary class="section-label">所有兴趣都还在 · ${state().ideas.length}</summary>${state().ideas.map(i => `<div class="topic-row"><span>${esc(i.title)}<small>${i.type === 'skill' ? '滴答接住的学习' : i.type === 'creative' ? '啵啵接住的创意' : '先收藏的碎碎念'}</small></span><button data-action="continue" data-id="${esc(i.id)}">接着聊 ↗</button></div>`).join('') || '<p class="empty">想到什么，先说给皮皮听。</p>'}</details>`;
  }
  function render() {
    const strict = app.mode() === 'strict', reward = app.mode() === 'reward';
    document.body.classList.toggle('strict', strict);
    document.body.classList.toggle('reward', reward);
    $('#mode-label').textContent = strict ? '认真督促 · 今天' : reward ? '奖励鼓励 · 今天' : '温和陪伴';
    $('#reward-strip').hidden = !reward;
    $('#reward-points').textContent = '✦ ' + state().studio.rewards.reduce((sum, r) => sum + r.points, 0) + ' 成长值';
    $('#task-count').textContent = state().tasks.filter(t => t.status === 'accepted').length;
    renderThread(); renderAgenda(); renderMemory();
  }
  function go(next, focus = false) {
    view = ['chat', 'agenda', 'memory'].includes(next) ? next : 'chat';
    for (const name of ['chat', 'agenda', 'memory']) $('#' + name + '-view').hidden = name !== view;
    document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('selected', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
    history.replaceState(null, '', '#' + view);
    if (focus) $('#composer').focus();
  }
  function bottom() { $('#thread').scrollTop = $('#thread').scrollHeight; }
  function setRobot(id, custom) {
    activeRobot = id;
    document.querySelectorAll('[data-character]').forEach(button => button.classList.toggle('active', +button.dataset.character === id));
    $('#stage-caption').textContent = robots[id].name + '：' + (custom || (app.mode() === 'strict' ? ['约定我会认真记。你解释原因，我也认真听。', '今天认真一点，遇到变化也可以重新约。', '大胆的脑洞，也配一个能验证的小动作。', '没有收到反馈，我会先问发生了什么。'][id - 1] : robots[id].hello));
  }
  function close() {
    if (feedbackPending) { toast('回回还在处理这次反馈。请等本轮结束；失败时表单会保留，可以继续修改。'); return false; }
    $('#dialog').close(); pendingVideo = null;
    if (videoURL) { URL.revokeObjectURL(videoURL); videoURL = null; }
    return true;
  }
  function dialog(title, html) {
    if (feedbackPending) { toast('回回还在处理这次反馈，表单和原文会保留。请等本轮结束。'); return; }
    if ($('#dialog').open) close();
    $('#dialog-body').innerHTML = `<h2 id="dialog-title">${title}</h2>${html}`;
    $('#dialog').showModal();
  }
  function showMode() {
    const current = app.mode();
    dialog('今天，想怎么被陪伴？', `<div class="dialog-hero">${sprite(2)}<p>这不是给人分类，是给今天选个相处方式。<br>随时可以改，明天默认回到温和。</p></div><form id="mode-form"><div class="mode-options">${[['gentle', '温和陪伴', '留出时间、拆小行动，遇到困难一起调。'], ['reward', '奖励鼓励', '把每一次小进步亮出来，用成长值记下收获。'], ['strict', '认真督促', '今日新约定到期还没反馈，滴答会主动来问。']].map(([value, title, description]) => `<label class="mode-option"><input type="radio" name="mode" value="${value}" ${current === value ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`).join('')}</div><label class="check-row"><input type="checkbox" name="accepted" ${current !== 'gentle' ? 'required' : ''}><span>我了解这是今天的可撤回约定。成长值是本地演示、待核验，不能抵钱；未完成只不发本次奖励，不清空历史。</span></label><label class="check-row"><input type="checkbox" name="bugs"><span>仅督促模式：允许网页虫虫提醒（10 秒自动清除，随时一键清除）。</span></label><div class="actions"><button class="primary" type="submit">用这个方式陪我</button><button class="secondary" type="button" data-action="rewards">看成长值规则</button><button class="text-button" type="button" data-action="preview-bugs">预览虫虫效果</button></div></form><p class="hint">三种模式都可以记成长值，奖励模式会更突出展示；不用为了积分选择不适合的陪伴。督促仅在网页打开时生效。</p>`);
  }
  function showRewards() {
    const ledger = state().studio.rewards, points = ledger.reduce((sum, r) => sum + r.points, 0);
    dialog('让每一步，都被看见', `<div class="reward-total">✦ ${points}<span>成长值 · 演示待核验</span></div><p>完成今日新安排，并自报至少 3 分钟：＋5；试了一部分且至少 3 分钟：＋2。同一兴趣每天一次，每天最多 15 点。没完成，只不发这次奖励，原来的记录还在。</p><p>三个模式采用同一规则。奖励模式只是把庆祝放在更显眼的位置，不代表更多实际优惠。</p><p class="hint">这是本地体验数据，能被浏览器修改，无法防刷。没有真实账户、服务端核验和积分账本之前，不可兑换现金或抵扣模型费用；上传视频也不等于核验通过。</p>${ledger.length ? `<details><summary>看看来自哪些小行动</summary>${ledger.slice(-12).reverse().map(r => `<p class="hint">${date(r.date)} · ${esc(state().tasks.find(t => t.id === r.taskId)?.title || '一次小行动')} · ＋${r.points} · 自报待核验</p>`).join('')}</details>` : '<p class="hint">还没有成长值。今天先约一件愿意试的小事，再带回真实反馈。</p>'}`);
  }
  function showFeedback(id) {
    const tasks = state().tasks.filter(t => t.status === 'accepted');
    const ideas = state().ideas.filter(i => !i.archived && i.type !== 'park');
    if (!tasks.length && !ideas.length) { go('chat', true); toast('先说说想学什么、想做什么，再来带回反馈。'); return; }
    setRobot(4);
    const selectedTask = tasks.find(t => t.id === id) || tasks.at(-1);
    const selectedIdea = ideas.find(i => i.id === id) || ideas.at(-1);
    const selectedTarget = selectedTask ? 'task:' + selectedTask.id : 'idea:' + selectedIdea.id;
    const selectedMinutes = selectedTask?.duration || selectedIdea?.preferences?.duration || 10;
    const options = [
      ...tasks.map(t => `<option value="task:${esc(t.id)}" ${'task:' + t.id === selectedTarget ? 'selected' : ''}>${date(t.date)} ${esc(t.title)} · 已预约</option>`),
      ...ideas.map(i => `<option value="idea:${esc(i.id)}" ${'idea:' + i.id === selectedTarget ? 'selected' : ''}>${esc(i.title)} · 未预约，按兴趣反馈</option>`)
    ];
    const draft = $('#composer').value.trim();
    dialog('回回，今天是这样的……', `<form id="feedback-form"><div class="form-grid"><div class="field full"><label for="feedback-target">想聊哪一次？</label><select id="feedback-target" name="target">${options.join('')}</select><p class="hint" id="feedback-target-hint">已预约行动会记录完成情况；未预约兴趣只分析这次经历，不改任何旧任务。</p></div><div class="field"><label for="completion">这次做到哪一步？</label><select id="completion" name="completion"><option value="done">做完啦</option><option value="partial">试了一部分</option><option value="skipped">今天暂时没做</option></select></div><div class="field"><label for="spent">实际用了多久？</label><input id="spent" name="minutes" type="number" min="0" max="480" step="1" value="${Number(selectedMinutes) || 10}"><p class="hint" id="minutes-hint">未预约反馈可以留空；留空就是不记录时长，不会替你编一个。</p></div><div class="field full"><label for="feeling">这次感觉怎么样？</label><select id="feeling" name="feeling"><option value="right">刚刚好</option><option value="hard">有点难，下次拆小一点</option><option value="easy">挺轻松，可以进一点点</option></select></div><div class="field full"><label for="reason">发现了什么，或者发生了什么？</label><textarea id="reason" name="reason" maxlength="2000" placeholder="比如：动作衔接有点难；排线好难；今天临时加班；这个兴趣好像没那么喜欢了……">${esc(draft)}</textarea><p class="hint">如果选择和文字不一致，回回会两条都保留：比如“总体挺轻松，但排线好难”。</p></div><div class="field full"><label for="feedback-video">也可以带一段视频（选填，25 MB 以内）</label><input id="feedback-video" name="video" type="file" accept="video/*"><video class="video-preview" id="feedback-preview" controls playsinline hidden></video><p class="hint" id="video-status">视频仅保存在本机。当前没有视频分析服务，回回会依据你的文字反馈调整，不会假装看懂视频。</p></div></div><div class="actions"><button class="primary" type="submit" id="feedback-submit">把收获交给回回 ↗</button><button type="button" class="secondary" data-action="close">再想一会儿</button></div></form>`);
    syncFeedbackTarget();
  }
  function syncFeedbackTarget() {
    const select = $('#feedback-target'); if (!select) return;
    const isTask = String(select.value || '').startsWith('task:');
    const spent = $('#spent');
    if (spent) { spent.required = isTask; spent.placeholder = isTask ? '请填写实际时长' : '可以留空，表示未记录时长'; }
    const hint = $('#feedback-target-hint');
    if (hint) hint.textContent = isTask ? '已预约行动会记录完成情况；时长必须如实填写。' : '未预约兴趣只分析这次经历，不改任何旧任务；时长可以留空。';
    const minutesHint = $('#minutes-hint');
    if (minutesHint) minutesHint.textContent = isTask ? '已预约行动请填写实际分钟数；不能留空，也不会替你补一个。' : '未预约反馈可以留空；留空就是不记录时长，不会替你编一个。';
  }
  function clearBugs(snooze = true) {
    clearTimeout(bugTimer); $('#bugs-layer').replaceChildren(); $('#bug-controls').hidden = true;
    if (bugTask && snooze) app.dismiss(bugTask, 30);
    bugTask = null;
  }
  function showBugs(taskId = null) {
    clearBugs(false); bugTask = taskId;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < (reduced ? 5 : 16); i++) {
      const bug = document.createElement('span'); bug.className = 'bug'; bug.textContent = ['🐛', '🐞', '🪲'][i % 3];
      bug.style.setProperty('--x', (4 + Math.random() * 80) + '%'); bug.style.setProperty('--y', (8 + Math.random() * 80) + '%'); bug.style.setProperty('--speed', (5 + Math.random() * 4) + 's'); $('#bugs-layer').append(bug);
    }
    $('#bug-controls').hidden = false;
    bugTimer = setTimeout(() => clearBugs(true), 10000);
  }
  function checkReminder() {
    if (document.hidden) return;
    if (app.mode() !== 'strict') { if (bugTask) clearBugs(false); document.body.classList.remove('strict'); document.body.classList.toggle('reward', app.mode() === 'reward'); $('#mode-label').textContent = app.mode() === 'reward' ? '奖励鼓励 · 今天' : '温和陪伴'; return; }
    const task = app.overdue().find(t => !seenReminders.has(t.id));
    if (task) {
      seenReminders.add(task.id); setRobot(2, '这次约定还没收到反馈。临时有事，还是哪里卡住了？');
      toast('滴答：' + task.title + '还没收到反馈，可以延期或告诉回回原因。');
      if (task.contract?.bugs) showBugs(task.id);
    }
  }
  async function submitFeedback(form) {
    if (sending || feedbackPending) return;
    if (recording) { toast('先结束语音并确认文字，再交给回回。'); return; }
    const data = Object.fromEntries(new FormData(form));
    const target = String(data.target || '');
    const isTask = target.startsWith('task:'), targetId = target.slice(5);
    const task = isTask ? state().tasks.find(t => t.id === targetId && t.status === 'accepted') : null;
    const idea = !isTask ? state().ideas.find(i => i.id === targetId) : null;
    if (isTask && !task) { toast('这次行动已经反馈过，请重新选择。', true); return; }
    if (!isTask && !idea) { toast('没有找到这个兴趣，请重新选择。', true); return; }
    const minutes = data.completion === 'skipped' ? 0 : data.minutes === '' || data.minutes === undefined ? null : Number(data.minutes);
    if (isTask && (!Number.isInteger(minutes) || minutes < 0 || minutes > 480)) { toast('已预约行动请填写 0—480 的实际分钟数。', true); return; }
    if (!isTask && minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 480)) { toast('实际时长请填写 0—480 的整数，或留空。', true); return; }
    if (!isTask && !useModel) { toast('未预约的兴趣反馈需要真实模型分析；请先切到真实模型，或把这个兴趣预约成小行动。', true); return; }
    const reason = String(data.reason || '').trim();
    const completionLabel = ({done: '完成了', partial: '做了一部分', skipped: '暂时没做'}[data.completion]);
    const feelingLabel = ({right: '刚好', hard: '有点难', easy: '挺轻松'}[data.feeling]);
    const raw = isTask
      ? `关于“${task.title}”（${task.date} ${task.start}）的行动反馈：${completionLabel}，实际${minutes}分钟，难度${feelingLabel}。${reason}`
      : `关于“${idea.title}”的未预约兴趣反馈：这次${completionLabel}，实际${minutes === null ? '未记录时长' : minutes + '分钟'}，难度${feelingLabel}。${reason}`;
    const button = $('#feedback-submit'), modelForThisFeedback = useModel;
    const controls = [...form.elements, ...$('#dialog').querySelectorAll('[data-action="close"]')].map(control => ({control, disabled: control.disabled}));
    feedbackPending = true; setSending(true); form.setAttribute('aria-busy', 'true');
    for (const {control} of controls) control.disabled = true;
    button.textContent = modelForThisFeedback ? '回回正在听…' : '正在保存…';
    try {
      let media = null;
      if (pendingVideo) media = await app.putMedia(app.uid(), pendingVideo);
      if (modelForThisFeedback) {
        const note = isTask
          ? await app.submitModel(raw, HaipiguaModel.turn, task.id, {expectedFeedback: {completion: data.completion, minutes, feeling: data.feeling, reason}})
          : await app.submitModel(raw, HaipiguaModel.turn, null, {expectedReview: {ideaId: idea.id, completion: data.completion, minutes, feeling: data.feeling, reason}});
        if (isTask) {
          const feedback = [...state().feedback].reverse().find(f => f.taskId === task.id && f.createdAt === note.createdAt);
          if (feedback && media) { feedback.media = media; app.save(); }
        } else if (media) {
          const review = [...state().reviews].reverse().find(r => r.noteId === note.id);
          if (review) { review.media = media; app.save(); }
        }
        modelValidated = true;
      } else {
        app.feedback({taskId: task.id, completion: data.completion, minutes, feeling: data.feeling, reason, media});
      }
      feedbackPending = false;
      close(); clearBugs(false); render(); go('chat'); bottom(); saveNotice(); updateConnection(); setRobot(4, '谢谢你告诉我真实情况。下一步只更新建议，不会替你预约时间。');
    } catch (error) { toast(error.message, true); }
    finally {
      feedbackPending = false; setSending(false); form.removeAttribute('aria-busy');
      for (const {control, disabled} of controls) if (control.isConnected) control.disabled = disabled;
      if (button.isConnected) button.textContent = '把收获交给回回 ↗';
    }
  }
  function setSending(value) { sending = value; $('#dictate').disabled = value; }
  function showFact(id, initial = '') {
    const existing = state().studio.facts.find(f => f.id === id);
    dialog(existing ? '这条记忆，我想改一改' : '皮皮，记住这一件小事', `<p class="hint">只记录你确认的内容。你可以随时修改、忘掉它。</p><form id="fact-form" data-id="${esc(existing?.id || '')}"><div class="field"><label for="fact-text">安排时，你希望我们知道什么？</label><textarea id="fact-text" name="text" maxlength="300" required>${esc(existing?.text || initial)}</textarea></div><div class="actions"><button type="submit" class="primary">确认记住</button><button type="button" class="secondary" data-action="close">先不记</button></div></form>`);
  }
  function capabilities() {
    dialog('现在的嗨皮瓜，会做些什么？', '<p>本地体验使用规则分流；真实模型模式通过本机服务调用你明确选择的平台与型号：皮皮理解并分流，滴答规划，啵啵探索，回回反馈。每轮只调用需要的角色，不为凑四次调用而浪费时间。</p><p>模型负责理解和建议；任务关联、日期、撞期、反馈依据与本机保存仍由代码校验。每条模型回复可以展开实际调用记录。失败会提示，不会偷偷换成本地规则并冒充模型。</p><p>模型模式发送本次文字和近期相关记录到所选平台。密钥仅在本机服务内存，不进浏览器或仓库；文字记录仍保存在你的浏览器，没有跨设备数据库。</p><p>语音转写依赖浏览器。视频仅本机回看，当前文本模型不会看视频。搜索入口不代表已核验教程，官方资料只有显示本次已读取时才表示实际读取。费用以平台账单为准。</p>');
  }
  function updateConnection() {
    const provider = modelHealth.providerLabel || modelHealth.provider || '模型服务';
    const name = modelHealth.modelLabel || modelHealth.model || '未检测到型号';
    $('#connection-button').textContent = useModel ? provider + ' · ' + name + (modelValidated ? ' · 已真实调用' : ' · 服务已配置') : '本地规则体验 · 未调用模型';
    $('#connection-dot').style.background = useModel ? '#6b9d77' : '#a6ad99';
  }
  async function refreshConnection(initial = false) {
    modelHealth = await HaipiguaModel.status();
    if (initial) useModel = modelHealth.ready;
    updateConnection(); return modelHealth;
  }
  function showConnection() {
    const provider = modelHealth.providerLabel || modelHealth.provider || '未检测到';
    const model = modelHealth.modelLabel || modelHealth.model || '未检测到';
    const price = modelHealth.price ? `输入 ${modelHealth.price.input?.join('–')} / 输出 ${modelHealth.price.output?.join('–')} ${modelHealth.price.currency || ''}` : '平台未返回价格';
    const budget = modelHealth.budget?.limitCny != null ? `本次本机服务估算预算 ¥${modelHealth.budget.limitCny}，已估算 ¥${modelHealth.budget.estimatedSpentCny ?? 0}；不是账单。` : '未设置本机估算预算上限；仍受每轮调用次数和每次启动对话段数限制。';
    dialog('这段对话，由谁来接住？', `<p><strong>${modelHealth.ready ? '本机模型服务已配置' : '本机模型服务尚未就绪'}</strong></p><p>当前配置：${esc(provider)} · ${esc(model)}。</p><p>模型价格：${esc(price)}。${esc(modelHealth.priceNote || '')}</p><p>${esc(budget)}</p><p>模型模式会把本次文字与近期相关记录发送到所选平台，按职责调用模型，再校验并保存。本地体验使用演示规则，两种来源逐条标清。密钥只在本机服务进程里，不会进入浏览器或仓库。</p><div class="actions">${modelHealth.ready ? '<button class="primary" data-action="model-on">使用真实模型</button>' : ''}<button class="secondary" data-action="model-recheck">重新检测本机服务</button><button class="secondary" data-action="model-off">使用本地体验</button></div><p class="hint">启动方法见仓库的 server/README.md；当前服务地址只在本机有效，不等于腾讯云已接通。真实费用以平台账单为准。</p>`);
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const {action: name, id, noteId, view: next, character, sample} = button.dataset;
    if (sending && !['close', 'bottom', 'clear-bugs'].includes(name) && !character && !next) { toast('这一轮还在处理，请稍等。原文留着，没有重复发送。'); return; }
    if (next) { go(next); return; }
    if (character) { setRobot(+character); return; }
    if (sample) {
      $('#composer').value = sample === 'learning' ? '我想学跳舞，我是零基础。明天中午十二点试十分钟吧。明天九点到十一点有课。' : '我想做一个给流浪小猫找家的小网站，先用十分钟画个最小的使用流程。';
      $('#composer').dispatchEvent(new Event('input')); $('#composer').focus(); return;
    }
    try {
      if (name === 'close') close();
      else if (name === 'mode') showMode();
      else if (name === 'rewards') showRewards();
      else if (name === 'capabilities') capabilities();
      else if (name === 'model-connection') showConnection();
      else if (name === 'model-on') { useModel = true; close(); updateConnection(); toast('已切到真实模型，下一条发送会调用所选平台。'); }
      else if (name === 'model-off') { useModel = false; close(); updateConnection(); toast('已切到本地规则体验。'); }
      else if (name === 'model-recheck') { await refreshConnection(); showConnection(); }
      else if (name === 'bottom') bottom();
      else if (name === 'older') { olderNotes = true; renderThread(); }
      else if (name === 'feedback') { clearBugs(true); showFeedback(id); }
      else if (name === 'chat-focus') { go('chat', true); setRobot(2); }
      else if (name === 'gentle') { app.setMode('gentle'); clearBugs(false); if ($('#dialog').open) close(); render(); setRobot(activeRobot); toast('已经换回温和陪伴。'); }
      else if (name === 'clear-bugs') clearBugs(true);
      else if (name === 'preview-bugs') { close(); showBugs(); toast('这是效果预览，不会创建任务或开启督促模式。'); }
      else if (name === 'continue') { app.continueIdea(id); const idea = state().ideas.find(i => i.id === id); close(); go('chat', true); toast('接着聊“' + idea.title + '”，直接补充想法或时间就好。'); }
      else if (name === 'undo') { if (!app.undo(id)) throw Error('后面已经有新改动，请直接说要怎样调整。'); render(); }
      else if (name === 'remember-note') { const note = state().notes.find(n => n.id === id); showFact('', note.text.slice(0, 300)); }
      else if (name === 'new-fact' || name === 'edit-fact') showFact(id);
      else if (name === 'forget') { app.forget(id); renderMemory(); toast('这条确认记忆已经移除。原始对话记录仍在。'); }
      else if (name === 'task-detail') {
        const task = state().tasks.find(t => t.id === id); if (!task) return;
        dialog(esc(task.title), `<p class="time-sticker">${date(task.date)} ${esc(task.start)}—${esc(task.end)} · ${task.duration} 分钟</p><p>${text(task.description)}</p>${resources(task.resources)}<p class="hint">教程为搜索入口，未进行内容筛选或查证。</p><div class="actions">${task.status === 'accepted' ? `<button class="primary" data-action="feedback" data-id="${esc(id)}">带回反馈</button>` : `<span class="hint">${status(task.status)}</span>`}<button class="secondary" data-action="continue" data-id="${esc(task.ideaId)}">在对话里调整</button></div>`);
      } else if (name === 'explore-detail') {
        const idea = state().ideas.find(i => i.id === id), saved = noteId ? state().notes.find(n => n.id === noteId)?.advice?.find(a => a.kind === 'exploration' && a.ideaId === id) : null, r = noteId ? saved?.value : idea?.exploration; if (!r) return;
        dialog('啵啵的探索草稿', `<p><strong>${esc(idea.title)}</strong></p><p>先验证这些假设：</p><ol>${(r.assumptions || []).map(s => `<li>${esc(typeof s === 'string' ? s : s.text || s.title)}</li>`).join('')}</ol>${(r.paths || []).map(p => `<p><strong>${esc(p.title)}</strong><br>${text(p.description)}</p>`).join('')}<p><strong>第一次试：</strong>${text(typeof r.firstStep === 'string' ? r.firstStep : r.firstStep?.title)}</p>${resources(r.searchLinks)}<p class="hint">这些方向尚未查证。涉及实际制造或工程项目，需要专业资料与条件核验。</p><button class="primary" data-action="continue" data-id="${esc(id)}">继续问啵啵 ↗</button>`);
      } else if (name === 'play-video') {
        const file = await app.getMedia(id); if (!file) throw Error('这个浏览器里没有这段视频，可能是从文字备份导入的。');
        const tag = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'img' : null;
        if (!tag) throw Error('这个旧成果格式暂不支持回放。');
        dialog('回看这一次尝试', `<${tag} id="saved-video" class="video-preview" ${tag !== 'img' ? 'controls' : 'alt="这一次尝试的照片"'} playsinline></${tag}><p class="hint">这是你的本机成果，尚未经过 AI 分析。</p>`); videoURL = URL.createObjectURL(file); $('#saved-video').src = videoURL;
      } else if (name === 'export') {
        const url = URL.createObjectURL(new Blob([app.exportData()], {type: 'application/json'}));
        const link = document.createElement('a'); link.href = url; link.download = '嗨皮瓜-文字备份-' + app.current().today + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (name === 'import') {
        dialog('用备份恢复文字记录？', '<p>导入会替换这个浏览器当前的文字记录。请先导出当前版本。视频不在文字备份里，导入后也不会自动开启督促模式。</p><div class="actions"><button class="primary" data-action="choose-import">选择备份文件</button><button class="secondary" data-action="export">先导出当前记录</button></div>');
      } else if (name === 'choose-import') $('#import-file').click();
    } catch (error) { toast(error.message || '这次没有处理成功，请再试一次。', true); }
  });
  $('#composer-form').addEventListener('submit', async event => {
    event.preventDefault(); if (recording) { toast('先结束语音，再确认文字发出。'); return; }
    if (sending) return;
    if (!$('#composer').value.trim()) return;
    setSending(true); const button = $('#send-button'), message = $('#model-message'), submittedDraft = $('#composer').value, modelForThisTurn = useModel;
    button.disabled = true; $('#composer').readOnly = true;
    message.hidden = !useModel; message.classList.remove('error'); message.textContent = '皮皮和朋友们正在理解这一段。只调用需要的角色，可能要等几十秒……';
    try {
      const note = modelForThisTurn ? await app.submitModel(submittedDraft, HaipiguaModel.turn) : app.submit(submittedDraft); if (!note) return;
      if (modelForThisTurn) modelValidated = true;
      if ($('#composer').value === submittedDraft) { $('#composer').value = ''; $('#composer').dispatchEvent(new Event('input')); }
      render(); bottom(); saveNotice();
      message.hidden = true; updateConnection();
      setRobot(note.agents.includes(4) ? 4 : note.agents.includes(3) ? 3 : note.agents.includes(2) ? 2 : 1);
      if (note.clarification) toast('有一处需要你补充，看皮皮的追问。');
      else if (note.reviewQuestion) toast('回回想先问一句，看看它的追问。');
    } catch (error) { message.hidden = false; message.classList.add('error'); message.textContent = error.message + ' 原文还在输入框，检查后可再发送。'; toast(error.message, true); }
    finally { setSending(false); button.disabled = false; $('#composer').readOnly = false; }
  });
  $('#composer').addEventListener('input', () => { $('#draft-count').textContent = $('#composer').value.length + ' / 8000'; try { sessionStorage.setItem('haipigua.draft', $('#composer').value); } catch {} });
  $('#composer').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer-form').requestSubmit(); } });
  $('#mode-button').addEventListener('click', showMode);
  document.addEventListener('submit', event => {
    if (event.target.id === 'composer-form') return;
    event.preventDefault(); const form = event.target, data = Object.fromEntries(new FormData(form));
    if (sending) { toast('先等这一轮处理完成，再修改记录。'); return; }
    try {
      if (form.id === 'mode-form') { app.setMode(data.mode, {accepted: data.accepted === 'on', bugs: data.bugs === 'on'}); close(); clearBugs(false); render(); setRobot(2); toast('今天的陪伴方式换好了，随时可以改。'); }
      else if (form.id === 'feedback-form') submitFeedback(form);
      else if (form.id === 'preference-form') { app.preference(data); toast('记住啦，后面的新安排会先参考这些偏好。'); saveNotice(); }
      else if (form.id === 'fact-form') { app.fact(data.text, form.dataset.id); close(); renderMemory(); saveNotice(); }
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('change', event => {
    if (event.target.name === 'mode') { const consent = $('#mode-form input[name=accepted]'); if (consent) consent.required = event.target.value !== 'gentle'; }
    if (event.target.id === 'feedback-target') syncFeedbackTarget();
    if (event.target.id === 'completion') {
      const skipped = event.target.value === 'skipped'; $('#spent').disabled = skipped;
      if (skipped) $('#spent').value = 0;
      setRobot(4, skipped ? '先听你的原因。今天发生什么了？' : robots[4].hello);
    }
    if (event.target.id === 'feedback-video') {
      const file = event.target.files[0];
      if (videoURL) { URL.revokeObjectURL(videoURL); videoURL = null; }
      pendingVideo = null; $('#feedback-preview').hidden = true;
      if (!file) return;
      if (!/^video\//.test(file.type) || !file.size || file.size > 25 * 1024 * 1024) { event.target.value = ''; toast('请选择 25 MB 以内的视频。', true); return; }
      pendingVideo = file; videoURL = URL.createObjectURL(file); $('#feedback-preview').src = videoURL; $('#feedback-preview').hidden = false;
      $('#video-status').textContent = '选好了：' + file.name + '。提交反馈后保存在本机，尚未进行 AI 分析。';
    }
  });
  $('#import-file').addEventListener('change', async event => {
    try { const file = event.target.files[0]; if (!file) return; if (file.size > 12000000) throw Error('请选择 12 MB 以内的文字备份。'); app.importData(await file.text()); close(); render(); toast('文字记录恢复了。视频文件仍以这个浏览器原有内容为准。'); }
    catch (error) { toast(error.message, true); } finally { event.target.value = ''; }
  });
  $('#dialog').addEventListener('cancel', event => { event.preventDefault(); close(); });
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('#dictate').addEventListener('click', () => {
    if (sending) { toast('这一轮还在处理，结束后再继续说；已有文字留着。'); return; }
    if (!Speech) { toast('这个浏览器没有语音转文字。可以用手机或系统键盘的语音输入，再把文字放进来。'); return; }
    if (recording) { recognition.stop(); return; }
    const base = $('#composer').value; let finalText = '';
    recognition = new Speech(); recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
    recognition.onstart = () => { recording = true; $('#dictate').setAttribute('aria-pressed', 'true'); $('#dictate').innerHTML = '<span aria-hidden="true">■</span>结束并检查文字'; $('#speech-status').textContent = '正在听……说完后结束录音，检查文字再递给皮皮。浏览器语音服务可能需要联网。'; };
    recognition.onresult = event => {
      if (sending) { recognition.stop(); return; }
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) finalText += event.results[i][0].transcript; else interim += event.results[i][0].transcript;
      const value = base + (base ? '\n' : '') + finalText + interim;
      $('#composer').value = value.slice(0, 8000); $('#composer').dispatchEvent(new Event('input'));
      if (value.length > 8000) { recognition.stop(); toast('已到 8000 字，请先发出这一段。', true); }
    };
    recognition.onerror = event => { $('#speech-status').textContent = event.error === 'not-allowed' ? '麦克风权限未开启，可以直接输入文字。' : '语音服务暂时不可用，已经识别出的文字留在输入框。'; };
    recognition.onend = () => { recording = false; $('#dictate').setAttribute('aria-pressed', 'false'); $('#dictate').innerHTML = '<span aria-hidden="true">♩</span>说给皮皮听'; $('#speech-status').textContent = '文字留在输入框，确认没有听错后再递给皮皮。'; };
    try { recognition.start(); } catch { toast('语音没有启动成功，可以先用文字。', true); }
  });
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  document.addEventListener('visibilitychange', checkReminder);
  try { $('#composer').value = (sessionStorage.getItem('haipigua.draft') || '').slice(0, 8000); $('#composer').dispatchEvent(new Event('input')); } catch {}
  render(); go(location.hash.slice(1)); bottom(); setInterval(checkReminder, 20000); checkReminder(); refreshConnection(true);
  if (app.storageError) toast(app.storageError, true);
})();
