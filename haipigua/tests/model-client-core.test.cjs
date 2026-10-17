'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const NOW='2026-10-17T01:00:00.000Z',KEY='little-spark.v1';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  let serial=0;const values=new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const context={console,Date,Intl,crypto:{randomUUID:()=>`client-${++serial}`}};context.window=context;
  vm.createContext(context);
  for(const file of ['engine.js','ramble.js','pocket.js','studio-core.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../web',file),'utf8'),context,{filename:file});
  return {app:context.HaipiguaCore.create(storage,()=>new Date(NOW)),values,context,storage};
}
function plan(){return {title:'写一份实习作品清单',steps:[{title:'盘点已有经验',description:'写出本次比赛中亲自完成的三个具体动作。'}],successCriterion:'保留三条可追问、有证据的经历。',rationale:'已有比赛实践，先整理可讨论的材料。',nextStep:'为其中一个动作补充前后对比。'};}
function response(){return {source:'model',requestId:'mock-provider-turn',usage:{inputTokens:80,outputTokens:120},trace:[{agent:'Agent 1',kind:'model',model:'glm-4.7-flash',action:'理解原话',status:'ok',durationMs:10},{agent:'Agent 2',kind:'model',model:'glm-4.7-flash',action:'生成计划',status:'success',durationMs:14}],analysis:{intents:[{kind:'idea',newIdeaKey:'job',data:{text:'准备AI产品实习',title:'AI产品实习',type:'skill'}},{kind:'schedule',newIdeaKey:'job',data:{date:'2026-10-17',start:'15:00',duration:20}}]},content:{plans:{job:plan()}}};}
function appointment(app,text='我想学跳舞，今天下午三点练20分钟'){
  app.submit(text);assert.ok(app.state.tasks.length);return app.state.tasks.at(-1);
}
const reflection=()=>({response:'下次先做更小的一步。',summary:'只做了五分钟，感到难。',emotion:'thinking',nextAdjustment:{durationScale:.5,difficulty:'easier',advice:'先缩成十分钟，只做一个动作。',nextStep:'重复一个基础动作并记下卡点。'}});

test('submitModel forwards a bounded context and applies a successful real-model task and trace',async()=>{
  const {app,values}=fixture();let received;
  const note=await app.submitModel('我想准备AI产品实习，今天下午三点试20分钟',async payload=>{received=copy(payload);return response();});
  assert.equal(received.now,NOW);assert.equal(received.today,'2026-10-17');assert.equal(received.clockMinutes,540);assert.equal(received.mode,'gentle');assert.ok(received.requestId);
  assert.equal(note.source,'model');assert.equal(note.requestId,'mock-provider-turn');assert.equal(note.usage.outputTokens,120);
  assert.equal(note.trace.filter(t=>t.kind==='model').length,2);assert.ok(note.trace.some(t=>t.tool==='save_task'));
  assert.equal(app.state.tasks.length,1);assert.equal(app.state.tasks[0].planningSource,'model');assert.match(app.state.tasks[0].description,/亲自完成的三个具体动作/);
  assert.equal(app.state.tasks[0].contract.mode,'gentle');assert.equal(JSON.parse(values.get(KEY)).notes[0].source,'model');
});

test('request failure and unverified source/trace leave state and storage atomically unchanged',async()=>{
  const {app,values}=fixture();app.fact('应用物理学大四，已保研');
  const before=app.exportData(),stored=values.get(KEY);
  await assert.rejects(app.submitModel('帮我准备实习',async()=>{throw Error('mock network unavailable');}),/mock network unavailable/);
  assert.equal(app.exportData(),before);assert.equal(values.get(KEY),stored);
  for(const invalid of [{...response(),source:'local-demo'},{...response(),trace:[]},{...response(),trace:[{kind:'model',status:'error'}]}]){
    await assert.rejects(app.submitModel('帮我准备实习',async()=>invalid),/模型结果/);
    assert.equal(app.exportData(),before);assert.equal(values.get(KEY),stored);
  }
});

