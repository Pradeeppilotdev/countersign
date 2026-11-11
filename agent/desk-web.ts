// Web-facing records around the shared CLI operations; no new payment decisions.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import lockfile from 'proper-lockfile';
import {SandboxDesk} from '../app/sandbox.ts';
import {publicError} from '../app/errors.ts';
import {AgentInbox} from './inbox.ts';
import {createDeskInbox,importDeskInvoice,runDeskInvoice,resumeDeskInvoices,readDeskStatus,readDeskCapacity} from './desk-core.ts';
import {demoProposer} from './demo-proposer.ts';
import {buildFacts} from './ask/facts.ts';
import {readInbox} from './ask/inbox-reader.ts';

export const NO_AGENT_VAULT='No agent vault yet. Run npm run agent:desk -- init first.';
export const AGENT_LOCKED='Agent vault is in use by another process';
export class DeskWebError extends Error {}
export function agentWebError(error:unknown){
 if((error as {code?:string})?.code==='ELOCKED')return AGENT_LOCKED;
 return error instanceof DeskWebError?error.message:publicError(error);
}
export async function requireAgentVault(directory:string){
 if(!existsSync(join(directory,'desk.json')))throw new DeskWebError(NO_AGENT_VAULT);
 if(await lockfile.check(directory,{stale:2000}))throw new DeskWebError(AGENT_LOCKED);
}
async function withInbox<T>(directory:string,read:(desk:SandboxDesk,inbox:AgentInbox)=>Promise<T>){
 await requireAgentVault(directory);
 const desk=new SandboxDesk(directory,{recoverOnStart:false});let inbox:AgentInbox|undefined;
 try{await desk.start();inbox=createDeskInbox(desk,directory);return await read(desk,inbox);}
 finally{inbox?.close();await desk.close();}
}
async function snapshot(directory:string,desk:SandboxDesk,inbox:AgentInbox){
 // The same status and capacity reads as the CLI; never run/reconcile on GET.
 const status=await readDeskStatus(desk,inbox),capacity=await readDeskCapacity(desk.vault);
 const facts=await buildFacts({vault:status.vault,block_height:await desk.worker.provider.block({finality:'optimistic'}).then((b:any)=>b.header.height),
  view:(method,args)=>desk.vault.view(method,args),inbox:readInbox(join(directory,'inbox.db'))});
 return {network:status.network,vault:status.vault,paused:status.controls?.paused??null,
  policy:facts.vault.rules,capacity,spending:facts.totals.per_day,merchants:facts.vault.merchant_keys,
  bills:facts.invoices.map(b=>({id:b.id,merchant:b.merchant,payee:b.payee,amount_near:b.amount_near,state:b.state,outcome:b.outcome,
   error:b.error,reason:b.reason,explanation:b.explanation,has_proposal:b.agent.has_proposal,
   attempt_id:b.chain.payment?.same_invoice?b.chain.payment.attempt_id:null,
   payload_hash:b.chain.payment?.same_invoice?b.chain.invoice_auth?.payload_hash??null:null,
   // The CLI transport returns decoded contract results; it does not persist tx hashes.
   tx_hash:null,network:status.network})),
 };
}
export const readAgentState=(directory:string)=>withInbox(directory,(desk,inbox)=>snapshot(directory,desk,inbox));
export async function importAgentBill(directory:string,raw:unknown){
 return withInbox(directory,async(desk,inbox)=>{
  const known=new Set(inbox.list().map(row=>row.id));
  let row;
  try{row=await importDeskInvoice(desk,inbox,raw);}
  catch(error){
   // Validation errors contain fixed code-authored text, never invoice values or keys.
   const message=error instanceof Error?error.message:'';
   if(/^(Invalid (signed|signature|merchant|signing)|Signed (invoice|vault|domain)|Merchant key|Inbox invoice already bound|Only exact native invoice)/.test(message))throw new DeskWebError(message);
   throw error;
  }
  const state=await snapshot(directory,desk,inbox);
  return {already_imported:known.has(row.id),record:state.bills.find(b=>b.id===row.id)!,state};
 });
}
export function liveAgentModelReady(){
 // Constructing the CLI proposer checks its existing environment/config loader;
 // it never calls the model and returns no credentials to the web layer.
 try{demoProposer(['--live-model']);return true;}catch{return false;}
}
export async function runAgentBill(directory:string,id:string,live:boolean){
 await requireAgentVault(directory);
 let failure:unknown;
 try{await runDeskInvoice(directory,id,live);}catch(error){failure=error;}
 if(failure&&(failure as {code?:string}).code==='ELOCKED')throw failure;
 const state=await readAgentState(directory),record=state.bills.find(b=>b.id===id);
 if(!record)throw new DeskWebError('Unknown inbox invoice');
 // A rejected call leaves its exact reason in the existing inbox. Return that
 // durable record even though the CLI correctly exits nonzero for this case.
 // Any other failure (paused vault, RPC outage) is reported as itself, never
 // as an older reason still saved on the record.
 if(failure&&record.error!==publicError(failure))throw new DeskWebError(agentWebError(failure));
 return {record,state};
}
export async function resumeAgentBill(directory:string,id:string){
 return withInbox(directory,async(desk,inbox)=>{
  await resumeDeskInvoices(inbox,id); // Never invokes a proposer/model.
  const state=await snapshot(directory,desk,inbox);
  return {record:state.bills.find(b=>b.id===id)!,state};
 });
}
