import { verifyQuoteSignature, quoteHash } from '@defuse-protocol/one-click-sdk-typescript';
export class QuoteServiceError extends Error {
 readonly status:number; readonly requestId:string|undefined;
 constructor(status:number,requestId:string|null){
  const safeId=requestId&&/^[A-Za-z0-9-]{1,100}$/.test(requestId)?requestId:undefined;
  const reason=status===521?'1Click is unavailable: its gateway reports the origin server is down':`1Click quote request failed`;
  super(`${reason} (HTTP ${status}). No quote was accepted. Retry later.${safeId?` Request ID: ${safeId}`:''}`);
  this.name='QuoteServiceError';this.status=status;this.requestId=safeId;
 }
}
export type Policy = { originAsset: string; destinationAsset: string; recipient: string; refundTo: string; amountOut: string; maxAmountIn: string; deadline: string };
function uint(x: unknown): bigint {
 if (typeof x !== 'string' || !/^[1-9][0-9]{0,38}$/.test(x) || BigInt(x) > (1n << 128n) - 1n) throw Error('invalid positive base-unit amount');
 return BigInt(x);
}
export function requestFor(p: Policy, now = Date.now()) {
 uint(p.amountOut); uint(p.maxAmountIn);
 for (const s of [p.originAsset,p.destinationAsset,p.recipient,p.refundTo]) if (typeof s !== 'string' || !s.length || s.length > 256 || s.trim() !== s) throw Error('invalid route');
 const deadline = Date.parse(p.deadline);
 if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 3_600_000) throw Error('deadline must be within one hour');
 return { dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 0, originAsset: p.originAsset, destinationAsset: p.destinationAsset, amount: p.amountOut, recipient: p.recipient, refundTo: p.refundTo, deadline: p.deadline, depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN' };
}
// Terms validation is separately exported for offline adversarial tests. It is NOT signature verification.
export function validateTerms(p: Policy, r: any, now = Date.now()) {
 const expected = requestFor(p, now);
 if (!r || !r.quote || !r.quoteRequest) throw Error('malformed quote');
 for (const [k,v] of Object.entries(expected)) if (r.quoteRequest[k] !== v) throw Error(`quote request mismatch: ${k}`);
 // Observed server defaults are accepted only for dry previews. The SDK excludes
 // some of these from its signature; none become execution authority.
 const defaults: Record<string, unknown> = { depositMode: 'SIMPLE', confidentiality: 'public', quoteWaitingTimeMs: 0, insured: false };
 for (const [k,v] of Object.entries(r.quoteRequest)) {
  if (k in expected) continue;
  if (k in defaults && v === defaults[k]) continue;
  if (k === 'appFees' && Array.isArray(v) && v.length <= 10 && v.every((f:any) => f && Object.keys(f).every(x=>['recipient','fee'].includes(x)) && typeof f.recipient === 'string' && f.recipient.length > 0 && f.recipient.length <= 256 && Number.isInteger(f.fee) && f.fee >= 0 && f.fee <= 10000)) continue;
  throw Error(`unsupported quote request field: ${k}`);
 }
 const t = Date.parse(r.timestamp);
 if (!Number.isFinite(t) || t > now + 5000 || now - t > 60_000) throw Error('stale or future quote');
 for (const k of ['depositAddress','depositMemo','chainDepositAddresses','virtualChainRecipient','virtualChainRefundRecipient','customRecipientMsg']) if (r.quote[k] !== undefined) throw Error('execution fields forbidden in dry quote');
 if (uint(r.quote.amountIn) > uint(p.maxAmountIn)) throw Error('input exceeds spending cap');
 if (uint(r.quote.amountOut) !== uint(p.amountOut) || uint(r.quote.minAmountOut) < uint(p.amountOut)) throw Error('invoice output not guaranteed');
 if (uint(r.quote.minAmountOut) > uint(r.quote.amountOut)) throw Error('inconsistent output');
 return { mode: 'DRY_RUN' as const, fundable: false as const, quoteHash: quoteHash(r), amountIn: r.quote.amountIn, amountOut: r.quote.amountOut, expiresAt: Math.min(t + 60_000, Date.parse(p.deadline)) };
}
export function validateQuote(p: Policy, r: any, now = Date.now()) {
 if (!verifyQuoteSignature(r)) throw Error('invalid 1Click signature');
 return validateTerms(p,r,now);
}
export async function preview(p: Policy, fetcher: typeof fetch = fetch) {
 // Snapshot owner-approved terms before awaiting network input.
 const policy = structuredClone(p), body = requestFor(policy);
 const response = await fetcher('https://1click.chaindefuser.com/v0/quote', { method:'POST', redirect:'error', signal: AbortSignal.timeout(15_000), headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
 if (!response.ok) {
  const error=new QuoteServiceError(response.status,response.headers.get('cf-ray'));
  await response.body?.cancel();throw error;
 }
 const raw = await response.json();
 return { validation: validateQuote(policy, raw), raw, rawNotice: 'Raw provider metadata is not all signed; only validation fields are trusted. Never fund a dry quote.' };
}