test('a response that arrives after a local edit is rejected without losing the new edit',async()=>{
  const {app,values}=fixture();let finish;
  const pending=app.submitModel('准备实习',()=>new Promise(resolve=>{finish=resolve;}));
  app.fact('每周实验时间待确认');const edited=app.exportData(),stored=values.get(KEY);
  finish(response());await assert.rejects(pending,/等待期间记录发生了变化/);
  assert.equal(app.exportData(),edited);assert.equal(values.get(KEY),stored);assert.equal(app.state.ideas.length,0);assert.equal(app.state.studio.facts.length,1);
});

test('focused feedback cannot be reassigned to another valid task by the model',async()=>{
  const {app}=fixture(),selected=appointment(app),other=appointment(app,'我想学唱歌，今天晚上八点练十分钟');
  const before=app.exportData();let focusedContext;
  await assert.rejects(app.submitModel('只做了五分钟，有点难',async payload=>{
    focusedContext=copy(payload.context.chatContext);
    return {source:'model',trace:response().trace,analysis:{intents:[{kind:'feedback',ideaId:other.ideaId,taskId:other.id,data:{completion:'partial',minutes:5,feeling:'hard'}}]},content:{reflections:{[other.id]:reflection()}}};
  },selected.id),/关联的行动不一致/);
  assert.equal(focusedContext.lastTaskId,selected.id);assert.equal(focusedContext.lastIdeaId,selected.ideaId);
  assert.equal(app.exportData(),before);assert.equal(app.state.feedback.length,0);assert.equal(app.state.tasks.every(t=>t.status==='accepted'),true);
});

test('modelContext uses nested field whitelists, omits media and credentials, and keeps confirmed facts',()=>{
  const {app}=fixture(),task=appointment(app);
  app.feedback({taskId:task.id,completion:'partial',minutes:5,feeling:'hard',reason:'基础动作跟不上'});
  app.fact('我已经保研，希望找AI产品相关实习');
  const marker='SHOULD-NEVER-BE-IN-MODEL-CONTEXT';
  app.state.modelApiKey=marker;
  app.state.ideas[0].media={private:marker};app.state.ideas[0].preferences.MODEL_API_KEY=marker;
  app.state.tasks[0].media={private:marker};app.state.tasks[0].apiKey=marker;
  app.state.feedback[0].media={name:marker};app.state.feedback[0].attachment={name:marker};app.state.feedback[0].nextAdjustment.apiKey=marker;
  app.state.availability['2026-10-17']=[{start:'12:00',end:'13:00',label:'实验',media:{private:marker},apiKey:marker}];
  app.state.chatContext={lastIdeaId:task.ideaId,lastTaskId:task.id,apiKey:marker,pending:{kind:'schedule',question:'改到几点？',intent:{kind:'schedule',ideaId:task.ideaId,data:{date:'2026-10-18',start:'15:00',duration:10,media:marker}},media:marker}};
  app.state.studio.preference.apiKey=marker;
  const context=app.modelContext();
  assert.deepEqual(Object.keys(context).sort(),['ideas','tasks','feedback','reviews','notes','availability','chatContext','confirmedFacts','studio'].sort());
  assert.equal(context.confirmedFacts[0].text,'我已经保研，希望找AI产品相关实习');assert.equal(context.confirmedFacts[0].source,'user-confirmed');
  assert.equal(context.ideas[0].id,task.ideaId);assert.equal(context.feedback[0].taskId,task.id);
  assert.equal(JSON.stringify(context).includes(marker),false,'nested preferences, adjustments, busy slots and pending context must all be whitelisted');
});

test('modelContext is a detached snapshot that request code cannot use to mutate application state',()=>{
  const {app}=fixture(),task=appointment(app);
  app.feedback({taskId:task.id,completion:'partial',minutes:5,feeling:'hard',reason:'基础动作跟不上'});
  app.state.availability['2026-10-17']=[{start:'12:00',end:'13:00',label:'实验'}];
  app.state.chatContext.pending={kind:'schedule',question:'改到几点？',intent:{kind:'schedule',ideaId:task.ideaId,data:{date:'2026-10-18',start:'15:00',duration:10}}};
  const before=app.exportData(),context=app.modelContext();
  context.ideas[0].preferences.duration=30;context.feedback[0].nextAdjustment.advice='unexpected mutation';context.availability['2026-10-17'][0].start='11:00';context.chatContext.pending.intent.data.start='19:00';context.studio.preference.energy='low';
  assert.equal(app.exportData(),before,'model request context must not hold references to mutable state objects');
});

