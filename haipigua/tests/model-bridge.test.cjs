'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const time={now:'2026-10-17T01:00:00.000Z',today:'2026-10-17',clockMinutes:540};
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  let serial=0;const win={crypto:{randomUUID:()=>`model-${++serial}`}};
  const context=vm.createContext({window:win,Date,Intl,console});
  for(const name of ['engine.js','ramble.js','pocket.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../web',name),'utf8'),context);
  return {win,state:{version:1,ideas:[],tasks:[],feedback:[],notes:[],availability:{},chatContext:{}}};
}
const plan=(title='写一份AI产品需求草稿')=>({title,steps:[{title:'选一个真实问题',description:'记录目标用户、问题出现的场景和已有替代方案。'}],successCriterion:'保留一页包含问题、证据和待验证假设的文档。',rationale:'应用物理背景，先把已有比赛经验转成可以讨论的产出。',nextStep:'找一位目标用户核对这个问题。',resources:[{label:'MDN参考入口',url:'https://developer.mozilla.org/zh-CN/',type:'documentation',source:'curated'}]});
const trace=[{agent:'Agent 1',kind:'model',model:'glm-4.7-flash',action:'理解原话',status:'ok',durationMs:12}];
function turn(win,state,text,intents,content={},extra={}){return win.PocketFlow.submit(text,state,{...time,analysis:{intents},content,trace,...extra});}
function makeTask(win,state){
  const note=turn(win,state,'我想准备AI产品实习，明天下午三点试20分钟',[{kind:'idea',newIdeaKey:'job',data:{type:'skill',text:'准备AI产品实习',title:'AI产品实习'}},{kind:'schedule',newIdeaKey:'job',data:{date:'2026-10-18',start:'15:00',duration:20}}],{plans:{job:plan()}});
  return {note,task:state.tasks[0],idea:state.ideas[0]};
}

test('an unscheduled career goal keeps a real model plan and its evidence without invented appointment',()=>{
  const {win,state}=fixture();win.RambleRouter={analyze(){throw Error('must not run a local parser for model output');}};
  const original='我是应用物理大四，已保研，想进入AI产品行业。每天至少有五小时，但实验时间待确认。';
  const understanding={goal:'寻找AI产品相关实习',facts:[{text:'应用物理学大四且已保研',evidence:'应用物理大四，已保研'}],constraints:[{text:'实验会占用部分时间',evidence:'实验时间待确认'}],unknowns:['已有产品作品与实践有哪些？']};
  const note=turn(win,state,original,[{kind:'idea',newIdeaKey:'job',data:{type:'skill',text:'寻找AI产品相关实习',title:'AI产品实习'}}],{plans:{job:plan()}},{analysis:{intents:[{kind:'idea',newIdeaKey:'job',data:{type:'skill',text:'寻找AI产品相关实习',title:'AI产品实习'}}],understanding,clarification:{question:'已有产品作品与实践有哪些？'}},usage:{inputTokens:100},requestId:'turn-career'});
  assert.equal(state.tasks.length,0);assert.equal(state.ideas.length,1);
  assert.equal(state.ideas[0].aiPlan.source,'model');assert.match(state.ideas[0].aiPlan.steps[0].description,/替代方案/);
  assert.equal(note.text,original);assert.equal(note.source,'model');assert.equal(note.ideaIds[0],state.ideas[0].id);
  assert.deepEqual(copy(note.understanding),understanding);assert.equal(note.clarification,'已有产品作品与实践有哪些？');
  assert.equal(note.requestId,'turn-career');assert.equal(note.usage.inputTokens,100);assert.deepEqual(copy(note.trace[0]),trace[0]);
});

