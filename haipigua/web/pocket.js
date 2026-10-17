(function(global){
  'use strict';
  let undoEntry=null;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const uid=()=>global.crypto?.randomUUID?.()||'pipi-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const minute=time=>{if(!/^\d{2}:\d{2}$/.test(time||''))return NaN;const [h,m]=time.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;};
  const clock=value=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const safeKey=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
  const validDate=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;const d=new Date(value+'T12:00:00+08:00');return Number.isFinite(+d)&&new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)===value;};
  function sentence(value,label,max=1500){if(typeof value!=='string'||!value.trim())throw Error('模型'+label+'不完整，记录尚未改动。');return value.trim().slice(0,max);}
  // Treat the provider response as untrusted structured input. A failed model turn
  // is never reparsed with local templates under a misleading “model” label.
  function validateAnalysis(raw,state){
    if(!object(raw)||!Array.isArray(raw.intents)||raw.intents.length>12)throw Error('模型意图格式不完整，记录尚未改动。');
    const kinds=['idea','plan','preference','schedule','busy','feedback','explore','note'],newKeys=new Set(),feedbackTasks=new Set();
    const intents=raw.intents.map(i=>{
      if(!object(i)||!kinds.includes(i.kind)||!object(i.data)||(i.agents!==undefined&&!Array.isArray(i.agents)))throw Error('模型返回了不支持的操作，记录尚未改动。');
      const out={kind:i.kind,agents:(i.agents||[]).filter(a=>/^Agent [1-4]$/.test(a)),data:{}};
      for(const k of ['ideaId','taskId','newIdeaKey'])if(i[k]!==undefined){if(!safeKey(i[k]))throw Error('模型引用无效，记录尚未改动。');out[k]=i[k];}
      if(out.ideaId&&!state.ideas.some(x=>x.id===out.ideaId))throw Error('模型引用了不存在的兴趣，记录尚未改动。');
      if(out.taskId&&!state.tasks.some(x=>x.id===out.taskId))throw Error('模型引用了不存在的任务，记录尚未改动。');
      if(out.taskId&&out.ideaId&&state.tasks.find(x=>x.id===out.taskId).ideaId!==out.ideaId)throw Error('任务和兴趣不一致，记录尚未改动。');
      if(out.taskId&&out.newIdeaKey)throw Error('已有任务不能归到尚未创建的新兴趣，记录尚未改动。');
      if(i.kind==='idea'){if(!out.newIdeaKey||newKeys.has(out.newIdeaKey)||out.ideaId)throw Error('新兴趣交接不完整，记录尚未改动。');newKeys.add(out.newIdeaKey);}
      else if(out.newIdeaKey&&!newKeys.has(out.newIdeaKey))throw Error('新兴趣应先记录再交接，记录尚未改动。');
      const data=i.data;
      if(i.kind==='plan'&&(out.taskId||['date','start','end','replaceTaskId'].some(k=>data[k]!==undefined)))throw Error('行动建议不能附带预约或改期操作，记录尚未改动。');
      for(const k of ['text','title','type','date','start','end','energy','level','goal','completion','feeling','reason','nextAvailable','resources','replaceTaskId','label','notice'])if(data[k]!==undefined){if(typeof data[k]!=='string')throw Error('模型字段类型不正确，记录尚未改动。');out.data[k]=data[k].slice(0,k==='text'?8000:k==='reason'?2000:500);}
      for(const [k,allowed] of Object.entries({type:['skill','creative','park'],energy:['low','medium','high'],level:['beginner','some','advanced'],completion:['done','partial','skipped'],feeling:['easy','right','hard']}))if(out.data[k]!==undefined&&!allowed.includes(out.data[k]))throw Error('模型选项不正确，记录尚未改动。');
      for(const k of ['duration','minutes'])if(data[k]!==undefined){if(!Number.isInteger(data[k])||data[k]<(k==='duration'?3:0)||data[k]>(k==='duration'?120:480))throw Error('模型时长不合法，记录尚未改动。');out.data[k]=data[k];}
      if(data.canApply!==undefined&&typeof data.canApply!=='boolean')throw Error('模型操作确认标记不正确。');
      if(data.pause!==undefined){if(typeof data.pause!=='boolean')throw Error('模型暂停标记不正确。');out.data.pause=data.pause;}
      out.data.canApply=data.canApply!==false;
      if(out.data.date!==undefined&&!validDate(out.data.date))throw Error('模型日期不合法，记录尚未改动。');
      for(const k of ['start','end'])if(out.data[k]!==undefined&&!Number.isFinite(minute(out.data[k])))throw Error('模型时间不合法，记录尚未改动。');
      if(out.data.end!==undefined&&out.data.start!==undefined&&minute(out.data.end)<=minute(out.data.start))throw Error('结束时间应晚于开始时间，记录尚未改动。');
      const replacement=out.data.replaceTaskId;
      if(replacement&&(!safeKey(replacement)||!state.tasks.some(t=>t.id===replacement&&t.status==='accepted'&&(!out.ideaId||t.ideaId===out.ideaId))))throw Error('模型改期目标无效，记录尚未改动。');
      if(replacement&&out.newIdeaKey)throw Error('已有任务不能改期到新的兴趣，记录尚未改动。');
      if(out.data.canApply){
        if(i.kind==='idea'&&(!out.data.text?.trim()||!out.data.type))throw Error('模型兴趣记录不完整。');
        if(['plan','preference','schedule','explore'].includes(i.kind)&&!out.ideaId&&!out.newIdeaKey)throw Error('模型未说明要交接哪个兴趣。');
        if(['schedule','busy'].includes(i.kind)&&(!out.data.date||!out.data.start))throw Error('模型未给出完整日期与时间，记录尚未改动。');
        if(i.kind==='busy'&&!out.data.end)throw Error('模型未给出忙碌时段的结束时间。');
        if(i.kind==='feedback'&&(!out.taskId||!out.data.completion||!state.tasks.some(t=>t.id===out.taskId&&t.status==='accepted')))throw Error('模型反馈目标无效或已经反馈，记录尚未改动。');
        if(i.kind==='feedback'){if(feedbackTasks.has(out.taskId))throw Error('同一轮不能重复写入同一行动的反馈。');feedbackTasks.add(out.taskId);}
      }
      return out;
    });
    if(raw.clarification!==undefined&&!object(raw.clarification))throw Error('模型追问格式不正确。');
    let understanding;
    if(raw.understanding!==undefined){
      const value=raw.understanding;if(!object(value))throw Error('模型理解摘要格式不正确。');
      const evidenceList=(items,label)=>{if(items===undefined)return [];if(!Array.isArray(items))throw Error('模型'+label+'格式不正确。');return items.slice(0,5).map(item=>({text:sentence(item?.text,label,500),evidence:sentence(item?.evidence,'原话证据',600)}));};
      if(value.unknowns!==undefined&&!Array.isArray(value.unknowns))throw Error('模型待确认信息格式不正确。');
      understanding={goal:typeof value.goal==='string'?value.goal.slice(0,600):'',...(typeof value.acknowledgement==='string' && value.acknowledgement ? {acknowledgement:value.acknowledgement.slice(0,300)} : {}),facts:evidenceList(value.facts,'已知信息'),constraints:evidenceList(value.constraints,'限制条件'),unknowns:(value.unknowns||[]).slice(0,5).map(item=>sentence(item,'待确认信息',500))};
    }
    return {intents,...(raw.clarification?.question?{clarification:{question:sentence(raw.clarification.question,'追问',500)}}:{}),...(understanding?{understanding}:{})};
  }
  function safeResources(value){
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>30)throw Error('模型资料格式不完整。');
    return value.map(r=>{if(!object(r)||typeof r.url!=='string'||!/^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/.test(r.url))throw Error('模型资料链接不合法，记录尚未改动。');return {label:sentence(r.label||r.title,'资料名称',100),url:r.url.slice(0,1500),type:typeof r.type==='string'?r.type:'reference',source:typeof r.source==='string'?r.source:'curated',...(typeof r.checkedAt==='string'?{checkedAt:r.checkedAt}:{}),...(typeof r.description==='string'?{description:r.description.slice(0,1000)}:{})};}).slice(0,6);
  }
  function safePlan(value){
    if(!object(value)||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>4)throw Error('模型计划缺少具体步骤，记录尚未改动。');
    return {source:'model',title:sentence(value.title,'计划标题',150),steps:value.steps.map(s=>({title:sentence(s?.title,'步骤标题',150),description:sentence(s?.description,'步骤说明')})),successCriterion:sentence(value.successCriterion,'完成标准',600),rationale:sentence(value.rationale,'计划依据',1000),nextStep:sentence(value.nextStep,'下一步',600),resources:safeResources(value.resources),...(Array.isArray(value.references)?{references:clone(value.references)}:{})};
  }
  function modelReflection(value){
    const a=value?.nextAdjustment;
    if(!object(value)||!object(a)||!Number.isFinite(a.durationScale)||a.durationScale<.25||a.durationScale>1.5||!['same','easier','slightly-harder'].includes(a.difficulty)||!['happy','sorry','proud','thinking'].includes(value.emotion))throw Error('模型反馈调整不完整，记录尚未改动。');
    return {source:'model',response:sentence(value.response,'反馈回应',2000),summary:sentence(value.summary,'反馈摘要',1000),emotion:value.emotion,nextAdjustment:{durationScale:a.durationScale,difficulty:a.difficulty,advice:sentence(a.advice,'调整依据'),nextStep:sentence(a.nextStep,'反馈下一步',1000)}};
  }
  function safeExploration(value){
    if(!object(value)||!Array.isArray(value.paths)||!value.paths.length||value.paths.length>4||!Number.isInteger(value.timeBudget)||value.timeBudget<3||value.timeBudget>120)throw Error('模型创意实验不完整，记录尚未改动。');
    const strings=(items,label)=>{if(items===undefined)return [];if(!Array.isArray(items)||items.length>6)throw Error('模型'+label+'格式不完整。');return items.map(s=>sentence(s,label,600));};
    return {source:'model',title:sentence(value.title,'实验标题',150),assumptions:strings(value.assumptions,'待验证假设'),paths:value.paths.map(s=>({title:sentence(s?.title,'实验路径',150),description:sentence(s?.description,'实验说明')})),firstStep:{title:sentence(value.firstStep?.title,'第一步标题',150),description:sentence(value.firstStep?.description,'第一步说明')},successSignal:sentence(value.successSignal,'观察信号',1000),questions:strings(value.questions,'创意追问'),timeBudget:value.timeBudget,searchLinks:safeResources(value.searchLinks),feedbackApplied:value.feedbackApplied===true};
  }
  function validateContent(raw,state,analysis){
    if(raw!==undefined&&!object(raw))throw Error('模型协作结果格式不正确。');
    const result={plans:Object.create(null),explorations:Object.create(null),reflections:Object.create(null)};
    const keys=new Set([...state.ideas.map(i=>i.id),...analysis.intents.filter(i=>i.kind==='idea').map(i=>i.newIdeaKey)]);
    for(const [kind,validate] of [['plans',safePlan],['explorations',safeExploration],['reflections',modelReflection]]){
      const values=raw?.[kind];if(values===undefined)continue;
      if(!object(values)||Object.keys(values).length>12)throw Error('模型协作结果格式不正确。');
      for(const [key,value] of Object.entries(values)){if(!safeKey(key)||(kind==='reflections'?!state.tasks.some(t=>t.id===key):!keys.has(key)))throw Error('模型协作引用无效，记录尚未改动。');result[kind][key]=validate(value);}
    }
    return result;
  }
  function contentFor(options,kind,intent,idea){
    const item=options.content?.[kind]?.[intent.newIdeaKey]||options.content?.[kind]?.[idea?.id];
    if(options.analysis&&!item)throw Error('模型'+({plans:'计划',explorations:'创意实验',reflections:'反馈'}[kind])+'缺失，记录尚未改动。请重试本次对话。');
    return item;
  }
  const domain=state=>clone({ideas:state.ideas,tasks:state.tasks,feedback:state.feedback,availability:state.availability||{},chatContext:state.chatContext||{}});
  function normalize(state){state.notes=Array.isArray(state.notes)?state.notes:[];state.chatContext=state.chatContext&&typeof state.chatContext==='object'?state.chatContext:{};state.availability=state.availability||{};if(!state.ideas.some(i=>i.id===state.chatContext.lastIdeaId))state.chatContext.lastIdeaId=null;if(!state.tasks.some(t=>t.id===state.chatContext.lastTaskId))state.chatContext.lastTaskId=null;return state;}
  function latest(state,id){return [...state.feedback].reverse().find(f=>f.ideaId===id);}
  function collision(state,date,start,end,excludeId){return (state.availability[date]||[]).some(s=>start<minute(s.end)&&end>minute(s.start))||state.tasks.some(t=>t.id!==excludeId&&t.date===date&&t.status!=='skipped'&&start<minute(t.end)&&end>minute(t.start));}
  function learningTask(state,idea,data,existing,options){
    data={...(options.preferences||{}),...(idea.preferences||{}),...data};
    const start=minute(data.start),duration=Number(data.duration||idea.preferences?.duration||10),finish=data.end?minute(data.end):start+duration;
    if(!validDate(data.date)||!Number.isFinite(start)||!Number.isInteger(duration)||duration<3||duration>120||!Number.isFinite(finish)||finish<=start||finish>=1440)return {error:'这一小步需要完整的时间，几点开始、准备试几分钟？'};
    if(data.date<options.today||(data.date===options.today&&start<options.clockMinutes))return {error:'这个时间已经过去啦，你想安排到哪一天？'};
    if(options.analysis){
      const plan=idea.type==='creative'?idea.exploration:idea.aiPlan;
      if(!plan||plan.source!=='model')throw Error('模型行动内容缺失，记录尚未改动。');
      const adjustment=existing?null:latest(state,idea.id)?.nextAdjustment;
      const scale=Number.isFinite(adjustment?.durationScale)?adjustment.durationScale:1;
      const amount=Math.min(finish-start,Math.max(3,Math.round(duration*scale)),{low:10,medium:20,high:40}[data.energy||'medium'],idea.type==='creative'?plan.timeBudget:120);
      if(amount<3)return {error:'这段时间不够，要不要换一段至少三分钟的空闲？'};
      if(collision(state,data.date,start,start+amount,existing?.id))return {error:'这个时间与你已有的安排撞上了，换到几点比较合适？'};
      const pieces=idea.type==='creative'?[plan.firstStep]:amount<8?[{title:plan.title,description:plan.steps.map(s=>s.title+'：'+s.description).join('\n')}]:plan.steps;
      let cursor=start;const steps=pieces.map((piece,index)=>{const part=index===pieces.length-1?amount-Math.floor(amount/pieces.length)*index:Math.floor(amount/pieces.length),begin=cursor;cursor+=part;return {title:piece.title,description:piece.description,start:clock(begin),end:clock(cursor),date:data.date,duration:part,resources:idea.type==='creative'?plan.searchLinks:plan.resources,successCriterion:plan.successCriterion||plan.successSignal};});
      return {result:plan,task:{id:existing?.id||uid(),ideaId:idea.id,date:data.date,start:clock(start),end:clock(start+amount),duration:amount,title:plan.title,description:steps.map(s=>s.title+'：'+s.description).join('\n'),steps,resources:idea.type==='creative'?plan.searchLinks:plan.resources,successCriterion:plan.successCriterion||plan.successSignal,planningSource:'model',rationale:plan.rationale||'',nextStep:plan.nextStep||plan.firstStep.description,kind:idea.type==='creative'?'experiment':'learning',status:'accepted',createdAt:existing?.createdAt||options.now,origin:'ramble'}};
    }
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
  function applyTurn(text,state,options){
    normalize(state);text=String(text||'').trim().slice(0,8000);if(!text)return null;
    options={now:new Date().toISOString(),...options};const before=domain(state),context=state.chatContext;
    let input=text;
    // A short answer can complete a previous scheduling question without re-creating the idea.
    const pending=context.pending;
    if(pending?.kind==='schedule'&&pending.start&&!/\d{1,2}[:：点时]|[一二三四五六七八九十两]+点/.test(text)&&/今天|明天|后天|\d{1,2}月\d{1,2}/.test(text))input=text+' '+pending.start+'开始，试'+(pending.duration||10)+'分钟';
    const routerContext={ideas:state.ideas,tasks:state.tasks,availability:state.availability,lastIdeaId:context.lastIdeaId,lastTaskId:context.lastTaskId,now:options.now,pending,defaultPreferences:options.preferences};
    const fresh=!options.analysis&&pending?global.RambleRouter.analyze(text,{...routerContext,pending:undefined}):null;
    const analysis=options.analysis||(fresh?.intents.some(i=>i.kind==='idea'&&i.data.canApply!==false)?fresh:global.RambleRouter.analyze(input,routerContext));
    const currentIdea=state.ideas.find(i=>i.id===context.lastIdeaId);
    if(!options.analysis&&currentIdea?.type==='creative'&&/能不能|行不行|可行|怎么办|渠道|路径|方法|细节|先问|先找|要不/.test(text)&&analysis.intents.every(i=>i.kind==='note'))analysis.intents.push({kind:'explore',ideaId:currentIdea.id,agents:['Agent 3'],data:{canApply:true}});
    const note={id:uid(),text,createdAt:options.now,reply:'',agents:[1],ideaIds:[],taskIds:[],links:[],source:options.analysis?'model':'local-demo',...(options.analysis?{trace:clone(options.trace||[]),...(analysis.understanding?{understanding:clone(analysis.understanding)}:{}),...(options.usage?{usage:clone(options.usage)}:{}),...(options.requestId?{requestId:String(options.requestId).slice(0,150)}:{})}:{})};
    const replies=[],mapped=new Map(),handledPreferences=new Set();let clarification=analysis.clarification?.question||null,emotion='proud',mutated=false;
    const keepPending=analysis.intents.some(i=>i.kind==='plan')&&!analysis.intents.some(i=>['schedule','busy','feedback'].includes(i.kind)&&i.data.canApply!==false);
    function linkIdea(intent){return state.ideas.find(i=>i.id===(intent.ideaId||mapped.get(intent.newIdeaKey)||context.lastIdeaId));}
    function saveAdvice(idea,kind,value){
      if(!options.analysis)return;
      note.advice=note.advice||[];
      const snapshot={ideaId:idea.id,kind,value:clone(value)},index=note.advice.findIndex(a=>a.ideaId===idea.id&&a.kind===kind);
      if(index<0)note.advice.push(snapshot);else note.advice[index]=snapshot;
    }
    for(const intent of analysis.intents||[]){
      const data={...(intent.data||{})};note.agents.push(...(intent.agents||[]).map(a=>Number(String(a).replace(/\D/g,''))).filter(n=>n>=1&&n<=4));
      if(data.canApply===false)continue;
      if(intent.kind==='idea'){
        const raw=data.text||intent.original||text,classed=options.analysis?{title:data.title||raw,type:data.type}:global.SparkEngine.classifyIdea(raw,data.type||'auto');
        const item={id:uid(),text:raw.slice(0,2000),title:String(data.title||classed.title||raw).slice(0,80),type:data.type||classed.type||'park',createdAt:options.now,archived:false,preferences:{...(options.preferences||{}),...Object.fromEntries(['energy','level','duration','goal'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]))}};
        if(options.analysis&&item.type==='skill'){item.aiPlan=contentFor(options,'plans',intent,item);saveAdvice(item,'plan',item.aiPlan);}
        state.ideas.unshift(item);mapped.set(intent.newIdeaKey||data.newIdeaKey||'new-0',item.id);context.lastIdeaId=item.id;context.lastTaskId=null;note.ideaIds.push(item.id);mutated=true;
        replies.push('收下“'+item.title+'”啦。'+(item.type==='skill'?'学习安排员已经接住了，接着说你什么时候有空就好。':item.type==='creative'?'创意探索员来帮你找一个能试的小入口。':'先替你好好收着，想行动的时候继续说。'));
        if(item.type==='creative'){item.exploration=options.analysis?contentFor(options,'explorations',intent,item):global.SparkEngine.exploreIdea({idea:item.text,timeBudget:10});saveAdvice(item,'exploration',item.exploration);replies.push('可以先试：'+String(item.exploration.firstStep?.title||item.exploration.firstStep));note.links.push({view:'lab',label:'已送到创意实验室',ideaId:item.id});note.agents.push(3);}else if(item.type==='skill'){note.agents.push(2);if(item.aiPlan)replies.push('下一小步：'+item.aiPlan.title+'。'+item.aiPlan.steps.map(s=>s.title+'：'+s.description).join(' '));}
      }else if(intent.kind==='plan'){
        const idea=linkIdea(intent);if(!idea)continue;
        if(!options.analysis)throw Error('本次行动建议需要完整的模型结果，记录尚未改动。');
        const creative=idea.type==='creative',value=contentFor(options,creative?'explorations':'plans',intent,idea);
        if(creative)idea.exploration=value;else idea.aiPlan=value;
        saveAdvice(idea,creative?'exploration':'plan',value);context.lastIdeaId=idea.id;note.ideaIds.push(idea.id);note.agents.push(creative?3:2);mutated=true;
        replies.push('已更新“'+idea.title+'”的本次建议：'+(creative?value.firstStep.title+'：'+value.firstStep.description:value.title+'。'+value.steps.map(s=>s.title+'：'+s.description).join(' '))+'。这次只更新建议，没有预约时间。');
      }else if(intent.kind==='preference'){
        const idea=linkIdea(intent);if(!idea||handledPreferences.has(idea.id))continue;handledPreferences.add(idea.id);
        if(options.analysis&&idea.type!=='creative'){idea.aiPlan=contentFor(options,'plans',intent,idea);saveAdvice(idea,'plan',idea.aiPlan);}
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
        if(options.analysis){if(idea.type==='creative')idea.exploration=contentFor(options,'explorations',intent,idea);else idea.aiPlan=contentFor(options,'plans',intent,idea);}
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
        const result=options.analysis?contentFor(options,'reflections',{...intent,newIdeaKey:task.id},{id:task.id}):global.SparkEngine.reflect({task,completion:reported,minutes:spent,feeling:data.feeling||'right',reason:data.reason||text,nextAvailable:data.nextAvailable});
        const feedback={id:uid(),ideaId:task.ideaId,taskId:task.id,taskTitle:task.title,createdAt:options.now,completion:reported,minutes:spent,feeling:data.feeling||'right',reason:data.reason||text,nextAvailable:data.nextAvailable||'',summary:result.summary,response:result.response,nextAdjustment:result.nextAdjustment,origin:'ramble'};
        feedback.source=options.analysis?'model':'local-demo';feedback.nextStep=result.nextAdjustment.nextStep||'';
        note.beforeAfter={before:{title:task.title,start:task.start,end:task.end,duration:task.duration},actual:{completion:reported,minutes:spent,feeling:data.feeling||'right',reason:data.reason||text},after:{advice:result.nextAdjustment.advice,duration:Math.max(3,Math.round(task.duration*result.nextAdjustment.durationScale)),difficulty:result.nextAdjustment.difficulty,nextStep:result.nextAdjustment.nextStep||''}};
        state.feedback.push(feedback);task.status=reported;context.lastIdeaId=task.ideaId;context.lastTaskId=task.id;context.pending=null;note.ideaIds.push(task.ideaId);note.taskIds.push(task.id);emotion=result.emotion;mutated=true;
        replies.push(result.response+' 下一次：'+result.nextAdjustment.advice);note.links.push({view:'feedback',label:'已留下成长反馈',taskId:task.id,ideaId:task.ideaId});
      }else if(intent.kind==='explore'){
        const idea=linkIdea(intent);if(!idea)continue;idea.exploration=options.analysis?contentFor(options,'explorations',intent,idea):global.SparkEngine.exploreIdea({idea:idea.text+'。补充：'+text,timeBudget:idea.preferences?.duration||10,resources:data.resources||'',feedback:latest(state,idea.id)});saveAdvice(idea,'exploration',idea.exploration);note.agents.push(3);note.ideaIds.push(idea.id);mutated=true;replies.push('继续想一想：'+String(idea.exploration.firstStep?.title||idea.exploration.firstStep));note.links.push({view:'lab',label:'探索路径已更新',ideaId:idea.id});
      }
    }
    if(analysis.clarification?.pending){context.pending=clone(analysis.clarification.pending);const intent=context.pending.intent;if(intent.newIdeaKey&&mapped.has(intent.newIdeaKey)){intent.ideaId=mapped.get(intent.newIdeaKey);delete intent.newIdeaKey;}}
    if(clarification){note.clarification=clarification;replies.push(clarification);if(!context.pending)context.pending={kind:'note',question:clarification};emotion='thinking';}
    else {if(!keepPending)context.pending=null;if(!replies.length)replies.push('这句碎碎念也收好了。你可以接着说想学什么、什么时候有空，或今天的小进展。');}
    note.reply=replies.join('\n\n');note.agents=[...new Set(note.agents)].sort();note.ideaIds=[...new Set(note.ideaIds)];note.taskIds=[...new Set(note.taskIds)];note.emotion=emotion;note.changed=mutated;
    if(options.analysis){
      const after=domain(state),addTrace=(agent,tool,detail,status='success')=>note.trace.push({agent,kind:'tool',tool,action:detail,status,at:options.now,durationMs:0,source:'local-state'});
      if(JSON.stringify(before.ideas)!==JSON.stringify(after.ideas))addTrace('Agent 1','save_idea','已保存兴趣与本次模型计划');
      if(JSON.stringify(before.availability)!==JSON.stringify(after.availability))addTrace('Agent 2','save_busy_slots','已保存忙碌时段');
      if(analysis.intents.some(i=>i.kind==='schedule'&&i.data.canApply))addTrace('Agent 2','check_availability','已实际校验日期、时长、精力与本地时间冲突',note.taskIds.length?'success':'needs_clarification');
      if(JSON.stringify(before.tasks)!==JSON.stringify(after.tasks))addTrace('Agent 2','save_task','已写入或更新本地行动');
      if(JSON.stringify(before.feedback)!==JSON.stringify(after.feedback))addTrace('Agent 4','save_feedback','已保存实际反馈与模型调整依据');
    }
    state.notes.push(note);if(state.notes.length>2000)state.notes.splice(0,state.notes.length-2000);undoEntry={id:note.id,before,after:domain(state)};return note;
  }
  function submit(text,state,options){
    if(!options||!Object.prototype.hasOwnProperty.call(options,'analysis'))return applyTurn(text,state,options);
    // Validate and apply on a private snapshot. Even a late missing specialist
    // response or a mismatched reference cannot leave a half-written model turn.
    const analysis=validateAnalysis(options.analysis,state),content=validateContent(options.content,state,analysis);
    if(options.trace!==undefined&&(!Array.isArray(options.trace)||options.trace.length>100||options.trace.some(t=>!object(t))))throw Error('模型执行痕迹格式不正确，记录尚未改动。');
    const working=clone(state),previousUndo=undoEntry;
    try{
      const note=applyTurn(text,working,{...options,analysis,content});if(!note)return null;
      for(const key of ['ideas','tasks','feedback','availability','chatContext','notes'])state[key]=working[key];
      return note;
    }catch(error){undoEntry=previousUndo;throw error;}
  }
  function canUndo(id,state){return undoEntry?.id===id&&(!state||JSON.stringify(domain(state))===JSON.stringify(undoEntry.after));}
  function undo(state,id){if(!canUndo(id,state)){undoEntry=null;return false;}Object.assign(state,clone(undoEntry.before));const note=state.notes.find(n=>n.id===id);if(note){note.undone=true;note.changed=false;note.reply='这句原话还在口袋里。刚才的自动改动已经撤销，可以重新说一个安排。';note.links=[];note.clarification=null;}undoEntry=null;return true;}
  function checkpoint(state,id){if(undoEntry?.id===id)undoEntry.after=domain(state);}
  global.PocketFlow=Object.freeze({submit,normalize,undo,canUndo,checkpoint,validateAnalysis});
})(window);
