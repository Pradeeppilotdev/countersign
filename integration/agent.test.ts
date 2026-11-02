import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SandboxDesk} from '../app/sandbox.ts';
import {InvoicePaymentTool,runInvoiceAgent} from '../agent/payment-tool.ts';

test('agent capability: real vault payment, lost response, restart reconciliation, tampering and duplicates', {timeout:180_000},async()=>{
 const desk=new SandboxDesk();const dir=mkdtempSync(join(tmpdir(),'countersign-agent-'));
 try {
  await desk.start();
  const invoice={id:'agent-invoice',payee:desk.merchant.accountId,asset:'near',amount:'100000000000000000000000'};
  await desk.owner.call(desk.vault,'authorize',{invoice});
  const before=BigInt((await desk.merchant.balance()).total.toString());
  let submissions=0, unavailable=true;
  const transport={
   async call(method:string,args:Record<string,unknown>){
    const result=await desk.executor.call(desk.vault,method,args,{gas:'100000000000000'});
    if(method==='execute'){submissions++;throw Error('Lost response after chain accepted transfer');}return result;
   },
   async view(method:string,args:Record<string,unknown>){
    if(submissions && unavailable)throw Error('RPC unavailable');
    return desk.vault.view(method,args);
   },
  };
  const path=join(dir,'attempts.db'),identity=`${desk.session}:${desk.vault.accountId}`;
  const tool=new InvoicePaymentTool(path,identity,invoice,transport);
  await assert.rejects(()=>tool.request({invoice_id:invoice.id,payee:'attacker.test.near'}),/Only the assigned/);
  await assert.rejects(()=>tool.request({invoice_id:'unapproved'}),/Only the assigned/);
  await assert.rejects(()=>runInvoiceAgent(invoice,async()=>({name:'execute',arguments:{invoice_id:invoice.id}}),tool),/Expected one/);
  const tampered=new InvoicePaymentTool(path,identity,{...invoice,amount:'2'},transport);
  await assert.rejects(()=>tampered.request({invoice_id:invoice.id}),/not approved/);
  await assert.rejects(()=>runInvoiceAgent(invoice,async()=>({name:'request_payment',arguments:{invoice_id:invoice.id}}),tool),/RPC unavailable/);
  assert.equal(submissions,1);
  // Reopen durable state while retaining the SAME running chain and deployed vault.
  unavailable=false;
  const recovered=new InvoicePaymentTool(path,identity,invoice,transport);
  const results=await Promise.all(Array.from({length:3},()=>recovered.request({invoice_id:invoice.id})));
  assert.ok(results.every(r=>r.state==='settled'));
  assert.equal(submissions,1);
  assert.equal(BigInt((await desk.merchant.balance()).total.toString())-before,BigInt(invoice.amount));
  assert.throws(()=>new InvoicePaymentTool(path,'different-vault',invoice,transport),/another vault/);
  console.log('Agent request settled once; reopened executor reconciled lost response without resubmission.');
 }finally{await desk.close();rmSync(dir,{recursive:true,force:true});}
});
