'use strict';
// Optional account/network diagnostic. Reads a key once; never prints it or provider text.
const readline = require('node:readline');
async function main() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('等待秘密配置，不回显；只测试官方免费文本模型。\n');
  const reader = readline.createInterface({input: process.stdin, terminal: false});
  const line = await new Promise(resolve => {reader.once('line', resolve); reader.once('close', () => resolve(''));}); reader.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  let key; try { key = JSON.parse(line).MODEL_API_KEY; } catch { throw Error(); }
  if (typeof key !== 'string' || !key || key.length > 1000) throw Error();
  for (const model of ['glm-4.7-flash', 'glm-4-flash-250414']) {
    try {
      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}, body:JSON.stringify({model,messages:[{role:'user',content:'仅回复JSON：{"ok":true}'}],max_tokens:64,...(model==='glm-4.7-flash'?{thinking:{type:'disabled'}}:{})}),signal:AbortSignal.timeout(20000)});
      const data = await response.json().catch(()=>({}));
      const code = String(data.error?.code || '');
      console.log(JSON.stringify({requestedModel:model,status:response.status,providerCode:/^\d{3,6}$/.test(code)?code:undefined,returnedModel:typeof data.model==='string'?data.model:undefined,hasContent:typeof data.choices?.[0]?.message?.content==='string'}));
    } catch { console.log(JSON.stringify({requestedModel:model,error:'NETWORK_OR_TIMEOUT'})); }
  }
  key = '';
}
main().catch(()=>{process.stderr.write('诊断未启动，秘密配置不完整。\n');process.exitCode=1;});
