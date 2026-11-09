// Test transport withholds the acknowledgement after the real vault call
// completes. SIGKILL is controlled by the parent, outside the payment code.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SandboxDesk} from '../../app/sandbox.ts';
import {AgentInbox} from '../../agent/inbox.ts';
import {demoProposer} from '../../agent/demo-proposer.ts';

const [directory,...ids]=process.argv.slice(2);
assert.equal(ids.length,2);
const desk=new SandboxDesk(directory,{recoverOnStart:false});
await desk.start();
let contenders=0;
const bothReady=Promise.withResolvers<void>();
const inbox=new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,{
 view:(method,args)=>desk.vault.view(method,args),
 async call(method,args){
  if(method==='authorize_signed_invoice'){
   if(++contenders===ids.length)bothReady.resolve();
   await bothReady.promise;
  }
  const result=await desk.executor.call(desk.vault,method,args,{gas:'100000000000000'});
  if(method==='execute'){
   process.send!({event:'transfer_accepted',id:args.invoice_id,attempt:args.attempt_id});
   await new Promise(resolve=>process.once('message',resolve));
  }
  return result;
 },
});
try {
 const proposer=demoProposer([]).propose;
 await Promise.all(ids.map(async id=>{
  const row=await inbox.run(id,proposer);
  assert.equal(row.state,'period_claimed');
  process.send!({event:'duplicate_blocked',id,error:row.error});
 }));
} finally {
 inbox.close();
 await desk.close();
}
