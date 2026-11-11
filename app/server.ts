import {publicError,validateDeskPolicy} from './errors.ts';
import { SandboxDesk } from './sandbox.ts';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DryRunWorkflow } from '../oneclick/workflow.ts';
import { preview } from '../oneclick/quotes.ts';
mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
const workflow = new DryRunWorkflow(process.env.COUNTERSIGN_WORKFLOW_DB ?? fileURLToPath(new URL('../work/app.db',import.meta.url)));
const port=Number(process.env.COUNTERSIGN_PORT ?? process.env.AEGIS_PORT ?? 4317), origin=`http://127.0.0.1:${port}`;
const assets: Record<string,[string,string]>={
 '/':['public/index.html','text/html'], '/app.js':['public/app.js','text/javascript'],
 '/sandbox.js':['public/sandbox.js','text/javascript'], '/style.css':['public/style.css','text/css'],
 '/components.js':['public/components.js','text/javascript'], '/state.js':['public/state.js','text/javascript'],
 '/logo.svg':['public/logo.svg','image/svg+xml'], '/fonts/manrope.ttf':['public/fonts/manrope.ttf','font/ttf'],
 '/attack-results/style.css':['public/attack-results.css','text/css'],
 '/attack-results/result.json':['../docs/attack-results/result.json','application/json'],
};
const sandbox=new SandboxDesk(process.env.COUNTERSIGN_SANDBOX_DIR ?? process.env.AEGIS_SANDBOX_DIR ?? fileURLToPath(new URL('../work/local-vault/',import.meta.url)));
await sandbox.start();
const server=createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 try {
  if(req.headers.host!==`127.0.0.1:${port}`) return json(403,{error:'Use the local app address.'});
  const url=new URL(req.url!,origin);
  if(req.method==='GET' && url.pathname==='/attack-results') {
   res.writeHead(308,{Location:'/attack-results/'});return res.end();
  }
  if(req.method==='GET' && url.pathname==='/attack-results/') {
   // GitHub renders this same repository-owned HTML fragment in its README viewer.
   const report=readFileSync(new URL('../docs/attack-results/README.md',import.meta.url),'utf8');
   const template=readFileSync(new URL('public/attack-results.html',import.meta.url),'utf8');
   res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   return res.end(template.replace('<!-- attack-results -->',()=>report));
  }
  if(req.method==='GET' && assets[url.pathname]) {const [file,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type});return res.end(readFileSync(new URL(file,import.meta.url)));}
  if(req.method==='GET' && url.pathname==='/api/sandbox') return json(200,await sandbox.snapshot());
  if(req.method==='GET' && url.pathname==='/api/workflows') {
   const ids=workflow.tracker.db.prepare('SELECT id FROM dry_quotes ORDER BY recorded DESC LIMIT 100').all();
   return json(200,ids.map(row=>workflow.inspect(String(row.id))));
  }
  if(req.method!=='POST' || req.headers.origin!==origin || !req.headers['content-type']?.startsWith('application/json')) return json(403,{error:'Local app requests only.'});
  let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>16384)return json(413,{error:'Request too large.'});}
  const input=JSON.parse(body);
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid invoice reference or request.');
  if(url.pathname==='/api/sandbox/start')return json(200,await sandbox.start());
  if(url.pathname.startsWith('/api/sandbox/'))return json(200,await sandbox.action(url.pathname.split('/').pop()!,input));
  if(url.pathname==='/api/replay') {
   const policy=JSON.parse(readFileSync(new URL('../oneclick/fixtures/live-policy.json',import.meta.url),'utf8'));
   const quote=JSON.parse(readFileSync(new URL('../oneclick/fixtures/live-dry-quote.json',import.meta.url),'utf8'));
   return json(201,workflow.save(`demo-${randomUUID().slice(0,8)}`,policy,quote,'ARCHIVED_REPLAY'));
  }
  if(url.pathname==='/api/preview') {
   const policy=input.policy;validateDeskPolicy(policy);
   const result=await preview(policy);
   return json(201,workflow.save(input.id,policy,result.raw));
  }
  if(url.pathname==='/api/simulate') {
   if(!['PROCESSING','SUCCESS','FAILED','REFUNDED'].includes(input.status))throw Error('Unsupported simulation');
   return json(200,workflow.simulate(input.id,{status:input.status,updatedAt:new Date().toISOString()}));
  }
  return json(404,{error:'Not found'});
 }catch(e){json(400,{error:publicError(e)});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Countersign: ${origin}`));
const shutdown=()=>server.close(async()=>{await sandbox.close();workflow.close();process.exit(0);});
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
