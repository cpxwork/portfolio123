'use strict';
// Run the real message renderer with a minimal DOM. Provider responses below
// are fixtures; this suite never calls a model, a network service or a browser.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const NOW='2026-10-17T01:00:00.000Z';
const plan=title=>({title,steps:[{title:'一小步',description:title+'的具体说明'}],successCriterion:'留下一个可检查的结果',rationale:'按照本轮限制缩小行动',nextStep:'下次从留下的结果继续'});
const exploration=title=>({title,assumptions:['这是待验证的假设'],paths:[{title:title+'的路径',description:title+'的路径说明'}],firstStep:{title:title+'的第一步',description:title+'的动作说明'},successSignal:'留下一张可观察的卡片',questions:[],timeBudget:10});
const trace=[{agent:'Agent 1',kind:'model',status:'ok',model:'fixture-only'}];
function fixture(){
  let serial=0;const saved=new Map(),storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)};
  const context={console,Date,Intl,crypto:{randomUUID:()=>`view-${++serial}`},localStorage:storage};context.window=context;
  vm.createContext(context);
  for(const name of ['engine.js','ramble.js','pocket.js','studio-core.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../web',name),'utf8'),context,{filename:name});
  const app=context.HaipiguaCore.create(storage,()=>new Date(NOW));
  function turn(raw,intents,content){return app.submit(raw,{source:'model',trace,analysis:{intents},content});}
  function render(){
    const elements=new Map(),listeners=new Map();
    function element(){return {innerHTML:'',textContent:'',value:'',hidden:false,open:false,scrollTop:0,scrollHeight:100,clientHeight:100,style:{},classList:{toggle(){},remove(){}},addEventListener(){},setAttribute(){},dispatchEvent(){},focus(){},querySelectorAll(){return [];},showModal(){this.open=true;},close(){this.open=false;}};}
    const document={hidden:false,body:element(),querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},querySelectorAll(){return [];},addEventListener(name,callback){listeners.set(name,callback);}};
    context.document=document;context.Event=class Event{};context.history={replaceState(){}};context.location={hash:''};context.sessionStorage={getItem(){return null;}};
    context.setInterval=()=>0;context.setTimeout=()=>0;context.clearTimeout=()=>{};context.addEventListener=()=>{};context.HaipiguaModel={status:async()=>({ready:false})};
    context.HaipiguaCore={...context.HaipiguaCore,create:()=>app};
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/studio.js'),'utf8'),context,{filename:'studio.js'});
    return {html:elements.get('#thread').innerHTML,elements,async click(dataset){await listeners.get('click')({target:{closest(){return {dataset};}}});}};
  }
  return {app,turn,render};
}

test('learning message bubbles render their own saved advice after the current interest plan changes',()=>{
  const {app,turn,render}=fixture();
  turn('FIRST-LEARNING-RAW',[{kind:'idea',newIdeaKey:'learn',data:{text:'法语入门',title:'法语入门',type:'skill'}}],{plans:{learn:plan('FIRST-LEARNING-SUGGESTION')}});
  const id=app.state.ideas[0].id;
  turn('SECOND-LEARNING-RAW',[{kind:'plan',ideaId:id,data:{duration:10}}],{plans:{[id]:plan('SECOND-LEARNING-SUGGESTION')}});
  const {html}=render(),first=html.slice(html.indexOf('FIRST-LEARNING-RAW'),html.indexOf('SECOND-LEARNING-RAW')),second=html.slice(html.indexOf('SECOND-LEARNING-RAW'));
  assert.match(first,/<strong>FIRST-LEARNING-SUGGESTION<\/strong>/);assert.doesNotMatch(first,/SECOND-LEARNING-SUGGESTION/);
  assert.match(second,/<strong>SECOND-LEARNING-SUGGESTION<\/strong>/);assert.doesNotMatch(second,/FIRST-LEARNING-SUGGESTION/);
  assert.match(second,/没有预约时间/);assert.equal(app.state.tasks.length,0);
});

