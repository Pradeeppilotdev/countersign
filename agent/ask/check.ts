// "Is this invoice OK?" A local look at one invoice file before anyone pays it.
// No model and no outside network: it uses the facts pack and the same
// read-only vault views. It verifies the supplier's signature; it cannot make one.
import {createPublicKey,verify} from 'node:crypto';
import {formatNear,type FactsPack} from './facts.ts';
import {payloadHash,signedBytes,type SignedTerms} from './receipt.ts';
import type {View} from './views.ts';

// 'cannot verify' means the evidence needed to call a check good is missing. It is never rounded up to good.
export type Grade='good'|'caution'|'cannot verify'|'bad';
export type Check={check:string;result:Grade;reason:string};
type Bill={invoice:{id:string;payee:string;asset:string;amount:string};merchant_id:string;bill_id?:string;vault?:string;domain?:string;key_version?:string;expires_at?:string;service?:{agreement_id:string;period_start_ms:string};signature?:string};

const id=/^[A-Za-z0-9_.:-]{1,128}$/,number=/^[0-9]{1,39}$/;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length<=256;
function parse(raw:any):Bill|null{
 const i=raw?.invoice;
 if(!raw||typeof raw!=='object'||!i||typeof i!=='object'||![i.id,i.payee,i.asset,i.amount,raw.merchant_id].every(text)||!id.test(i.id)||!number.test(i.amount)||!id.test(raw.merchant_id))return null;
 const bill:Bill={invoice:{id:i.id,payee:i.payee,asset:i.asset,amount:i.amount},merchant_id:raw.merchant_id};
 if(raw.signature===undefined)return bill;
 if(![raw.bill_id,raw.vault,raw.domain,raw.key_version,raw.expires_at,raw.signature].every(text)||!number.test(raw.key_version)||!number.test(raw.expires_at))return null;
 Object.assign(bill,{bill_id:raw.bill_id,vault:raw.vault,domain:raw.domain,key_version:raw.key_version,expires_at:raw.expires_at,signature:raw.signature});
 if(raw.service!==undefined){
  if(!raw.service||!text(raw.service.agreement_id)||!text(raw.service.period_start_ms)||!number.test(raw.service.period_start_ms))return null;
  bill.service={agreement_id:raw.service.agreement_id,period_start_ms:raw.service.period_start_ms};
 }
 return bill;
}
function signatureMatches(bill:Bill,publicKey:string){
 try{
  const key=Buffer.from(publicKey,'base64'),signature=Buffer.from(bill.signature!,'base64');
  if(key.length!==32||signature.length!==64)return false;
  return verify(null,signedBytes(bill as SignedTerms),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:key.toString('base64url')},format:'jwk'}),signature);
 }catch{return false;}
}

// Names that read the same at a glance: 0/o, 1/l/i, 5/s, rn/m, vv/w, separators dropped.
const skeleton=(s:string)=>s.toLowerCase().replace(/rn/g,'m').replace(/vv/g,'w').replace(/0/g,'o').replace(/[1i]/g,'l').replace(/5/g,'s').replace(/[-_.:]/g,'');
function distance(a:string,b:string){
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
 return row[b.length];
}
export function lookalike(candidate:string,pinned:string){
 if(candidate===pinned)return false;
 return skeleton(candidate)===skeleton(pinned)||distance(candidate.toLowerCase(),pinned.toLowerCase())<=(Math.min(candidate.length,pinned.length)>=6?2:1);
}
const toYocto=(near:string|null)=>{if(!near)return null;const [w,f='']=near.split('.');return BigInt(w)*10n**24n+BigInt(f.padEnd(24,'0'));};
const big=(v:unknown)=>typeof v==='string'&&number.test(v)?BigInt(v):null;