test('model feedback changes the next saved action, with real content and before-after evidence',()=>{
  const {win,state}=fixture(),{note,task,idea}=makeTask(win,state);
  assert.equal(task.planningSource,'model');assert.equal(task.start,'15:00');assert.equal(task.end,'15:20');assert.match(task.description,/目标用户/);assert.match(task.successCriterion,/待验证假设/);
  assert.ok(note.trace.some(t=>t.tool==='save_task'&&t.source==='local-state'));
  const reflection={response:'先留下观察，再写方案。',summary:'实际做了五分钟，卡在不知道问谁。',emotion:'thinking',nextAdjustment:{durationScale:.5,difficulty:'easier',advice:'下次缩到十分钟，只列出三个可能访谈的人。',nextStep:'列出三位可能的目标用户，并联系其中一位。'}};
  const response=turn(win,state,'只做了五分钟，不知道问谁',[{kind:'feedback',ideaId:idea.id,taskId:task.id,data:{completion:'partial',minutes:5,feeling:'hard',reason:'不知道问谁'}}],{reflections:{[task.id]:reflection}});
  assert.equal(state.feedback[0].source,'model');assert.equal(state.feedback[0].nextStep,reflection.nextAdjustment.nextStep);
  assert.equal(response.beforeAfter.before.duration,20);assert.equal(response.beforeAfter.actual.minutes,5);assert.equal(response.beforeAfter.after.duration,10);
  turn(win,state,'后天下午三点再试20分钟',[{kind:'schedule',ideaId:idea.id,data:{date:'2026-10-19',start:'15:00',duration:20}}],{plans:{[idea.id]:{...plan('只列出三位目标用户'),steps:[{title:'找到可访谈的人',description:reflection.nextAdjustment.nextStep}]}}});
  const next=state.tasks.at(-1);assert.equal(next.duration,10);assert.equal(next.end,'15:10');assert.match(next.description,/三位可能的目标用户/);assert.equal(next.planningSource,'model');
  assert.equal(state.tasks[0].status,'partial');assert.equal(state.tasks.length,2);
});

test('creative specialist content becomes the real experiment instead of a local template',()=>{
  const {win,state}=fixture();
  const exploration={title:'试一张梦境卡',assumptions:['图画能表达一种梦境感受，尚待验证。'],paths:[{title:'纸上试展',description:'先画一张卡片并找朋友描述感受。'}],firstStep:{title:'画三个色块',description:'用三个色块表达一次梦境。'},successSignal:'保留一张梦境卡和一条观众反馈。',questions:['这段梦境最重要的感受是什么？'],timeBudget:10};
  turn(win,state,'我想做梦境小展览，明天下午两点试十分钟',[{kind:'idea',newIdeaKey:'dream',data:{type:'creative',text:'做梦境小展览',title:'梦境展'}},{kind:'schedule',newIdeaKey:'dream',data:{date:'2026-10-18',start:'14:00',duration:10}}],{explorations:{dream:exploration}});
  assert.equal(state.ideas[0].exploration.source,'model');assert.equal(state.tasks[0].kind,'experiment');assert.match(state.tasks[0].description,/三个色块/);assert.equal(state.tasks[0].successCriterion,exploration.successSignal);
});

test('foreign IDs, impossible dates and mismatched task references reject atomically',()=>{
  const {win,state}=fixture(),{note,task,idea}=makeTask(win,state),before=JSON.stringify(state);
  for(const bad of [
    {kind:'schedule',ideaId:'missing',data:{date:'2026-10-18',start:'12:00',duration:10}},
    {kind:'schedule',ideaId:idea.id,data:{date:'2026-02-30',start:'12:00',duration:10}},
    {kind:'schedule',ideaId:idea.id,data:{date:'2026-10-18',start:'25:00',duration:10}},
    {kind:'schedule',newIdeaKey:'new-one',data:{date:'2026-10-18',start:'12:00',duration:10,replaceTaskId:task.id}}
  ]){
    assert.throws(()=>turn(win,state,'test',[{kind:'idea',newIdeaKey:'new-one',data:{type:'park',text:'一条新记忆'}},bad]));
    assert.equal(JSON.stringify(state),before);
  }
  assert.equal(win.PocketFlow.canUndo(note.id,state),true,'a rejected turn must not consume the previous undo');
});

test('missing or malformed specialist output never partly writes or silently falls back',()=>{
  const {win,state}=fixture(),before=JSON.stringify(state);
  const intents=[{kind:'idea',newIdeaKey:'job',data:{type:'skill',text:'准备AI产品实习',title:'AI产品实习'}}];
  for(const content of [{},{plans:{job:{title:'看似计划',steps:[]}}},{plans:{job:{...plan(),resources:[{label:'unsafe',url:'javascript:alert(1)'}]}}}]){
    assert.throws(()=>turn(win,state,'准备AI产品实习',intents,content));assert.equal(JSON.stringify(state),before);
  }
  const {task,idea}=makeTask(win,state),ready=JSON.stringify(state);
  assert.throws(()=>turn(win,state,'记录新想法并反馈',[{kind:'idea',newIdeaKey:'note',data:{type:'park',text:'另一条想法'}},{kind:'feedback',ideaId:idea.id,taskId:task.id,data:{completion:'partial',minutes:3}}],{}));
  assert.equal(JSON.stringify(state),ready,'even a late missing feedback result rolls back the earlier idea');
});