test('creative bubbles and expanded paths both use the clicked message snapshot',async()=>{
  const {app,turn,render}=fixture();
  const firstNote=turn('FIRST-CREATIVE-RAW',[{kind:'idea',newIdeaKey:'dream',data:{text:'梦境展',title:'梦境展',type:'creative'}}],{explorations:{dream:exploration('FIRST-CREATIVE-ADVICE')}});
  const id=app.state.ideas[0].id;
  turn('SECOND-CREATIVE-RAW',[{kind:'plan',ideaId:id,data:{duration:10}}],{explorations:{[id]:exploration('SECOND-CREATIVE-ADVICE')}});
  const view=render(),first=view.html.slice(view.html.indexOf('FIRST-CREATIVE-RAW'),view.html.indexOf('SECOND-CREATIVE-RAW'));
  assert.match(first,/FIRST-CREATIVE-ADVICE的动作说明/);assert.doesNotMatch(first,/SECOND-CREATIVE-ADVICE/);
  assert.ok(first.includes(`data-note-id="${firstNote.id}"`));
  await view.click({action:'explore-detail',id,noteId:firstNote.id});
  const detail=view.elements.get('#dialog-body').innerHTML;
  assert.match(detail,/FIRST-CREATIVE-ADVICE的路径说明/);assert.match(detail,/FIRST-CREATIVE-ADVICE的第一步/);assert.doesNotMatch(detail,/SECOND-CREATIVE-ADVICE/);
});

test('legacy model messages without snapshots show only their saved reply instead of the latest interest suggestion',()=>{
  for(const type of ['skill','creative']){
    const {app,turn,render}=fixture(),kind=type==='creative'?'explorations':'plans',value=type==='creative'?exploration:plan;
    turn('LEGACY-RAW',[{kind:'idea',newIdeaKey:'legacy',data:{text:'旧兴趣',title:'旧兴趣',type}}],{[kind]:{legacy:value('LEGACY-SUGGESTION')}});
    delete app.state.notes[0].advice;
    const id=app.state.ideas[0].id;
    turn('CURRENT-RAW',[{kind:'plan',ideaId:id,data:{duration:10}}],{[kind]:{[id]:value('CURRENT-SUGGESTION')}});
    const {html}=render(),legacy=html.slice(html.indexOf('LEGACY-RAW'),html.indexOf('CURRENT-RAW'));
    assert.match(legacy,/LEGACY-SUGGESTION/);assert.doesNotMatch(legacy,/CURRENT-SUGGESTION/);
    assert.doesNotMatch(legacy,/data-action="explore-detail"/,'an absent historical snapshot cannot expand the latest exploration as old advice');
  }
});

test('a review message renders its evidence, honesty note, and same-turn planner handoff without a score',()=>{
  const {app,turn,render}=fixture();
  turn('REVIEW-SEED',[{kind:'idea',newIdeaKey:'draw',data:{text:'画画',title:'画画',type:'skill'}}],{plans:{draw:plan('SEED-PLAN')}});
  const id=app.state.ideas[0].id;
  const review={source:'model',ideaId:id,response:'你练了排线，也看到了线条抖。',summary:'画了两张排线，线条还是抖。',progress:[{point:'画了两张',evidence:'画了两张'}],problems:[{point:'线条还是抖',evidence:'线条还是抖'}],missingEvidence:['没有看到画，无法判断抖动的具体原因'],hasArtifact:false,needsEvidence:false,question:'',nextStep:'只画两组短线，固定方向与间距。',durationScale:.8,difficulty:'easier',emotion:'thinking',advice:'先固定方向。',taskId:null,minutes:null,fromForm:false};
  turn('REVIEW-RAW',[{kind:'review',ideaId:id,data:{canApply:true}},{kind:'plan',ideaId:id,data:{duration:8}}],{reviews:{[id]:review},plans:{[id]:plan('AFTER-REVIEW-PLAN')}});
  const {html}=render(),section=html.slice(html.indexOf('REVIEW-RAW'));
  assert.match(section,/你练了排线/);assert.match(section,/画了两张/);assert.match(section,/线条还是抖/);
  assert.match(section,/没有看到具体作品或内容/);assert.match(section,/回回 → 滴答/);assert.match(section,/AFTER-REVIEW-PLAN/);
  assert.match(section,/没有预约时间/);assert.doesNotMatch(section,/评分[:：]\s*\d/);
  assert.equal(app.state.reviews.length,1);assert.equal(app.state.tasks.length,0);
});