test('feedback form facts are sent explicitly and any model rewrite is rejected without changing saved records',async()=>{
  for(const patch of [{completion:'done'},{minutes:10},{feeling:'right'},{reason:'我已经全部学会了'}]){
    const {app,values}=fixture(),task=appointment(app),before=app.exportData(),stored=values.get(KEY);
    const expected={completion:'partial',minutes:4,feeling:'hard',reason:'跟不上拍子'};let payload;
    await assert.rejects(app.submitModel('这是表单生成的反馈',async p=>{
      payload=copy(p);
      return {source:'model',trace:response().trace,analysis:{intents:[{kind:'feedback',taskId:task.id,data:{canApply:true,...expected,...patch}}]},content:{reflections:{[task.id]:reflection()}}};
    },task.id,{expectedFeedback:expected}),/模型改动了你填写/);
    assert.deepEqual(payload.reportedFeedback,{taskId:task.id,...expected});
    assert.equal(app.exportData(),before);assert.equal(values.get(KEY),stored);
  }
});

test('a verified feedback form retains an explicitly empty reason and its model adjustment through save and undo',async()=>{
  const {app}=fixture(),task=appointment(app),before=app.exportData();
  const expected={completion:'partial',minutes:4,feeling:'hard',reason:''};
  const note=await app.submitModel('表单反馈：只做了四分钟',async()=>({source:'model',trace:response().trace,analysis:{intents:[{kind:'feedback',taskId:task.id,data:{canApply:true,...expected}},{kind:'review',ideaId:task.ideaId,taskId:task.id,data:{canApply:true}}]},content:{reflections:{[task.id]:reflection()},reviews:{[task.ideaId]:{response:'先缩小一步。',summary:'只做了四分钟。',progress:[{point:'试了四分钟',evidence:'四分钟'}],problems:[{point:'觉得难',evidence:'难'}],missingEvidence:['没有看到作品'],hasArtifact:false,needsEvidence:false,question:'',nextStep:'只做一个动作。',durationScale:.5,difficulty:'easier',emotion:'thinking',advice:'缩小一步。',taskId:task.id,minutes:4}}}}),task.id,{expectedFeedback:expected});
  assert.equal(app.state.feedback[0].reason,'');assert.equal(note.beforeAfter.actual.reason,'');
  assert.equal(app.state.feedback[0].nextAdjustment.durationScale,.5);
  assert.equal(app.undo(note.id),true);assert.equal(app.state.feedback.length,0);assert.equal(app.state.tasks[0].status,'accepted');
});

test('advice snapshots survive browser save and reload without changing existing task agreements or defaults',async()=>{
  const {app,context,storage}=fixture();
  app.setMode('strict',{accepted:true,bugs:true});
  await app.submitModel('准备实习，今天十五点试20分钟',async()=>response());
  const original=copy({tasks:app.state.tasks,preferences:app.state.ideas[0].preferences,studio:app.state.studio}),ideaId=app.state.ideas[0].id;
  app.state.chatContext.pending={field:'start',question:'旧行动改到几点？',intent:{kind:'schedule',ideaId,taskId:app.state.tasks[0].id,data:{date:'2026-10-17',start:'15:00',duration:20}}};
  const pending=copy(app.state.chatContext.pending);app.save();
  const revised={...plan(),title:'本次只写一张项目卡'};
  const note=await app.submitModel('只改建议，每次10分钟，不预约',async()=>({source:'model',trace:response().trace,analysis:{intents:[{kind:'plan',ideaId,data:{duration:10}}]},content:{plans:{[ideaId]:revised}}}));
  assert.deepEqual(copy({tasks:app.state.tasks,preferences:app.state.ideas[0].preferences,studio:app.state.studio}),original);
  assert.deepEqual(copy(app.state.chatContext.pending),pending);assert.equal(context.HaipiguaCore.validate(copy(app.state)),true);
  const reloaded=context.HaipiguaCore.create(storage,()=>new Date(NOW));
  assert.equal(reloaded.storageError,'');assert.equal(reloaded.state.notes.find(n=>n.id===note.id).advice[0].value.title,revised.title);
  assert.deepEqual(copy(reloaded.state.tasks),original.tasks);assert.deepEqual(copy(reloaded.state.chatContext.pending),pending);
  for(const corrupt of [backup=>{backup.notes.at(-1).advice[0].ideaId='missing';},backup=>{backup.notes.at(-1).advice[0].kind='schedule';},backup=>{backup.notes.at(-1).advice[0].value.steps=[];},backup=>{backup.notes.at(-1).advice[0].value.nextStep='';}]){
    const backup=copy(app.state);corrupt(backup);assert.equal(context.HaipiguaCore.validate(backup),false);
  }
});

