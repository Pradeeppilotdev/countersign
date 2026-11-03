import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SandboxDesk} from '../app/sandbox.ts';
import {InvoicePaymentTool,runInvoiceAgent} from './payment-tool.ts';
const d=new SandboxDesk(),directory=mkdtempSync(join(tmpdir(),'countersign-policy-demo-'));
try{
 await d.start();
 await d.owner.call(d.vault,'set_policy',{
  merchants:[{id:'demo-merchant',payee:d.merchant.accountId}],
  per_payment:'100000000000000000000000',daily_limit:'150000000000000000000000',expires_at:String(Date.now()+3600000),
 });
 console.log('Owner configured merchant, 0.1 NEAR per-payment cap, 0.15 NEAR rolling budget and one-hour expiry.');
 const invoice={id:'policy-demo',payee:d.merchant.accountId,asset:'near',amount:'100000000000000000000000'};
 const transport={call:(m:string,a:any)=>d.executor.call(d.vault,m,a,{gas:'100000000000000'}),view:(m:string,a:any)=>d.vault.view(m,a)};
 const tool=new InvoicePaymentTool(join(directory,'attempts.db'),`${d.session}:${d.vault.accountId}`,invoice,transport,'demo-merchant');
 const before=BigInt((await d.merchant.balance()).total.toString());
 const result=await runInvoiceAgent(invoice,async()=>({name:'request_payment',arguments:{invoice_id:invoice.id}}),tool);
 assert.equal(result.state,'settled');await tool.request({invoice_id:invoice.id});
 assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,BigInt(invoice.amount));
 const blocked=await d.executor.callRaw(d.vault,'authorize_by_policy',{invoice:{...invoice,id:'over-daily'},merchant_id:'demo-merchant'});
 assert.ok(blocked.receiptFailureMessagesContain('rolling daily budget exceeded'));
 console.log('PASS: fixture agent paid 0.1 local test NEAR without an invoice-by-invoice owner call; duplicate paid nothing.');
 console.log('PASS: second 0.1 NEAR invoice rejected by the rolling budget. No real funds or live model calls.');
}finally{await d.close();rmSync(directory,{recursive:true,force:true});}
