import {createPrivateKey,generateKeyPairSync,randomInt,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import lockfile from 'proper-lockfile';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {saveJson} from '../app/local-chain.ts';
import {signInvoice,publicKeyBase64} from '../merchant/invoice.ts';
import {setDeskMerchantKey,setDeskPolicy,addDeskWeeklyService} from './desk-setup.ts';
import {createDeskInbox,importDeskInvoice} from './desk-core.ts';
import {readAgentState,runAgentBill,resumeAgentBill,DeskWebError} from './desk-web.ts';

type Supplier={id:string;name:string;payee:string;baseline:string;privateKey:string;version:string;domain:string};
// Display copy of each delivered invoice, for the demo mailbox only. It is never read
// by import or payment code; the vault still decides from the signed invoice itself.
type MailInvoice={id:string;merchant:string;supplier:string;payee:string;amount:string;expires_at:string;week:number|null};
type Cafe={suppliers:Supplier[];scam:{payee:string;baseline:string};rejected:({id:string;reason:string}&Partial<MailInvoice>)[];ready:boolean;
 mail?:{issued_at:string;invoices:MailInvoice[]}};
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
   suppliers,scam:{payee:cafe.scam.payee,received:scamReceived},rejected:cafe.rejected,mail:cafe.mail??null,bills:state.bills,read_at:new Date().toISOString()};
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
   cafe.mail={issued_at:new Date().toISOString(),invoices:bills.map(display)};
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
export type CafeProgress={running:boolean;completed:number;total:number;current:string|null};
export async function payCafe(directory:string,live:boolean,progress:CafeProgress){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 const state=await readAgentState(directory);
 // Invoice references establish a stable queue independent of shuffled delivery.
 // There is no outcome classification here: every queued bill goes through run.
 const queue=state.bills.filter(b=>['queued','proposed'].includes(b.outcome)).sort((a,b)=>a.id.localeCompare(b.id));
 // Round-robin deliveries: first bill from each supplier, then subsequent bills.
 queue.sort((a,b)=>{const order=(id:string)=>Number(id.match(/-(\d\d)-/)?.[1]??0);return order(a.id)-order(b.id);});
 Object.assign(progress,{running:true,completed:0,total:queue.length,current:null});
 try{
  for(const bill of queue){progress.current=bill.id;await runAgentBill(directory,bill.id,live);progress.completed++;}
  // Reconcile only genuinely pending saved transfers; no new proposal is made.
  const after=await readAgentState(directory);
  for(const bill of after.bills.filter(b=>b.outcome==='pending'))await resumeAgentBill(directory,bill.id);
 }finally{progress.running=false;progress.current=null;}
 return readCafe(directory);
}
export async function topUpCafe(directory:string){
 requireLocalDemo();if(!config(directory).ready)throw new DeskWebError('Open the café first.');
 await withDesk(directory,async desk=>{await desk.worker.rootAccount.transfer(desk.owner,parseNear('5'));await desk.owner.call(desk.vault,'fund',{}, {attachedDeposit:parseNear('5')});});
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
