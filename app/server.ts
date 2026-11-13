import {createDemoRoute} from './demo-route.ts';
import {readCafe,setupCafe,receiveCafe,payCafe,topUpCafe,walletFaucetCafe,depositCafe,setRulesCafe,renewRulesCafe,retryCafeBill,resetCafe} from '../agent/demo-cafe.ts';
import {publicError,validateDeskPolicy} from './errors.ts';
import { SandboxDesk } from './sandbox.ts';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DryRunWorkflow } from '../oneclick/workflow.ts';
import { preview } from '../oneclick/quotes.ts';
import {askSource} from './ask-source.ts';
import {createAgentRoute} from './agent-route.ts';
import {readAgentState,importAgentBill,runAgentBill,resumeAgentBill,liveAgentModelReady,agentWebError} from '../agent/desk-web.ts';
mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
const workflow = new DryRunWorkflow(process.env.COUNTERSIGN_WORKFLOW_DB ?? fileURLToPath(new URL('../work/app.db',import.meta.url)));
const port=Number(process.env.COUNTERSIGN_PORT ?? process.env.AEGIS_PORT ?? 4317), origin=`http://127.0.0.1:${port}`;
const assets: Record<string,[string,string]>={
 '/':['public/index.html','text/html'], '/app.js':['public/app.js','text/javascript'],
 '/sandbox.js':['public/sandbox.js','text/javascript'], '/style.css':['public/style.css','text/css'],
 '/components.js':['public/components.js','text/javascript'], '/state.js':['public/state.js','text/javascript'],
 '/agent-payments.js':['public/agent-payments.js','text/javascript'], '/agent-payments.css':['public/agent-payments.css','text/css'],
 '/demo-cafe.js':['public/demo-cafe.js','text/javascript'], '/demo-world.js':['public/demo-world.js','text/javascript'], '/invoice-doc.js':['public/invoice-doc.js','text/javascript'], '/demo-cafe.css':['public/demo-cafe.css','text/css'],
 '/ask-source.js':['public/ask-source.js','text/javascript'],
 '/ask-shared.js':['public/ask-shared.js','text/javascript'], '/ask-widget.js':['public/ask-widget.js','text/javascript'], '/ask-suggest.js':['public/ask-suggest.js','text/javascript'],
 '/ask-widget.css':['public/ask-widget.css','text/css'],
 '/logo.svg':['public/logo.svg','image/svg+xml'], '/fonts/manrope.ttf':['public/fonts/manrope.ttf','font/ttf'],
 '/attack-results/style.css':['public/attack-results.css','text/css'],
 '/attack-results/result.json':['../docs/attack-results/result.json','application/json'],
};
const paymentDir=resolve(process.env.COUNTERSIGN_SANDBOX_DIR ?? process.env.AEGIS_SANDBOX_DIR ?? fileURLToPath(new URL('../work/local-vault/',import.meta.url)));
const agentDir=resolve(process.env.COUNTERSIGN_AGENT_DIR??fileURLToPath(new URL('../work/agent-vault/',import.meta.url)));
const agentRoute=createAgentRoute({state:()=>readAgentState(agentDir),importBill:invoice=>importAgentBill(agentDir,invoice),
 run:(id,live)=>runAgentBill(agentDir,id,live),resume:id=>resumeAgentBill(agentDir,id),modelReady:liveAgentModelReady,error:agentWebError});
const demoRoute=createDemoRoute({network:()=>process.env.COUNTERSIGN_NETWORK,state:()=>readCafe(agentDir),setup:()=>setupCafe(agentDir),receive:()=>receiveCafe(agentDir),pay:(live,progress)=>payCafe(agentDir,live,progress),faucet:()=>topUpCafe(agentDir),walletFaucet:()=>walletFaucetCafe(agentDir),deposit:amount=>depositCafe(agentDir,amount),setRules:rules=>setRulesCafe(agentDir,rules),renewRules:()=>renewRulesCafe(agentDir),retry:id=>retryCafeBill(agentDir,id),reset:()=>resetCafe(agentDir),modelReady:liveAgentModelReady});
let agentMutation=false;
const source=()=>askSource(agentDir,paymentDir,process.env.COUNTERSIGN_NETWORK);
const sandbox=new SandboxDesk(paymentDir);
await sandbox.start();
const server=createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 let ownsAgentMutation=false;
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
  if(req.method==='GET' && url.pathname==='/api/config')return json(200,{demoEnabled:process.env.COUNTERSIGN_NETWORK===undefined||process.env.COUNTERSIGN_NETWORK==='local'});
  if(req.method==='GET' && url.pathname.startsWith('/api/demo/')) {
   const result=await demoRoute(req.method,url.pathname,undefined);return json(result.status,result.body);
  }
  if(req.method==='GET' && url.pathname.startsWith('/api/agent/')) {
   const result=await agentRoute(req.method,url.pathname,undefined);return json(result.status,result.body);
  }
  if(req.method==='GET' && url.pathname==='/api/sandbox') return json(200,await sandbox.snapshot());
  if(req.method==='GET' && url.pathname==='/api/ask/source') return json(200,source());
  if(req.method==='GET' && url.pathname==='/api/workflows') {
   const ids=workflow.tracker.db.prepare('SELECT id FROM dry_quotes ORDER BY recorded DESC LIMIT 100').all();
   return json(200,ids.map(row=>workflow.inspect(String(row.id))));
  }
  if(req.method!=='POST' || req.headers.origin!==origin || !req.headers['content-type']?.startsWith('application/json')) return json(403,{error:'Local app requests only.'});
  let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>16384)return json(413,{error:'Request too large.'});}
  const input=JSON.parse(body);
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid invoice reference or request.');
  if(url.pathname.startsWith('/api/agent/')||url.pathname.startsWith('/api/demo/')){
   if(agentMutation)return json(409,{ok:false,error:'An agent operation is already in progress.'});
   agentMutation=true;ownsAgentMutation=true;
  }
  if(url.pathname.startsWith('/api/demo/')) {
   const result=await demoRoute(req.method,url.pathname,input,Buffer.byteLength(body));return json(result.status,result.body);
  }
  if(url.pathname.startsWith('/api/agent/')) {
   const result=await agentRoute(req.method,url.pathname,input,Buffer.byteLength(body));return json(result.status,result.body);
  }
  if(url.pathname==='/api/ask') {
    // Read-only: the real Ask Dave CLI, same directory rule as agent/desk.ts.
    const {handleAsk}=await import('./ask-route.ts');
    const {askCommand}=await import('../agent/ask/cli.ts');
    const result=await handleAsk(input,{ask:askCommand,agentDir,vaultExists:()=>existsSync(join(agentDir,'desk.json')),now:Date.now});
    return json(result.status,{...result.body,source:source()});
  }
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
 }catch(e){json(400,{ok:false,error:publicError(e)});}finally{if(ownsAgentMutation)agentMutation=false;}
});
server.listen(port,'127.0.0.1',()=>console.log(`Countersign: ${origin}`));
const shutdown=()=>server.close(async()=>{await sandbox.close();workflow.close();process.exit(0);});
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
