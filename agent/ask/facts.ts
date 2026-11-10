// Ask Dave, step 1: the facts pack. Everything here is read and arithmetic.
// No model is involved, and nothing in agent/ask can pay, approve, cancel or
// change a rule: the only inputs are a read-only copy of the inbox and
// allowlisted contract views pinned to one block.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {AskError,openVaultReader,type View} from './views.ts';
import {readInbox,type InboxCopy,type InboxRow} from './inbox-reader.ts';
import {explain} from './glossary.ts';

const YOCTO=10n**24n;
const digits=(value:unknown):value is string=>typeof value==='string'&&/^[0-9]{1,39}$/.test(value);
export function formatNear(yocto:bigint|string|null|undefined):string|null{
 if(typeof yocto==='string'){if(!digits(yocto))return null;yocto=BigInt(yocto);}
 if(typeof yocto!=='bigint')return null;
 const sign=yocto<0n?'-':'';if(yocto<0n)yocto=-yocto;
 const fraction=(yocto%YOCTO).toString().padStart(24,'0').replace(/0+$/,'');
 return sign+(yocto/YOCTO).toString()+(fraction?'.'+fraction:'');
}
const iso=(ms:unknown)=>digits(ms)&&BigInt(ms)<=8_640_000_000_000_000n?new Date(Number(ms)).toISOString():null;
function median(values:bigint[]){
 const sorted=[...values].sort((a,b)=>a<b?-1:a>b?1:0),middle=sorted.length>>1;
 return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2n;
}

export type Outcome='queued'|'proposed'|'pending'|'paid'|'blocked'|'failed'|'cancelled';
// Fixed contract/agent wording → one stable category. Unknown wording stays 'other'
// and is always reported with its original text.
const reasonTable:[string,string[]][]=[
 ['period_claimed',['service period already claimed']],
 ['duplicate_bill',['merchant bill already used','signed invoice already bound']],
 ['rejected_signature',['invalid merchant signature','merchant signature required','merchant key revoked','merchant key changed','merchant key version mismatch','merchant key missing','signed vault mismatch','signed domain mismatch','signed invoice differs']],
 ['over_limit',['per-payment cap exceeded','rolling daily budget exceeded','service payment cap exceeded','below policy minimum','insufficient budget','insufficient liquid balance','policy history capacity reached','pending policy capacity reached']],
 ['expired',['signed invoice expired','invoice expired','outside current service period']],
 ['policy',['no spending policy','policy expired','policy revoked','policy changed','merchant not allowed','merchant payout mismatch','signed service period required','unknown service agreement','service agreement revoked','service merchant or payout mismatch','service claim mismatch']],
 ['vault_paused',['vault payments paused']],
 ['unconfirmed',['payment outcome pending','could not be confirmed']],
 ['model_proposal',['model proposal unavailable or rejected','proposal superseded']],
];
export function reasonCode(error:string|null){
 if(!error)return null;
 const text=error.toLowerCase();
 return reasonTable.find(([,phrases])=>phrases.some(p=>text.includes(p)))?.[0]??'other';
}

type Payment={invoice?:{amount?:unknown};commitment?:unknown;state?:unknown;attempt_id?:unknown}|null|undefined;
function classify(row:InboxRow,payment:Payment):{outcome:Outcome;reason:string|null}{
 const chain=payment?.state,reason=reasonCode(row.error);
 // The vault holds some other invoice under this number: nothing it says applies to this bill.
 if(payment&&(row.commitment===null||payment.commitment!==row.commitment))return {outcome:row.state==='cancelled'?'cancelled':'blocked',reason:'invoice_id_taken'};
 if(chain==='Settled')return {outcome:'paid',reason:null};
 if(chain==='Failed')return {outcome:'failed',reason:'transfer_failed'};
 if(chain==='Cancelled'||row.state==='cancelled')return {outcome:'cancelled',reason:null};
 if(chain==='Reserved'||chain==='Executing')return {outcome:'pending',reason:'payment_in_flight'};
 if(row.state==='period_claimed')return {outcome:'blocked',reason:'period_claimed'};
 if(row.state==='proposal_failed')return {outcome:'failed',reason:'model_proposal'};
 if(row.state==='settled'||row.state==='failed')return {outcome:'pending',reason:'not_confirmed_on_chain'};
 if(row.error)return reason==='unconfirmed'?{outcome:'pending',reason}:{outcome:'blocked',reason};
 if(row.state==='inference_pending')return {outcome:'pending',reason:'awaiting_model'};
 if(row.state==='queued')return {outcome:'queued',reason:null};
 return chain==='Authorized'?{outcome:'pending',reason:'approved_not_sent'}:{outcome:'proposed',reason:null};
}

