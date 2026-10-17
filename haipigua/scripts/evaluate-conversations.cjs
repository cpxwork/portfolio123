'use strict';
// Real model regression with synthetic context. No keys or browser storage.
const fs=require('fs'),vm=require('vm'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const base=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/conversation-context.json'),'utf8'));
function fixture(){
 const store=new Map([['little-spark.v1',JSON.stringify(base)]]);
 const c={Date,Intl,console,crypto};c.window=c;vm.createContext(c);
 for(const f of ['engine.js','ramble.js','pocket.js','studio-core.js'])vm.runInContext(fs.readFileSync(path.join(root,'web',f),'utf8'),c);
 return c.HaipiguaCore.create({getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},()=>new Date('2026-10-17T03:00:00Z'));
}
fs.mkdirSync(path.join(root,'.local'),{recursive:true});const report={synthetic:true,fixtureDate:'2026-10-17',startedAt:new Date().toISOString(),cases:[]};
async function run(name,text,check){
 const app=fixture(),before=JSON.stringify(app.state),started=Date.now(),entry={name,text,checks:{},success:false};
 try{
  const note=await app.submitModel(text,async payload=>{
   const response=await fetch('http://127.0.0.1:8877/api/agent',{method:'POST',headers:{Origin:'http://127.0.0.1:8877','Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(110000)});
   const result=await response.json();entry.response=result;entry.status=response.status;
   if(!response.ok)throw Error(result.error?.message||'request failed');return result;
  });
  entry.checks={realModel:note.source==='model',...check(app,note,JSON.parse(before),entry.response)};
  entry.success=Object.values(entry.checks).every(x=>x===true);entry.reply=note.reply;entry.clarification=note.clarification;
 }catch(error){entry.error=error.message;entry.stateUnchanged=JSON.stringify(app.state)===before;}
 entry.elapsedMs=Date.now()-started;entry.after=JSON.parse(app.exportData());report.cases.push(entry);
 fs.writeFileSync(path.join(root,'.local','conversation-evaluation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({name,success:entry.success,checks:entry.checks,error:entry.error,calls:entry.response?.usage?.calls,clarification:entry.clarification}));
}
(async()=>{
 await run('suggest-without-appointment','陶笛刚才的计划太多了。我只想修改学习建议，每次10分钟，只练一个音。暂时不预约时间，请给我一个能做的小动作。',(app,note,before,r)=>({noOldAppointmentChanges:JSON.stringify(app.state.tasks)===JSON.stringify(before.tasks),defaultsUnchanged:JSON.stringify(app.state.ideas.map(i=>i.preferences))===JSON.stringify(before.ideas.map(i=>i.preferences)),plannerActuallyCalled:r.trace.some(t=>t.agent==='Agent 2'&&t.kind==='model'&&t.status==='ok'),specificPlanSaved:JSON.stringify(app.state.ideas.find(i=>i.type==='skill')?.aiPlan)!==JSON.stringify(before.ideas.find(i=>i.type==='skill')?.aiPlan),messageSnapshotSaved:!!note.advice?.length,noUnwantedDateQuestion:!note.clarification||!/(哪一天|哪天|几点)/.test(note.clarification)}));
 await run('new-busy-conflict','明天中午十二点到下午一点我有实验，没空练陶笛。',(app,note,before)=>({busySaved:app.state.availability['2026-10-18']?.some(s=>s.start==='12:00'&&s.end==='13:00')===true,asksAboutConflict:!!note.clarification,noSilentReschedule:JSON.stringify(app.state.tasks)===JSON.stringify(before.tasks)}));
 await run('continue-creative','校园换书工具先不写代码，我想在10分钟内验证有没有同学愿意交换。请沿用刚才这个创意，给我一个具体的验证动作。',(app,note,before,r)=>({sameIdeaCount:app.state.ideas.length===before.ideas.length,explorerActuallyCalled:r.trace.some(t=>t.agent==='Agent 3'&&t.kind==='model'),existingExperimentUpdated:JSON.stringify(app.state.ideas.find(i=>i.type==='creative')?.exploration)!==JSON.stringify(before.ideas.find(i=>i.type==='creative')?.exploration)}));
 await run('hypothetical-busy','陶笛的学习建议先改成5分钟，不预约。如果明天下午两点到三点有实验，就没空练，但这件事还没确定，先别记成忙碌。',(app,note,before)=>({uncertainTimeNotSaved:JSON.stringify(app.state.availability)===JSON.stringify(before.availability),appointmentsUnchanged:JSON.stringify(app.state.tasks)===JSON.stringify(before.tasks),adviceStillProduced:JSON.stringify(app.state.ideas.find(i=>i.type==='skill')?.aiPlan)!==JSON.stringify(before.ideas.find(i=>i.type==='skill')?.aiPlan)}));
 await run('mixed-advice-and-busy','陶笛先改成5分钟只练一个音，不预约时间。另外明天下午两点到三点有实验。',(app,note,before,r)=>({adviceUpdated:JSON.stringify(app.state.ideas.find(i=>i.type==='skill')?.aiPlan)!==JSON.stringify(before.ideas.find(i=>i.type==='skill')?.aiPlan),busySaved:app.state.availability['2026-10-18']?.some(s=>s.start==='14:00'&&s.end==='15:00')===true,appointmentsUnchanged:JSON.stringify(app.state.tasks)===JSON.stringify(before.tasks),plannerActuallyCalled:r.trace.some(t=>t.agent==='Agent 2'&&t.kind==='model'&&t.status==='ok')}));
 report.success=report.cases.every(c=>c.success);report.finishedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'.local','conversation-evaluation.json'),JSON.stringify(report,null,2));
 if(!report.success)process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
