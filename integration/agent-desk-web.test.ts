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
import {SandboxDesk,parseNear} from '../app/sandbox.ts';

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
  assert.equal(paid.record.payment_confirmed,true);
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

test('desk receipts reject signed-bill and terms collisions, and missing merchant attribution', {timeout:180000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-desk-receipts-'));
 const desk=new SandboxDesk(directory,{recoverOnStart:false});
 const route=createAgentRoute({state:()=>readAgentState(directory),importBill:bill=>importAgentBill(directory,bill),
  run:(id,live)=>runAgentBill(directory,id,live),resume:id=>resumeAgentBill(directory,id),modelReady:()=>false,error:agentWebError});
 try{
  await desk.start();const {vault,owner,executor,merchant}=desk;
  const now=BigInt((await vault.view('policy_snapshot',{})).now),amount=parseNear('0.04');
  const pair=generateKeyPairSync('ed25519'),domain='a'.repeat(64);
  await owner.call(vault,'configure_invoice_auth',{domain});
  await owner.call(vault,'set_merchant_key',{merchant_id:'supplier',public_key:publicKeyBase64(pair.publicKey)});
  await owner.call(vault,'set_policy',{merchants:[{id:'supplier',payee:merchant.accountId}],per_payment:amount,daily_limit:parseNear('0.12'),expires_at:String(now+3_600_000n)});
  const signed=(id:string,bill_id:string,value=amount)=>signInvoice({invoice:{id,payee:merchant.accountId,asset:'near',amount:value},
   merchant_id:'supplier',bill_id,vault:vault.accountId,domain,key_version:'1',expires_at:String(now+600_000n)},pair.privateKey);
  const cases=[
   {original:signed('SAME-TERMS','PAID-BILL'),incoming:signed('SAME-TERMS','ANOTHER-BILL'),error:/signed bill in the inbox is not the one/},
   {original:signed('OTHER-AMOUNT','ORIGINAL-AMOUNT'),incoming:signed('OTHER-AMOUNT','ORIGINAL-AMOUNT',parseNear('0.03')),error:/different invoice under this invoice number/},
   {original:signed('NO-SIGNED-RECEIPT','MANUAL-PAYMENT'),incoming:signed('NO-SIGNED-RECEIPT','UNPROVEN-BILL'),error:/no signed supplier receipt/},
  ];
  const before=BigInt((await merchant.balance()).total.toString());
  // Payments made outside this inbox must not become receipts for a later,
  // different signed bill merely because its ID and payment terms collide.
  for(const [i,c] of cases.entries()){
   if(i===2)await owner.call(vault,'authorize',{invoice:c.original.invoice});
   else await executor.call(vault,'authorize_signed_invoice',{signed:c.original},{gas:'100000000000000'});
   await executor.call(vault,'reserve',{invoice:c.original.invoice,attempt_id:'paid-'+i},{gas:'100000000000000'});
   await executor.call(vault,'execute',{invoice_id:c.original.invoice.id,attempt_id:'paid-'+i},{gas:'100000000000000'});
  }
  const paidBalance=(await merchant.balance()).total.toString();
  assert.equal(BigInt(paidBalance)-before,BigInt(amount)*3n);
  await desk.close();
  const check=(record:any,pattern:RegExp)=>{
   assert.equal(record.outcome,'blocked');assert.equal(record.payment_confirmed,false);
   assert.equal(record.reason,'unattributed_payment');assert.match(record.error,pattern);
   assert.equal(record.attempt_id,null);assert.equal(record.payload_hash,null);assert.equal(record.tx_hash,null);
  };
  for(const c of cases){
   const imported=await route('POST','/api/agent/import',{invoice:c.incoming});
   assert.equal(imported.status,200);assert.equal(imported.body.already_imported,false);
   assert.equal(imported.body.record.state,'queued');check(imported.body.record,c.error);
   const again=await route('POST','/api/agent/import',{invoice:c.incoming});
   assert.equal(again.body.already_imported,true);check(again.body.record,c.error);
   // Reopening the desk and explicitly retrying cannot turn that wrong receipt
   // into a paid badge, or cause another transfer.
   const run=await route('POST','/api/agent/run',{id:c.incoming.invoice.id,live:false});
   assert.equal(run.status,400);assert.equal(run.body.ok,false);
   const resumed=await route('POST','/api/agent/resume',{id:c.incoming.invoice.id});
   assert.equal(resumed.status,200);check(resumed.body.record,c.error);
   const state=await route('GET','/api/agent/state',undefined);
   check(state.body.state.bills.find((b:any)=>b.id===c.incoming.invoice.id),c.error);
   assert.equal((await merchant.balance()).total.toString(),paidBalance);
  }
  console.log('PASS: two signed-bill collisions and a missing signature receipt stayed Blocked across import, refresh and retry; no borrowed receipt or extra payment.');
 }finally{
  await desk.close();
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
