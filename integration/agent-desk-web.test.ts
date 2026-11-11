import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import lockfile from 'proper-lockfile';
import {createAgentRoute} from '../app/agent-route.ts';
import {readAgentState,importAgentBill,runAgentBill,resumeAgentBill,agentWebError} from '../agent/desk-web.ts';
import {publicKeyBase64,signInvoice,signedInvoiceHash} from '../merchant/invoice.ts';
import {parseNear} from '../app/sandbox.ts';

const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
test('agent web café pays once, retains identical imports, and blocks a new-ID duplicate and daily overspend',{timeout:180000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-agent-web-'));
 const cli=async(...args:string[])=>{
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{
   cwd:root,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:60000});
  return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
 };
 const route=createAgentRoute({state:()=>readAgentState(directory),importBill:bill=>importAgentBill(directory,bill),
  run:(id,live)=>runAgentBill(directory,id,live),resume:id=>resumeAgentBill(directory,id),modelReady:()=>false,error:agentWebError});
 const post=async(action:string,body:unknown)=>{const r=await route('POST','/api/agent/'+action,body,Buffer.byteLength(JSON.stringify(body)));assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.ok,true,JSON.stringify(r.body));return r.body;};
 let chain:any;
 try{
  const missing=await route('GET','/api/agent/state',undefined);assert.match(missing.body.error,/No agent vault yet/);
  const initial=await cli('init');chain=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));
  await cli('policy','0.5','0.8','120','0.01');
  const pair=generateKeyPairSync('ed25519'),key=await cli('merchant-key','local-merchant',publicKeyBase64(pair.publicKey));
  const signed=(id:string,amount:string,bill:string)=>signInvoice({invoice:{id,payee:initial.merchant,asset:'near',amount:parseNear(amount)},
   merchant_id:'local-merchant',bill_id:bill,vault:initial.vault,domain:key.domain,key_version:key.version,expires_at:String(Date.now()+600000)},pair.privateKey);
  const balance=async()=>{
   const reply=await fetch('http://127.0.0.1:'+chain.port,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'balance',method:'query',params:{request_type:'view_account',account_id:initial.merchant,finality:'optimistic'}})});
   const value=await reply.json();assert.ok(!value.error);return BigInt(value.result.amount);
  };
  const before=await balance(),bill=signed('INV-BEANS-001','0.4','BEANS-A');
  // A changed amount no longer matches the supplier's signature: the fixed reason reaches the caller and nothing is saved.
  const forged=await route('POST','/api/agent/import',{invoice:{...bill,invoice:{...bill.invoice,amount:parseNear('0.5')}}});
  assert.equal(forged.status,400);assert.equal(forged.body.error,'Invalid merchant signature');
  assert.equal((await route('GET','/api/agent/state',undefined)).body.state.bills.length,0);
  assert.equal((await post('import',{invoice:bill})).record.outcome,'queued');
  const paid=await post('run',{id:bill.invoice.id,live:false});
  assert.equal(paid.record.outcome,'paid');assert.equal(paid.record.state,'settled');assert.ok(paid.record.attempt_id);
  assert.equal(paid.record.payload_hash,signedInvoiceHash(bill));assert.equal(await balance()-before,BigInt(parseNear('0.4')));
  const again=await post('import',{invoice:bill});assert.equal(again.already_imported,true);assert.equal(again.state.bills.length,1);
  assert.equal(again.record.attempt_id,paid.record.attempt_id);assert.equal(again.record.outcome,'paid');
  assert.equal((await post('run',{id:bill.invoice.id,live:false})).record.attempt_id,paid.record.attempt_id);
  assert.equal((await post('resume',{id:bill.invoice.id})).record.outcome,'paid');
  assert.equal(await balance()-before,BigInt(parseNear('0.4')));
  const duplicate=signed('INV-BEANS-001-AGAIN','0.4','BEANS-A');await post('import',{invoice:duplicate});
  const blocked=await post('run',{id:duplicate.invoice.id,live:false});assert.equal(blocked.record.outcome,'blocked');assert.match(blocked.record.error,/Merchant bill already used/);
  assert.equal(await balance()-before,BigInt(parseNear('0.4')));
  assert.match(blocked.record.explanation.meaning,/another invoice number/);
  const costly=signed('INV-BEANS-003','0.5','BEANS-C');await post('import',{invoice:costly});
  const budget=await post('run',{id:costly.invoice.id,live:false});assert.equal(budget.record.outcome,'blocked');assert.match(budget.record.error,/Rolling daily budget exceeded/);
  const state=await route('GET','/api/agent/state',undefined);assert.equal(state.body.state.bills.length,3);
  assert.equal(state.body.state.spending.used_near,'0.4');assert.equal(state.body.state.spending.remaining_near,'0.4');
  assert.equal(state.body.state.paused,false);assert.equal(state.body.state.merchants[0].active,true);
  assert.equal(await balance()-before,BigInt(parseNear('0.4')));
  const publicText=JSON.stringify(state.body);assert.ok(!publicText.includes(bill.signature));assert.ok(!publicText.includes(key.domain));
  const release=await lockfile.lock(directory,{stale:2000,update:1000});
  try{const locked=await route('GET','/api/agent/state',undefined);assert.equal(locked.status,409);assert.equal(locked.body.error,'Agent vault is in use by another process');}finally{await release();}
 }finally{if(chain?.pid)try{process.kill(chain.pid,'SIGTERM');}catch{}}
});
