// Shared CLI operations. Payment decisions stay in AgentInbox/runPersistentInvoice.
import {join} from 'node:path';
import {readVaultControls} from '../app/vault-controls.ts';
import {SandboxDesk} from '../app/sandbox.ts';
import {AgentInbox} from './inbox.ts';
import {runPersistentInvoice} from './run-invoice.ts';
import {demoProposer} from './demo-proposer.ts';

export function createDeskInbox(desk:SandboxDesk,directory:string){
 return new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,{
  call:(method,body)=>desk.executor.call(desk.vault,method,body,{gas:'100000000000000'}),
  view:(method,body)=>desk.vault.view(method,body),
 });
}
export const importDeskInvoice=(desk:SandboxDesk,inbox:AgentInbox,raw:unknown)=>inbox.enqueueSigned(raw,desk.vault.accountId);
export const runDeskInvoice=(directory:string,id:string,live=false)=>
 runPersistentInvoice(directory,id,invoice=>demoProposer(live?['--live-model']:[]).propose(invoice));
export async function resumeDeskInvoices(inbox:AgentInbox,id?:string){
 const result=[];
 const candidates=id!==undefined?[inbox.get(id)]:inbox.list().filter(r=>r.state==='proposal_ready'||r.state==='period_claimed');
 for(const row of candidates){
  const updated=await inbox.resume(String(row.id)).catch(()=>inbox.get(String(row.id)));
  if(id!==undefined||row.state!=='period_claimed'||updated.state!=='period_claimed')result.push(updated);
 }
 return result;
}
export async function readDeskCapacity(vault:{view:Function}){
 try{return await vault.view('policy_capacity',{});}
 catch(error){if(error instanceof Error&&error.message.includes('MethodNotFound'))throw Error('Upgrade the local vault before using policy capacity controls.');throw error;}
}
export async function readDeskStatus(desk:SandboxDesk,inbox:AgentInbox){
 return {controls:await readVaultControls(desk.vault),network:'LOCAL_SANDBOX',vault:desk.vault.accountId,merchant:desk.merchant.accountId,
  policy:await desk.vault.view('get_policy',{}),usage:await desk.vault.view('policy_usage',{}),available:await desk.vault.view('available_balance',{}),
  merchantReceived:(BigInt((await desk.merchant.balance()).total.toString())-desk.baseline).toString(),invoices:inbox.list()};
}
