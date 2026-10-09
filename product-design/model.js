/* AI-assisted fictional product design lab. No real business data. */
(function (root) {
  'use strict';
  const common = { version: 'v1.0', status: '学习示例', timezone: 'UTC+8', freshness: '观察窗结束后下一汇总节点 09:00，且来源完整' };
  const metrics = [
    {id:'M01',name:'当日新注册用户数',domain:'增长',type:'基础',unit:'人',owner:'增长产品',tags:['注册','人群'],definition:'符合E范围、registered_at落在自然日D的去重用户数。',formula:'COUNT(DISTINCT user_id)',source:'users',upstreams:[],sample:'1,000',maturity:'D+1 09:00'},
    {id:'M02',name:'当日活跃用户数',domain:'内容',type:'基础',unit:'人',owner:'内容运营',tags:['活跃','留存'],definition:'E中在D发生login、content_view或pay_success的去重用户数。',formula:'COUNT(DISTINCT active user_id)',source:'users + events',upstreams:[],sample:'2,000',maturity:'D+1 09:00'},
    {id:'M03',name:'当日新增首购用户数',domain:'交易',type:'基础',unit:'人',owner:'交易产品',tags:['首购','交易'],definition:'E中全历史最早成功正金额支付时间落在D的去重用户数；退款不改写首购事实。',formula:'COUNT(DISTINCT first_paid_user_id)',source:'users + transactions',upstreams:[],sample:'160',maturity:'D+1 09:00 + 完整支付历史'},
    {id:'M04',name:'新注册当日首购用户数',domain:'增长',type:'派生',unit:'人',owner:'增长产品',tags:['注册','首购'],definition:'当日注册人群与当日首次支付人群的交集；不包含更早注册的首购用户。',formula:'COUNT(users in cohort D AND first_paid_at in D)',source:'users + transactions',upstreams:[{id:'M01',kind:'人群依赖'},{id:'M03',kind:'首购规则依赖'}],sample:'80',maturity:'D+1 09:00 + 上游完整'},
    {id:'M05',name:'新注册当日付费转化率',domain:'增长',type:'复合',unit:'%',owner:'增长产品',tags:['付费','转化','注册'],definition:'当天注册且首购用户数 / 当天新注册用户数。分母0返回空值。',formula:'M04 / M01 × 100%',source:'users + transactions',upstreams:[{id:'M04',kind:'数值依赖'},{id:'M01',kind:'数值依赖'}],sample:'8.0%',maturity:'D+1 09:00 + 上游完整'},
    {id:'M06',name:'新注册次日留存率',domain:'增长',type:'复合',unit:'%',owner:'增长产品',tags:['注册','留存'],definition:'D注册队列中D+1有有效活跃行为的人数 / M01(D)。不可用D+1所有活跃用户代替分子。',formula:'active users from cohort D on D+1 / M01(D)',source:'users + events',upstreams:[{id:'M01',kind:'人群/分母依赖'},{id:'M02',kind:'活跃规则依赖'}],sample:'28.0%',maturity:'D+2 09:00 + 上游完整'},
    {id:'M07',name:'当日净支付金额',domain:'交易',type:'派生',unit:'元',owner:'交易产品',tags:['净额','支付','退款'],definition:'D成功支付金额减D成功退款金额；record_id去重，退款可来自往日订单，净额可为负。',formula:'(SUM(payment_fen) − SUM(refund_fen)) / 100',source:'users + transactions',upstreams:[],sample:'12,400.00',maturity:'D+1 09:00'},
    {id:'M08',name:'新注册7日首购转化率',domain:'增长',type:'复合',unit:'%',owner:'增长产品',tags:['注册','付费','队列'],definition:'D注册队列在[D 00:00,D+7 00:00)首次支付的人数 / M01(D)。观察窗结束前不定稿。',formula:'first payers in cohort D within 7 days / M01(D)',source:'users + transactions',upstreams:[{id:'M01',kind:'人群/分母依赖'},{id:'M03',kind:'全历史首购规则依赖'}],sample:'14.5%',maturity:'D+7 09:00 + 上游完整'}
  ].map(m => Object.assign({}, common, m));
  function search(query='',domain='',type='') {
    const q=query.trim().toLowerCase();
    return metrics.filter(m=>(!domain||m.domain===domain)&&(!type||m.type===type)&&(!q||[m.id,m.name,m.owner,...m.tags].join(' ').toLowerCase().includes(q)));
  }
  function downstream(id) { return metrics.filter(m=>m.upstreams.some(u=>u.id===id)); }
  function ratio(n,d) { return d===0 ? null : n/d; }
  function start(day) { return Date.parse(day+'T00:00:00+08:00'); }
  function inDay(iso,day) { const t=Date.parse(iso),s=start(day);return t>=s&&t<s+86400000; }
  function eligible(u) { return !u.is_test&&!u.is_internal; }
  function uniqueRecords(rows) { const seen=new Set();return rows.filter(r=>{if(seen.has(r.record_id))return false;seen.add(r.record_id);return true;}); }
  function firstPayments(rows,users) {
    const valid=new Set(users.filter(eligible).map(u=>u.user_id)), out={};
    uniqueRecords(rows).filter(r=>valid.has(r.user_id)&&r.record_type==='payment'&&r.status==='success'&&r.amount_fen>0).forEach(r=>{if(!out[r.user_id]||Date.parse(r.occurred_at)<Date.parse(out[r.user_id]))out[r.user_id]=r.occurred_at;});
    return out;
  }
  function netAmount(rows,users,day) {
    const valid=new Set(users.filter(eligible).map(u=>u.user_id));
    return uniqueRecords(rows).filter(r=>valid.has(r.user_id)&&r.status==='success'&&inDay(r.occurred_at,day)).reduce((s,r)=>s+(r.record_type==='payment'?r.amount_fen:r.record_type==='refund'?-r.amount_fen:0),0)/100;
  }
  function cohort7(users,rows,day,asOf,sourceComplete=true) {
    if(Date.parse(asOf)<start(day)+7*86400000+9*3600000) return {status:'观察中',value:null};
    if(!sourceComplete) return {status:'数据延迟',value:null};
    const cohort=users.filter(u=>eligible(u)&&inDay(u.registered_at,day)), first=firstPayments(rows,users), s=start(day);
    const count=cohort.filter(u=>first[u.user_id]&&Date.parse(first[u.user_id])>=s&&Date.parse(first[u.user_id])<s+7*86400000).length;
    return {status:cohort.length?'可定稿':'无可计算样本',value:ratio(count,cohort.length)};
  }
  const errors={
    zero:{title:'无可计算样本',result:'—',reason:'分母 M01 = 0；当天没有符合范围的新注册用户。',action:'保留空值并说明样本范围，不能把空值写成0%。'},
    delayed:{title:'数据延迟',result:'—',reason:'示例：transactions 汇总尚未完成，M03/M04来源不齐。',action:'补齐源数据并确认刷新节点后再定稿，禁止把旧日期数值标成本期。'},
    version:{title:'口径待复核',result:'—',reason:'示例：M05要求M01 v1.0，实际依赖声明为v1.1。',action:'先核对版本与人群规则，再确认定义；本状态阻断最终值展示。'}
  };
  const cases=[['AC01','8项目录完整','默认打开展示8项ID、名称、业务域和类型'],['AC02','关键词搜索','“付费”应返回M05、M08'],['AC03','联合筛选','增长+复合应返回M05、M06、M08'],['AC04','负责人搜索','交易产品应返回M03、M07'],['AC05','关联跳转','M05上游为M04和M01；M01下游含M04/M05/M06/M08'],['AC06','口径对比','示例显示8%、8%、50%，同时说明不同统计对象'],['AC07','零分母','显示空值与原因，不显示0%、Infinity或NaN'],['AC08','自然日边界','D+1 00:00归次日；D 00:00归当日'],['AC09','去重与首购','record_id去重，首购取全历史最早成功正金额支付'],['AC10','观察窗成熟','7日窗结束且汇总完成才定稿；之前显示观察中'],['AC11','数据延迟','本期最终值隐藏，并说明需要补齐的来源'],['AC12','版本冲突','显示预期/实际版本，先核对再定稿']];
  root.PlatformLab={metrics,search,downstream,ratio,inDay,firstPayments,netAmount,cohort7,errors,cases};
})(globalThis);
