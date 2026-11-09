import {DatabaseSync} from 'node:sqlite';
import {commitment,type Invoice,type Payment} from '../executor/core.ts';
import {InvoicePaymentTool,validateInvoiceProposal} from './payment-tool.ts';
import type {VaultTransport} from '../executor/vault.ts';
import {parseSignedInvoice,verifySignedInvoice,type SignedInvoice} from '../merchant/invoice.ts';
import {publicError} from '../app/errors.ts';
import {vaultReason} from '../executor/errors.ts';

type Proposer=(invoice:Readonly<Invoice>)=>Promise<unknown>;
export class AgentInbox {
 private db:DatabaseSync;
 private path:string; private identity:string; private transport:VaultTransport;
 constructor(path:string,identity:string,transport:VaultTransport){
  this.path=path;this.identity=identity;this.transport=transport;
  if(path===':memory:'||!identity)throw Error('Persistent storage and pinned vault identity required');
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS inbox_scope (id INTEGER PRIMARY KEY CHECK(id=1),vault TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY,invoice TEXT NOT NULL,merchant TEXT NOT NULL,commitment TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,proposal TEXT,error TEXT);`);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare('INSERT OR IGNORE INTO inbox_scope VALUES(1,?)').run(identity);
   if(this.db.prepare('SELECT vault FROM inbox_scope WHERE id=1').get()?.vault!==identity)throw Error('Inbox belongs to another vault');
   if(!this.db.prepare('PRAGMA table_info(inbox)').all().some(c=>c.name==='signed_invoice'))this.db.exec('ALTER TABLE inbox ADD COLUMN signed_invoice TEXT');
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');this.db.close();throw error;}
 }
 close(){this.db.close();}
 get(id:string){const row=this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);if(!row)throw Error('Unknown inbox invoice');return {...row,signed_invoice:row.signed_invoice?JSON.parse(String(row.signed_invoice)):null,invoice:JSON.parse(String(row.invoice)),proposal:row.proposal?JSON.parse(String(row.proposal)):null};}
 list(){return this.db.prepare('SELECT id FROM inbox ORDER BY rowid').all().map(r=>this.get(String(r.id)));}
 enqueue(invoice:Invoice,merchant:string,signed?:SignedInvoice){
  if(!invoice||typeof invoice!=='object'||Array.isArray(invoice)||Object.keys(invoice).sort().join(',')!=='amount,asset,id,payee'||!Object.values(invoice).every(v=>typeof v==='string')||invoice.asset!=='near')throw Error('Only exact native invoice fields are accepted');
  if(typeof merchant!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(merchant))throw Error('Invalid merchant');
  const hash=commitment(invoice);
  const auth=signed?parseSignedInvoice(signed):null;
  if(auth&&(commitment(auth.invoice)!==hash||auth.merchant_id!==merchant))throw Error('Signed invoice capability mismatch');
  this.db.prepare("INSERT OR IGNORE INTO inbox(id,invoice,merchant,commitment,state,signed_invoice) VALUES(?,?,?,?,'queued',?)").run(invoice.id,JSON.stringify(invoice),merchant,hash,auth?JSON.stringify(auth):null);
  const row=this.get(invoice.id);
  if(row.commitment!==hash||row.merchant!==merchant)throw Error('Inbox invoice already bound to different terms');
  if(auth&&JSON.stringify(row.signed_invoice)!==JSON.stringify(auth))throw Error('Signed invoice already bound or previously queued unsigned');
  return row;
 }
 async enqueueSigned(raw:unknown,vault:string){
  const parsed=parseSignedInvoice(raw);
  const [domain,key]=await Promise.all([this.transport.view('get_invoice_domain',{}),this.transport.view('get_merchant_key',{merchant_id:parsed.merchant_id})]);
  const signed=verifySignedInvoice(parsed,{vault,domain,key});
  return this.enqueue(signed.invoice,signed.merchant_id,signed);
 }
 async propose(id:string,proposer:Proposer){
  const row=this.get(id);
  const claim=this.db.prepare("UPDATE inbox SET state='inference_pending',error=NULL WHERE id=? AND state='queued' AND generation=?").run(id,row.generation);
  if(!claim.changes)return this.get(id);
  try{
   const proposal=validateInvoiceProposal(row.invoice,await proposer(Object.freeze({...row.invoice})));
   const saved=this.db.prepare("UPDATE inbox SET state='proposal_ready',proposal=?,error=NULL WHERE id=? AND state='inference_pending' AND generation=?").run(JSON.stringify(proposal),id,row.generation);
   if(!saved.changes)throw Error('Proposal superseded; no payment submitted');
  }catch(error){
   this.db.prepare("UPDATE inbox SET state='proposal_failed',error='Model proposal unavailable or rejected' WHERE id=? AND state='inference_pending' AND generation=?").run(id,row.generation);
   throw error;
  }
  return this.get(id);
 }
 // Explicit operator action after interrupted/failed inference. An old in-flight
 // response cannot overwrite a new generation or authorize a payment.
 retryProposal(id:string){
  this.get(id);
  const changed=this.db.prepare("UPDATE inbox SET state='queued',generation=generation+1,proposal=NULL,error=NULL WHERE id=? AND state IN ('inference_pending','proposal_failed')").run(id);
  if(!changed.changes)throw Error('Only interrupted or failed proposals can be retried');
  return this.get(id);
 }
 async resume(id:string){
  const row=this.get(id);
  if(row.state!=='proposal_ready')return row; // Never infer or invent consent during recovery.
  const proposal=validateInvoiceProposal(row.invoice,row.proposal);
  if(commitment(row.invoice)!==row.commitment)throw Error('Inbox commitment mismatch');
  const tool=new InvoicePaymentTool(this.path,this.identity,row.invoice,this.transport,String(row.merchant),row.signed_invoice??undefined);
  try{
   const result=await tool.request(proposal.arguments);
   const state=['settled','failed','cancelled'].includes(result.state)?result.state:'proposal_ready';
   this.db.prepare("UPDATE inbox SET state=?,error=? WHERE id=? AND state='proposal_ready'").run(state,state==='proposal_ready'?'Payment outcome pending; resume the same invoice':null,id);
  }catch(error){
   const signed:SignedInvoice|null=row.signed_invoice;
   if(signed?.service && vaultReason(error)?.startsWith('service period already claimed by [')){
    // Only a permanent on-chain claim can make this rejection terminal. A
    // timeout or an unverifiable error leaves the saved proposal retryable.
    const winner:unknown=await this.transport.view('get_service_claim',{service:signed.service}).catch(()=>null);
    if(typeof winner==='string' && winner!==id && /^[A-Za-z0-9_.:-]{1,128}$/.test(winner)){
     this.db.prepare("UPDATE inbox SET state='period_claimed',error=? WHERE id=? AND state='proposal_ready'").run(`Service period already claimed by [${winner}].`,id);
     return this.get(id);
    }
    error=Error('Service period claim could not be confirmed. Resume the saved invoice.');
   }
   this.db.prepare("UPDATE inbox SET error=? WHERE id=? AND state='proposal_ready'").run(publicError(error),id);
   throw error;
  }
  return this.get(id);
 }
 // Operator-only cancellation is separate from the agent capability. Trust only
 // a confirmed contract cancellation; never release an uncertain execution locally.
 async cancel(id:string,cancelOnChain:(id:string)=>Promise<Payment>){
  const row=this.get(id),payment=await cancelOnChain(id);
  if(payment.state!=='Cancelled'||payment.commitment!==row.commitment||commitment(payment.invoice)!==row.commitment)throw Error('Cancellation not confirmed for this invoice');
  this.db.prepare("UPDATE inbox SET state='cancelled',generation=generation+1,error=NULL WHERE id=?").run(id);
  return this.get(id);
 }
 async run(id:string,proposer:Proposer){await this.propose(id,proposer);return this.resume(id);}
}
