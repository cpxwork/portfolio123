const M=require('./model.js'), fs=require('node:fs');
const seeds=[7,17,29,53,83,137,211,307,419,202610];
const strategies=[
 {id:'conservative',name:'固定低价少备',decide:()=>({price:14,stock:55,staff:1,marketing:0})},
 {id:'overstock',name:'固定高备货',decide:()=>({price:18,stock:180,staff:3,marketing:100})},
 {id:'match',name:'按当日需求匹配',decide:g=>{const event=M.eventFor(g.seed,g.day);const willing=Math.round((Math.round(event.baseVisitors*(.8+g.reputation/250))+4)*.902);const staff=Math.min(4,Math.max(1,Math.ceil((willing-55)/45)+1));return {price:18,stock:Math.min(220,Math.max(10,willing)),staff,marketing:20};}}
];
const runs=[];
for(const strategy of strategies)for(const seed of seeds){let g=M.createGame(seed),stop='14天完成';for(let i=0;i<14;i++){try{g=M.operate(g,strategy.decide(g));}catch(e){stop='预算不足提前停止';break;}}const t=M.totals(g);runs.push({strategy:strategy.id,name:strategy.name,seed,days:g.records.length,stop,cash:g.cash,...t});}
const summaries=strategies.map(s=>{const rows=runs.filter(r=>r.strategy===s.id);const avg=k=>+(rows.reduce((n,r)=>n+r[k],0)/rows.length).toFixed(2);return {id:s.id,name:s.name,runs:rows.length,completed:rows.filter(r=>r.days===14).length,meanProfit:avg('profit'),minProfit:Math.min(...rows.map(r=>r.profit)),maxProfit:Math.max(...rows.map(r=>r.profit)),meanSold:avg('sold'),meanWaste:avg('waste'),meanQueueLost:avg('queueLost'),meanStockLost:avg('stockLost')};});
const out={project:'街角咖啡经营实验室',date:'2026-10-13',scope:'同一预先固定种子集合的规则仿真，不是真实玩家A/B实验',assumptions:'当日预估可见；需求匹配策略使用已知环境与当前声誉。声誉是策略后果，后续到店数不保证相等。固定高备货可能提前因预算不足停止，统计不填补缺失天数。',seeds,strategies:strategies.map(({id,name})=>({id,name})),summaries,runs};
fs.writeFileSync(__dirname+'/EXPERIMENTS.json',JSON.stringify(out,null,2));
const keys=['strategy','name','seed','days','stop','profit','sold','waste','queueLost','stockLost','cash'];fs.writeFileSync(__dirname+'/EXPERIMENTS.csv','\ufeff'+keys.join(',')+'\r\n'+runs.map(r=>keys.map(k=>r[k]).join(',')).join('\r\n'));
console.log(JSON.stringify(summaries));
