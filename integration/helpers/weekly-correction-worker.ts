import assert from 'node:assert/strict';
import {once} from 'node:events';
import {join} from 'node:path';
import {AgentInbox} from '../../agent/inbox.ts';
import {demoProposer} from '../../agent/demo-proposer.ts';
import {SandboxDesk} from '../../app/sandbox.ts';

const [directory,id,gate]=process.argv.slice(2);
const desk=new SandboxDesk(directory,{recoverOnStart:false});
await desk.start();
// Independent signers can submit concurrently on NEAR. Release the CLI's
// local process lock so the actual owner command can race this executor.
await desk.close();
async function checkpoint(){
 const proceed=once(process,'message');
 process.send!('reserve checkpoint');
 await proceed;
}
const inbox=new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,{
 view:(method,args)=>desk.vault.view(method,args),
 async call(method,args){
  if(method==='reserve' && gate==='before')await checkpoint();
  const result=await desk.executor.call(desk.vault,method,args,{gas:'100000000000000'});
  if(method==='reserve' && gate==='after')await checkpoint();
  // The real execute call has finalized. The result never reaches the inbox.
  if(method==='execute')process.kill(process.pid,'SIGKILL');
  return result;
 },
});
try {
 const outcome=await inbox.run(id,demoProposer([]).propose);
 assert.equal(outcome.state,'cancelled');
}finally{inbox.close();process.disconnect();}
