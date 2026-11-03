import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SandboxDesk} from '../app/sandbox.ts';
import {InvoicePaymentTool,runInvoiceAgent} from './payment-tool.ts';
import {demoProposer} from './demo-proposer.ts';
const {live,model,propose}=demoProposer(process.argv.slice(2));
const d=new SandboxDesk(),directory=mkdtempSync(join(tmpdir(),'countersign-policy-demo-'));
try{
 console.log(live?`LIVE MODEL (${model}) → POLICY → LOCAL TEST FUNDS ONLY`:'FIXTURE MODEL → POLICY → LOCAL TEST FUNDS ONLY');
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
 assert.equal(await d.vault.view('get_payment',{invoice_id:invoice.id}),null);
 const result=await runInvoiceAgent(invoice,propose,tool);
 assert.equal(result.state,'settled');await tool.request({invoice_id:invoice.id});
 assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,BigInt(invoice.amount));
 const blockedInvoice={...invoice,id:'over-daily'};
 const blockedTool=new InvoicePaymentTool(join(directory,'attempts.db'),`${d.session}:${d.vault.accountId}`,blockedInvoice,transport,'demo-merchant');
 await assert.rejects(()=>runInvoiceAgent(blockedInvoice,propose,blockedTool),/rolling daily budget exceeded/);
 assert.equal(await d.vault.view('get_payment',{invoice_id:blockedInvoice.id}),null);
 assert.equal(await d.vault.view('policy_usage',{}),invoice.amount);
 assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,BigInt(invoice.amount));
 console.log(`PASS: ${live?'live':'fixture'} agent paid 0.1 local test NEAR under policy without a per-invoice owner call; duplicate paid nothing.`);
 console.log('PASS: second agent-proposed 0.1 NEAR invoice rejected by the rolling budget; no authorization or extra credit.');
 console.log(live?'Two live model requests; all payments used disposable local test NEAR. No swaps or real funds.':'Fixture proposals only; no live model requests, swaps or real funds.');
}finally{await d.close();rmSync(directory,{recursive:true,force:true});}