test('modelContext includes bounded detached prior advice while omitting nested resources, media and secrets',()=>{
  const {app}=fixture(),task=appointment(app),marker='PRIVATE-ADVICE-METADATA';
  app.state.ideas[0].aiPlan={...plan(),steps:[{title:'旧步骤',description:'旧说明',media:marker}],resources:[{label:marker,url:marker}],references:[{secret:marker}],apiKey:marker};
  app.state.ideas.push({id:'creative-memory',text:'梦境展',title:'梦境展',type:'creative',preferences:{duration:10},exploration:{title:'原实验',assumptions:['待验证'],paths:[{title:'旧路径',description:'旧路径说明',media:marker}],firstStep:{title:'旧入口',description:'旧入口说明',apiKey:marker},successSignal:'留一张卡',questions:['还有什么未知？'],timeBudget:10,searchLinks:[{label:marker,url:marker}],media:marker}});
  const before=app.exportData(),context=app.modelContext(),learning=context.ideas.find(i=>i.id===task.ideaId),creative=context.ideas.find(i=>i.id==='creative-memory');
  assert.equal(learning.aiPlan.steps[0].description,'旧说明');assert.equal(creative.exploration.firstStep.title,'旧入口');
  assert.equal(JSON.stringify(context).includes(marker),false);
  assert.equal('resources' in learning.aiPlan,false);assert.equal('searchLinks' in creative.exploration,false);
  learning.aiPlan.steps[0].description='不能改本机';creative.exploration.firstStep.title='也不能改本机';creative.exploration.assumptions[0]='不能改数组';
  assert.equal(app.exportData(),before);
  app.state.ideas[0].aiPlan.steps=Array.from({length:9},()=>({title:'题'.repeat(250),description:'述'.repeat(1000)}));
  const bounded=app.modelContext().ideas.find(i=>i.id===task.ideaId).aiPlan;
  assert.equal(bounded.steps.length,4);assert.equal(bounded.steps[0].title.length,100);assert.equal(bounded.steps[0].description.length,600);
});

test('creative advice snapshots validate their concrete first step and time budget on import',async()=>{
  const {app,context,storage}=fixture();
  const exploration={title:'一张梦境卡',assumptions:['色块能表达感受，待验证'],paths:[{title:'画卡',description:'画三个色块'}],firstStep:{title:'先画三个色块',description:'只画一张卡'},successSignal:'留下一张卡',questions:[],timeBudget:10};
  await app.submitModel('想做梦境展，先给建议',async()=>({source:'model',trace:response().trace,analysis:{intents:[{kind:'idea',newIdeaKey:'dream',data:{text:'梦境展',title:'梦境展',type:'creative'}}]},content:{explorations:{dream:exploration}}}));
  assert.equal(context.HaipiguaCore.validate(copy(app.state)),true);
  assert.equal(context.HaipiguaCore.create(storage,()=>new Date(NOW)).state.notes[0].advice[0].kind,'exploration');
  for(const corrupt of [value=>{value.firstStep.description='';},value=>{value.timeBudget=0;},value=>{value.paths=[];},value=>{value.source='local-demo';}]){
    const backup=copy(app.state);corrupt(backup.notes[0].advice[0].value);assert.equal(context.HaipiguaCore.validate(backup),false);
  }
});
