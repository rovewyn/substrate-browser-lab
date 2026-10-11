import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const startedAt = new Date().toISOString();
const token = crypto.randomUUID();
fs.mkdirSync('/tmp/browser-artifacts', {recursive:true});
fs.mkdirSync('/tmp/browser-home', {recursive:true});
const debugLog=fs.openSync('/tmp/browser-artifacts/mcp-debug.log','a');
const mcp = spawn(process.execPath, ['/app/node_modules/@playwright/mcp/cli.js',
  '--config', '/app/mcp-config.json', '--headless', '--browser', 'chromium',
  '--no-sandbox', '--host', '127.0.0.1', '--port', '8931',
  '--allowed-hosts', '127.0.0.1:8931', '--shared-browser-context',
  '--user-data-dir', '/tmp/browser-profile', '--output-dir', '/tmp/browser-artifacts',
  '--idle-timeout', '0'], {env:{...process.env,DEBUG:'pw:browser'},stdio:['ignore',debugLog,debugLog]});
mcp.on('exit', code => {console.error('MCP process exited', code); process.exit(code || 1)});
const json = (res, value, status=200) => {res.writeHead(status, {'content-type':'application/json'});res.end(JSON.stringify(value))};
function diagnostics() {
  const processes=[];
  for (const name of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
    try {
      const text=fs.readFileSync(`/proc/${name}/status`,'utf8');
      const status=Object.fromEntries(text.split('\n').filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return [x.slice(0,i),x.slice(i+1).trim()]}));
      const command=fs.readFileSync(`/proc/${name}/cmdline`,'utf8').replaceAll('\0',' ');
      if (!command) continue;
      processes.push({pid:Number(name),ppid:Number(status.PPid),name:status.Name,rssBytes:Number((status.VmRSS||'0').split(' ')[0])*1024,command});
    } catch {}
  }
  return {startedAt,token,nodeVersion:process.version,pid:process.pid,mcpPid:mcp.pid,memory:process.memoryUsage(),processes};
}
const fixture=fs.readFileSync('/app/fixture.html');
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health' || url.pathname==='/diagnostics') return json(res,diagnostics());
  if(url.pathname==='/fixture' || url.pathname==='/') {res.writeHead(200,{'content-type':'text/html'});return res.end(fixture)}
  if(url.pathname.startsWith('/artifacts/')) {
    const name=path.basename(decodeURIComponent(url.pathname.slice('/artifacts/'.length)));
    const file=path.join('/tmp/browser-artifacts',name);
    if(!fs.existsSync(file)) return json(res,{error:'Artifact not found'},404);
    res.writeHead(200,{'content-type':name.endsWith('.png')?'image/png':'application/octet-stream'});return fs.createReadStream(file).pipe(res);
  }
  // MCP stays inside the actor. The outer Substrate router selects the actor.
  const headers={...req.headers,host:'127.0.0.1:8931'};
  delete headers['ate-target-actor'];
  const proxy=http.request({hostname:'127.0.0.1',port:8931,path:req.url,method:req.method,headers},upstream=>{
    res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
  });
  proxy.on('error',error=>json(res,{error:error.message},503));
  req.pipe(proxy);
}).listen(80,'0.0.0.0',()=>console.log('Browser lab listening on port 80'));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{mcp.kill(sig);process.exit(0)});
