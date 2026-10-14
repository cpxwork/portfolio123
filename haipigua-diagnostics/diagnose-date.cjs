const vm=require('node:vm'),fs=require('node:fs');
const original=fs.readFileSync(__dirname+'/ramble.js','utf8');
const before='date: date.date, dateExplicit: date.explicit, start: start && start.time, end: endTime, duration, ...prefs';
const after='date: date.explicit ? date.date : (currentTask ? currentTask.date : date.date), dateExplicit: date.explicit, start: start && start.time, end: endTime, duration, ...prefs';
if(!original.includes(before))throw Error('Source does not match expected line');
const patched=original.replace(before,after);
fs.writeFileSync(__dirname+'/ramble-date-proposed.js',patched);
const cases=[
 {id:'date-01',text:'改到下午三点吧',date:'2026-10-15',start:'15:00'},
 {id:'date-02',text:'改到今天下午三点吧',date:'2026-10-14',start:'15:00'},
 {id:'date-03',text:'改到后天下午三点吧',date:'2026-10-16',start:'15:00'},
 {id:'date-04',text:'明天下午三点再安排一次',date:'2026-10-15',start:'15:00'},
 {id:'date-05',text:'改到下午四点吧',date:'2026-10-15',start:'16:00'}
];
function run(source){const ctx=vm.createContext({console});vm.runInContext(source,ctx);return cases.map(c=>{const context={now:'2026-10-14T04:00:00.000Z',ideas:[{id:'idea1',title:'学跳舞',text:'我想学跳舞',type:'skill'}],tasks:[{id:'task1',ideaId:'idea1',title:'学跳舞',status:'accepted',date:'2026-10-15',start:'12:00',end:'12:10',duration:10}],lastIdeaId:'idea1',lastTaskId:'task1',availability:{}};const result=ctx.RambleRouter.analyze(c.text,context);const intent=result.intents.find(i=>i.kind==='schedule');return {id:c.id,input:c.text,expectedDate:c.date,expectedStart:c.start,date:intent?.data.date,start:intent?.data.start,replacedTask:intent?.data.replaceTaskId,passed:intent?.data.date===c.date&&intent?.data.start===c.start,trace:result};});}
const baseline=run(original),proposed=run(patched);
const report={date:'2026-10-14',scope:'Observed public-site issue + local proposed router patch; NOT deployed to Haipigua',sourceLine:418,baselinePassed:baseline.filter(c=>c.passed).length,proposedPassed:proposed.filter(c=>c.passed).length,total:cases.length,baseline,proposed};
fs.writeFileSync(__dirname+'/date-regression.json',JSON.stringify(report,null,2));console.log(JSON.stringify({baselinePassed:report.baselinePassed,proposedPassed:report.proposedPassed,total:report.total},null,2));