export async function checkInvoice(raw:unknown,source:{vault:string;view:View;pack:FactsPack}){
 const {view,pack}=source,checks:Check[]=[];
 const add=(check:string,result:Grade,reason:string)=>checks.push({check,result,reason});
 const finish=(bill:Bill|null)=>({
  kind:'countersign.ask-dave.invoice-check',read_only:true,
  verdict:(checks.some(c=>c.result==='bad')?'bad':checks.some(c=>c.result==='cannot verify')?'cannot verify':checks.some(c=>c.result==='caution')?'caution':'good') as Grade,
  invoice:bill?{id:bill.invoice.id,merchant:bill.merchant_id,payee:bill.invoice.payee,amount_near:formatNear(bill.invoice.amount),bill_id:bill.bill_id??null}:null,
  checks,
 });
 const bill=parse(raw);
 if(!bill){add('file','bad','This is not a readable invoice file.');return finish(null);}
 const amount=BigInt(bill.invoice.amount),near=`${formatNear(amount)} NEAR`;
 const snapshot:any=pack.vault.policy_snapshot,policy=snapshot?.policy??null;
 const suppliers:{id:string;payee:string}[]=(policy?.merchants??[]).map((m:any)=>({id:String(m.id),payee:String(m.payee)}));
 const pinned=suppliers.find(s=>s.id===bill.merchant_id);

 // 1. Does the money go to the account pinned for this supplier?
 if(!pinned)add('pinned_payee','caution',`"${bill.merchant_id}" is not one of your pinned suppliers, so your agent cannot pay it.`);
 else if(pinned.payee!==bill.invoice.payee)add('pinned_payee','bad',`It pays ${bill.invoice.payee}, not ${pinned.payee}, the account pinned for ${pinned.id}.`);
 else add('pinned_payee','good',`It pays ${pinned.payee}, the account pinned for ${pinned.id}.`);

 // 2. Did the supplier really sign exactly this invoice?
 const key:any=await view('get_merchant_key',{merchant_id:bill.merchant_id})??null;
 const now=big(snapshot?.now);
 if(bill.signature===undefined)add('signature',key?.public_key?'bad':'caution',key?.public_key?`It is not signed, and ${bill.merchant_id} has a signing key pinned.`:'It is not signed, and no signing key is pinned for this supplier.');
 else if(bill.vault!==source.vault)add('signature','bad','It was signed for a different vault.');
 else if(bill.domain!==(await view('get_invoice_domain',{})??null))add('signature','bad','It was signed for a different signing domain.');
 else if(!key)add('signature','caution','No signing key is pinned for this supplier, so the signature cannot be checked.');
 else if(!key.public_key)add('signature','bad','The signing key for this supplier was revoked.');
 else if(String(key.version)!==bill.key_version)add('signature','bad',`It was signed with key version ${bill.key_version}; the pinned key is version ${key.version}.`);
 else if(!signatureMatches(bill,String(key.public_key)))add('signature','bad','The signature does not match the invoice. It was changed after signing, or signed by someone else.');
 else if(now!==null&&BigInt(bill.expires_at!)<=now)add('signature','caution','The signature is genuine but has expired. Ask the supplier for a fresh invoice.');
 else add('signature','good',`Signed by ${bill.merchant_id} with the pinned key, unchanged since signing.`);

 // 3. Was this invoice, bill or service week paid already?
 const payment:any=await view('get_payment',{invoice_id:bill.invoice.id})??null;
 const sameBill=bill.bill_id===undefined?[]:pack.invoices.filter(i=>i.id!==bill.invoice.id&&i.merchant===bill.merchant_id&&i.signed?.bill_id===bill.bill_id);
 const paidTwin=sameBill.find(i=>i.outcome==='paid');
 const weekWinner:any=bill.service?await view('get_service_claim',{service:bill.service})??null:null;
 if(paidTwin)add('already_paid','bad',`Bill ${bill.bill_id} was already paid as invoice ${paidTwin.id}.`);
 else if(typeof weekWinner==='string'&&weekWinner!==bill.invoice.id)add('already_paid','bad',`This service week was already claimed by invoice ${weekWinner}.`);
 else if(payment){
  const receipt:any=bill.signature===undefined?null:await view('get_invoice_auth',{invoice_id:bill.invoice.id})??null;
  const same=String(payment.invoice?.amount)===bill.invoice.amount&&String(payment.invoice?.payee)===bill.invoice.payee&&(!receipt||receipt.payload_hash===payloadHash(bill as SignedTerms));
  if(!same)add('already_paid','bad',`The vault already holds a different invoice under the number ${bill.invoice.id} (${String(payment.state).toLowerCase()}).`);
  else if(payment.state==='Settled')add('already_paid','caution','This invoice was already paid. The vault will not pay it twice.');
  else add('already_paid','caution',`This invoice is already in the vault as ${String(payment.state).toLowerCase()}.`);
 }
 else if(sameBill.length)add('already_paid','caution',`Bill ${bill.bill_id} is already in the inbox as invoice ${sameBill[0].id} (${sameBill[0].outcome}).`);
 else add('already_paid','good','Not paid or claimed before.');

 // 4. Would your rules let the agent pay it right now?
 const blocks:string[]=[];
 const per=big(policy?.per_payment),limit=big(policy?.daily_limit),min=big(snapshot?.min_payment),usage=big(snapshot?.usage),available=big(pack.vault.available_yocto);
 if(pack.vault.controls?.paused)blocks.push('the vault is paused');
 if(!policy)blocks.push('there is no spending policy');
 else{
  if(now!==null&&big(policy.expires_at)!==null&&big(policy.expires_at)!<=now)blocks.push('the spending policy has expired');
  if(!pinned)blocks.push('the supplier is not on the policy');
  if(bill.invoice.asset!=='near')blocks.push('only NEAR invoices can be paid');
  if(per!==null&&amount>per)blocks.push(`${near} is over the ${formatNear(per)} NEAR per-payment limit`);
  if(min!==null&&amount<min)blocks.push(`${near} is under the ${formatNear(min)} NEAR minimum`);
  if(limit!==null&&usage!==null&&usage+amount>limit)blocks.push(`${near} is more than the ${formatNear(limit>usage?limit-usage:0n)} NEAR left in the rolling 24-hour budget`);
 }
 if(available!==null&&amount>available)blocks.push(`the vault holds only ${formatNear(available)} NEAR`);
 const service:any=bill.service?await view('get_weekly_service',{agreement_id:bill.service.agreement_id})??null:null;
 const cap=big(service?.cap);
 if(service?.revoked)blocks.push(`weekly service ${bill.service!.agreement_id} was revoked`);
 else if(service&&cap!==null&&amount>cap)blocks.push(`${near} is over the ${formatNear(cap)} NEAR weekly service limit`);
 if(blocks.length)add('fits_policy','caution',`Your rules would block it: ${blocks.join('; ')}.`);
 else add('fits_policy','good',`${near} fits your rules: within the ${formatNear(per)} NEAR per-payment limit and the rolling 24-hour budget.`);

 // 5. Weekly bills: is this the right agreement, for this supplier, for the current week?
 // Good needs positive evidence for every part; anything unread is "cannot verify".
 const enrolled=pack.vault.weekly_services.filter(w=>w.service&&!w.service.revoked&&w.service.merchant_id===bill.merchant_id).map(w=>w.agreement_id);
 if(bill.service){
  const name=bill.service.agreement_id;
  const current:any=service&&!service.revoked?await view('current_service_period',{agreement_id:name})??null:null;
  if(!service)add('service_week','cannot verify',`Weekly service "${name}" could not be found in this vault, so the week on this bill cannot be checked.`);
  else if(typeof service.merchant_id!=='string'||typeof service.payee!=='string')add('service_week','cannot verify',`The vault's record of weekly service "${name}" is incomplete.`);
  else if(service.merchant_id!==bill.merchant_id||service.payee!==bill.invoice.payee)add('service_week','bad',`Weekly service "${name}" belongs to supplier ${service.merchant_id}, not ${bill.merchant_id}.`);
  else if(service.revoked)add('service_week','caution',`You cancelled weekly service "${name}".`);
  else if(typeof current?.period_start_ms!=='string'||!number.test(current.period_start_ms))add('service_week','cannot verify',`The vault did not say which week of "${name}" is current, so the week on this bill cannot be checked.`);
  else if(BigInt(bill.service.period_start_ms)>BigInt(current.period_start_ms))add('service_week','caution','This bill is for a week that has not started yet.');
  else if(BigInt(bill.service.period_start_ms)<BigInt(current.period_start_ms))add('service_week','caution','This bill is for a past week, not the current one.');
  else add('service_week','good',`It is for the current week of "${name}", your weekly service with ${bill.merchant_id}.`);
 }
 else if(enrolled.length)add('service_week','caution',`${bill.merchant_id} bills you weekly ("${enrolled.join('", "')}"), and this bill does not say which week it covers. The vault will refuse it.`);

 // 6. Is the name a near-copy of a supplier you trust?
 const copies:string[]=[];
 for(const s of suppliers){
  if(!pinned&&lookalike(bill.merchant_id,s.id))copies.push(`supplier name "${bill.merchant_id}" looks like your pinned supplier "${s.id}" but is not the same`);
  if(bill.invoice.payee!==s.payee&&!suppliers.some(p=>p.payee===bill.invoice.payee)&&lookalike(bill.invoice.payee,s.payee))copies.push(`payout account "${bill.invoice.payee}" looks like the pinned account "${s.payee}" but is not the same`);
 }
 if(copies.length)add('lookalike','caution',`Lookalike: ${[...new Set(copies)].join('; ')}.`);
 else add('lookalike','good','No lookalike of a pinned supplier name or account.');

 // 7. Is the amount unusual for this supplier?
 const history=pack.totals.per_merchant.find(m=>m.merchant===bill.merchant_id);
 const median=toYocto(history?.median_paid_near??null);
 if(median===null||median===0n)add('amount_vs_median','good','No paid invoices from this supplier yet to compare with.');
 else if(amount>3n*median)add('amount_vs_median','caution',`${near} is more than 3x the usual ${formatNear(median)} NEAR paid to ${bill.merchant_id}.`);
 else add('amount_vs_median','good',`${near} is in line with the usual ${formatNear(median)} NEAR paid to ${bill.merchant_id}.`);
 return finish(bill);
}
