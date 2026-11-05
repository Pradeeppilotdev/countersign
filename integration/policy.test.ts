import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SandboxDesk} from '../app/sandbox.ts';
import {InvoicePaymentTool,runInvoiceAgent} from '../agent/payment-tool.ts';
test('owner policies authorize agent payments with pinned merchants, caps, rolling holds and expiry',{timeout:240_000},async()=>{
 const d=new SandboxDesk(),directory=mkdtempSync(join(tmpdir(),'countersign-policy-'));
 try{
  await d.start();const base={payee:d.merchant.accountId,asset:'near',amount:'1000'};
  const config={merchants:[{id:'merchant',payee:d.merchant.accountId}],per_payment:'1000',daily_limit:'1500',expires_at:String(Date.now()+3600000)};
  async function rejected(actor:any,method:string,args:any,reason:string){const r=await actor.callRaw(d.vault,method,args);assert.equal(r.failed,true);assert.ok(r.receiptFailureMessagesContain(reason),JSON.stringify(r.receiptFailures));}
  await rejected(d.executor,'set_policy',config,'owner only');
  await d.owner.call(d.vault,'set_policy',config);
  await rejected(d.owner,'authorize_by_policy',{invoice:{...base,id:'owner-cannot-use-executor-path'},merchant_id:'merchant'},'executor only');
  for(const [id,patch,merchant,reason] of [['unknown',{},'unknown','merchant not allowed'],['redirect',{payee:d.owner.accountId},'merchant','merchant payout mismatch'],['over',{amount:'1001'},'merchant','per-payment cap exceeded']] as const){
   await rejected(d.executor,'authorize_by_policy',{invoice:{...base,id,...patch},merchant_id:merchant},reason);
  }
  const transport={call:(m:string,a:any)=>d.executor.call(d.vault,m,a,{gas:'100000000000000'}),view:(m:string,a:any)=>d.vault.view(m,a)};
  const invoice={...base,id:'policy-paid'},tool=new InvoicePaymentTool(join(directory,'agent.db'),d.vault.accountId,invoice,transport,'merchant');
  await assert.rejects(()=>tool.request({invoice_id:invoice.id,payee:d.owner.accountId}),/Only the assigned/);
  assert.equal(await d.vault.view('get_payment',{invoice_id:invoice.id}),null);
  const before=BigInt((await d.merchant.balance()).total.toString());
  const result=await runInvoiceAgent(invoice,async()=>({name:'request_payment',arguments:{invoice_id:invoice.id}}),tool);
  assert.equal(result.state,'settled');assert.equal((await tool.request({invoice_id:invoice.id})).state,'settled');
  assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,1000n);
  assert.equal(await d.vault.view('policy_usage',{}),'1000');
  await rejected(d.executor,'authorize_by_policy',{invoice:{...base,id:'daily-over'},merchant_id:'merchant'},'rolling daily budget exceeded');
  // Two concurrent authorizations cannot both consume the last 500 units.
  const racers=['race-a','race-b'];
  const results=await Promise.all(racers.map(id=>d.executor.callRaw(d.vault,'authorize_by_policy',{invoice:{...base,id,amount:'300'},merchant_id:'merchant'})));
  assert.equal(results.filter(r=>!r.failed).length,1);assert.equal(await d.vault.view('policy_usage',{}),'1300');
  for(const id of racers)if(await d.vault.view('get_payment',{invoice_id:id}))await d.owner.call(d.vault,'cancel',{invoice_id:id});
  assert.equal(await d.vault.view('policy_usage',{}),'1000');
  // Updating rules cannot reset spending history.
  await d.owner.call(d.vault,'set_policy',config);
  await rejected(d.executor,'authorize_by_policy',{invoice:{...base,id:'reset-bypass'},merchant_id:'merchant'},'rolling daily budget exceeded');
  const hold={...base,id:'hold',amount:'500'};
  await d.executor.call(d.vault,'authorize_by_policy',{invoice:hold,merchant_id:'merchant'});
  assert.equal(await d.vault.view('policy_usage',{}),'1500');
  await d.owner.call(d.vault,'cancel',{invoice_id:hold.id});assert.equal(await d.vault.view('policy_usage',{}),'1000');
  const revoked={...hold,id:'revoked'};
  await d.executor.call(d.vault,'authorize_by_policy',{invoice:revoked,merchant_id:'merchant'});
  await d.executor.call(d.vault,'reserve',{invoice:revoked,attempt_id:'r'});
  await d.owner.call(d.vault,'revoke_policy',{});
  await rejected(d.executor,'execute',{invoice_id:revoked.id,attempt_id:'r'},'policy revoked');
  await d.owner.call(d.vault,'set_policy',{...config,expires_at:String(Date.now()+25000)});
  await rejected(d.executor,'execute',{invoice_id:revoked.id,attempt_id:'r'},'policy changed');
  await d.worker.provider.fastForward(100);
  await rejected(d.executor,'authorize_by_policy',{invoice:{...base,id:'policy-expired',amount:'1'},merchant_id:'merchant'},'policy expired');
  // A real failed native transfer releases policy quota and vault budget once.
  await d.owner.call(d.vault,'set_policy',{...config,min_payment:'1',daily_limit:'3000',merchants:[{id:'missing',payee:'missing-policy-payee.test.near'}],expires_at:String(Date.now()+3600000)});
  const quota=await d.vault.view('policy_usage',{}),budget=await d.vault.view('available_balance',{});
  const badInvoice={...base,id:'failed-policy',payee:'missing-policy-payee.test.near',amount:'1'};
  const failedTool=new InvoicePaymentTool(join(directory,'failed.db'),d.vault.accountId,badInvoice,transport,'missing');
  assert.equal((await failedTool.request({invoice_id:badInvoice.id})).state,'failed');
  assert.equal((await failedTool.request({invoice_id:badInvoice.id})).state,'failed');
  assert.equal(await d.vault.view('policy_usage',{}),quota);assert.equal(await d.vault.view('available_balance',{}),budget);
  // Manual approval remains an explicit owner override.
  assert.equal((await d.owner.call(d.vault,'authorize',{invoice:{...base,id:'manual-override',amount:'2000'}})).state,'Authorized');
 }finally{await d.close();rmSync(directory,{recursive:true,force:true});}
});
