// Read-only window onto the local vault for Ask Dave.
// This file can only issue NEAR RPC `block` and `query/call_function` requests
// for the allowlisted view methods below. It has no keys, no signer and no
// transaction code, and it refuses any RPC endpoint other than 127.0.0.1.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export class AskError extends Error {}

export const VIEW_METHODS=Object.freeze([
 'get_payment','get_invoice_auth','get_merchant_bill_invoice','invoice_expiry',
 'policy_snapshot','policy_capacity','available_balance','get_vault_controls',
 'get_weekly_service','current_service_period','get_service_claim','requires_service_period','get_merchant_key','get_invoice_domain',
] as const);
export type ViewMethod=typeof VIEW_METHODS[number];
export type View=(method:ViewMethod,args:Record<string,unknown>)=>Promise<unknown>;
export type VaultReader={vault:string;session:string;block_height:number;view:View};

const account=/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const validAccount=(value:unknown):value is string=>typeof value==='string'&&value.length>=2&&value.length<=64&&account.test(value);
function readJson(path:string,label:string){
 if(!existsSync(path))throw new AskError(`Ask Dave: ${label} not found. Initialize the agent vault with agent:desk init first.`);
 try{return JSON.parse(readFileSync(path,'utf8'));}catch{throw new AskError(`Ask Dave: ${label} is unreadable.`);}
}

// Returns undefined for a view the deployed contract does not have (older vault).
export async function openVaultReader(directory:string):Promise<VaultReader>{
 const chain=readJson(join(directory,'chain.json'),'local chain record');
 const desk=readJson(join(directory,'desk.json'),'vault record');
 if(!Number.isInteger(chain.port)||chain.port<=1024||chain.port>=65536)throw new AskError('Ask Dave: invalid local chain record.');
 if(!validAccount(desk.vault)||typeof desk.session!=='string')throw new AskError('Ask Dave: invalid vault record.');
 const url=new URL(`http://127.0.0.1:${chain.port}`);
 if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new AskError('Ask Dave: non-local RPC rejected.');
 async function rpc(method:'block'|'query',params:Record<string,unknown>){
  let reply:any;
  try{
   // Never follow a redirect: invoice IDs and vault names must not reach another server.
   const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'ask-dave',method,params}),signal:AbortSignal.timeout(10000)});
   reply=await response.json();
  }catch{throw new AskError('Ask Dave: the local chain is not answering. Run agent:desk status once to start it, then ask again.');}
  return reply;
 }
 // Pin every view to one block so the facts describe a single moment. Use the
 // newest block, as the agent's own reads do: a just-settled payment must not
 // be reported as still in flight.
 const head=await rpc('block',{finality:'optimistic'});
 const block_height=head?.result?.header?.height;
 if(!Number.isInteger(block_height))throw new AskError('Ask Dave: the local chain returned no block.');
 const view:View=async(method,args)=>{
  if(!VIEW_METHODS.includes(method))throw new AskError(`Ask Dave: ${String(method)} is not a permitted read.`);
  const reply=await rpc('query',{request_type:'call_function',block_id:block_height,account_id:desk.vault,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  const failure=reply?.error??reply?.result?.error;
  if(failure){
   if(JSON.stringify(failure).includes('MethodNotFound'))return undefined;
   throw new AskError(`Ask Dave: could not read ${method} from the vault.`);
  }
  if(!Array.isArray(reply?.result?.result))throw new AskError(`Ask Dave: could not read ${method} from the vault.`);
  return JSON.parse(Buffer.from(reply.result.result).toString('utf8'));
 };
 return {vault:desk.vault,session:desk.session,block_height,view};
}
