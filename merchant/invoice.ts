import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {commitment,type Invoice} from '../executor/core.ts';
export type ServicePeriod = {agreement_id:string; period_start_ms:string};
export type SignedInvoice={invoice:Invoice;merchant_id:string;bill_id:string;vault:string;domain:string;key_version:string;expires_at:string;service?:ServicePeriod;signature:string};
export type MerchantKey={version:string;public_key:string|null};
const fields=['invoice','merchant_id','bill_id','vault','domain','key_version','expires_at','signature'];
const legacyFields=[...fields].sort().join(',');
const serviceFields=[...fields,'service'].sort().join(',');
const idPattern=/^[A-Za-z0-9_.:-]{1,128}$/;
const u64Max=(1n<<64n)-1n;
export function validMillis(value:unknown):value is string {
 return typeof value==='string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value)<=u64Max;
}
function base64(value:unknown,length:number){
 if(typeof value!=='string')throw Error('Invalid signature/key encoding');
 const bytes=Buffer.from(value,'base64');
 if(bytes.length!==length||bytes.toString('base64')!==value)throw Error('Invalid signature/key encoding');return bytes;
}
export function parseSignedInvoice(value:unknown):SignedInvoice{
 const s=value as SignedInvoice;
 if(!s||typeof s!=='object'||Array.isArray(s))throw Error('Invalid signed invoice fields');
 const hasService=Object.hasOwn(s,'service');
 if(Object.keys(s).sort().join(',')!==(hasService?serviceFields:legacyFields))throw Error('Invalid signed invoice fields');
 let service:ServicePeriod|undefined;
 if(hasService){
  const period=s.service;
  if(!period||typeof period!=='object'||Array.isArray(period)||Object.keys(period).sort().join(',')!=='agreement_id,period_start_ms'||
     typeof period.agreement_id!=='string'||!idPattern.test(period.agreement_id)||!validMillis(period.period_start_ms))throw Error('Invalid signed service period');
  service={agreement_id:period.agreement_id,period_start_ms:period.period_start_ms};
 }
 if(!s.invoice||Object.keys(s.invoice).sort().join(',')!=='amount,asset,id,payee'||!Object.values(s.invoice).every(v=>typeof v==='string')||s.invoice.asset!=='near')throw Error('Invalid signed invoice terms');
 commitment(s.invoice);
 for(const id of [s.merchant_id,s.bill_id])if(typeof id!=='string'||!idPattern.test(id))throw Error('Invalid merchant bill id');
 commitment({...s.invoice,payee:s.vault});
 if(typeof s.domain!=='string'||!/^[0-9a-f]{64}$/.test(s.domain))throw Error('Invalid signing domain');
 for(const n of [s.key_version,s.expires_at])if(typeof n!=='string'||!/^([1-9][0-9]*)$/.test(n)||BigInt(n)>(1n<<64n)-1n)throw Error('Invalid signature version/expiry');
 base64(s.signature,64);return {invoice:{id:s.invoice.id,payee:s.invoice.payee,asset:s.invoice.asset,amount:s.invoice.amount},merchant_id:s.merchant_id,bill_id:s.bill_id,vault:s.vault,domain:s.domain,key_version:s.key_version,expires_at:s.expires_at,...(service?{service}:{}),signature:s.signature};
}
export function signingBytes(s:SignedInvoice){
 const values=[s.domain,s.vault,s.merchant_id,s.bill_id,s.key_version,s.expires_at,s.invoice.id,s.invoice.payee,s.invoice.asset,s.invoice.amount];
 if(s.service)values.push(s.service.agreement_id,s.service.period_start_ms);
 const prefix=s.service?'COUNTERSIGN-SIGNED-INVOICE-V2\n':'COUNTERSIGN-SIGNED-INVOICE-V1\n';
 return Buffer.from(prefix+values.map(v=>`${Buffer.byteLength(v)}:${v}`).join(''));
}
// The vault keeps this signed payload hash even after the key rotates or the bill expires.
export function matchesInvoiceReceipt(signed:SignedInvoice|null,receipt:unknown):boolean{
 if(signed===null)return receipt===null;
 if(!receipt||typeof receipt!=='object'||!('payload_hash' in receipt))return false;
 return receipt.payload_hash===createHash('sha256').update(signingBytes(signed)).digest('hex');
}
// Merchant-side utility: callers retain the private key; no agent/model receives it.
export function signInvoice(unsigned:Omit<SignedInvoice,'signature'>,privateKey:KeyObject):SignedInvoice{
 const s=parseSignedInvoice({...unsigned,signature:Buffer.alloc(64).toString('base64')});
 if(privateKey.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signing key required');
 return {...s,signature:sign(null,signingBytes(s),privateKey).toString('base64')};
}
export function publicKeyBase64(key:KeyObject){
 const jwk=key.export({format:'jwk'});if(jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||!jwk.x)throw Error('Ed25519 public key required');
 return Buffer.from(jwk.x,'base64url').toString('base64');
}
export function verifySignedInvoice(raw:unknown,expected:{vault:string;domain:string|null;key:MerchantKey|null},now=Date.now()):SignedInvoice{
 const s=parseSignedInvoice(raw);
 if(s.vault!==expected.vault)throw Error('Signed vault mismatch');
 if(s.domain!==expected.domain)throw Error('Signed domain mismatch');
 if(!expected.key?.public_key)throw Error('Merchant key missing or revoked');
 if(s.key_version!==expected.key.version)throw Error('Merchant key version mismatch');
 if(BigInt(s.expires_at)<=BigInt(now)||BigInt(s.expires_at)>BigInt(now)+86_400_000n)throw Error('Signed invoice expired or excessive lifetime');
 const key=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:base64(expected.key.public_key,32).toString('base64url')},format:'jwk'});
 if(!verify(null,signingBytes(s),key,base64(s.signature,64)))throw Error('Invalid merchant signature');
 return s;
}
