import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Executor, commitment, type Invoice } from '../executor/core.ts';
import { vaultAdapters, type VaultTransport } from '../executor/vault.ts';

export const paymentToolSchema = Object.freeze({
 name: 'request_payment',
 description: 'Request payment of the assigned, owner-approved invoice. Unknown outcomes require reconciliation, never a new payment.',
 parameters: {type:'object',properties:{invoice_id:{type:'string'}},required:['invoice_id'],additionalProperties:false},
});

// Constructed by the trusted host, never from model output. One capability per invoice.
export class InvoicePaymentTool {
 #db: string; #invoice: Invoice; #transport: VaultTransport; #attempt: string;
 constructor(db: string, vaultIdentity: string, approvedInvoice: Invoice, transport: VaultTransport) {
  if(!vaultIdentity || db===':memory:')throw Error('Persistent storage and a pinned vault identity are required');
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
  const payment=await this.#transport.view('get_payment',{invoice_id:this.#invoice.id});
  if(!payment || payment.commitment!==commitment(this.#invoice) || commitment(payment.invoice)!==payment.commitment)throw Error('Invoice is not approved with the assigned terms');
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
export async function runInvoiceAgent(invoice: Invoice, propose: (input: Readonly<Invoice>)=>Promise<unknown>, tool: InvoicePaymentTool) {
 const proposal=await propose(Object.freeze({...invoice}));
 if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||Object.keys(proposal).length!==2||
  (proposal as any).name!=='request_payment'||!Object.hasOwn(proposal,'arguments'))throw Error('Expected one request_payment tool call');
 return tool.request((proposal as any).arguments);
}
