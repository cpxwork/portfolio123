#!/usr/bin/env node
'use strict';
// Real HTTP evaluation only. No API keys, mocks, browser storage, or user records.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),OUTPUT=path.join(ROOT,'.local','live-evaluation.json');
const ENDPOINT='http://127.0.0.1:8878/api/agent',ORIGIN='http://127.0.0.1:8877',TIMEOUT_MS=110000;
const args=process.argv.slice(2),routeOnly=args.length===2&&args[0]==='--case'&&args[1]==='route';
if(args.length&&!routeOnly){console.error('Usage: node scripts/evaluate-live.cjs [--case route]');process.exit(2);}
const copy=value=>JSON.parse(JSON.stringify(value));
const dayAfter=(day,amount)=>new Date(Date.parse(day+'T12:00:00Z')+amount*86400000).toISOString().slice(0,10);
function memoryApp(){
  const values=new Map(),context={Date,Intl,console,crypto:{randomUUID:()=>crypto.randomUUID()}};context.window=context;vm.createContext(context);
  for(const file of ['engine.js','ramble.js','pocket.js','studio-core.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,'web',file),'utf8'),context,{filename:file});
  return context.HaipiguaCore.create({getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},()=>new Date());
}
const report={synthetic:true,startedAt:new Date().toISOString(),endpoint:ENDPOINT,timeoutMs:TIMEOUT_MS,selection:routeOnly?'route':'all',cases:[]};
function persist(){fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n','utf8');}
function receipt(result){console.log(JSON.stringify({case:result.case,success:result.success,modelCalls:result.modelCalls,provider:result.provider,model:result.model,estimatedCostCny:result.estimatedCostCny,why:result.why}));report.cases.push(result);persist();}
async function runCase(name,app,text,inspect,focusTaskId){
  const result={case:name,input:text,success:false,modelCalls:0,why:'',checks:{},request:null,response:null};
  const started=Date.now();let httpStatus=null;
  try{
    const note=await app.submitModel(text,async payload=>{
      result.request=copy(payload);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
      try{
        const response=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:JSON.stringify(payload),signal:controller.signal});
        httpStatus=response.status;const raw=await response.text();
        try{result.response=JSON.parse(raw);}catch{throw Error('HTTP '+httpStatus+' returned invalid JSON');}
        result.modelCalls=Array.isArray(result.response.trace)?result.response.trace.filter(t=>t.kind==='model').length:0;
        result.provider=result.response.usage?.provider;
        result.model=result.response.usage?.model;
        result.estimatedCostCny=result.response.usage?.estimatedCostCny;
        if(!response.ok)throw Error('HTTP '+httpStatus+' '+String(result.response.error?.code||'REQUEST_FAILED'));
        return result.response;
      }finally{clearTimeout(timer);}
    },focusTaskId);
    const calls=result.response.trace.filter(t=>t.kind==='model'&&['ok','success'].includes(t.status));
    result.checks={realModelSource:note?.source==='model'&&result.response.source==='model',actualSuccessfulModelCalls:calls.length>0,...inspect(note,app,result.response)};
    result.success=Object.values(result.checks).every(value=>value===true);
    result.why=result.success?'All stated checks passed.':'Failed checks: '+Object.entries(result.checks).filter(([,value])=>value!==true).map(([key])=>key).join(', ');
    result.note=copy(note);
  }catch(error){result.why=error.name==='AbortError'?'Request timed out after 110 seconds.':String(error.message||'Request failed').slice(0,600);}
  result.httpStatus=httpStatus;result.elapsedMs=Date.now()-started;
  result.state=JSON.parse(app.exportData());receipt(result);return result;
}
function skip(name,why){receipt({case:name,success:null,modelCalls:0,why,skipped:true});}
async function main(){
  const app=memoryApp();
  await runCase('route',app,'我想学陶笛，明天中午十二点练10分钟。另外我想做一个校园换书工具，让同学交换闲置书。',(note,current,response)=>{
    const ids=new Set(note.ideaIds),ideas=current.state.ideas.filter(i=>ids.has(i.id)),skill=ideas.find(i=>i.type==='skill'),creative=ideas.find(i=>i.type==='creative');
    const tomorrow=dayAfter(current.current().today,1),tasks=current.state.tasks;
    return {twoDistinctRoles:!!skill&&!!creative,plannerAndExplorerCalled:['Agent 2','Agent 3'].every(agent=>response.trace.some(t=>t.kind==='model'&&t.agent===agent&&['ok','success'].includes(t.status))),
      noInventedAppointment:tasks.every(t=>t.ideaId===skill?.id&&t.date===tomorrow&&t.start==='12:00'&&t.duration>0&&t.duration<=10&&t.planningSource==='model'),
      appointmentOrExplicitClarification:tasks.length>0||!!note.clarification,creativeExperimentSaved:creative?.exploration?.source==='model'};
  });
  if(!routeOnly){
    const skill=app.state.ideas.find(i=>i.type==='skill'),task=app.state.tasks.find(t=>t.ideaId===skill?.id&&t.status==='accepted');
    if(task){
      await runCase('feedback',app,'陶笛只练了4分钟，没完成，有点难，总是吹不响。',(note,current,response)=>{
        const feedback=current.state.feedback.find(f=>f.taskId===task.id);
        return {feedbackAgentCalled:response.trace.some(t=>t.agent==='Agent 4'&&t.kind==='model'&&['ok','success'].includes(t.status)),correctTask:feedback?.taskId===task.id,
          actualReportSaved:feedback?.source==='model'&&feedback.completion==='partial'&&feedback.minutes===4&&feedback.feeling==='hard',beforeAfterSaved:note.beforeAfter?.actual?.minutes===4};
      },task.id);
      const feedback=app.state.feedback.find(f=>f.taskId===task.id&&f.source==='model');
      if(feedback){
        app.continueIdea(skill.id);const oldIds=new Set(app.state.tasks.map(t=>t.id));
        await runCase('next-step',app,'陶笛下次后天中午十二点再学10分钟。',(note,current)=>{
          const next=current.state.tasks.find(t=>!oldIds.has(t.id)&&t.ideaId===skill.id);
          return {sameInterest:!!next,feedbackReallyShortensNext:!!next&&next.duration>0&&next.duration<10,realModelPlan:next?.planningSource==='model',timeGrounded:next?.date===dayAfter(current.current().today,2)&&next.start==='12:00',previousFeedbackRetained:current.state.feedback.some(f=>f.id===feedback.id)};
        });
      }else skip('next-step','No real model feedback was saved; cannot claim the adaptive loop passed.');
    }else{skip('feedback','Route round saved no accepted skill task; no fabricated task was substituted.');skip('next-step','No preceding real task/feedback; adaptive-loop check is unavailable.');}
    // An isolated fourth context is essential: an existing task could legitimately
    // supply an inherited date, so it would not test genuinely missing information.
    const ambiguous=memoryApp();
    await runCase('ambiguity',ambiguous,'那十二点',(note,current)=>({asksInsteadOfGuessing:!!note.clarification,noInventedTask:current.state.tasks.length===0}));
  }
  report.finishedAt=new Date().toISOString();report.success=report.cases.every(result=>result.success===true);persist();
  console.log('Synthetic results: '+OUTPUT);if(!report.success)process.exitCode=1;
}
main().catch(error=>{report.finishedAt=new Date().toISOString();report.success=false;report.fatal=String(error.message||'Evaluation failed').slice(0,600);persist();console.error('Evaluation stopped: '+report.fatal);process.exitCode=1;});
