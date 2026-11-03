import {QuoteServiceError} from '../oneclick/quotes.ts';
export function publicError(error:unknown){
 if(error instanceof QuoteServiceError)return error.message;
 const message=error instanceof Error?error.message:'';
 for(const reason of ['vault payments paused','pause before replacing executor','merchant signature required','merchant key revoked','merchant key changed; approval invalidated','merchant key version mismatch','invalid merchant signature','merchant bill already used','signed invoice already bound','signed invoice expired or excessive lifetime','signed vault mismatch','signed domain mismatch','no spending policy','merchant not allowed','merchant payout mismatch','per-payment cap exceeded','rolling daily budget exceeded','policy expired','policy revoked','policy changed; approval invalidated','policy history capacity reached','invoice expired','invoice cancelled','insufficient budget','insufficient liquid balance','reservation has not expired','only confirmed failed transfers can be released','only authorized or expired reserved invoices can be cancelled','owner only','executor only','attempt mismatch','invoice mismatch']){
  if(message.includes(reason))return reason[0].toUpperCase()+reason.slice(1)+'.';
 }
 if(/^(Enter a positive|Sandbox invoices must|Invalid invoice reference|Invoice already bound|Unknown invoice|Reserve the invoice first|Settle the invoice|Unsupported simulation|invalid route|invalid positive|deadline must|quote request mismatch|unsupported quote request field|input exceeds|invalid 1Click signature|stale or future quote|Only a fresh|workflow id already|Base recipient|NEAR refund|Only NEAR-to-Base)/.test(message))return message.slice(0,300);
 return 'Request could not be confirmed. Refresh the invoice state before retrying.';
}
export function validateDeskPolicy(p:any){
 if(!p||typeof p!=='object')throw Error('Invalid invoice reference or policy.');
 if(p.originAsset!=='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'||p.destinationAsset!=='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near')throw Error('Only NEAR-to-Base USDC is supported by this desk.');
 if(typeof p.recipient!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(p.recipient))throw Error('Base recipient must be a 0x address with 40 hexadecimal characters.');
 if(typeof p.refundTo!=='string'||p.refundTo.length<2||p.refundTo.length>64||!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(p.refundTo))throw Error('NEAR refund must be a valid NEAR account ID.');
}
