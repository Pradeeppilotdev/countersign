import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,lstatSync,readdirSync,chmodSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cp,lstat,readdir,chmod,open} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import lockfile from 'proper-lockfile';
import {localChain,saveJson} from './local-chain.ts';
import {digest,storageDigest,storedInvoiceIds,rootAccounts,localRecords,type StorageEntry} from './upgrade-state.ts';

const artifact=fileURLToPath(new URL('../contract/target/wasm32-unknown-unknown/release/countersign.wasm',import.meta.url));
type Snapshot={blockId:string;storage:StorageEntry[];storageHash:string;available:string;accounts:{owner:string;executor:string};payments:any[];payeeBalances:Record<string,string>;accessKeys:any[]};
type Pending={version:1;vault:string;chainId:string;backup:string;targetHash:string;oldHash:string;before:Snapshot;local:ReturnType<typeof localRecords>};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function secureTree(path:string){
 const s=await lstat(path);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('Backup refuses linked or special files');
 if(s.isDirectory()){await chmod(path,0o700);for(const n of await readdir(path))await secureTree(join(path,n));}else await chmod(path,0o600);
 const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}
}
function checkTree(path:string){
 const s=lstatSync(path);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('Saved vault contains linked or special files');
 if(s.isDirectory())for(const n of readdirSync(path))checkTree(join(path,n));
}
async function stopSavedChain(config:any){
 if(!config.pid)return;
 let command='';try{command=execFileSync('ps',['-p',String(config.pid),'-o','command='],{stdio:['ignore','pipe','ignore']}).toString();}catch{}
 if(!command)return;
 if(!command.includes('near-sandbox')||!command.includes(config.homeDir))throw Error('Saved process identity changed; refusing to stop it');
 process.kill(config.pid,'SIGTERM');
 for(let n=0;n<100;n++){try{process.kill(config.pid,0);}catch{return;}await new Promise(r=>setTimeout(r,100));}
 throw Error('Local chain did not stop; no backup or deployment attempted');
}
async function requireOffline(port:number){
 const listening=await new Promise<boolean>((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(1500);
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',(error:any)=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(false);else reject(Error('Cannot confirm local chain is stopped'));});
  socket.once('timeout',()=>{socket.destroy();reject(Error('Cannot confirm local chain is stopped'));});
 });
 if(listening)throw Error('Saved RPC port is still in use; refusing an inconsistent chain backup');
}
function queryFor(rpc:string){
 const url=new URL(rpc);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Upgrade requires a local test chain');
 return async(params:any)=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'upgrade',method:'query',params}),signal:AbortSignal.timeout(15000)});
  const body=await response.json();if(!response.ok||body.error)throw Error('Local upgrade query failed; saved data retained');return body.result;
 };
}
async function snapshot(query:ReturnType<typeof queryFor>,vault:string):Promise<Snapshot>{
 // A completed SDK call can still precede finality. Wait until the observed
 // head is final, then pin every read to that one block (including recent pause).
 const request={request_type:'view_state',account_id:vault,prefix_base64:''};
 const head=await query({...request,finality:'optimistic'});let state=await query({...request,finality:'final'});
 for(let n=0;state.block_height<head.block_height&&n<80;n++){await new Promise(r=>setTimeout(r,250));state=await query({...request,finality:'final'});}
 if(state.block_height<head.block_height)throw Error('Local chain has not finalized; no upgrade can be verified');
 const at={account_id:vault,block_id:state.block_hash};
 const view=async(method_name:string,args:any)=>{const r=await query({...at,request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});return JSON.parse(Buffer.from(r.result).toString());};
 const storage:StorageEntry[]=state.values,storageHash=storageDigest(storage),accounts=rootAccounts(storage);
 const payments=[];for(const invoice_id of storedInvoiceIds(storage)){
  const p=await view('get_payment',{invoice_id});if(!p||p.invoice.id!==invoice_id||!['Authorized','Reserved','Executing','Settled','Failed','Cancelled'].includes(p.state))throw Error('Stored invoice could not be verified');
  if(p.state==='Executing')throw Error('In-flight payment must settle before upgrading; its hold is retained');payments.push(p);
 }
 const payeeBalances:Record<string,string>={};
 for(const account_id of [...new Set(['merchant.test.near',...payments.map(p=>p.invoice.payee)])].sort()){
  // Failed payments may refer to an account that never existed. Their stored
  // failure is preserved; only accounts that actually received funds need balance checks.
  if(account_id!=='merchant.test.near'&&!payments.some(p=>p.invoice.payee===account_id&&p.state==='Settled'))continue;
  const a=await query({request_type:'view_account',account_id,block_id:state.block_hash});payeeBalances[account_id]=a.amount;
 }
 const keys=await query({...at,request_type:'view_access_key_list'});
 const accessKeys=keys.keys.map((k:any)=>({public_key:k.public_key,permission:k.access_key.permission})).sort((a:any,b:any)=>a.public_key.localeCompare(b.public_key));
 return {blockId:state.block_hash,storage,storageHash,accounts,payments,payeeBalances,accessKeys,available:await view('available_balance',{})};
}
function verify(before:Snapshot,after:Snapshot){
 const changed=(['storageHash','accounts','payments','payeeBalances','accessKeys','available'] as const).filter(k=>!equal(before[k],after[k]));
 if(changed.length)throw Error('Upgrade verification failed ('+changed.join(', ')+'); payment startup remains blocked and the full backup is retained');
}
export async function upgradeLocalVault(directory:string,wasmPath=artifact){
 directory=resolve(directory);const deskPath=join(directory,'desk.json'),chainPath=join(directory,'chain.json'),pendingPath=join(directory,'upgrade-pending.json');
 if(!existsSync(deskPath)||!existsSync(chainPath))throw Error('No saved local vault to upgrade; refusing to create one');
 const code=readFileSync(wasmPath);if(!WebAssembly.validate(code))throw Error('Compiled contract is not valid WebAssembly');
 const exports=new Set(WebAssembly.Module.exports(new WebAssembly.Module(code)).map(e=>e.name));
 for(const name of ['get_payment','available_balance','get_vault_controls','policy_capacity','clear_policy_approvals'])if(!exports.has(name))throw Error('Build the current contract before upgrading');
 const targetHash=digest(code),unlock=await lockfile.lock(directory,{stale:2000,update:1000,retries:0});
 try{
  const saved=JSON.parse(readFileSync(deskPath,'utf8')),config=JSON.parse(readFileSync(chainPath,'utf8'));
  if(!saved.vault?.endsWith('.test.near')||config.network!=='sandbox'||config.rootAccountId!=='test.near'||config.homeDir!==join(directory,'chain')||!config.chainId||![config.port,config.peerPort].every(p=>Number.isInteger(p)&&p>1024&&p<65536))throw Error('Only an initialized saved local test vault can be upgraded');
  const local=localRecords(directory);let pending:Pending|undefined;
  if(existsSync(pendingPath)){
   pending=JSON.parse(readFileSync(pendingPath,'utf8'));
   if(pending?.version!==1||pending.vault!==saved.vault||pending.chainId!==config.chainId||pending.targetHash!==targetHash||!equal(pending.local,local))throw Error('Interrupted upgrade does not match this artifact or saved records; retain the backup and investigate');
  }
  let backup=pending?.backup;
  if(!pending){
   await stopSavedChain(config);await requireOffline(config.port);checkTree(directory);
   const parent=join(dirname(directory),'upgrade-backups');mkdirSync(parent,{recursive:true,mode:0o700});chmodSync(parent,0o700);
   backup=mkdtempSync(join(parent,basename(directory)+'-'));chmodSync(backup,0o700);
   await cp(directory,join(backup,'saved-vault'),{recursive:true,errorOnExist:true,force:false});await secureTree(backup);
   if(!equal(local,localRecords(join(backup,'saved-vault'))))throw Error('Backup verification failed; no deployment attempted');
  }
  const chain=await localChain(directory),vault=chain.account(saved.vault),query=queryFor(chain.provider.connection.url);
  const before=await snapshot(query,saved.vault);
  const old=await query({request_type:'view_code',account_id:saved.vault,block_id:before.blockId}),oldCode=Buffer.from(old.code_base64,'base64'),currentHash=digest(oldCode);
  if(pending){verify(pending.before,before);if(![pending.oldHash,pending.targetHash].includes(currentHash))throw Error('Interrupted upgrade code changed unexpectedly; payment startup remains blocked');}
  else{
   if(before.accounts.owner!=='owner.test.near')throw Error('Local owner does not match the vault');
   writeFileSync(join(backup!,'previous-contract.wasm'),oldCode,{mode:0o600});
   writeFileSync(join(backup!,'target-contract.wasm'),code,{mode:0o600});
   for(const name of ['previous-contract.wasm','target-contract.wasm']){const fd=await open(join(backup!,name),'r');try{await fd.sync();}finally{await fd.close();}}
   pending={version:1,vault:saved.vault,chainId:config.chainId,backup:backup!,targetHash,oldHash:currentHash,before,local};
   saveJson(join(backup!,'verification.json'),pending);
   saveJson(pendingPath,pending); // Durable before code submission, including uncertain responses.
  }
  const changed=currentHash!==targetHash;
  const pinnedArtifact=join(pending.backup,'target-contract.wasm');
  if(digest(readFileSync(pinnedArtifact))!==targetHash)throw Error('Pinned upgrade artifact changed; payment startup remains blocked');
  if(changed)await vault.deploy(pinnedArtifact);
  const after=await snapshot(query,saved.vault);
  const actual=await query({request_type:'view_code',account_id:saved.vault,block_id:after.blockId});
  if(digest(Buffer.from(actual.code_base64,'base64'))!==targetHash)throw Error('Upgrade code could not be confirmed; payment startup remains blocked');
  verify(pending.before,after);
  if(!equal(pending.local,localRecords(directory)))throw Error('Local records changed during upgrade; payment startup remains blocked');
  const controls:any=await vault.view('get_vault_controls',{}),capacity=await vault.view('policy_capacity',{});
  if(controls.owner!==after.accounts.owner||controls.executor!==after.accounts.executor)throw Error('Upgraded owner/executor view does not match saved state');
  // Keep the evidence, but atomically clear the startup barrier only after verification.
  renameSync(pendingPath,join(directory,'upgrade-verified.json'));
  const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  return {network:'LOCAL_SANDBOX',vault:saved.vault,upgraded:changed,backup:pending.backup,codeHash:targetHash,storageHash:after.storageHash,storageEntries:after.storage.length,invoices:after.payments.map(p=>({id:p.invoice.id,state:p.state})),available:after.available,localRecords:pending.local.databases,controls,capacity};
 }finally{await unlock();}
}
