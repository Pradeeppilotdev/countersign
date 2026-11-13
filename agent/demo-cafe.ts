import {createPrivateKey,generateKeyPairSync,randomInt,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import lockfile from 'proper-lockfile';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {saveJson} from '../app/local-chain.ts';
import {signInvoice,publicKeyBase64} from '../merchant/invoice.ts';
import {setDeskMerchantKey,setDeskPolicy,addDeskWeeklyService} from './desk-setup.ts';
import {renewLocalPolicy} from './policy-renewal.ts';
import {createDeskInbox,importDeskInvoice} from './desk-core.ts';
import {readAgentState,runAgentBill,resumeAgentBill,DeskWebError} from './desk-web.ts';

type Supplier={id:string;name:string;payee:string;baseline:string;privateKey:string;version:string;domain:string};
// Display copy of each delivered invoice, for the demo mailbox only. It is never read
// by import or payment code; the vault still decides from the signed invoice itself.
type MailInvoice={id:string;merchant:string;supplier:string;payee:string;amount:string;expires_at:string;week:number|null};
type BankEntry={at:string;kind:'faucet'|'deposit';amount:string};
type Cafe={suppliers:Supplier[];scam:{payee:string;baseline:string};rejected:({id:string;reason:string}&Partial<MailInvoice>)[];ready:boolean;
 mail?:{issued_at:string;invoices:MailInvoice[]};bank?:BankEntry[];
 // The latest payment run (processing order) and the vault when the day's first run began.
 run?:{order:string[];vault_before:string};day_vault_start?:string};
const YOCTO=10n**24n;
export const WALLET_FAUCET=5n*YOCTO,GAS_RESERVE=YOCTO/2n;
export const RESERVE_MESSAGE='Keep 0.5 NEAR in your wallet for fees.';
// Demo deposit amounts: positive NEAR with up to 24 decimals, exact in yoctoNEAR.
export function parseDemoAmount(value:unknown){
 if(typeof value!=='string'||!/^\d{1,9}(\.\d{1,24})?$/.test(value))throw new DeskWebError('Enter an amount in NEAR, like 2 or 0.25 (up to 24 decimals).');
 const [whole,fraction='']=value.split('.');const amount=BigInt(whole)*YOCTO+BigInt(fraction.padEnd(24,'0'));
 if(amount<=0n)throw new DeskWebError('Enter an amount greater than 0.');
 return amount;
}
// Your rules. The shared CLI operations (setDeskPolicy, renewLocalPolicy) accept
// 1–1440 minutes and at most 5 NEAR per amount, inside the contract's 30-day limit.
export const MAX_RULE_HOURS=24,MAX_RULE_YOCTO=5n*YOCTO,RENEW_MINUTES=120;
export type DemoRules={per:bigint;daily:bigint;hours:number};
function ruleAmount(label:string,value:unknown){
 if(typeof value!=='string'||!/^\d{1,9}(\.\d{1,24})?$/.test(value))throw new DeskWebError(`${label}: enter an amount in NEAR, like 0.5 (up to 24 decimals).`);
 const [whole,fraction='']=value.split('.');const amount=BigInt(whole)*YOCTO+BigInt(fraction.padEnd(24,'0'));
 if(amount<=0n)throw new DeskWebError(`${label}: enter an amount greater than 0.`);
 if(amount>MAX_RULE_YOCTO)throw new DeskWebError(`${label}: the local sandbox allows at most 5 NEAR.`);
 return amount;
}
export function parseDemoRules(input:{per_bill?:unknown;daily_budget?:unknown;hours?:unknown}):DemoRules{
 const per=ruleAmount('Most per bill',input.per_bill),daily=ruleAmount('Daily budget',input.daily_budget);
 if(per>daily)throw new DeskWebError("Most per bill can't be more than the daily budget.");
 if(typeof input.hours!=='string'||!/^\d{1,4}$/.test(input.hours)||Number(input.hours)<1||Number(input.hours)>MAX_RULE_HOURS)
  throw new DeskWebError(`Rules can last from 1 to ${MAX_RULE_HOURS} hours.`);
 return {per,daily,hours:Number(input.hours)};
}
const walletOf=async(desk:SandboxDesk)=>BigInt((await desk.owner.balance()).available.toString());
// NEAR refunds unused gas to the signer a few blocks after a call. Wait until the
// owner's balance stops moving so the wallet shown (and any delta) is settled.
async function settleWallet(desk:SandboxDesk){
 let last=await walletOf(desk),steady=0;
 for(let i=0;i<20&&steady<2;i++){
  await new Promise(r=>setTimeout(r,700));
  const next=await walletOf(desk);steady=next===last?steady+1:0;last=next;
 }
 return last;
}
const WEEK_MS=7*24*60*60*1000;
export function requireLocalDemo(network=process.env.COUNTERSIGN_NETWORK){
 if(network!==undefined&&network!=='local')throw new DeskWebError('Demo café is available only on the local sandbox.');
}
const config=(directory:string):Cafe=>JSON.parse(readFileSync(join(directory,'cafe.json'),'utf8'));
async function withDesk<T>(directory:string,fn:(desk:SandboxDesk)=>Promise<T>){
 requireLocalDemo();const desk=new SandboxDesk(directory,{recoverOnStart:false});
 try{await desk.start();return await fn(desk);}finally{await desk.close();}
}
export async function setupCafe(directory:string){
 requireLocalDemo();
 if(existsSync(join(directory,'cafe.json'))){
  if(!config(directory).ready)throw new DeskWebError('Café setup was interrupted. Reset café to back up and start fresh.');
  return readCafe(directory);
 }
 if(existsSync(join(directory,'desk.json')))throw new DeskWebError('An agent vault already exists. Reset café to back it up and open a fresh café.');
 await withDesk(directory,async desk=>{
  const cafe:Cafe={suppliers:[],scam:{payee:'',baseline:'0'},rejected:[],ready:false};
  const save=()=>saveJson(join(directory,'cafe.json'),cafe);save();
  for(const [label,id,name] of [['beans','Bean-Co','Bean Co'],['milk','Milk-Co','Milk Co'],['pastry','Pastry-Co','Pastry Co']]){
   const account=await desk.worker.rootAccount.createSubAccount(label);
   const pair=generateKeyPairSync('ed25519');
   const key=await setDeskMerchantKey(desk,id,publicKeyBase64(pair.publicKey));
   cafe.suppliers.push({id,name,payee:account.accountId,baseline:(await account.balance()).total.toString(),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),version:key.version,domain:key.domain});save();
  }
  // A lookalike of Bean Co's payout (5 for s): the tampered invoice pays here.
  const scam=await desk.worker.rootAccount.createSubAccount('bean5');
  cafe.scam={payee:scam.accountId,baseline:(await scam.balance()).total.toString()};save();
  await setDeskPolicy(desk,'0.5','1.2',120,undefined,cafe.suppliers.map(s=>({id:s.id,payee:s.payee})));
  const now=String((await desk.vault.view('policy_snapshot',{})).now);
  await addDeskWeeklyService(desk,'weekly-milk','Milk-Co','0.5',now);
  await settleWallet(desk);
  cafe.ready=true;save();
 });
 return readCafe(directory);
}
export async function readCafe(directory:string){
 requireLocalDemo();
 if(!existsSync(join(directory,'cafe.json')))return {ready:false,existing:existsSync(join(directory,'desk.json'))};
 const cafe=config(directory);
 if(!cafe.ready)return {ready:false,existing:true};
 // Reuse exact signed-receipt attribution used by Agent payments and Ask Dave.
 const state=await readAgentState(directory);
 return withDesk(directory,async desk=>{
  const suppliers=[];
  for(const supplier of cafe.suppliers){
   const received=(BigInt((await desk.worker.account(supplier.payee).balance()).total.toString())-BigInt(supplier.baseline)).toString();
   const paid=state.bills.filter(b=>b.payment_confirmed&&b.merchant===supplier.id&&b.payee===supplier.payee);
   const receipts=[];
   for(const bill of paid){
    const payment:any=await desk.vault.view('get_payment',{invoice_id:bill.id});
    const auth:any=await desk.vault.view('get_invoice_auth',{invoice_id:bill.id});
    receipts.push({invoice_id:bill.id,amount:payment.invoice.amount,attempt_id:payment.attempt_id,payload_hash:auth.payload_hash,state:payment.state});
   }
   suppliers.push({id:supplier.id,name:supplier.name,payee:supplier.payee,received,paid_count:receipts.length,receipts});
  }
  const scamReceived=(BigInt((await desk.worker.account(cafe.scam.payee).balance()).total.toString())-BigInt(cafe.scam.baseline)).toString();
  return {ready:true,network:'LOCAL_SANDBOX',vault:state.vault,available:await desk.vault.view('available_balance',{}),policy:state.policy,
   suppliers,scam:{payee:cafe.scam.payee,received:scamReceived},rejected:cafe.rejected,mail:cafe.mail??null,bank:cafe.bank??[],
   run:cafe.run??null,day_vault_start:cafe.day_vault_start??null,
   wallet_yocto:(await walletOf(desk)).toString(),bills:state.bills,read_at:new Date().toISOString()};
 });
}
export async function receiveCafe(directory:string){
 requireLocalDemo();const cafe=config(directory);
 if(!cafe.ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{
  const inbox=createDeskInbox(desk,directory);
  try{
   const batch=randomUUID().slice(0,8),expiry=String(Date.now()+60*60*1000);
   const service=await desk.vault.view('current_service_period',{agreement_id:'weekly-milk'});
   const make=(supplier:Supplier,id:string,bill:string,amount:string,weekly=false)=>signInvoice({
    invoice:{id:`INV-${id}-${batch}`,payee:supplier.payee,asset:'near',amount:parseNear(amount)},merchant_id:supplier.id,bill_id:`${bill}-${batch}`,
    vault:desk.vault.accountId,domain:supplier.domain,key_version:supplier.version,expires_at:expiry,...(weekly?{service}:{}),
   },createPrivateKey(supplier.privateKey));
   const [beans,milk,pastry]=cafe.suppliers;
   const bills=[make(beans,'BEANS-01','beans-delivery','0.4'),make(milk,'MILK-01','milk-delivery','0.4',true),make(pastry,'PASTRY-01','pastry-delivery','0.4'),
    make(beans,'BEANS-02','beans-delivery','0.4'),make(milk,'MILK-02','milk-delivery-2','0.4',true),make(pastry,'PASTRY-02','pastry-delivery-2','0.5')];
   const tampered=make(beans,'BEANS-03','beans-delivery-3','0.4');tampered.invoice.payee=cafe.scam.payee;bills.push(tampered);
   for(let i=bills.length-1;i>0;i--){const j=randomInt(i+1);[bills[i],bills[j]]=[bills[j],bills[i]];}
   const weekly:any=await desk.vault.view('get_weekly_service',{agreement_id:'weekly-milk'});
   const week=(bill:typeof bills[number])=>bill.service&&weekly?Math.floor((Number(bill.service.period_start_ms)-Number(weekly.anchor_ms))/WEEK_MS)+1:null;
   // As delivered: the payee is what is written on the invoice, tampered or not.
   const display=(bill:typeof bills[number]):MailInvoice=>({id:bill.invoice.id,merchant:bill.merchant_id,supplier:cafe.suppliers.find(s=>s.id===bill.merchant_id)!.name,
    payee:bill.invoice.payee,amount:bill.invoice.amount,expires_at:bill.expires_at,week:week(bill)});
   // Keep earlier deliveries visible when another batch arrives the same day.
   cafe.mail={issued_at:cafe.mail?.issued_at??new Date().toISOString(),invoices:[...(cafe.mail?.invoices??[]),...bills.map(display)]};
   for(const bill of bills){
    try{await importDeskInvoice(desk,inbox,bill);}
    catch(error){
     if(!(error instanceof Error)||error.message!=='Invalid merchant signature')throw error;
     cafe.rejected.push({...display(bill),reason:error.message});
    }
   }
   saveJson(join(directory,'cafe.json'),cafe);
  }finally{inbox.close();}
 });
 return readCafe(directory);
}
// results: each bill's real outcome, appended the moment its run finishes, in processing order.
export type CafeResult={id:string;outcome:string;error:string|null;explanation:{meaning:string}|null};
export type CafeProgress={running:boolean;completed:number;total:number;current:string|null;order?:string[];results?:CafeResult[];vault_before?:string|null};
async function beginCafeRun(directory:string,order:string[]){
 return withDesk(directory,async desk=>{
  const before=String(await desk.vault.view('available_balance',{}));
  if(order.length){
   const cafe=config(directory);cafe.run={order,vault_before:before};cafe.day_vault_start??=before;
   // Save before submission so a restart cannot lose the original balance.
   saveJson(join(directory,'cafe.json'),cafe);
  }
  return before;
 });
}
export async function payCafeBill(directory:string,id:string){
 requireLocalDemo();const cafe=config(directory);
 if(!cafe.ready||!cafe.mail?.invoices.some(invoice=>invoice.id===id))throw new DeskWebError('Unknown café invoice.');
 const before=await readAgentState(directory);
 if(!before.bills.some(bill=>bill.id===id&&['queued','proposed'].includes(bill.outcome)))throw new DeskWebError('This invoice is no longer queued.');
 await beginCafeRun(directory,[id]);
 const {record}=await runAgentBill(directory,id,false);
 return {record,state:await readCafe(directory)};
}
export async function payCafe(directory:string,live:boolean,progress:CafeProgress){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 const state=await readAgentState(directory);
 const mailbox=new Set(config(directory).mail?.invoices.map(invoice=>invoice.id)??[]);
 // Invoice references establish a stable queue independent of shuffled delivery.
 // There is no outcome classification here: every queued bill goes through run.
 const queue=state.bills.filter(b=>mailbox.has(b.id)&&['queued','proposed'].includes(b.outcome)).sort((a,b)=>a.id.localeCompare(b.id));
 // Round-robin deliveries: first bill from each supplier, then subsequent bills.
 queue.sort((a,b)=>{const order=(id:string)=>Number(id.match(/-(\d\d)-/)?.[1]??0);return order(a.id)-order(b.id);});
 const vaultBefore=await beginCafeRun(directory,queue.map(b=>b.id));
 Object.assign(progress,{running:true,completed:0,total:queue.length,current:null,order:queue.map(b=>b.id),results:[],vault_before:vaultBefore});
 try{
  for(const bill of queue){
   progress.current=bill.id;
   const {record}=await runAgentBill(directory,bill.id,live);
   progress.results!.push({id:record.id,outcome:record.outcome,error:record.error??null,explanation:record.explanation?{meaning:record.explanation.meaning}:null});
   progress.completed++;
  }
  // Reconcile only genuinely pending saved transfers; no new proposal is made.
  const after=await readAgentState(directory);
  for(const bill of after.bills.filter(b=>b.outcome==='pending'))await resumeAgentBill(directory,bill.id);
 }finally{progress.running=false;progress.current=null;}
 return readCafe(directory);
}
export async function topUpCafe(directory:string){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{await desk.worker.rootAccount.transfer(desk.owner,parseNear('5'));await desk.owner.call(desk.vault,'fund',{}, {attachedDeposit:parseNear('5')});await settleWallet(desk);});
 return readCafe(directory);
}
function logBank(directory:string,kind:BankEntry['kind'],amount:bigint){
 const cafe=config(directory);cafe.bank=[...(cafe.bank??[]),{at:new Date().toISOString(),kind,amount:amount.toString()}];
 saveJson(join(directory,'cafe.json'),cafe);
}
// First half of the old faucet: 5 test NEAR from the sandbox root to Dave's wallet.
export async function walletFaucetCafe(directory:string){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{await desk.worker.rootAccount.transfer(desk.owner,WALLET_FAUCET.toString());await settleWallet(desk);});
 logBank(directory,'faucet',WALLET_FAUCET);
 return readCafe(directory);
}
// Second half of the old faucet, with Dave's chosen amount: the owner's existing `fund`.
export async function depositCafe(directory:string,value:unknown){
 requireLocalDemo();const amount=typeof value==='bigint'?value:parseDemoAmount(value);
 if(amount<=0n)throw new DeskWebError('Enter an amount greater than 0.');
 if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{
  const wallet=await walletOf(desk),limit=wallet>GAS_RESERVE?wallet-GAS_RESERVE:0n;
  if(amount>limit)throw new DeskWebError(`You can deposit up to ${formatYocto(limit)} NEAR. ${RESERVE_MESSAGE}`);
  await desk.owner.call(desk.vault,'fund',{},{attachedDeposit:amount.toString()});
  await settleWallet(desk);
 });
 logBank(directory,'deposit',amount);
 return readCafe(directory);
}
const formatYocto=(v:bigint)=>{const whole=v/YOCTO,fraction=(v%YOCTO).toString().padStart(24,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:String(whole);};
// Same operation as `agent:desk policy`, keeping the pinned suppliers and minimum.
export async function setRulesCafe(directory:string,input:DemoRules|{per_bill?:unknown;daily_budget?:unknown;hours?:unknown}){
 requireLocalDemo();const rules='per' in input?input:parseDemoRules(input);
 if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{
  const snapshot:any=await desk.vault.view('policy_snapshot',{});
  const merchants=(snapshot.policy?.merchants??[]).map((m:any)=>({id:m.id,payee:m.payee}));
  if(!merchants.length)throw new DeskWebError('No suppliers are pinned. Start a new day to set the café up again.');
  const minimum=BigInt(snapshot.min_payment);
  if(rules.per<minimum)throw new DeskWebError(`Most per bill must be at least the minimum payment (${formatYocto(minimum)} NEAR).`);
  await setDeskPolicy(desk,formatYocto(rules.per),formatYocto(rules.daily),rules.hours*60,formatYocto(minimum),merchants);
  await settleWallet(desk);
 });
 return readCafe(directory);
}
// Same operation as `agent:desk renew-policy`: a later expiry, the same limits.
export async function renewRulesCafe(directory:string){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{
  try{await renewLocalPolicy(desk,`demo-${Date.now()}-${randomUUID().slice(0,8)}`,RENEW_MINUTES);}
  catch(error){
   if(error instanceof Error&&/must extend (the current )?policy expiry/i.test(error.message))throw new DeskWebError('Your rules already last longer than 2 more hours.');
   throw error;
  }
  await settleWallet(desk);
 });
 return readCafe(directory);
}
// "Try again" for a bill the vault stopped only because of the daily budget:
// the existing resume path re-requests the saved proposal (no model call).
export const BUDGET_STOP=/rolling daily budget exceeded/i;
export const budgetRetryable=(bill:{outcome?:string;error?:string|null;has_proposal?:boolean})=>bill.outcome==='blocked'&&bill.has_proposal===true&&BUDGET_STOP.test(bill.error??'');
export async function retryCafeBill(directory:string,id:string){
 requireLocalDemo();const cafe=config(directory);if(!cafe.ready)throw new DeskWebError('Open the café first.');
 if(!cafe.mail?.invoices.some(invoice=>invoice.id===id))throw new DeskWebError("That bill isn't in today's café mailbox.");
 const bill=(await readAgentState(directory)).bills.find(b=>b.id===id);
 if(!bill)throw new DeskWebError('Unknown invoice.');
 if(!budgetRetryable(bill))throw new DeskWebError('Only bills stopped by the daily budget can be tried again.');
 await resumeAgentBill(directory,id);
 return readCafe(directory);
}
export async function backupCafe(directory:string){
 requireLocalDemo();
 if(!existsSync(directory))return null;
 const release=await lockfile.lock(directory,{stale:2000,retries:0});
 try{
  const chainPath=join(directory,'chain.json');
  if(existsSync(chainPath)){
   const chain=JSON.parse(readFileSync(chainPath,'utf8'));
   if(chain.pid){
    let command='';try{command=execFileSync('ps',['-p',String(chain.pid),'-o','command='],{encoding:'utf8'});}catch{}
    if(command.includes('near-sandbox')&&command.includes(join(directory,'chain'))){
     process.kill(chain.pid,'SIGTERM');
     for(let i=0;i<100;i++){
      try{process.kill(chain.pid,0);}catch{break;}
      if(i===99)throw new DeskWebError('Local chain is still stopping. Retry reset.');
      await new Promise(r=>setTimeout(r,100));
     }
    }else if(command)throw new DeskWebError('Cannot safely stop the local chain. Existing data retained.');
   }
  }
  const backup=join(dirname(directory),`agent-vault.bak-${Date.now()}-${randomUUID().slice(0,8)}`);
  renameSync(directory,backup);return backup;
 }finally{await release();}
}
export async function resetCafe(directory:string){await backupCafe(directory);return setupCafe(directory);}