test('model-created records retain full 8000-character originals and support checkpointed undo',()=>{
  const {win,state}=fixture(),original='记'.repeat(8000);
  const note=turn(win,state,original,[{kind:'idea',newIdeaKey:'note',data:{type:'park',text:'原话已保留',title:'碎碎念'}}]);
  assert.equal(note.text,original);
  state.ideas[0].preferences={duration:10};win.PocketFlow.checkpoint(state,note.id);
  assert.equal(win.PocketFlow.canUndo(note.id,state),true);assert.equal(win.PocketFlow.undo(state,note.id),true);
  assert.equal(state.ideas.length,0);assert.equal(state.notes[0].text,original);assert.equal(state.notes[0].undone,true);
});

test('advice-only plan replaces the saved model suggestion while preserving appointments, preferences and pending rescheduling',()=>{
  const {win,state}=fixture(),{task,idea}=makeTask(win,state);
  state.tasks[0].contract={mode:'strict',date:'2026-10-18',bugs:true};
  state.ideas[0].preferences={duration:20,energy:'high',level:'some',goal:'原来确认的目标'};
  state.chatContext.pending={field:'start',question:'这项旧约定改到几点？',intent:{kind:'schedule',ideaId:idea.id,taskId:task.id,data:{date:task.date,start:task.start,duration:task.duration,replaceTaskId:task.id}}};
  const before=copy({tasks:state.tasks,preferences:state.ideas[0].preferences,availability:state.availability,pending:state.chatContext.pending,feedback:state.feedback});
  win.RambleRouter={analyze(){throw Error('model advice must not use the local router');}};
  win.SparkEngine={planLearning(){throw Error('model advice must not use a local plan');}};
  const revised={...plan('本轮只写一张项目卡'),steps:[{title:'写项目卡',description:'只写目标用户、问题和一项亲自做过的决策，缺证据处标待补。'}]};
  const note=turn(win,state,'只修改学习建议，每次10分钟，不预约时间',[{kind:'plan',ideaId:idea.id,data:{duration:10,energy:'low',level:'beginner',goal:'仅本次比较两类岗位'}}],{plans:{[idea.id]:revised}});
  assert.equal(state.ideas.length,1);assert.equal(state.ideas[0].aiPlan.title,revised.title);assert.equal(state.ideas[0].aiPlan.source,'model');
  assert.deepEqual(copy({tasks:state.tasks,preferences:state.ideas[0].preferences,availability:state.availability,pending:state.chatContext.pending,feedback:state.feedback}),before);
  assert.equal(note.taskIds.length,0);assert.equal(note.clarification,undefined);assert.match(note.reply,/没有预约时间/);
  assert.equal(note.advice[0].ideaId,idea.id);assert.equal(note.advice[0].kind,'plan');assert.equal(note.advice[0].value.title,revised.title);
  assert.equal(note.trace.some(t=>t.tool==='save_task'),false);
  turn(win,state,'还没确认本次建议的目标',[{kind:'plan',data:{canApply:false}}],{});
  assert.deepEqual(copy(state.chatContext.pending),before.pending,'an unapplied plan cannot dismiss an existing rescheduling question');
});

test('a same-turn plan uses the new interest key without adding an appointment or changing its defaults',()=>{
  const {win,state}=fixture();
  const note=turn(win,state,'想学法语，先给五分钟建议，不预约',[{kind:'idea',newIdeaKey:'french',data:{text:'学法语',title:'法语入门',type:'skill',duration:20}},{kind:'plan',newIdeaKey:'french',data:{duration:5}}],{plans:{french:plan('只跟读一个词')}});
  assert.equal(state.ideas.length,1);assert.equal(state.tasks.length,0);assert.equal(state.ideas[0].preferences.duration,20);
  assert.equal(note.advice.length,1);assert.equal(note.advice[0].ideaId,state.ideas[0].id);assert.equal(note.advice[0].value.title,'只跟读一个词');
});

