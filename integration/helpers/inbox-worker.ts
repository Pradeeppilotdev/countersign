// Test-only crash checkpoints; production commands expose no kill/fault switches.
import {join} from 'node:path';
import {SandboxDesk} from '../../app/sandbox.ts';
import {AgentInbox} from '../../agent/inbox.ts';
const [directory,id,checkpoint]=process.argv.slice(2);
const desk=new SandboxDesk(directory);let inbox:AgentInbox|undefined;
try{
 await desk.start();
 inbox=new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,{
  call:(m,a)=>desk.executor.call(desk.vault,m,a,{gas:'100000000000000'}),view:(m,a)=>desk.vault.view(m,a),
 });
 await inbox.propose(id,async()=>{
  if(checkpoint==='inference'){process.send?.('inference');await new Promise(()=>{});}
  return {name:'request_payment',arguments:{invoice_id:id}};
 });
 process.send?.('proposal_saved');await new Promise(()=>{});
}finally{inbox?.close();await desk.close();}
