import {strict as assert} from 'node:assert';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {SandboxDesk} from '../app/sandbox.ts';
import {preview,QuoteServiceError} from './quotes.ts';
import {DryRunWorkflow} from './workflow.ts';
import {routeCommitment} from './approval.ts';

// Explicit online demo: one dry quote request, no API keys, no swap or deposit endpoint.
const desk=new SandboxDesk();let workflow:DryRunWorkflow|undefined;
try{
 await desk.start();
 const before=await desk.snapshot();
 const template=JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
 const policy={...template,deadline:new Date(Date.now()+10*60_000).toISOString()};
 const id='live-route-'+randomUUID();
 mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
 workflow=new DryRunWorkflow(fileURLToPath(new URL('../work/live-route-approval.db',import.meta.url)));
 console.log('Fetching one fresh signed 1Click DRY_RUN quote for a synthetic 1 USDC invoice…');
 const quote=await preview(policy);
 workflow.save(id,policy,quote.raw,'LIVE_PREVIEW');
 const result=await workflow.approve(id,{
  vault:desk.vault.accountId,
  call:(method,args)=>desk.owner.call(desk.vault,method,args),
  view:(method,args)=>desk.vault.view(method,args),
 });
 assert.equal(result.fundable,false);
 assert.equal(result.approvalState,'APPROVED','Dry approval is unresolved; do not submit it again');
 assert.ok(result.approval);
 assert.equal(result.approval.commitment,routeCommitment(desk.vault.accountId,result.approval.route));
 // Close/reopen the local records and recover through a read-only capability.
 workflow.close();
 workflow=new DryRunWorkflow(fileURLToPath(new URL('../work/live-route-approval.db',import.meta.url)));
 const recovered=await workflow.reconcileApproval(id,{vault:desk.vault.accountId,view:(method,args)=>desk.vault.view(method,args)});
 assert.deepEqual(recovered.approval,result.approval);
 assert.equal(recovered.approvalState,'APPROVED');
 const persisted=await desk.vault.view('get_route',{invoice_id:id});
 assert.equal(persisted.commitment,result.approval.commitment);
 await assert.rejects(()=>desk.vault.view('check_route',{route:{...result.approval.route,refund_to:'attacker.near'}}),/route mismatch/);
 const after=await desk.snapshot();
 assert.equal(after.available,before.available);assert.equal(after.merchantReceived,before.merchantReceived);
 const evidence={verifiedAt:new Date().toISOString(),network:'LOCAL_SANDBOX',quoteMode:'LIVE_PREVIEW',fundable:false,invoiceId:id,vault:desk.vault.accountId,policy,validation:quote.validation,approval:result.approval,recoveredAfterReopen:true,availableBefore:before.available,availableAfter:after.available,merchantReceivedBefore:before.merchantReceived,merchantReceivedAfter:after.merchantReceived};
 const evidencePath=new URL('../work/live-route-approval.json',import.meta.url);
 writeFileSync(evidencePath,JSON.stringify(evidence,null,2),{mode:0o600});
 console.log('PASS: fresh provider signature and invoice terms verified.');
 console.log('PASS: owner approval stored on the local vault; commitment matches.');
 console.log('PASS: reopened approval records reconcile using read-only vault access.');
 console.log('PASS: changed refund address rejected; vault budget and merchant balance unchanged.');
 console.log(JSON.stringify({invoiceId:id,quoteHash:quote.validation.quoteHash,commitment:result.approval.commitment,expiresAt:new Date(quote.validation.expiresAt).toISOString(),fundable:false,evidence:fileURLToPath(evidencePath)},null,2));
}catch(error){
 if(!(error instanceof QuoteServiceError))throw error;
 console.error(`BLOCKED: ${error.message}`);
 console.error('No route approval was submitted. No swap or real payment was executed.');
 process.exitCode=1;
}finally{workflow?.close();await desk.close();}
