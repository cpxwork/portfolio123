'use strict';
// All records and traces here are simulated fixtures. This projection suite
// loads only the view module and never calls a model, network or browser.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context={};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/relay-view.js'),'utf8'),context,{filename:'relay-view.js'});
const build=context.HaipiguaRelay.build;
const plan=title=>({title,steps:[{title:title+'的一步',description:'模拟步骤说明'}],successCriterion:'模拟可检查产出',resources:[]});
const exploration=title=>({title,firstStep:{title:title+'的实验',description:'模拟验证动作'},successSignal:'模拟观察信号',searchLinks:[]});
const state=()=>({ideas:[{id:'learn',title:'模拟画画目标',type:'skill'},{id:'dream',title:'模拟猫咪创意',type:'creative'}],tasks:[],feedback:[]});
const note=extra=>({id:'simulated-note',text:'模拟输入',source:'model',agents:[1],ideaIds:[],taskIds:[],advice:[],trace:[],...extra});
const hasEdge=(view,from,to)=>view.edges.some(e=>e.from===from&&e.to===to);
const review=(needsEvidence=false)=>({response:'模拟反馈回应',summary:'模拟排线困难',strengths:[],gaps:[{point:'模拟卡点',evidence:'排线很难'}],needsEvidence,question:needsEvidence?'能提供一小段具体产出吗？':'',nextStep:needsEvidence?'':'模拟只练一组线'});

test('mixed learning and creative advice reaches both specialists while feedback waits; only model traces count',()=>{
  const record=note({agents:[1,2,3],ideaIds:['learn','dream'],advice:[{ideaId:'learn',kind:'plan',value:plan('模拟学习建议')},{ideaId:'dream',kind:'exploration',value:exploration('模拟创意建议')}],trace:[{kind:'model',agent:'Agent 1',status:'ok',model:'simulated-provider'},{kind:'tool',agent:'Agent 2',status:'success'},{kind:'model',agent:'Agent 3',status:'ok',model:'simulated-provider'}]});
  const view=build(state(),record);
  assert.equal(Object.keys(view.nodes).length,4);assert.ok(hasEdge(view,1,2));assert.ok(hasEdge(view,1,3));
  assert.equal(view.nodes[4].state,'waiting');assert.equal(view.calls.length,2);
  assert.equal(view.calls[0].agent,'Agent 1');assert.equal(view.calls[1].agent,'Agent 3');
});

test('vague review waits for evidence; concrete review keeps its before/after snapshots when current advice changes',()=>{
  const records=state();
  const vague=build(records,note({agents:[1,4],ideaIds:['learn'],reviews:[{ideaId:'learn',value:review(true),before:plan('模拟旧建议')}]}));
  assert.equal(vague.nodes[4].state,'question');assert.equal(vague.nodes[2].state,'idle');
  assert.ok(hasEdge(vague,1,4));assert.ok(!hasEdge(vague,4,2));assert.ok(!hasEdge(vague,4,3));assert.equal(vague.calls.length,0);
  const concrete=note({agents:[1,2,4],ideaIds:['learn'],reviews:[{ideaId:'learn',value:review(),before:plan('模拟旧建议')}],advice:[{ideaId:'learn',kind:'plan',value:plan('模拟本轮新建议')}]});
  records.ideas[0].aiPlan=plan('模拟未来建议，不能泄漏进历史轮次');
  const before=JSON.stringify(records),view=build(records,concrete);
  assert.ok(hasEdge(view,4,2));assert.equal(view.nodes[2].previous,'模拟旧建议的一步');
  assert.match(view.nodes[2].paragraphs.join(' '),/模拟本轮新建议/);assert.doesNotMatch(JSON.stringify(view),/模拟未来建议/);
  assert.equal(JSON.stringify(records),before,'a view projection must not modify domain records');
});

test('reviewing learning A and adding creative B does not fabricate a feedback handoff to B',()=>{
  const view=build(state(),note({agents:[1,2,3,4],ideaIds:['learn','dream'],reviews:[{ideaId:'learn',value:review(),before:plan('模拟学习旧建议')}],advice:[{ideaId:'learn',kind:'plan',value:plan('模拟学习更新')},{ideaId:'dream',kind:'exploration',value:exploration('模拟新创意')}]}));
  assert.ok(hasEdge(view,4,2));assert.ok(hasEdge(view,1,3));assert.ok(!hasEdge(view,4,3));
  assert.equal(view.nodes[2].previous,'模拟学习旧建议的一步');assert.equal(view.nodes[3].previous,undefined);
});
