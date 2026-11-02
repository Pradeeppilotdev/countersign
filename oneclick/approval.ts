import {createHash} from 'node:crypto';
import {validateQuote,type Policy} from './quotes.ts';
export type DryRoute={invoice_id:string;origin_asset:string;destination_asset:string;recipient:string;refund_to:string;amount_out:string;max_amount_in:string;quoted_amount_in:string;expires_at:string;quote_hash:string;response_hash:string};
function digest(s:string){return createHash('sha256').update(s).digest('hex');}
// Full canonical JSON binds even metadata omitted from the provider signature.
function canonical(value:any):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export function routeCommitment(vault:string,r:DryRoute){
 const fields=[vault,r.invoice_id,r.origin_asset,r.destination_asset,r.recipient,r.refund_to,r.amount_out,r.max_amount_in,r.quoted_amount_in,r.expires_at,r.quote_hash,r.response_hash];
 return digest('NEAR-AEGIS-DRY-ROUTE-V1\n'+fields.map(s=>`${Buffer.byteLength(s)}:${s}`).join(''));
}
export function prepareRoute(invoiceId:string,policy:Policy,response:unknown,now=Date.now()):DryRoute {
 if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(invoiceId))throw Error('Invalid invoice id');
 const validated=validateQuote(policy,response,now);
 return {invoice_id:invoiceId,origin_asset:policy.originAsset,destination_asset:policy.destinationAsset,recipient:policy.recipient,refund_to:policy.refundTo,amount_out:policy.amountOut,max_amount_in:policy.maxAmountIn,quoted_amount_in:validated.amountIn,expires_at:String(validated.expiresAt),quote_hash:validated.quoteHash,response_hash:digest(canonical(response))};
}
export interface OwnerRouteTransport {vault:string;call(method:string,args:Record<string,unknown>):Promise<any>;view(method:string,args:Record<string,unknown>):Promise<any>}
