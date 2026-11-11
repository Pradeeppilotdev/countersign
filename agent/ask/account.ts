// Ask Dave, step 3: "Would you pay this account?"
// Read-only. Code collects every fact and decides the verdict; no model is involved.
// Network reads: NEAR RPC `query` (view_account, view_access_key_list) on the local
// sandbox or FastNEAR's free RPC, and two free NearBlocks GETs (account creation and
// recent transactions), cached on disk for an hour. No keys, no signer, no transactions.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookalike} from './check.ts';
import {formatNear,type FactsPack} from './facts.ts';
import {AskError,validAccount} from './views.ts';

export type Network='local'|'testnet'|'mainnet';
export type Verdict='STOP'|'WARN'|'PAY';
export type AccountCheck={kind:'countersign.ask-dave.account-check';read_only:true;network:Network;account:string;verdict:Verdict;reasons:string[];facts:string[];sources:string[]};
type Send=typeof fetch;

const RPC:Record<Exclude<Network,'local'>,string>={testnet:'https://test.rpc.fastnear.com',mainnet:'https://free.rpc.fastnear.com'};
const NEARBLOCKS:Record<Exclude<Network,'local'>,string>={testnet:'https://api-testnet.nearblocks.io',mainnet:'https://api.nearblocks.io'};
const EMPTY_CODE='11111111111111111111111111111111';
const HOUR=3_600_000,WEEK_NS=7n*86_400_000_000_000n;
export const LOOKALIKE_STOP='Looks like your supplier\'s account but isn\'t.';
export const MISSING_STOP='Account does not exist.';

export function networkFrom(value:string|undefined):Network{
 if(value===undefined||value===''||value==='local'||value==='sandbox')return 'local';
 if(value==='testnet'||value==='mainnet')return value;
 throw new AskError('Ask Dave: COUNTERSIGN_NETWORK must be local, testnet or mainnet.');
}

// The local sandbox is reached only on 127.0.0.1, at the port the desk saved.
function localRpc(directory:string){
 let chain:any;
 try{chain=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));}
 catch{throw new AskError('Ask Dave: local chain record not found. Initialize the agent vault with agent:desk init first.');}
 if(!Number.isInteger(chain?.port)||chain.port<=1024||chain.port>=65536)throw new AskError('Ask Dave: invalid local chain record.');
 return `http://127.0.0.1:${chain.port}`;
}

async function rpcQuery(send:Send,url:string,params:Record<string,unknown>){
 let reply:any;
 try{
  const response=await send(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:'ask-dave',method:'query',params}),signal:AbortSignal.timeout(10000)});
  reply=await response.json();
 }catch{throw new AskError('Ask Dave: the NEAR RPC is not answering.');}
 return reply;
}
const unknownAccount=(reply:any)=>{
 const text=JSON.stringify(reply?.error??reply?.result?.error??'');
 return text.includes('UNKNOWN_ACCOUNT')||/does not exist/.test(text);
};

// NearBlocks: free API, about 6 calls a minute. Successful replies are cached for an
// hour; a 429 records a back-off so no further call is made until it passes.
type Indexed={ok:true;body:any;fetched_at:string;cached:boolean}|{ok:false;why:string};
async function nearblocks(send:Send,network:Exclude<Network,'local'>,path:string,name:string,cacheDir:string,now:number):Promise<Indexed>{
 const file=join(cacheDir,`nearblocks-${network}-${name}.json`),backoff=join(cacheDir,`nearblocks-${network}-backoff.json`);
 const readJson=(path:string)=>{try{return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;}catch{return null;}};
 const cached=readJson(file);
 if(cached&&typeof cached.fetched_ms==='number'&&now-cached.fetched_ms<HOUR)return {ok:true,body:cached.body,fetched_at:new Date(cached.fetched_ms).toISOString(),cached:true};
 const wait=readJson(backoff);
 if(wait&&typeof wait.until_ms==='number'&&now<wait.until_ms)return {ok:false,why:'NearBlocks rate limit; backing off'};
 let response:Response;
 try{response=await send(NEARBLOCKS[network]+path,{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});}
 catch{return {ok:false,why:'NearBlocks did not answer'};}
 if(response.status===429){
  await response.body?.cancel();
  const seconds=Number(response.headers.get('retry-after'));
  const until_ms=now+Math.max(60_000,Number.isFinite(seconds)?seconds*1000:0);
  try{mkdirSync(cacheDir,{recursive:true});writeFileSync(backoff,JSON.stringify({until_ms}));}catch{}
  return {ok:false,why:'NearBlocks rate limit'};
 }
 if(!response.ok){await response.body?.cancel();return {ok:false,why:`NearBlocks returned HTTP ${response.status}`};}
 let body:any;
 try{const text=await response.text();if(text.length>524288)throw Error('oversized');body=JSON.parse(text);}
 catch{return {ok:false,why:'NearBlocks reply was unreadable'};}
 try{mkdirSync(cacheDir,{recursive:true});writeFileSync(file,JSON.stringify({fetched_ms:now,body}));}catch{}
 return {ok:true,body,fetched_at:new Date(now).toISOString(),cached:false};
}