test('successive plans retain separate immutable message advice and undo restores the previous plan',()=>{
  const {win,state}=fixture(),{idea}=makeTask(win,state);
  const originalAdvice=copy(state.notes[0].advice),beforeTasks=copy(state.tasks);
  const first=turn(win,state,'先给第一条建议',[{kind:'plan',ideaId:idea.id,data:{duration:10}}],{plans:{[idea.id]:plan('第一条建议')}});
  const second=turn(win,state,'再换第二条建议',[{kind:'plan',ideaId:idea.id,data:{duration:5}}],{plans:{[idea.id]:plan('第二条建议')}});
  assert.deepEqual(copy(state.notes[0].advice),originalAdvice);
  assert.equal(state.notes.find(n=>n.id===first.id).advice[0].value.title,'第一条建议');
  assert.equal(state.notes.find(n=>n.id===second.id).advice[0].value.title,'第二条建议');
  state.ideas[0].aiPlan.steps[0].description='修改当前计划也不能改变旧消息';
  assert.notEqual(state.notes.find(n=>n.id===second.id).advice[0].value.steps[0].description,state.ideas[0].aiPlan.steps[0].description);
  state.ideas[0].aiPlan.steps[0].description=state.notes.find(n=>n.id===second.id).advice[0].value.steps[0].description;
  assert.equal(win.PocketFlow.undo(state,second.id),true);assert.equal(state.ideas[0].aiPlan.title,'第一条建议');assert.deepEqual(copy(state.tasks),beforeTasks);
});

test('creative plan stores only the supplied exploration and keeps its own message snapshot',()=>{
  const {win,state}=fixture();
  const exploration={title:'先画一张卡',assumptions:['一张卡能表达梦境，尚待验证。'],paths:[{title:'画卡片',description:'用三个色块表达一种梦境感受。'}],firstStep:{title:'三个色块',description:'只画一张卡片。'},successSignal:'留下一张卡片。',questions:['最重要的感受是什么？'],timeBudget:10};
  turn(win,state,'想做梦境展',[{kind:'idea',newIdeaKey:'dream',data:{type:'creative',text:'做梦境小展览',title:'梦境展'}}],{explorations:{dream:exploration}});
  const idea=state.ideas[0],initial=copy(state.notes[0].advice),preferences=copy(idea.preferences);
  const next={...exploration,title:'再试声音卡',firstStep:{title:'写一句声音说明',description:'先只写一句话，不录音。'}};
  const note=turn(win,state,'只改实验建议，用五分钟，不预约',[{kind:'plan',ideaId:idea.id,data:{duration:5}}],{explorations:{[idea.id]:next}});
  assert.equal(state.ideas[0].exploration.firstStep.title,next.firstStep.title);assert.equal(note.advice[0].kind,'exploration');
  assert.deepEqual(copy(state.notes[0].advice),initial);assert.deepEqual(copy(state.ideas[0].preferences),preferences);assert.equal(state.tasks.length,0);
  assert.equal(note.agents.includes(3),true);assert.equal(note.clarification,undefined);
});

test('missing specialist content and appointment fields in plan reject the whole turn without local fallback',()=>{
  const {win,state}=fixture(),{idea,task}=makeTask(win,state),before=JSON.stringify(state);
  const good={kind:'plan',ideaId:idea.id,data:{duration:10}};
  for(const content of [{},{plans:{[idea.id]:{...plan(),steps:[]}}}]){
    assert.throws(()=>turn(win,state,'只改建议',[good],content));assert.equal(JSON.stringify(state),before);
  }
  for(const bad of [{...good,taskId:task.id},...['date','start','end','replaceTaskId'].map(k=>({...good,data:{duration:10,[k]:k==='date'?'2026-10-18':k==='replaceTaskId'?task.id:'15:00'}})),{kind:'plan',data:{duration:10}}]){
    assert.throws(()=>turn(win,state,'只改建议',[bad],{plans:{[idea.id]:plan()}}));assert.equal(JSON.stringify(state),before);
  }
  assert.equal(win.PocketFlow.canUndo(state.notes[0].id,state),true);
});