export type FactsSource={vault:string;block_height:number;view:View;inbox:InboxCopy;upgrade_pending?:boolean};
export async function buildFacts(source:FactsSource){
 const {view,inbox}=source,unavailable=new Set<string>();
 const read=async(method:Parameters<View>[0],args:Record<string,unknown>={})=>{
  const value=await view(method,args);
  if(value===undefined){unavailable.add(method);return null;}
  return value as any;
 };
 const snapshot=await read('policy_snapshot'),capacity=await read('policy_capacity');
 const available=await read('available_balance'),controls=await read('get_vault_controls');
 const policy=snapshot?.policy??null,now=digits(snapshot?.now)?BigInt(snapshot.now):null;
 const past=(ms:unknown)=>now!==null&&digits(ms)?BigInt(ms)<=now:null;

 const flags:{type:string;invoice_id:string;merchant:string;amount_near:string|null;detail:string}[]=[];
 const invoices=[];
 const unattributed:{invoice_id:string;inbox_merchant:string;receipt_merchant:string|null;amount_near:string|null;amount:bigint;reason:string}[]=[];
 for(const row of inbox.rows){
  const invoice_id=row.id;
  const payment:Payment=await read('get_payment',{invoice_id});
  const auth=await read('get_invoice_auth',{invoice_id}),expiry=await read('invoice_expiry',{invoice_id});
  const service_claim=row.signed?.service?await read('get_service_claim',{service:row.signed.service}):null;
  const {outcome,reason}=classify(row,payment);
  const amount=digits(row.invoice.amount)?BigInt(row.invoice.amount):null;
  const chainAmount=digits(payment?.invoice?.amount)?BigInt(payment!.invoice!.amount as string):null;
  const flag=(type:string,detail:string)=>{flags.push({type,invoice_id,merchant:row.merchant,amount_near:formatNear(amount),detail});mine.push(type);};
  const mine:string[]=[];
  // A payment is credited to a supplier only on the vault's own evidence: the
  // payment is this exact invoice, and the signed receipt names this supplier
  // and this exact signed bill.
  const settled=payment?.state==='Settled'&&chainAmount!==null;
  let attribution:null|'verified'|'unattributed'=null,attribution_reason:string|null=null;
  if(settled&&outcome==='paid'){
   if(!auth)attribution_reason='The vault holds no signed supplier receipt for this payment.';
   else if(auth.merchant_id!==row.merchant)attribution_reason=`The vault's signed receipt names supplier ${auth.merchant_id}, not ${row.merchant}.`;
   else if(!row.signed?.payload_hash||auth.payload_hash!==row.signed.payload_hash)attribution_reason='The signed bill in the inbox is not the one the vault paid.';
   attribution=attribution_reason?'unattributed':'verified';
  }else if(settled){attribution='unattributed';attribution_reason='The vault paid a different invoice under this invoice number.';}
  if(attribution==='unattributed'){
   unattributed.push({invoice_id,inbox_merchant:row.merchant,receipt_merchant:typeof auth?.merchant_id==='string'?auth.merchant_id:null,amount_near:formatNear(chainAmount),amount:chainAmount!,reason:attribution_reason!});
   flag('unattributed_payment',attribution_reason!);
  }
  if(outcome==='blocked')flag('blocked_attempt',row.error??explain(null,reason)?.meaning??'Blocked.');
  if(outcome==='failed')flag('failed_attempt',row.error??(reason==='transfer_failed'?'The transfer failed on chain; the budget was returned or awaits release.':'Failed.'));
  if(reason==='rejected_signature')flag('rejected_signature',row.error!);
  if(reason==='duplicate_bill')flag('duplicate_bill',row.error!);
  if(reason==='period_claimed')flag('period_claimed',row.error??`Service period claimed by ${service_claim}.`);
  if(outcome==='pending')flag('stuck_pending',({payment_in_flight:`On-chain state is ${payment?.state}; the outcome is not final.`,awaiting_model:'Model inference started and never finished.',approved_not_sent:'Approved on chain; payment not sent.',not_confirmed_on_chain:`Inbox says ${row.state} but the vault does not confirm it.`,unconfirmed:row.error??''} as Record<string,string>)[reason!]??'Pending.');
  const lapsed=past(expiry)===true||(expiry===null&&past(row.signed?.expires_at)===true);
  if(lapsed&&['queued','proposed','pending'].includes(outcome)&&payment?.state!=='Executing')flag('expired_unpaid','The invoice deadline passed before it was paid.');
  if((row.state==='settled')!==(payment?.state==='Settled')||(row.state==='failed')!==(payment?.state==='Failed')||(chainAmount!==null&&chainAmount!==amount))
   flag('state_mismatch',`Inbox: ${row.state}, ${formatNear(amount)} NEAR. Vault: ${payment?`${payment.state}, ${formatNear(chainAmount)} NEAR`:'no record'}.`);
  invoices.push({
   id:invoice_id,merchant:row.merchant,payee:row.invoice.payee,
   amount_near:formatNear(amount),amount_yocto:row.invoice.amount,
   state:row.state,error:row.error,outcome,reason,attribution,attribution_reason,
   // Fixed glossary text for this error or outcome; null when there is nothing to explain.
   explanation:explain(row.error,reason),
   signed:row.signed?{bill_id:row.signed.bill_id,key_version:row.signed.key_version,expires_at_ms:row.signed.expires_at,expires_at:iso(row.signed.expires_at),service:row.signed.service}:null,
   agent:{generation:row.generation,has_proposal:row.has_proposal,attempt_state:row.attempt_state},
   chain:{
    payment:payment?{state:payment.state,attempt_id:payment.attempt_id??null,amount_near:formatNear(chainAmount),commitment:payment.commitment,same_invoice:row.commitment!==null&&payment.commitment===row.commitment}:null,
    invoice_auth:auth,invoice_expiry_ms:expiry,invoice_expiry:iso(expiry),expired:past(expiry),service_claim,
   },
   flags:mine,
   // Working values for the totals below; removed before output.
   paid:attribution==='verified'?chainAmount:null,amount,
  });
 }

 // Totals. Paid amounts come from the vault's own payment record.
 const merchants=new Map<string,typeof invoices>();
 for(const i of invoices)merchants.set(i.merchant,[...(merchants.get(i.merchant)??[]),i]);
 const sum=(values:(bigint|null)[])=>values.reduce<bigint>((a,b)=>a+(b??0n),0n);
 const outcomes:Outcome[]=['queued','proposed','pending','paid','blocked','failed','cancelled'];
 const tally=(list:typeof invoices)=>Object.fromEntries(outcomes.map(o=>[o,list.filter(i=>i.outcome===o).length])) as Record<Outcome,number>;
 const per_merchant=[...merchants].map(([merchant,list])=>{
  const paid=list.flatMap(i=>i.paid===null?[]:[i.paid]);
  const mid=paid.length?median(paid):null;
  if(mid!==null)for(const i of list)if(i.amount!==null&&i.amount>3n*mid){
   const detail=`${formatNear(i.amount)} NEAR is more than 3x this merchant's median paid invoice of ${formatNear(mid)} NEAR (${paid.length} paid).`;
   flags.push({type:'over_3x_median',invoice_id:i.id,merchant,amount_near:formatNear(i.amount),detail});i.flags.push('over_3x_median');
  }
  return {merchant,invoices:list.length,counts:tally(list),paid_near:formatNear(sum(paid)),paid_yocto:sum(paid).toString(),
   median_paid_near:formatNear(mid),largest_paid_near:paid.length?formatNear(paid.reduce((a,b)=>a>b?a:b)):null,
   not_paid_near:formatNear(sum(list.filter(i=>i.outcome==='blocked'||i.outcome==='failed').map(i=>i.amount)))};
 });
 const usage=digits(snapshot?.usage)?BigInt(snapshot.usage):null,limit=digits(policy?.daily_limit)?BigInt(policy.daily_limit):null;

 // Weekly services can only be discovered through the bills that name them:
 // the contract has no view that lists agreements.
 const agreements=[...new Set(inbox.rows.flatMap(r=>r.signed?.service?[r.signed.service.agreement_id]:[]))];
 const weekly_services=[],weeks=[];
 for(const agreement_id of agreements){
  const service=await read('get_weekly_service',{agreement_id}),current=await read('current_service_period',{agreement_id});
  const billed=invoices.filter(i=>i.signed?.service?.agreement_id===agreement_id);
  const periods=[];
  for(const period_start_ms of [...new Set(billed.map(i=>i.signed!.service!.period_start_ms))].sort((a,b)=>Number(BigInt(a)-BigInt(b)))){
   const inPeriod=billed.filter(i=>i.signed!.service!.period_start_ms===period_start_ms);
   const period={period_start_ms,period_start:iso(period_start_ms),claimed_by:await read('get_service_claim',{service:{agreement_id,period_start_ms}}),
    invoices:inPeriod.map(i=>i.id),paid_near:formatNear(sum(inPeriod.map(i=>i.paid)))};
   periods.push(period);weeks.push({agreement_id,...period});
  }
  weekly_services.push({agreement_id,
   service:service?{merchant_id:service.merchant_id,payee:service.payee,cap_near:formatNear(service.cap),anchor_ms:service.anchor_ms,anchor:iso(service.anchor_ms),revoked:service.revoked}:null,
   current_period:current?{period_start_ms:current.period_start_ms,period_start:iso(current.period_start_ms),claimed_by:await read('get_service_claim',{service:current})}:null,
   periods});
 }
 const merchant_keys=[];
 for(const merchant_id of new Set<string>([...(policy?.merchants??[]).map((m:any)=>String(m.id)),...merchants.keys()])){
  const key=await read('get_merchant_key',{merchant_id});
  merchant_keys.push({merchant_id,key_version:key?.version??null,active:Boolean(key?.public_key)});
 }

 const alerts:string[]=[];
 if(controls?.paused)alerts.push('vault_paused');
 if(snapshot&&!policy)alerts.push('no_spending_policy');
 if(policy&&past(policy.expires_at))alerts.push('policy_expired');
 if(source.upgrade_pending)alerts.push('upgrade_pending');

 return {
  kind:'countersign.ask-dave.facts',version:1,
  read_only:true,
  generated_at:new Date().toISOString(),
  source:{network:'LOCAL_SANDBOX',vault:source.vault,block_height:source.block_height,
   chain_time_ms:snapshot?.now??null,chain_time:iso(snapshot?.now),inbox_present:inbox.present,
   views_unavailable:[...unavailable],
   notes:[
    'Amounts ending _near are decimal NEAR; _yocto are exact integer strings.',
    'A payment counts toward a supplier only when the vault\'s payment is that exact invoice and its signed receipt names that supplier and that signed bill. Anything else is listed under totals.unattributed and credited to nobody.',
    'Each invoice explanation is fixed glossary text for its error or outcome: what it means and what the owner can do.',
    'The inbox stores no payment timestamps. Daily spend is the contract\'s rolling 24-hour policy usage; weekly spend is grouped by signed service week. Calendar-day history is not available.',
    'Invoices refused when first imported, for example an edited signed file, are never stored and do not appear here.',
    'Weekly services are listed only when a bill in the inbox names them.',
   ]},
  vault:{
   controls,alerts,
   available_near:formatNear(available),available_yocto:available,
   rules:policy?{
    version:policy.version,merchants:policy.merchants,
    per_payment_near:formatNear(policy.per_payment),rolling_24h_limit_near:formatNear(policy.daily_limit),min_payment_near:formatNear(snapshot.min_payment),
    expires_at_ms:policy.expires_at,expires_at:iso(policy.expires_at),expired:past(policy.expires_at),
   }:null,
   merchant_keys,
   policy_snapshot:snapshot,policy_capacity:capacity,
   weekly_services,
  },
  invoices:invoices.map(({paid,amount,...rest})=>rest),
  totals:{
   invoices:invoices.length,
   counts:tally(invoices),
   inbox_states:Object.fromEntries([...new Set(inbox.rows.map(r=>r.state))].sort().map(s=>[s,inbox.rows.filter(r=>r.state===s).length])),
   paid_near:formatNear(sum(invoices.map(i=>i.paid))),paid_yocto:sum(invoices.map(i=>i.paid)).toString(),
   per_merchant,
   unattributed:{paid_near:formatNear(sum(unattributed.map(u=>u.amount))),payments:unattributed.map(({amount,...rest})=>rest)},
   per_day:{basis:'rolling_24h_policy_usage',used_near:formatNear(usage),limit_near:formatNear(limit),
    remaining_near:usage!==null&&limit!==null?formatNear(limit>usage?limit-usage:0n):null},
   per_week:{basis:'signed_service_weeks',weeks},
  },
  flags,
 };
}
export type FactsPack=Awaited<ReturnType<typeof buildFacts>>;

// The one way any ask command opens a vault: the inbox must be pinned to the
// same session and vault as the chain record, or nothing is read from it.
export async function openSources(directory:string){
 const reader=await openVaultReader(directory);
 const inbox=readInbox(join(directory,'inbox.db'));
 if(inbox.scope!==null&&inbox.scope!==`${reader.session}:${reader.vault}`)throw new AskError('Ask Dave: the inbox belongs to another vault.');
 const pack=await buildFacts({vault:reader.vault,block_height:reader.block_height,view:reader.view,inbox,upgrade_pending:existsSync(join(directory,'upgrade-pending.json'))});
 return {reader,pack};
}
export async function collectFacts(directory:string):Promise<FactsPack>{return (await openSources(directory)).pack;}
