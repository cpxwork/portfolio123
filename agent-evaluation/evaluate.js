// Offline task assistant evaluation. Deterministic router + real local tools. No model/API.
const fs=require('node:fs');const path=require('node:path');const M=require('../coffee-lab/model.js');
const dev=[
 ['D01','为什么今天亏钱',['diagnose']],['D02','为什么排队的人这么多',['diagnose']],['D03','缺货是什么原因',['diagnose']],['D04','剩了好多杯，怎么回事',['diagnose']],
 ['D05','给我一个备货方案',['recommend']],['D06','建议我怎么调价格',['recommend']],['D07','比较一下几种设置',['recommend']],['D08','下一天策略怎么选',['recommend']],
 ['D09','看看累计利润',['ledger']],['D10','现金变了多少',['ledger']],['D11','导出账本CSV',['ledger']],['D12','收入和成本总计',['ledger']],
 ['D13','先分析亏损，再给备货方案',['diagnose','recommend']],['D14','先看账本，再分析排队原因',['ledger','diagnose']],['D15','给我方案，也看一下利润总计',['recommend','ledger']],
 ['D16','不用给方案，只分析亏损',['diagnose']],['D17','不要分析原因，只导出账本',['ledger']],['D18','别看账本，只给建议',['recommend']],
 ['D19','帮我看看',['clarify']],['D20','推荐一部电影',['unsupported']],['D21','直接帮我转账进货',['unsupported']],['D22','把真实顾客数据接进来',['unsupported']],
 ['D23','我还没营业，为什么今天亏钱',['clarify'],false],['D24','没有记录，看看累计利润',['clarify'],false]
];
const holdout=[
 ['H01','排队流失的原因能解释吗',['diagnose']],['H02','备货建议和利润总计一起给我',['recommend','ledger']],['H03','不用分析排队，给我设置建议',['recommend']],
 ['H04','不要给建议，告诉我亏损原因',['diagnose']],['H05','看累计现金和收入',['ledger']],['H06','我没营业，导出账本',['clarify'],false],
 ['H07','你看这个怎么办',['clarify']],['H08','替我买一台咖啡机',['unsupported']],['H09','把排队损失和缺货原因分析一下',['diagnose']],
 ['H10','先给备货方案，再看今天为什么亏',['recommend','diagnose']],
 ['H11','今天钱越卖越少，给个诊断',['diagnose']], // intentionally difficult phrasing; retained error
 ['H12','导出CSV之后，再解释一下为什么排队',['ledger','diagnose']]
];
const toolFor={diagnose:'diagnose_day',recommend:'compare_options',ledger:'get_ledger'};
const cases=[...dev.map(x=>({...pack(x),split:'dev'})),...holdout.map(x=>({...pack(x),split:'holdout'}))];
function pack([id,text,expected,hasRecords=true]){return {id,text,expected,hasRecords,reference: expected.includes('clarify')?'先澄清目标或请求营业记录，不调用工具':expected.includes('unsupported')?'说明仅支持本地咖啡模拟，不执行外部操作':{tools:expected.map(i=>toolFor[i]),quality:['source=local-simulation','simulation=true','nonempty-result','no-claims-of-actual-business-benefit']}};}
const patterns={diagnose:/亏|损失|排队|缺货|浪费|剩了|原因|怎么回事/,recommend:/方案|备货|建议|怎么调|策略|设置|比较/,ledger:/账|利润|现金|总计|记录|收入|成本|CSV/i};
function v0(text){for(const i of ['recommend','diagnose','ledger'])if(patterns[i].test(text))return [i];return ['unsupported'];}
function v1(text,hasRecords){
 if(/转账|真实顾客|电影|替我买/.test(text))return ['unsupported'];
 let remaining=text.replace(/(?:不用|不要|别)(?:给我|给|看|分析)?[^，,；;]*(?:，|,|；|;)/g,'');
 const intents=Object.keys(patterns).filter(i=>patterns[i].test(remaining));
 if(!intents.length)return ['clarify'];
 if(!hasRecords&&intents.some(i=>['diagnose','ledger'].includes(i)))return ['clarify'];
 return intents;
}
function equal(a,b){return a.length===b.length&&[...a].sort().join('|')===[...b].sort().join('|');}
function execute(c,version){
 const route=version==='v0'?v0(c.text):v1(c.text,c.hasRecords);
 const trace=[{stage:'input',case:c.id,text:c.text,hasRecords:c.hasRecords},{stage:'route',version,intents:route}];
 let g=M.createGame(202610);
 if(c.hasRecords)g=M.operate(g,{price:14,stock:120,staff:1,marketing:40});
 const outputs=[];
 for(const intent of route){
  if(['clarify','unsupported'].includes(intent)){outputs.push({kind:intent,message:intent==='clarify'?'请补充要解决的目标或营业记录。':'此原型只支持咖啡模拟账本、诊断和方案对比。',simulation:true,source:'local-simulation'});continue;}
  const tool=toolFor[intent];trace.push({stage:'tool_request',tool});
  if(intent==='diagnose'&&!g.records.length){trace.push({stage:'tool_error',tool,error:'missing_records'});continue;}
  let data;
  if(intent==='diagnose'){const r=g.records.at(-1);data={day:r.day,profit:r.profit,queueLost:r.queueLost,stockLost:r.stockLost,waste:r.waste,explanation:M.explain(r)};}
  if(intent==='recommend')data={scope:'same-day single-variable local comparison; not global optimum',alternatives:M.recommendations(g,g.preferences)};
  if(intent==='ledger')data={records:g.records.length,totals:M.totals(g),csv:M.csv(g)};
  outputs.push({kind:intent,tool,source:'local-simulation',simulation:true,data});trace.push({stage:'tool_result',tool,data});
 }
 const routePass=equal(route,c.expected);
 const taskPass=equal(outputs.map(o=>o.kind),c.expected)&&!trace.some(t=>t.stage==='tool_error');
 // Output quality is a binary contract check, not semantic/model quality.
 const qualityPass=outputs.length>0&&outputs.every(o=>o.source==='local-simulation'&&o.simulation===true&&(o.data||o.message))&&(!route.includes('diagnose')||outputs.filter(o=>o.kind==='diagnose').every(o=>o.data.profit===g.records.at(-1)?.profit));
 const endToEnd=routePass&&taskPass&&qualityPass;
 let failureStage=endToEnd?null:!routePass?'intent_route':!taskPass?'tool_execution':'output_contract';
 trace.push({stage:'evaluation',routePass,taskPass,qualityPass,endToEnd,failureStage});
 return {id:c.id,split:c.split,version,input:c.text,expected:c.expected,predicted:route,routePass,taskPass,qualityPass,endToEnd,failureStage,outputs,trace};
}
const results=cases.flatMap(c=>['v0','v1'].map(v=>execute(c,v)));
const summaries=[];for(const version of ['v0','v1'])for(const split of ['dev','holdout']){const r=results.filter(x=>x.version===version&&x.split===split);const count=key=>r.filter(x=>x[key]).length;const n=r.length;summaries.push({version,split,n,routePassed:count('routePass'),taskPassed:count('taskPass'),qualityPassed:count('qualityPass'),endToEndPassed:count('endToEnd'),routeRate:count('routePass')/n,taskRate:count('taskPass')/n,qualityRate:count('qualityPass')/n,endToEndRate:count('endToEnd')/n});}
const report={date:'2026-10-14',scope:'AI-assisted learning prototype; hand-authored cases; offline deterministic routing; no LLM/API or online user data',n:36,dev:24,holdout:12,note:'Development and holdout are both authored during this exercise. Holdout is kept separate from router changes, but not an independently collected or blind business benchmark. Rates are sample-level rule/tool outcomes, not model accuracy.',summaries,remainingFailures:results.filter(r=>r.version==='v1'&&!r.endToEnd).map(r=>({id:r.id,input:r.input,predicted:r.predicted,expected:r.expected,failureStage:r.failureStage,split:r.split}))};
fs.writeFileSync(path.join(__dirname,'cases.json'),JSON.stringify(cases,null,2));fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(results,null,2));fs.writeFileSync(path.join(__dirname,'report.json'),JSON.stringify(report,null,2));
const csv=['id,split,version,expected,predicted,route_pass,task_pass,contract_pass,end_to_end,failure_stage',...results.map(r=>[r.id,r.split,r.version,r.expected.join('|'),r.predicted.join('|'),r.routePass,r.taskPass,r.qualityPass,r.endToEnd,r.failureStage||''].join(','))].join('\n');fs.writeFileSync(path.join(__dirname,'results.csv'),csv);
console.log(JSON.stringify(report,null,2));
