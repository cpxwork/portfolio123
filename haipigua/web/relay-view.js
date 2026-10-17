(function(global){
  'use strict';
  // Project one saved conversation turn onto the four characters. This view
  // never calls a model, writes domain state, or invents intermediate progress.
  const names={1:'皮皮',2:'滴答',3:'啵啵',4:'回回'};
  const greetings={1:'想到什么就说吧，我会把原话接住，再交给需要的伙伴。',2:'想学什么、什么时候没空，都可以一起说给皮皮听。',3:'有个天马行空的点子？我帮你找第一件可以验证的小事。',4:'做完、卡住、改变主意，都能直接说。我来接住这次的发现。'};
  function build(state,note){
    const nodes=Object.fromEntries([1,2,3,4].map(id=>[id,{id,name:names[id],status:'等你开口',state:'idle',paragraphs:[greetings[id]],bullets:[],links:[],noteId:note?.id||''}]));
    const edges=[],add=(from,to)=>{if(!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to});};
    const out={nodes,edges,original:note?.text||'',source:note?.source||'empty',calls:[],caption:'你说一次，四个伙伴一起接住。',noteId:note?.id||''};
    if(!note)return out;
    if(note.undone){nodes[1]={...nodes[1],state:'question',status:'本轮已撤销',paragraphs:['这段原话还留着；这轮改动已经撤销。你可以直接说新的想法。']};out.caption='本轮已撤销，原话仍在记录里。';return out;}
    const set=(id,status,paragraphs,bullets=[])=>Object.assign(nodes[id],{state:'ready',status,paragraphs,bullets});
    const ideas=(note.ideaIds||[]).map(id=>state.ideas.find(i=>i.id===id)).filter(Boolean);
    const u=note.understanding;
    set(1,'原话已收好',[u?.acknowledgement,u?.goal?'我听到的目标：'+u.goal:ideas.length?'这次聊到：'+ideas.map(i=>i.title).join('、'):'原话已经收下，接着说也可以。'].filter(Boolean),(u?.facts||[]).slice(0,3).map(f=>f.text));
    const advice=note.advice||[],plans=advice.filter(a=>a.kind==='plan'),explorations=advice.filter(a=>a.kind==='exploration');
    const tasks=(note.taskIds||[]).map(id=>state.tasks.find(t=>t.id===id)).filter(Boolean);
    if(plans.length){
      set(2,'小行动已更新',plans.flatMap(a=>[a.value.title,'留下什么：'+a.value.successCriterion]),plans.flatMap(a=>a.value.steps.map(s=>s.title+'：'+s.description)));
      nodes[2].links=plans.flatMap(a=>a.value.resources||[]);
    }else if(tasks.some(t=>t.kind!=='experiment')&&!note.agents.includes(4)){
      set(2,'当前保存的安排',tasks.filter(t=>t.kind!=='experiment').flatMap(t=>[t.title,t.date+' '+t.start+'—'+t.end+' · '+t.duration+' 分钟',t.description]));
    }else if(note.agents.includes(2)){
      set(2,note.clarification?'时间想问清楚':'安排已记录',[note.clarification||note.reply]);
    }
    if(explorations.length){
      set(3,'小实验已更新',explorations.flatMap(a=>[a.value.title,a.value.firstStep.title+'：'+a.value.firstStep.description,'观察什么：'+a.value.successSignal]));
      nodes[3].links=explorations.flatMap(a=>a.value.searchLinks||[]);
    }else if(tasks.some(t=>t.kind==='experiment')&&!note.agents.includes(4)){
      set(3,'当前保存的实验安排',tasks.filter(t=>t.kind==='experiment').flatMap(t=>[t.title,t.date+' '+t.start+'—'+t.end,t.description]));
    }else if(note.agents.includes(3))set(3,'接住创意补充',[note.reply]);
    const reviews=note.reviews||(note.reviewIds||[]).map(id=>(state.reviews||[]).find(r=>r.id===id)).filter(Boolean).map(r=>({ideaId:r.ideaId,value:{...r,strengths:r.progress||[],gaps:r.problems||[]}}));
    const feedback=state.feedback.find(f=>f.id===note.feedbackId)||[...state.feedback].reverse().find(f=>(note.taskIds||[]).includes(f.taskId)&&f.createdAt===note.createdAt);
    if(reviews.length){
      const values=reviews.map(r=>r.value),question=values.find(v=>v.needsEvidence)?.question;
      set(4,question?'想再听具体一点':'这次收获已记下',values.flatMap(v=>[v.response,v.summary,v.needsEvidence?v.question:'下一步：'+v.nextStep]));
      nodes[4].bullets=values.flatMap(v=>[...v.strengths,...v.gaps].map(p=>p.point+'（你说：“'+p.evidence+'”）'));
      if(question)nodes[4].state='question';
      add(1,4);
      for(const a of advice){const related=reviews.some(r=>r.ideaId===a.ideaId&&!r.value.needsEvidence);add(related?4:1,a.kind==='plan'?2:3);}
      add(4,1);
      for(const r of reviews){
        const target=r.before?.steps?2:r.before?.firstStep?3:null;
        if(target&&advice.some(a=>a.ideaId===r.ideaId))nodes[target].previous=r.before.steps?.map(s=>s.title).join('、')||r.before.firstStep.title;
      }
      out.caption=question?'回回接住反馈，先问一个具体问题；还没有更新行动。':'回回接住发现 → 伙伴修改下一步 → 收进灵感口袋。';
    }else if(feedback){
      set(4,'行动反馈已收下',[feedback.response,feedback.summary,'下一次建议：'+(feedback.nextAdjustment?.advice||'先聊聊具体发现。')]);
      nodes[4].previous=note.beforeAfter?.before?.title||'';
      add(1,4);add(4,1);out.caption='这次反馈交给回回，调整建议已保存。';
    }else{
      if(nodes[2].state==='ready')add(1,2);
      if(nodes[3].state==='ready')add(1,3);
      if(note.clarification){nodes[1].paragraphs.push(note.clarification);nodes[1].state='question';nodes[1].status='有一处想问清楚';}
      if(nodes[2].state==='ready'||nodes[3].state==='ready'){
        nodes[4].state='waiting';nodes[4].status='等你带回发现';nodes[4].paragraphs=['等你试过以后，直接在下面告诉我结果或困难。我还没有收到这一步的反馈。'];
        out.caption='皮皮分好方向。等你尝试，再由回回把收获带回来。';
      }
    }
    out.calls=(note.trace||[]).filter(t=>t.kind==='model').map(t=>({agent:t.agent,status:t.status,model:t.model}));
    return out;
  }
  global.HaipiguaRelay=Object.freeze({build});
})(typeof window!=='undefined'?window:globalThis);
