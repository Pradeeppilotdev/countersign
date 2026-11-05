import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Executor, commitment, type Invoice } from '../executor/core.ts';
import {parseSignedInvoice,type SignedInvoice} from '../merchant/invoice.ts';
import { callVault, vaultAdapters, type VaultTransport } from '../executor/vault.ts';

export const paymentToolSchema = Object.freeze({
 name: 'request_payment',
 description: 'Request payment of the assigned invoice under owner approval or an owner-configured spending policy. Unknown outcomes require reconciliation, never a new payment.',
 parameters: {type:'object',properties:{invoice_id:{type:'string'}},required:['invoice_id'],additionalProperties:false},
});

// Constructed by the trusted host, never from model output. One capability per invoice.
export class InvoicePaymentTool {
 #db: string; #invoice: Invoice; #transport: VaultTransport; #attempt: string; #policyMerchant?:string; #signed?:SignedInvoice;
 constructor(db: string, vaultIdentity: string, approvedInvoice: Invoice, transport: VaultTransport, policyMerchant?:string, signed?:SignedInvoice) {
  if(!vaultIdentity || db===':memory:')throw Error('Persistent storage and a pinned vault identity are required');
  if(policyMerchant!==undefined&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(policyMerchant))throw Error('Invalid policy merchant');
  this.#policyMerchant=policyMerchant;
  if(signed){this.#signed=parseSignedInvoice(signed);if(this.#signed.merchant_id!==policyMerchant||commitment(this.#signed.invoice)!==commitment(approvedInvoice))throw Error('Signed invoice capability mismatch');}
  const hash=commitment(approvedInvoice);
  this.#db=db; this.#invoice=Object.freeze({...approvedInvoice});this.#transport=transport;
  this.#attempt=createHash('sha256').update(JSON.stringify([vaultIdentity,approvedInvoice.id,hash])).digest('hex');
  const store=new DatabaseSync(db);
  try {
   store.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS agent_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), vault TEXT NOT NULL)');
   store.prepare('INSERT OR IGNORE INTO agent_scope VALUES (1,?)').run(vaultIdentity);
   if(store.prepare('SELECT vault FROM agent_scope WHERE singleton=1').get()?.vault!==vaultIdentity)throw Error('Attempt database belongs to another vault');
  }finally{store.close();}
 }
 async request(input: unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||
   !Object.hasOwn(input,'invoice_id')||(input as any).invoice_id!==this.#invoice.id)throw Error('Only the assigned invoice_id is accepted');
  let payment=await this.#transport.view('get_payment',{invoice_id:this.#invoice.id});
  // Host-selected policy capability. The model still gets only invoice_id.
  if(!payment && this.#policyMerchant){
   if(this.#signed)await callVault(this.#transport,'authorize_signed_invoice',{signed:this.#signed});
   else await callVault(this.#transport,'authorize_by_policy',{invoice:this.#invoice,merchant_id:this.#policyMerchant});
   payment=await this.#transport.view('get_payment',{invoice_id:this.#invoice.id});
  }
  if(!payment || payment.commitment!==commitment(this.#invoice) || commitment(payment.invoice)!==payment.commitment)throw Error('Invoice is not approved with the assigned terms');
  if(payment.state==='Cancelled')return {invoice_id:this.#invoice.id,state:'cancelled'};
  const {auth,rail}=vaultAdapters(this.#transport,this.#invoice.id);
  const executor=new Executor(this.#db,auth,rail);
  try {
   const state=await executor.execute(this.#invoice,this.#attempt);
   return {invoice_id:this.#invoice.id,state:state==='claimed'||state==='unknown'?await executor.reconcile(this.#invoice.id):state};
  }finally{executor.close();}
 }
}

// The proposer receives data only, and returns a single tool call. No vault transport or keys.
// This is a capability boundary, not an OS sandbox for running untrusted JavaScript.
export function validateInvoiceProposal(invoice:Invoice,proposal:unknown) {
 if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||Object.keys(proposal).length!==2||
  (proposal as any).name!=='request_payment'||!Object.hasOwn(proposal,'arguments'))throw Error('Expected one request_payment tool call');
 const args=(proposal as any).arguments;
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||!Object.hasOwn(args,'invoice_id')||args.invoice_id!==invoice.id)throw Error('Only the assigned invoice_id is accepted');
 return {name:'request_payment' as const,arguments:{invoice_id:invoice.id}};
}
export async function runInvoiceAgent(invoice: Invoice, propose: (input: Readonly<Invoice>)=>Promise<unknown>, tool: InvoicePaymentTool) {
 const proposal=validateInvoiceProposal(invoice,await propose(Object.freeze({...invoice})));
 return tool.request(proposal.arguments);
}
