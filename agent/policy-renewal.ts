import {existsSync,mkdirSync,readFileSync,readdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {saveJson} from '../app/local-chain.ts';
import {vaultReason} from '../executor/errors.ts';

type Policy={version:string;merchants:{id:string;payee:string}[];per_payment:string;daily_limit:string;expires_at:string};
type Snapshot={policy:Policy|null;min_payment:string;usage:string;now:string};
type Receipt={renewal_id:string;previous_version:string;version:string;expires_at:string};
type Journal={schema:1;identity:string;id:string;minutes:number;before:Policy;minimum:string;request:{renewal_id:string;expected_version:string;expires_at:string};state:'pending'|'confirmed'|'expired'|'superseded';receipt?:Receipt};
export type RenewalContext={directory:string;identity:string;view:(method:string,args:any)=>Promise<any>;call:(method:string,args:any)=>Promise<any>};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const terms=(policy:Policy)=>({merchants:policy.merchants,per_payment:policy.per_payment,daily_limit:policy.daily_limit});

// Trusted owner command; callers hold the saved-vault directory lock. The model
// receives neither this capability nor the owner transport.
export async function renewSavedPolicy(context:RenewalContext,id:string,minutes:number){
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('Renewal ID must use 1–64 letters, digits, underscores or hyphens');
 if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('Renewal duration must be 1–1440 minutes');
 const folder=join(context.directory,'policy-renewals'),file=join(folder,id+'.json');
 const snapshot=async():Promise<Snapshot>=>{
  try{return await context.view('policy_snapshot',{});}
  catch(error){if(error instanceof Error&&error.message.includes('MethodNotFound'))throw Error('Upgrade the local vault before using policy renewal');throw error;}
 };
 let current=await snapshot();let receipt:Receipt|null=await context.view('get_policy_renewal',{renewal_id:id});let journal:Journal;
 if(existsSync(file)){
  journal=JSON.parse(readFileSync(file,'utf8'));
  if(journal.schema!==1||journal.identity!==context.identity||journal.id!==id||journal.minutes!==minutes||journal.request.renewal_id!==id||journal.request.expected_version!==journal.before.version)throw Error('Renewal record does not match this vault, ID or duration');
 }else{
  if(receipt)throw Error('Renewal ID already exists on chain; retain the receipt and choose a new ID for a new request');
  if(existsSync(folder)&&readdirSync(folder).filter(n=>n.endsWith('.json')).some(n=>JSON.parse(readFileSync(join(folder,n),'utf8')).state==='pending'))throw Error('Renewal already pending; reconcile its saved ID before starting another');
  if(!current.policy)throw Error('no spending policy');
  const expires=BigInt(current.now)+BigInt(minutes)*60000n;
  if(expires<=BigInt(current.policy.expires_at))throw Error('Renewal must extend the current policy expiry');
  journal={schema:1,identity:context.identity,id,minutes,before:current.policy,minimum:current.min_payment,request:{renewal_id:id,expected_version:current.policy.version,expires_at:expires.toString()},state:'pending'};
  mkdirSync(folder,{recursive:true,mode:0o700});
  const fd=openSync(context.directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  saveJson(file,journal); // Fixed expiry and expected version are durable before submission.
 }
 const result=(state:string)=>({renewal_id:id,state,receipt:journal.receipt??null,policy:current.policy,min_payment:current.min_payment,usage:current.usage,policy_active:current.policy!==null&&BigInt(current.policy.expires_at)>BigInt(current.now)});
 const confirm=()=>{
  if(!receipt||receipt.renewal_id!==id||receipt.previous_version!==journal.request.expected_version||receipt.expires_at!==journal.request.expires_at||BigInt(receipt.version)!==BigInt(receipt.previous_version)+1n)throw Error('Renewal receipt does not match the saved request');
  const stillCurrent=current.policy?.version===receipt.version;
  if(stillCurrent&&(!same(terms(current.policy!),terms(journal.before))||current.min_payment!==journal.minimum||current.policy!.expires_at!==receipt.expires_at))throw Error('Renewal changed spending rules unexpectedly');
  journal.state='confirmed';journal.receipt=receipt;saveJson(file,journal);
  return result(stillCurrent?'confirmed':'superseded');
 };
 if(receipt){current=await snapshot();return confirm();} // Includes lost-response/crash recovery, even after a later revocation.
 if(journal.state==='expired'||journal.state==='superseded')return result(journal.state);
 if(journal.state!=='pending')throw Error('Renewal receipt is unavailable; do not issue another transaction for this ID');
 if(!current.policy||current.policy.version!==journal.before.version){journal.state='superseded';saveJson(file,journal);return result('superseded');}
 if(!same(terms(current.policy),terms(journal.before))||current.min_payment!==journal.minimum)throw Error('Renewal terms changed without a matching version');
 if(BigInt(current.now)>=BigInt(journal.request.expires_at)){journal.state='expired';saveJson(file,journal);return result('expired');}
 try{await context.call('renew_policy',journal.request);}catch(error){
  const reason=vaultReason(error);
  throw Error(reason??`Renewal outcome is unconfirmed. Retry renew-policy ${minutes} ${id} to reconcile the same saved request.`);
 }
 // Reconciliation trusts the retained contract receipt, not a transport's claim.
 receipt=await context.view('get_policy_renewal',{renewal_id:id});current=await snapshot();
 return confirm();
}
