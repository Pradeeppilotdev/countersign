import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {SandboxDesk} from '../app/sandbox.ts';
import {prepareRoute,routeCommitment} from '../oneclick/approval.ts';

test('local contract binds dry route; owner-only, expiry, tampering and no native execution',{timeout:180_000},async()=>{
 const desk=new SandboxDesk();
 async function rejected(actor:any,method:string,args:any,reason:string){
  const result=await actor.callRaw(desk.vault,method,args);
  assert.equal(result.failed,true,`Expected rejection: ${reason}`);
  assert.ok(result.receiptFailureMessagesContain(reason),`Wrong rejection: ${JSON.stringify(result.receiptFailures)}`);
  console.log(`PASS: rejected ${method}: ${reason}`);
 }
 try{
  await desk.start();
  const policy=JSON.parse(readFileSync(new URL('../oneclick/fixtures/live-policy.json',import.meta.url),'utf8'));
  const quote=JSON.parse(readFileSync(new URL('../oneclick/fixtures/live-dry-quote.json',import.meta.url),'utf8'));
  // Synthetic fresh expiry exercises contract rules; this is NOT a fresh provider quote.
  const route={...prepareRoute('route-1',policy,quote,Date.parse(quote.timestamp)),expires_at:String(Date.now()+55_000)};
  const before=await desk.snapshot();
  await rejected(desk.executor,'authorize_route',{route},'owner only');
  const approved=await desk.owner.call(desk.vault,'authorize_route',{route});
  assert.equal(approved.commitment,routeCommitment(desk.vault.accountId,route));
  assert.equal((await desk.owner.call(desk.vault,'authorize_route',{route})).commitment,approved.commitment);
  for(const field of Object.keys(route)){
   const changed={...route,[field]:['amount_out','max_amount_in','quoted_amount_in','expires_at'].includes(field)?String(BigInt(route[field])+1n):route[field]+'x'};
   await assert.rejects(()=>desk.vault.view('check_route',{route:changed}),new RegExp(field==='invoice_id'?'unknown route':'route mismatch'),field);
  }
  await rejected(desk.owner,'authorize_route',{route:{...route,recipient:'attacker'}},'route already bound');
  await rejected(desk.owner,'authorize_route',{route:{...route,invoice_id:'expired',expires_at:'1'}},'expired or excessive route lifetime');
  await rejected(desk.owner,'authorize',{invoice:{id:route.invoice_id,payee:desk.merchant.accountId,asset:'near',amount:'1'}},'invoice id already used');
  await rejected(desk.executor,'execute',{invoice_id:route.invoice_id,attempt_id:'a'},'unknown invoice');
  const after=await desk.snapshot();assert.equal(after.available,before.available);assert.equal(after.merchantReceived,before.merchantReceived);
 }finally{await desk.close();}
});
