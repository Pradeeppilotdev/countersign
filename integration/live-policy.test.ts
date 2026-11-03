import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SandboxDesk} from '../app/sandbox.ts';
import {nearModelProposer} from '../agent/near-model.ts';
import {InvoicePaymentTool,runInvoiceAgent} from '../agent/payment-tool.ts';

test('model adapter reaches policy checks; invalid proposals cannot transact; lost authorization recovers once',{timeout:180_000},async()=>{
 const d=new SandboxDesk(),directory=mkdtempSync(join(tmpdir(),'countersign-model-policy-'));
 try{
  await d.start();
  await d.owner.call(d.vault,'set_policy',{merchants:[{id:'merchant',payee:d.merchant.accountId}],per_payment:'1000',daily_limit:'1500',expires_at:String(Date.now()+3600000)});
  const invoice={id:'model-policy',payee:d.merchant.accountId,asset:'near',amount:'1000'};
  let calls=0,authorizations=0,executions=0,loseAuthorization=true,modelCalls=0;
  const transport={
   async call(method:string,args:any){
    calls++;assert.ok(['authorize_by_policy','reserve','execute'].includes(method));
    if(method==='authorize_by_policy')authorizations++;
    if(method==='execute')executions++;
    const result=await d.executor.call(d.vault,method,args,{gas:'100000000000000'});
    if(method==='authorize_by_policy'&&loseAuthorization){loseAuthorization=false;throw Error('Lost authorization response');}
    return result;
   },
   view:(method:string,args:any)=>d.vault.view(method,args),
  };
  const toolFor=(i:typeof invoice)=>new InvoicePaymentTool(join(directory,'attempts.db'),`${d.session}:${d.vault.accountId}`,i,transport,'merchant');
  const response=(args:any,name='request_payment')=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  const config={apiKey:'fixture-secret',model:'fixture-model'};
  const tool=toolFor(invoice);
  // Exercise the real provider adapter/parser with adversarial HTTP fixtures, never a live API key.
  for(const send of [async()=>new Response('private provider details',{status:503}),async()=>response({invoice_id:invoice.id,amount:'999999'}),async()=>response({invoice_id:invoice.id,merchant_id:'attacker'}),async()=>response({invoice_id:invoice.id},'set_policy')]){
   await assert.rejects(()=>runInvoiceAgent(invoice,nearModelProposer(config,send),tool));
  }
  assert.equal(calls,0);assert.equal(await d.vault.view('policy_usage',{}),'0');
  assert.equal(await d.vault.view('get_payment',{invoice_id:invoice.id}),null);
  const propose=nearModelProposer(config,async(_url,options)=>{
   modelCalls++;const body=JSON.parse(String(options?.body));
   assert.equal(body.tools.length,1);assert.equal(body.tools[0].function.name,'request_payment');
   const assigned=JSON.parse(body.messages[1].content);
   assert.deepEqual(Object.keys(assigned).sort(),['amount','asset','id','payee']);
   assert.ok(!String(options?.body).includes('fixture-secret'));
   return response({invoice_id:assigned.id});
  });
  const before=BigInt((await d.merchant.balance()).total.toString());
  await assert.rejects(()=>runInvoiceAgent(invoice,propose,tool),/Lost authorization response/);
  assert.equal((await d.vault.view('get_payment',{invoice_id:invoice.id}) as any).state,'Authorized');
  assert.equal(await d.vault.view('policy_usage',{}),'1000');
  assert.equal(BigInt((await d.merchant.balance()).total.toString()),before);
  // Reopen the same persistent capability after uncertain authorization, without paying for another model call.
  const reopened=toolFor(invoice);
  assert.equal((await reopened.request({invoice_id:invoice.id})).state,'settled');
  assert.equal((await reopened.request({invoice_id:invoice.id})).state,'settled');
  assert.equal(authorizations,1);assert.equal(executions,1);assert.equal(modelCalls,1);
  assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,1000n);
  const over={...invoice,id:'over-budget'};
  await assert.rejects(()=>runInvoiceAgent(over,propose,toolFor(over)),/rolling daily budget exceeded/);
  assert.equal(await d.vault.view('get_payment',{invoice_id:over.id}),null);
  assert.equal(await d.vault.view('policy_usage',{}),'1000');
  // An owner may revoke policy while inference is in flight. Its later valid proposal grants no authority.
  const revoked={...invoice,id:'revoked-during-inference',amount:'500'};
  const revokeDuringInference=nearModelProposer(config,async()=>{
   await d.owner.call(d.vault,'revoke_policy',{});return response({invoice_id:revoked.id});
  });
  await assert.rejects(()=>runInvoiceAgent(revoked,revokeDuringInference,toolFor(revoked)),/no spending policy/);
  assert.equal(await d.vault.view('get_payment',{invoice_id:revoked.id}),null);
  assert.equal(executions,1);assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,1000n);
 }finally{await d.close();rmSync(directory,{recursive:true,force:true});}
});
