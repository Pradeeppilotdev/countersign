import { type Authorization, type Invoice, type Payment, type Rail } from './core.ts';
// Transport is bound to one vault and its authorized executor account.
// No recipient/amount arguments are accepted by the contract's execute method.
export interface VaultTransport {
 call(method: string, args: Record<string, unknown>): Promise<Payment>;
 view(method: string, args: Record<string, unknown>): Promise<Payment | null>;
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
    return transport.call('reserve', { invoice, attempt_id: attempt });
   },
   async resolve(id, attempt, settled) {
    const p = await read();
    if (id !== invoiceId || p.attempt_id !== attempt || p.state !== (settled ? 'Settled' : 'Failed')) throw Error('unconfirmed result');
    return p; // Only the on-chain callback changes settlement state.
   }
  },
  rail: {
   async submit(invoice, attempt) {
    if (invoice.id !== invoiceId) throw Error('wrong invoice');
    await transport.call('execute', { invoice_id: invoiceId, attempt_id: attempt });
   },
   async status(attempt) {
    const p = await read();
    if (p.attempt_id !== attempt) throw Error('attempt mismatch');
    return p.state === 'Settled' ? 'settled' : p.state === 'Failed' ? 'failed' : 'unknown';
   }
  }
 };
}