const isoNs=(ns:bigint)=>new Date(Number(ns/1_000_000n)).toISOString();
export type AccountOptions={network:Network;directory:string;pack?:FactsPack|null;send?:Send;cacheDir?:string;now?:number};

export async function checkAccount(account:string,options:AccountOptions):Promise<AccountCheck>{
 if(!validAccount(account))throw new AskError('Ask Dave: that is not a valid NEAR account ID.');
 const {network,directory}=options,send=options.send??fetch,now=options.now??Date.now();
 const cacheDir=options.cacheDir??fileURLToPath(new URL('../../work/ask-cache/',import.meta.url));
 const url=network==='local'?localRpc(directory):RPC[network];
 const rpcName=network==='local'?'local sandbox RPC':`FastNEAR ${network} RPC`;
 const facts:string[]=[],sources:string[]=[],reasons:string[]=[];
 const done=(verdict:Verdict):AccountCheck=>({kind:'countersign.ask-dave.account-check',read_only:true,network,account,verdict,reasons,facts,sources});

 // 1. Exists?
 const view=await rpcQuery(send,url,{request_type:'view_account',finality:'final',account_id:account});
 if(unknownAccount(view)){reasons.push(MISSING_STOP);facts.push('Exists: no.');sources.push(`${rpcName}, finality final`);return done('STOP');}
 const record=view?.result,height=record?.block_height;
 if(view?.error||!record||typeof record.code_hash!=='string'||!Number.isInteger(height))throw new AskError('Ask Dave: the NEAR RPC returned no account record.');
 facts.push('Exists: yes.');
 sources.push(`${rpcName} at block ${height}`);

 // 2. Contract?
 facts.push(record.code_hash===EMPTY_CODE?'Contract: no contract code is deployed.':`Contract: yes, contract code is deployed (code hash ${record.code_hash}).`);

 // 3. Access keys, read at the same block.
 const keys=await rpcQuery(send,url,{request_type:'view_access_key_list',block_id:height,account_id:account});
 const list=keys?.result?.keys;
 if(Array.isArray(list)){
  const full=list.filter((k:any)=>k?.access_key?.permission==='FullAccess').length;
  facts.push(`Access keys: ${list.length}, of which ${full} full-access.`);
 }else facts.push('Access keys: unknown (the RPC did not return the key list).');

 // 4. Age and activity. Unknown is reported as unknown, never guessed.
 let created:bigint|null=null,activity:number|null=null;
 if(network==='local'){
  facts.push('Age: age unknown (no public indexer for the local sandbox).');
  facts.push('Activity: unknown (no public indexer for the local sandbox).');
 }else{
  const info=await nearblocks(send,network,`/v3/accounts/${account}`,`account-${account}`,cacheDir,now);
  const ts=info.ok?info.body?.data?.created?.block_timestamp:null;
  if(info.ok&&typeof ts==='string'&&/^[0-9]{1,25}$/.test(ts)){
   created=BigInt(ts);
   const days=Number((BigInt(now)*1_000_000n-created)/86_400_000_000_000n);
   facts.push(`Age: created ${isoNs(created)} (${days} day${days===1?'':'s'} ago).`);
  }else facts.push(`Age: age unknown (${info.ok?'NearBlocks has no creation record':info.why}).`);
  // One page of 25 is one NearBlocks credit. No next page means this is every transaction.
  const txns=info.ok||!/rate limit/.test(info.why)?await nearblocks(send,network,`/v3/accounts/${account}/txns?limit=25`,`txns-${account}`,cacheDir,now):info;
  if(txns.ok&&Array.isArray(txns.body?.data)){
   activity=txns.body.data.length;
   const more=Boolean(txns.body?.meta?.next_page);
   facts.push(`Activity: ${activity}${more?'+':''} transaction${activity===1&&!more?'':'s'} on record.`);
  }else facts.push(`Activity: unknown (${txns.ok?'NearBlocks returned no transaction list':txns.why}).`);
  const fetched=[info,txns].flatMap(r=>r.ok?[`${r.fetched_at}${r.cached?' (cached)':''}`]:[]);
  if(fetched.length)sources.push(`NearBlocks ${network} API v3, fetched ${[...new Set(fetched)].join(', ')}`);
 }

 // 5. This vault: pinned payouts, past payments, lookalikes. The vault lives on the local sandbox.
 let pinned=false,paid=false;
 if(network!=='local'){
  facts.push(`Your vault: not checked. Your vault runs on the local sandbox, so its pinned suppliers and payments say nothing about a ${network} account.`);
  reasons.push('It is not a pinned supplier payout account in your vault.');
 }else{
  const pack=options.pack;
  if(!pack)throw new AskError('Ask Dave: the vault could not be read.');
  const merchants:{id:string;payee:string}[]=(pack.vault.policy_snapshot?.policy?.merchants??[]).map((m:any)=>({id:String(m.id),payee:String(m.payee)}));
  const mine=merchants.filter(m=>m.payee===account);
  pinned=mine.length>0;
  facts.push(pinned?`Pinned payout: yes, for supplier ${mine.map(m=>m.id).join(', ')}.`:'Pinned payout: no.');
  const payments=pack.invoices.filter(i=>i.payee===account&&i.outcome==='paid');
  paid=payments.length>0;
  const total=payments.reduce((sum,i)=>sum+(i.amount_yocto&&/^[0-9]+$/.test(i.amount_yocto)?BigInt(i.amount_yocto):0n),0n);
  facts.push(paid?`Paid before by this vault: yes, ${payments.length} payment${payments.length===1?'':'s'} totalling ${formatNear(total)} NEAR (${payments.map(i=>i.id).join(', ')}).`:'Paid before by this vault: no.');
  const name=(a:string)=>a.split('.')[0];
  const copies=pinned?[]:merchants.filter(m=>lookalike(account,m.payee)||(name(account)===name(m.payee)&&account!==m.payee));
  facts.push(copies.length?`Lookalike: yes, it looks like ${copies.map(m=>`${m.payee} (pinned for ${m.id})`).join(', ')}.`:'Lookalike: no.');
  sources.push(`vault ${pack.source.vault} policy and inbox at block ${pack.source.block_height}`);
  if(copies.length){reasons.push(LOOKALIKE_STOP);return done('STOP');}
  if(!pinned)reasons.push('It is not a pinned supplier payout account in your vault.');
  else if(!paid)reasons.push('It is pinned, but this vault has never paid it.');
 }
 if(created!==null&&BigInt(now)*1_000_000n-created<WEEK_NS)reasons.push('It was created less than 7 days ago.');
 if(activity===0)reasons.push('It has no prior transactions.');
 return done(reasons.length?'WARN':'PAY');
}

export function renderAccount(check:AccountCheck){
 const head=check.verdict==='PAY'?'PAY: pinned supplier payout account with paid history.':`${check.verdict}: ${check.reasons.join(' ')}`;
 return [head,...check.facts.map(f=>'- '+f),'Sources: '+check.sources.join('; ')].join('\n');
}
