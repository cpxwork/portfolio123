'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'web');
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
const port=Number(process.env.PORT||8877);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT must be an integer between 1024 and 65535');
const server=http.createServer((req,res)=>{
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
