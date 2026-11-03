import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {SandboxDesk} from '../app/sandbox.ts';
test('owner cancellation releases only expired reservations exactly once',{timeout:180_000},async()=>{
 const d=new SandboxDesk();try{
  await d.start();const base={payee:d.merchant.accountId,asset:'near',amount:'100000000000000000000000'};
  async function reject(actor:any,method:string,args:any,reason:string){const r=await actor.callRaw(d.vault,method,args);assert.equal(r.failed,true);assert.ok(r.receiptFailureMessagesContain(reason),JSON.stringify(r.receiptFailures));}
  const cancelled={...base,id:'cancelled'};
  await d.owner.call(d.vault,'authorize',{invoice:cancelled});
  assert.ok(BigInt(await d.vault.view('invoice_expiry',{invoice_id:cancelled.id}))>0n);
  await reject(d.executor,'cancel',{invoice_id:cancelled.id},'owner only');
  const before=await d.snapshot();
  for(let n=0;n<2;n++)assert.equal((await d.owner.call(d.vault,'cancel',{invoice_id:cancelled.id})).state,'Cancelled');
  await reject(d.executor,'reserve',{invoice:cancelled,attempt_id:'c'},'invoice cancelled');
  await reject(d.executor,'execute',{invoice_id:cancelled.id,attempt_id:'c'},'invoice cancelled');
  await reject(d.owner,'authorize',{invoice:cancelled},'invoice id already used');
  assert.equal((await d.snapshot()).available,before.available);
  const expired={...base,id:'expires-before-reserve'},reserved={...base,id:'expires-before-execute'};
  const expiry=String(Date.now()+30_000);
  await reject(d.owner,'authorize',{invoice:{...base,id:'bad-expiry'},expires_at:'1'},'expiry must be within 24 hours');
  for(const invoice of [expired,reserved])await d.owner.call(d.vault,'authorize',{invoice,expires_at:expiry});
  await d.executor.call(d.vault,'reserve',{invoice:reserved,attempt_id:'r'});
  const held=await d.snapshot();
  await reject(d.owner,'cancel',{invoice_id:reserved.id},'reservation has not expired');
  await d.worker.provider.fastForward(100);
  await reject(d.executor,'reserve',{invoice:expired,attempt_id:'e'},'invoice expired');
  await reject(d.executor,'execute',{invoice_id:reserved.id,attempt_id:'r'},'invoice expired');
  const after=await d.snapshot();assert.equal(after.available,held.available);assert.equal(after.merchantReceived,before.merchantReceived);
  await reject(d.executor,'cancel',{invoice_id:reserved.id},'owner only');
  for(let i=0;i<2;i++)assert.equal((await d.owner.call(d.vault,'cancel',{invoice_id:reserved.id})).state,'Cancelled');
  assert.equal((await d.snapshot()).available,before.available);
  await reject(d.executor,'execute',{invoice_id:reserved.id,attempt_id:'r'},'invoice cancelled');
  await reject(d.owner,'authorize',{invoice:reserved},'invoice id already used');
 }finally{await d.close();}
});
