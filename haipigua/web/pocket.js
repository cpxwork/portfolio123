(function(global){
  'use strict';
  let undoEntry=null;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const uid=()=>global.crypto?.randomUUID?.()||'pipi-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const minute=time=>{if(!/^\d{2}:\d{2}$/.test(time||''))return NaN;const [h,m]=time.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;};
  const clock=value=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
  const domain=state=>clone({ideas:state.ideas,tasks:state.tasks,feedback:state.feedback,availability:state.availability||{},chatContext:state.chatContext||{}});
  function normalize(state){state.notes=Array.isArray(state.notes)?state.notes:[];state.chatContext=state.chatContext&&typeof state.chatContext==='object'?state.chatContext:{};state.availability=state.availability||{};if(!state.ideas.some(i=>i.id===state.chatContext.lastIdeaId))state.chatContext.lastIdeaId=null;if(!state.tasks.some(t=>t.id===state.chatContext.lastTaskId))state.chatContext.lastTaskId=null;return state;}
  function latest(state,id){return [...state.feedback].reverse().find(f=>f.ideaId===id);}
  function collision(state,date,start,end,excludeId){return (state.availability[date]||[]).some(s=>start<minute(s.end)&&end>minute(s.start))||state.tasks.some(t=>t.id!==excludeId&&t.date===date&&t.status!=='skipped'&&start<minute(t.end)&&end>minute(t.start));}
  function learningTask(state,idea,data,existing,options){
    data={...(options.preferences||{}),...(idea.preferences||{}),...data};
    const start=minute(data.start),duration=Number(data.duration||idea.preferences?.duration||10),finish=data.end?minute(data.end):start+duration;
    if(!data.date||!Number.isFinite(start)||!Number.isInteger(duration)||duration<3||duration>120||!Number.isFinite(finish)||finish<=start||finish>=1440)return {error:'这一小步需要完整的时间，几点开始、准备试几分钟？'};
    if(data.date<options.today||(data.date===options.today&&start<options.clockMinutes))return {error:'这个时间已经过去啦，你想安排到哪一天？'};
    // A spoken start time is exact. A conflict is clarified instead of silently moving it.
    const expectedEnd=Math.min(finish,start+Math.min(duration,{low:10,medium:20,high:40}[data.energy||idea.preferences?.energy||'medium']));
    if(collision(state,data.date,start,expectedEnd,existing?.id))return {error:'这个时间与你已有的安排撞上了，换到几点比较合适？'};
    const preferences={...(idea.preferences||{}),...data};
    if(idea.type==='creative'){
      const result=global.SparkEngine.exploreIdea({idea:idea.text,resources:preferences.resources||'',timeBudget:Math.min(duration,finish-start),feedback:latest(state,idea.id)});
      const amount=Math.min(duration,finish-start,result.timeBudget||duration);
      if(collision(state,data.date,start,start+amount,existing?.id))return {error:'这个时间已有安排，创意小尝试想改到几点？'};
      return {result,task:{id:existing?.id||uid(),ideaId:idea.id,date:data.date,start:data.start,end:clock(start+amount),duration:amount,title:String(result.firstStep?.title||result.firstStep||'一次创意小尝试').replace(/\d+\s*分钟/g,amount+' 分钟'),description:result.firstStep?.description||result.successSignal,resources:result.searchLinks||[],kind:'experiment',status:'accepted',createdAt:existing?.createdAt||options.now,origin:'ramble'}};
    }
    const result=global.SparkEngine.planLearning({idea:idea.text,title:idea.title,date:data.date,availableStart:data.start,availableEnd:clock(finish),duration,energy:preferences.energy||'medium',level:preferences.level||'beginner',goal:preferences.goal||'',busySlots:[],adjustment:existing?undefined:latest(state,idea.id)?.nextAdjustment});
    if(!result.tasks?.length)return {error:result.error||'这段时间不够，要不要换一段至少三分钟的空闲？'};
    const steps=result.tasks,resources=steps.flatMap(t=>t.resources||[]);
    return {result,task:{id:existing?.id||uid(),ideaId:idea.id,date:data.date,start:steps[0].start,end:steps.at(-1).end,duration:steps.reduce((s,t)=>s+t.duration,0),title:idea.title+' · 一次小练习',description:steps.map(t=>t.title+'：'+t.description).join('\n'),steps,resources:resources.filter((r,i)=>resources.findIndex(x=>x.url===r.url)===i),kind:'learning',status:'accepted',createdAt:existing?.createdAt||options.now,origin:'ramble'}};
  }
  function submit(text,state,options){
    normalize(state);text=String(text||'').trim().slice(0,8000);if(!text)return null;
    options={now:new Date().toISOString(),...options};const before=domain(state),context=state.chatContext;
    let input=text;
    // A short answer can complete a previous scheduling question without re-creating the idea.
    const pending=context.pending;
    if(pending?.kind==='schedule'&&pending.start&&!/\d{1,2}[:：点时]|[一二三四五六七八九十两]+点/.test(text)&&/今天|明天|后天|\d{1,2}月\d{1,2}/.test(text))input=text+' '+pending.start+'开始，试'+(pending.duration||10)+'分钟';
    const routerContext={ideas:state.ideas,tasks:state.tasks,availability:state.availability,lastIdeaId:context.lastIdeaId,lastTaskId:context.lastTaskId,now:options.now,pending,defaultPreferences:options.preferences};
    const fresh=pending?global.RambleRouter.analyze(text,{...routerContext,pending:undefined}):null;
    const analysis=fresh?.intents.some(i=>i.kind==='idea'&&i.data.canApply!==false)?fresh:global.RambleRouter.analyze(input,routerContext);
    const currentIdea=state.ideas.find(i=>i.id===context.lastIdeaId);
    if(currentIdea?.type==='creative'&&/能不能|行不行|可行|怎么办|渠道|路径|方法|细节|先问|先找|要不/.test(text)&&analysis.intents.every(i=>i.kind==='note'))analysis.intents.push({kind:'explore',ideaId:currentIdea.id,agents:['Agent 3'],data:{canApply:true}});
    const note={id:uid(),text,createdAt:options.now,reply:'',agents:[1],ideaIds:[],taskIds:[],links:[],source:'local-demo'};
    const replies=[],mapped=new Map(),handledPreferences=new Set();let clarification=analysis.clarification?.question||null,emotion='proud',mutated=false;
    function linkIdea(intent){return state.ideas.find(i=>i.id===(intent.ideaId||mapped.get(intent.newIdeaKey)||context.lastIdeaId));}
    for(const intent of analysis.intents||[]){
      const data={...(intent.data||{})};note.agents.push(...(intent.agents||[]).map(a=>Number(String(a).replace(/\D/g,''))).filter(n=>n>=1&&n<=4));
      if(data.canApply===false)continue;
      if(intent.kind==='idea'){
        const raw=data.text||intent.original||text,classed=global.SparkEngine.classifyIdea(raw,data.type||'auto');
        const item={id:uid(),text:raw.slice(0,2000),title:String(data.title||classed.title||raw).slice(0,80),type:data.type||classed.type||'park',createdAt:options.now,archived:false,preferences:{...(options.preferences||{}),...Object.fromEntries(['energy','level','duration','goal'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]))}};
        state.ideas.unshift(item);mapped.set(intent.newIdeaKey||data.newIdeaKey||'new-0',item.id);context.lastIdeaId=item.id;context.lastTaskId=null;note.ideaIds.push(item.id);mutated=true;
        replies.push('收下“'+item.title+'”啦。'+(item.type==='skill'?'学习安排员已经接住了，接着说你什么时候有空就好。':item.type==='creative'?'创意探索员来帮你找一个能试的小入口。':'先替你好好收着，想行动的时候继续说。'));
        if(item.type==='creative'){item.exploration=global.SparkEngine.exploreIdea({idea:item.text,timeBudget:10});replies.push('可以先试：'+String(item.exploration.firstStep?.title||item.exploration.firstStep));note.links.push({view:'lab',label:'已送到创意实验室',ideaId:item.id});note.agents.push(3);}else if(item.type==='skill')note.agents.push(2);
      }else if(intent.kind==='preference'){
        const idea=linkIdea(intent);if(!idea||handledPreferences.has(idea.id))continue;handledPreferences.add(idea.id);
        for(const preference of analysis.intents.filter(i=>i.kind==='preference'&&i.data?.canApply!==false&&linkIdea(i)?.id===idea.id))Object.assign(data,preference.data);
        idea.preferences={...(idea.preferences||{}),...data};context.lastIdeaId=idea.id;note.ideaIds.push(idea.id);note.agents.push(2);mutated=true;
        if(data.pause)replies.push('先把这个喜欢放一放，原记录和收获都留着。已有时间安排暂未改动，想改时间也可以接着说。');
        const preferencesChanged=[data.energy?'精力':null,data.level?'基础':null,data.duration?'想试的时长':null,data.goal?'目标':null].filter(Boolean);
        if(preferencesChanged.length)replies.push('记住了你的'+preferencesChanged.join('和')+'，安排时会一起考虑。');
        const task=state.tasks.find(t=>t.id===context.lastTaskId&&t.ideaId===idea.id&&t.status==='accepted'&&(t.date>options.today||t.date===options.today&&minute(t.start)>=options.clockMinutes));
        const hasSchedule=analysis.intents.some(i=>i.kind==='schedule'&&(i.ideaId===idea.id||mapped.get(i.newIdeaKey)===idea.id));
        if(task&&!hasSchedule&&(data.energy||data.duration||data.level||data.goal)){
          const duration=Number(data.duration||task.duration),prepared=learningTask(state,idea,{...idea.preferences,date:task.date,start:task.start,end:clock(minute(task.start)+duration),duration},task,options);
          if(prepared.task){state.tasks[state.tasks.indexOf(task)]=prepared.task;note.taskIds.push(task.id);replies.push('顺手把还没开始的小行动调成 '+prepared.task.start+'–'+prepared.task.end+'，'+prepared.task.duration+' 分钟。');note.links.push({view:'plan',label:'时间安排已一起调整',ideaId:idea.id,taskId:task.id});}
          else replies.push('现有小行动暂未改动：'+prepared.error);
        }
      }else if(intent.kind==='schedule'){
        const idea=linkIdea(intent);if(!idea){clarification=clarification||'这段时间是想留给哪个喜欢？直接说名字就好。';continue;}
        context.lastIdeaId=idea.id;note.ideaIds.push(idea.id);note.agents.push(idea.type==='creative'?3:2);
        if(data.canApply===false){clarification=clarification||data.notice||'这段时间还没听清，你想安排到哪一天、几点？';context.pending={kind:'schedule',ideaId:idea.id,...data,question:clarification};continue;}
        const replacement=data.replaceTaskId||intent.taskId;
        const existing=replacement&&state.tasks.find(t=>t.id===replacement&&t.ideaId===idea.id&&t.status==='accepted');
        const prepared=learningTask(state,idea,data,existing,options);
        if(prepared.error){clarification=prepared.error;context.pending={intent:{...clone(intent),ideaId:idea.id,newIdeaKey:undefined,data:{...data,replaceTaskId:existing?.id}},field:'start',question:clarification};emotion='thinking';continue;}
        if(existing)state.tasks[state.tasks.indexOf(existing)]=prepared.task;else state.tasks.push(prepared.task);
        if(idea.type==='creative')idea.exploration=prepared.result;
        idea.preferences={...(idea.preferences||{}),...data};context.lastTaskId=prepared.task.id;context.pending=null;note.taskIds.push(prepared.task.id);mutated=true;
        replies.push((data.rolledToTomorrow?'今天这个点已过，按下一次这个时间记到明天。':'')+(existing?'已调整':'已安排')+'“'+idea.title+'”：'+prepared.task.date+' '+prepared.task.start+'–'+prepared.task.end+'，'+prepared.task.duration+' 分钟。'+(prepared.task.duration!==Number(data.duration||10)?'结合精力和上次反馈，这次先缩小一点。':'先从小小一段开始。'));
        note.links.push({view:'plan',label:'已放到时间安排',taskId:prepared.task.id,ideaId:idea.id});
      }else if(intent.kind==='busy'){
        note.agents.push(2);if(data.canApply===false||!data.date||!Number.isFinite(minute(data.start))||minute(data.end)<=minute(data.start)){clarification=clarification||'你这段没空的时间是几点到几点？';continue;}
        const slots=state.availability[data.date]||[];if(!slots.some(s=>s.start===data.start&&s.end===data.end))state.availability[data.date]=[...slots,{start:data.start,end:data.end,label:String(data.label||text).slice(0,100),origin:'ramble'}];mutated=true;
        replies.push('记住了：'+data.date+' '+data.start+'–'+data.end+'没空，安排员会绕开。');
        const conflict=state.tasks.find(t=>t.date===data.date&&t.status==='accepted'&&minute(t.start)<minute(data.end)&&minute(t.end)>minute(data.start));
        if(conflict){context.lastIdeaId=conflict.ideaId;context.lastTaskId=conflict.id;context.pending={intent:{index:0,kind:'schedule',agents:['Agent 2'],original:text,ideaId:conflict.ideaId,data:{date:conflict.date,start:conflict.start,duration:conflict.duration,dateExplicit:true,replaceTaskId:conflict.id}},field:'start',question:'“'+conflict.title+'”刚好撞上这段安排，要改到几点？'};clarification=context.pending.question;replies.push('之前的小行动暂未移动。');}
      }else if(intent.kind==='feedback'){
        note.agents.push(4);let task=state.tasks.find(t=>t.id===intent.taskId&&t.status==='accepted');
        if(!task){clarification=clarification||'你说的是哪个小行动？告诉我它的名字就好。';context.pending={kind:'feedback',data,question:clarification};continue;}
        const reported=data.completion||'partial',spent=reported==='skipped'?0:Math.max(0,Math.min(480,Number(data.minutes??(reported==='done'?task.duration:0))));
        const result=global.SparkEngine.reflect({task,completion:reported,minutes:spent,feeling:data.feeling||'right',reason:data.reason||text,nextAvailable:data.nextAvailable});
        const feedback={id:uid(),ideaId:task.ideaId,taskId:task.id,taskTitle:task.title,createdAt:options.now,completion:reported,minutes:spent,feeling:data.feeling||'right',reason:data.reason||text,nextAvailable:data.nextAvailable||'',summary:result.summary,response:result.response,nextAdjustment:result.nextAdjustment,origin:'ramble'};
        state.feedback.push(feedback);task.status=reported;context.lastIdeaId=task.ideaId;context.lastTaskId=task.id;context.pending=null;note.ideaIds.push(task.ideaId);note.taskIds.push(task.id);emotion=result.emotion;mutated=true;
        replies.push(result.response+' 下一次：'+result.nextAdjustment.advice);note.links.push({view:'feedback',label:'已留下成长反馈',taskId:task.id,ideaId:task.ideaId});
      }else if(intent.kind==='explore'){
        const idea=linkIdea(intent);if(!idea)continue;idea.exploration=global.SparkEngine.exploreIdea({idea:idea.text+'。补充：'+text,timeBudget:idea.preferences?.duration||10,resources:data.resources||'',feedback:latest(state,idea.id)});note.agents.push(3);note.ideaIds.push(idea.id);mutated=true;replies.push('继续想一想：'+String(idea.exploration.firstStep?.title||idea.exploration.firstStep));note.links.push({view:'lab',label:'探索路径已更新',ideaId:idea.id});
      }
    }
    if(analysis.clarification?.pending){context.pending=clone(analysis.clarification.pending);const intent=context.pending.intent;if(intent.newIdeaKey&&mapped.has(intent.newIdeaKey)){intent.ideaId=mapped.get(intent.newIdeaKey);delete intent.newIdeaKey;}}
    if(clarification){note.clarification=clarification;replies.push(clarification);if(!context.pending)context.pending={kind:'note',question:clarification};emotion='thinking';}
    else {context.pending=null;if(!replies.length)replies.push('这句碎碎念也收好了。你可以接着说想学什么、什么时候有空，或今天的小进展。');}
    note.reply=replies.join('\n\n');note.agents=[...new Set(note.agents)].sort();note.ideaIds=[...new Set(note.ideaIds)];note.taskIds=[...new Set(note.taskIds)];note.emotion=emotion;note.changed=mutated;
    state.notes.push(note);if(state.notes.length>2000)state.notes.splice(0,state.notes.length-2000);undoEntry={id:note.id,before,after:domain(state)};return note;
  }
  function canUndo(id,state){return undoEntry?.id===id&&(!state||JSON.stringify(domain(state))===JSON.stringify(undoEntry.after));}
  function undo(state,id){if(!canUndo(id,state)){undoEntry=null;return false;}Object.assign(state,clone(undoEntry.before));const note=state.notes.find(n=>n.id===id);if(note){note.undone=true;note.changed=false;note.reply='这句原话还在口袋里。刚才的自动改动已经撤销，可以重新说一个安排。';note.links=[];note.clarification=null;}undoEntry=null;return true;}
  function checkpoint(state,id){if(undoEntry?.id===id)undoEntry.after=domain(state);}
  global.PocketFlow=Object.freeze({submit,normalize,undo,canUndo,checkpoint});
})(window);
