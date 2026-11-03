import {join} from 'node:path';
import {SandboxDesk} from '../app/sandbox.ts';
import {readVaultControls} from '../app/vault-controls.ts';
import type {Invoice} from '../executor/core.ts';
import {AgentInbox} from './inbox.ts';

// Inference has no payment authority and must not hold the owner's command lock.
// All chain mutations still run under the lock after reconnecting and rechecking.
export async function runPersistentInvoice(directory:string,id:string,proposer:(invoice:Readonly<Invoice>)=>Promise<unknown>){
 let desk=new SandboxDesk(directory,{recoverOnStart:false});let inbox:AgentInbox|undefined;
 try{
  await desk.start();
  const identity=`${desk.session}:${desk.vault.accountId}`;
  inbox=new AgentInbox(join(directory,'inbox.db'),identity,{
   call:(method,args)=>desk.executor.call(desk.vault,method,args,{gas:'100000000000000'}),
   view:(method,args)=>desk.vault.view(method,args),
  });
  if((await readVaultControls(desk.vault))?.paused)throw Error('Vault payments paused');
  if(inbox.get(id).state==='queued'){
   await desk.close();
   // SQLite claims the inference generation independently of the chain lock.
   // Owner cancellation/retry can invalidate a late proposal while this awaits.
   await inbox.propose(id,proposer);
   desk=new SandboxDesk(directory,{recoverOnStart:false});
   await desk.start();
   if(`${desk.session}:${desk.vault.accountId}`!==identity)throw Error('Vault identity changed during inference; no payment submitted');
  }
  if((await readVaultControls(desk.vault))?.paused)throw Error('Vault payments paused');
  // The proposal is durable, but current on-chain policy/key/expiry rules still
  // govern authorization and dispatch. A new signer keeps the same attempt ID.
  return await inbox.resume(id);
 }finally{inbox?.close();await desk.close();}
}
