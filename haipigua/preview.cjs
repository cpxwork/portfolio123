'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'web');
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
const port=Number(process.env.PORT||8877);
const backendPort=Number(process.env.HAIPIGUA_BACKEND_PORT||8878);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT must be an integer between 1024 and 65535');
const server=http.createServer((req,res)=>{
  if(['/api/health','/api/agent'].includes(req.url)){
    if(!['GET','POST'].includes(req.method)){res.writeHead(405);return res.end();}
    const origin=req.headers.origin;
    if(origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(origin)){res.writeHead(403);return res.end();}
    let size=0,rejected=false;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>128*1024){rejected=true;chunks.length=0;if(!res.headersSent){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'这段记录太长，请分两次说。'}}));}}else if(!rejected)chunks.push(chunk);});
    req.on('end',()=>{
      if(rejected)return;
      const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{'Content-Type':'application/json','Content-Length':Buffer.concat(chunks).length,...(origin?{Origin:origin}:{})}},reply=>{
        res.writeHead(reply.statusCode,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});reply.pipe(res);
      });
      upstream.setTimeout(115000,()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:{code:'LOCAL_BACKEND_OFFLINE',message:'本机模型服务尚未启动。可先用本地体验；密钥不要填进碎碎念。'}}));}else res.end();});
      upstream.end(Buffer.concat(chunks));
    });return;
  }
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);return res.end();}
  const name=pathname==='/'?'index.html':pathname.slice(1);
  // This local preview exposes only single-level public web assets.
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)||!types[path.extname(name)]){res.writeHead(404);return res.end('Not found');}
  fs.readFile(path.join(root,name),(error,data)=>{
    if(error){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':types[path.extname(name)],'Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  });
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Preview port is in use. Set PORT to another free port.':'Preview could not start.');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('Haipigua frontend preview: http://127.0.0.1:'+port+'/'));
