import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { base58 } from '@scure/base';
import { quoteHash, verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestFor, validateTerms, validateQuote, preview, QuoteServiceError } from './quotes.ts';
import { SimulationTracker } from './tracker.ts';
const now = Date.now();
const p = {originAsset:'nep141:fixture.near',destinationAsset:'nep141:base-fixture.near',recipient:'fixture-payee',refundTo:'fixture-refund',amountOut:'1000000',maxAmountIn:'1100000',deadline:new Date(now+600000).toISOString()};
function fixture(): any {return {timestamp:new Date(now).toISOString(),quoteRequest:requestFor(p,now),quote:{amountIn:'1050000',amountOut:'1000000',minAmountOut:'1000000'},signature:'invalid'};}
test('valid terms, exact output, cap and immutable routing',()=>{
 assert.equal(validateTerms(p,fixture(),now).fundable,false);
 for (const [field,value] of Object.entries({recipient:'attacker',refundTo:'attacker',originAsset:'other',destinationAsset:'other',amount:'1',dry:false,swapType:'EXACT_INPUT'})) {
  const r=fixture();r.quoteRequest[field]=value;assert.throws(()=>validateTerms(p,r,now));
 }
 for (const patch of [{amountIn:'1100001'},{minAmountOut:'999999'},{amountOut:'1000001'},{amountIn:'01'},{depositAddress:'attacker'},{depositMemo:'1'}]) {const r=fixture();Object.assign(r.quote,patch);assert.throws(()=>validateTerms(p,r,now));}
 const r=fixture();r.quoteRequest.depositMode='MEMO';assert.throws(()=>validateTerms(p,r,now));
 assert.throws(()=>validateTerms(p,fixture(),now+61000));
 assert.throws(()=>requestFor({...p,deadline:'bad'},now));
});
test('SDK cryptographic verification rejects tampering and untrusted signing keys',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const key='ed25519:'+base58.encode(publicKey.export({type:'spki',format:'der'}).subarray(-32));
 const r=fixture();r.signature='ed25519:'+base58.encode(sign(null,Buffer.from(quoteHash(r)),privateKey));
 assert.equal(verifyQuoteSignature(r,key),true);
 assert.throws(()=>validateQuote(p,r,now),/signature/); // Test signer is not the official signer.
 r.quoteRequest.recipient='attacker';assert.equal(verifyQuoteSignature(r,key),false);
});
test('network client only sends dry quote request and rejects unsigned response',async()=>{
 let calls=0;
 const fake=async(url: any,options: any)=>{calls++;assert.equal(url,'https://1click.chaindefuser.com/v0/quote');assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).dry,true);return new Response(JSON.stringify(fixture()),{status:200});};
 await assert.rejects(()=>preview(p,fake as typeof fetch),/signature/);assert.equal(calls,1);
 await assert.rejects(()=>preview(p,(async()=>new Response('',{status:503})) as typeof fetch),/503/);
});
test('simulation persists across restart; duplicate/stale events, conflicts and unknown outcomes never unlock payments',()=>{
 const dir=mkdtempSync(join(tmpdir(),'countersign-1click-'));const file=join(dir,'simulation.db');let db=new SimulationTracker(file);
 try {
 db.register('a','quote-a');db.register('a','quote-a');assert.throws(()=>db.register('a','quote-b'));
 const event=(status:string,t:number)=>({quoteHash:'quote-a',status,updatedAt:new Date(now+t).toISOString()});
 assert.equal(db.observe('a',event('PROCESSING',1)).state,'SIMULATED_PROCESSING');
 db.close();db=new SimulationTracker(file);
 assert.equal(db.get('a').state,'SIMULATED_PROCESSING');
 assert.throws(()=>db.observe('a',{...event('SUCCESS',2),quoteHash:'other'}));
 assert.equal(db.observe('a',event('FAILED',3)).state,'NEEDS_REVIEW');
 assert.equal(db.observe('a',event('SUCCESS',4)).state,'NEEDS_REVIEW');
 db.register('b','quote-a');assert.equal(db.observe('b',event('SUCCESS',5)).state,'SIMULATED_PROVIDER_SUCCESS');
 assert.equal(db.observe('b',event('PROCESSING',1)).state,'SIMULATED_PROVIDER_SUCCESS');
 assert.equal(db.observe('b',event('REFUNDED',6)).state,'NEEDS_REVIEW');
 db.register('c','quote-a');assert.equal(db.observe('c',event('NEW_UNKNOWN_STATUS',1)).state,'NEEDS_REVIEW');
 db.register('d','quote-a');assert.equal(db.observe('d',event('REFUNDED',1)).state,'SIMULATED_PROVIDER_REFUND');
 }finally{db.close();rmSync(dir,{recursive:true});}
});

test('recorded live 1Click quote verifies with official key and observed defaults',()=>{
 const r=JSON.parse(readFileSync(new URL('./fixtures/live-dry-quote.json',import.meta.url),'utf8'));
 const policy=JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
 const captured=Date.parse(r.timestamp);
 assert.equal(verifyQuoteSignature(r),true);
 const result=validateQuote(policy,r,captured);
 assert.equal(result.fundable,false);assert.equal(result.amountOut,policy.amountOut);
 assert.equal('appFees' in result,false);
 assert.throws(()=>validateQuote(policy,r,captured+61000));
 for(const field of ['recipient','refundTo','originAsset','destinationAsset']) {
  const changed=structuredClone(r);changed.quoteRequest[field]='attacker';assert.throws(()=>validateQuote(policy,changed,captured),/signature/);
 }
 const changed=structuredClone(r);changed.quote.amountIn='1';assert.throws(()=>validateQuote(policy,changed,captured),/signature/);
 const unsigned=structuredClone(r);unsigned.quoteRequest.depositMode='MEMO';assert.throws(()=>validateQuote(policy,unsigned,captured),/unsupported/);
});

test('provider outage fails closed once with safe diagnostics and no HTML disclosure',async()=>{
 let calls=0;
 const fetcher=async()=>{calls++;return new Response('<html>untrusted provider body</html>',{status:521,headers:{'cf-ray':'abc123-BOM'}});};
 await assert.rejects(()=>preview(p,fetcher as typeof fetch),error=>{
  assert.ok(error instanceof QuoteServiceError);assert.equal(error.status,521);assert.equal(error.requestId,'abc123-BOM');
  assert.match(error.message,/origin server is down/);assert.ok(!error.message.includes('untrusted provider body'));return true;
 });
 assert.equal(calls,1);
 assert.equal(new QuoteServiceError(521,'invalid request id <script>').requestId,undefined);
});
