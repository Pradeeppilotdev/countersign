import {cleanVaultError} from './errors.ts';
import { commitment, type Authorization, type Invoice, type Payment, type Rail } from './core.ts';
// Transport is bound to one vault and its authorized executor account.
// No recipient/amount arguments are accepted by the contract's execute method.
export interface VaultTransport {
 call(method: string, args: Record<string, unknown>): Promise<Payment>;
 view(method: string, args: Record<string, unknown>): Promise<Payment | null>;
}
export async function callVault(transport:VaultTransport,method:string,args:Record<string,unknown>){
 try{return await transport.call(method,args);}catch(error){throw cleanVaultError(error);}
}
export function vaultAdapters(transport: VaultTransport, invoiceId: string): { auth: Authorization; rail: Rail } {
 const read = async () => {
  const p = await transport.view('get_payment', { invoice_id: invoiceId });
  if (!p) throw Error('unknown invoice');
  return p;
 };
 return {
  auth: {
   async reserve(invoice: Invoice, attempt: string) {
    if (invoice.id !== invoiceId) throw Error('wrong invoice');
    return callVault(transport,'reserve', { invoice, attempt_id: attempt });
   },
   async resolve(id, attempt, settled) {
    const p = await read();
    if (id !== invoiceId || p.attempt_id !== attempt || p.state !== (settled ? 'Settled' : 'Failed')) throw Error('unconfirmed result');
    return p; // Only the on-chain callback changes settlement state.
   }
  },
  rail: {
   // This capability is exclusive to the native vault. Contract serialization
   // makes same-attempt reserve/execute safe even across concurrent processes.
   // Never attach it to an external payment provider.
   async recoverNative(expected,attempt){
    let p=await read();
    const check=()=>{
     if(p.commitment!==expected || commitment(p.invoice)!==expected || p.invoice.id!==invoiceId)throw Error('recovery invoice mismatch');
     if(p.attempt_id!==null && p.attempt_id!==attempt)throw Error('attempt mismatch');
    };
    check();
    if(p.state==='Cancelled')return p;
    if(p.state==='Authorized'){p=await callVault(transport,'reserve',{invoice:p.invoice,attempt_id:attempt});check();}
    if(p.state==='Reserved'){
     // Surface a definitive contract rejection. A timeout keeps the durable
     // record; the next recovery still uses exactly the same obligation.
     try{await callVault(transport,'execute',{invoice_id:invoiceId,attempt_id:attempt});}
     catch(error){p=await read();check();if(!['Settled','Failed','Executing'].includes(p.state))throw error;}
     p=await read();check();
    }
    return p;
   },
   async submit(invoice, attempt) {
    if (invoice.id !== invoiceId) throw Error('wrong invoice');
    await callVault(transport,'execute', { invoice_id: invoiceId, attempt_id: attempt });
   },
   async status(attempt) {
    const p = await read();
    if (p.attempt_id !== attempt) throw Error('attempt mismatch');
    return p.state === 'Settled' ? 'settled' : p.state === 'Failed' ? 'failed' : 'unknown';
   }
  }
 };
}
