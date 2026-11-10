// Hashes only. These let Ask Dave compare what is in the inbox with what the
// vault recorded: the invoice commitment and the signed merchant receipt.
// Both layouts must stay identical to executor/core.ts, merchant/invoice.ts and
// the contract; agent/ask.test.ts checks them against those files.
import {createHash} from 'node:crypto';

export type InvoiceTerms={id:string;payee:string;asset:string;amount:string};
export type SignedTerms={invoice:InvoiceTerms;merchant_id:string;bill_id:string;vault:string;domain:string;key_version:string;expires_at:string;service?:{agreement_id:string;period_start_ms:string}};
const strings=(values:unknown[])=>values.every(v=>typeof v==='string');
const framed=(values:string[])=>values.map(v=>`${Buffer.byteLength(v)}:${v}`).join('');

export function commitmentOf(i:InvoiceTerms):string|null{
 if(!i||!strings([i.id,i.payee,i.asset,i.amount]))return null;
 return createHash('sha256').update('NEAR-AEGIS-INVOICE-V1\n'+framed([i.id,i.payee,i.asset,i.amount])).digest('hex');
}
// The exact bytes a supplier signs.
export function signedBytes(s:SignedTerms){
 const values=[s.domain,s.vault,s.merchant_id,s.bill_id,s.key_version,s.expires_at,s.invoice.id,s.invoice.payee,s.invoice.asset,s.invoice.amount];
 if(s.service)values.push(s.service.agreement_id,s.service.period_start_ms);
 return Buffer.from((s.service?'COUNTERSIGN-SIGNED-INVOICE-V2\n':'COUNTERSIGN-SIGNED-INVOICE-V1\n')+framed(values));
}
// What the vault stores as payload_hash in get_invoice_auth.
export function payloadHash(s:SignedTerms):string|null{
 if(!s||!s.invoice||!strings([s.domain,s.vault,s.merchant_id,s.bill_id,s.key_version,s.expires_at,s.invoice.id,s.invoice.payee,s.invoice.asset,s.invoice.amount]))return null;
 if(s.service&&!strings([s.service.agreement_id,s.service.period_start_ms]))return null;
 return createHash('sha256').update(signedBytes(s)).digest('hex');
}
