import {requireUpgradeVerified} from './upgrade-state.ts';
import {readVaultControls} from './vault-controls.ts';
import {deployVault} from './deploy-vault.ts';
import { SandboxWorker } from 'near-workspaces';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { join } from 'node:path';
import { localChain, saveJson } from './local-chain.ts';
import { Executor } from '../executor/core.ts';
import { vaultAdapters } from '../executor/vault.ts';

const YOCTO=10n**24n;
export function parseNear(value: unknown) {
 if(typeof value!=='string'||!/^\d{1,2}(\.\d{1,24})?$/.test(value))throw Error('Enter a positive sandbox NEAR amount (up to 24 decimals).');
 const [whole,fraction='']=value.split('.');const amount=BigInt(whole)*YOCTO+BigInt(fraction.padEnd(24,'0'));
 if(amount<=0n || amount>5n*YOCTO)throw Error('Sandbox invoices must be between 0 and 5 NEAR.');return amount.toString();
}
export class SandboxDesk {
 releaseLock?:()=>Promise<void>;
 readonly directory?:string;
 readonly recoverOnStart:boolean;
 constructor(directory?:string,options:{recoverOnStart?:boolean}={}) {this.directory=directory;this.recoverOnStart=options.recoverOnStart??true;}
 persist(){if(this.directory)saveJson(join(this.directory,'desk.json'),{session:this.session,baseline:this.baseline.toString(),vault:this.vault?.accountId,executor:this.executor?.accountId,invoices:[...this.invoices],events:this.events});}
 async reconcileAll(){for(const [id] of this.invoices){const runner=this.runner(id);try{if(runner.db.prepare('SELECT invoice_id FROM attempts WHERE invoice_id=?').get(id))await runner.reconcile(id);}catch{this.log(`${id}: recovery requires attention; inspect the invoice before retrying.`);}finally{runner.close();}}}
 runner(id:string){const {auth,rail}=vaultAdapters({call:(method,args)=>this.executor.call(this.vault,method,args,{gas:'100000000000000'}),view:(method,args)=>this.vault.view(method,args)},id);return new Executor(this.directory?join(this.directory,'attempts.db'):fileURLToPath(new URL(`../work/sandbox-${this.session}.db`,import.meta.url)),auth,rail);}
 session=randomUUID(); worker:any; owner:any; executor:any; merchant:any; vault:any;
 baseline=0n; phase='OFFLINE'; error=''; queue=Promise.resolve();
 invoices=new Map<string,{invoice:any;attempt:string}>(); events:any[]=[];
 run(fn:()=>Promise<any>) {const task=this.queue.then(fn);this.queue=task.then(()=>{},()=>{});return task;}
 async start(){return this.run(async()=>{
  if(this.phase==='READY')return this.snapshot();
  if(this.worker)throw Error('Previous sandbox setup failed. Restart the app before retrying.');
  this.phase='STARTING';
  try {
   if(this.directory){mkdirSync(this.directory,{recursive:true,mode:0o700});this.releaseLock=await lockfile.lock(this.directory,{stale:2000,update:1000,retries:{retries:20,minTimeout:250,maxTimeout:500}});}
   if(this.directory)requireUpgradeVerified(this.directory);
   const binary=fileURLToPath(new URL('../work/sandbox-bin/near-sandbox',import.meta.url));
   const wasm=fileURLToPath(new URL('../contract/target/wasm32-unknown-unknown/release/countersign.wasm',import.meta.url));
   if(!existsSync(binary)||!existsSync(wasm))throw Error('Local sandbox binary or compiled contract is missing.');
   process.env.NEAR_SANDBOX_BIN_PATH=fileURLToPath(new URL('./sandbox-launcher/near-sandbox',import.meta.url));process.env.NEAR_SANDBOX_BINARY_PATH=fileURLToPath(new URL('./sandbox-launcher/',import.meta.url));
   // Explicit class creates a fresh local chain; no network selector, external URL or user keys.
   this.worker=this.directory?await localChain(this.directory):await SandboxWorker.init({network:'sandbox',rm:true});
   const rpc=new URL(this.worker.provider.connection.url);
   if(rpc.hostname!=='127.0.0.1'||rpc.protocol!=='http:')throw Error('Non-local RPC rejected.');
   if(this.directory&&existsSync(join(this.directory,'desk.json'))){
    const saved=JSON.parse(readFileSync(join(this.directory,'desk.json'),'utf8'));
    if(!saved.vault)throw Error('Incomplete vault setup; refusing to create or fund another vault.');
    this.session=saved.session;this.baseline=BigInt(saved.baseline);this.invoices=new Map(saved.invoices);this.events=saved.events;
    this.owner=this.worker.account('owner.test.near');this.executor=this.worker.account(saved.executor??'executor.test.near');this.merchant=this.worker.account('merchant.test.near');this.vault=this.worker.account(saved.vault);
    const controls=await readVaultControls(this.vault);
    if(controls){if(controls.owner!==this.owner.accountId)throw Error('Local owner does not match vault');this.executor=this.worker.account(controls.executor);}
    if(this.recoverOnStart)await this.reconcileAll();this.phase='READY';this.log(this.recoverOnStart?'Reconnected to existing vault; saved attempts reconciled.':'Reconnected to existing vault; automatic payment recovery disabled.');return this.snapshot();
   }
   this.persist();
   const root=this.worker.rootAccount;
   this.owner=await root.createSubAccount('owner');this.executor=await root.createSubAccount('executor');this.merchant=await root.createSubAccount('merchant');
   this.vault=await deployVault(root,wasm,this.owner.accountId,this.executor.accountId);
   await this.owner.call(this.vault,'fund',{}, {attachedDeposit:(5n*YOCTO).toString()});
   this.baseline=BigInt((await this.merchant.balance()).total.toString());
   this.phase='READY';this.log('Sandbox ready: vault funded with 5 test NEAR.');return this.snapshot();
  }catch(e){this.phase='ERROR';this.error=e instanceof Error?e.message:String(e);if(this.worker)await this.worker.tearDown();await this.releaseLock?.();this.releaseLock=undefined;throw e;}
 });}
 log(message:string){this.events.push({message,at:new Date().toISOString()});this.persist();}
 ready(){if(this.phase!=='READY')throw Error('Start the local sandbox first.');}
 async action(action:string,input:any){return this.run(async()=>{
  this.ready();
  const id=input.id;if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw Error('Invalid invoice reference.');
  if(action==='authorize'){
   const invoice={id,payee:this.merchant.accountId,asset:'near',amount:parseNear(input.amount)};
   const previous=this.invoices.get(id);
   if(previous && JSON.stringify(previous.invoice)!==JSON.stringify(invoice))throw Error('Invoice already bound to different terms.');
   if(!previous){this.invoices.set(id,{invoice,attempt:randomUUID()});this.persist();}
   const existing=await this.vault.view('get_payment',{invoice_id:id});
   if(!existing)await this.owner.call(this.vault,'authorize',{invoice});
   this.log(`${id}: ${existing?'already authorized; no new authorization submitted':'owner authorization confirmed'}.`);
  }else{
   const entry=this.invoices.get(id);if(!entry)throw Error('Unknown invoice.');
   if(action==='reserve'){
    await this.executor.call(this.vault,'reserve',{invoice:entry.invoice,attempt_id:entry.attempt});
    this.log(`${id}: reservation confirmed.`);
   }else if(action==='execute'){
    const p=await this.vault.view('get_payment',{invoice_id:id});if(!p||p.state==='Authorized')throw Error('Reserve the invoice first.');
    const runner=this.runner(id);
    try{const result=await runner.execute(entry.invoice,entry.attempt);this.log(`${id}: ${result==='settled'?'payment settled':result==='failed'?'transfer failed; budget returned':result==='cancelled'?'invoice cancelled':'payment outcome pending; refresh to reconcile'}.`);}finally{runner.close();}
   }else if(action==='cancel'||action==='release_failed'){
    await this.owner.call(this.vault,action,{invoice_id:id});
    this.log(`${id}: ${action==='cancel'?'cancelled; any expired reservation released':'confirmed failure budget released'}.`);
   }else if(action==='duplicate'){
    const p=await this.vault.view('get_payment',{invoice_id:id});if(p?.state!=='Settled')throw Error('Settle the invoice before testing replay.');
    const before=(await this.merchant.balance()).total.toString();
    await this.executor.call(this.vault,'execute',{invoice_id:id,attempt_id:entry.attempt},{gas:'100000000000000'});
    const after=(await this.merchant.balance()).total.toString();
    if(before!==after)throw Error('Unexpected balance change on replay.');
    this.log(`${id}: duplicate execution blocked — merchant balance unchanged.`);
   }else throw Error('Unknown sandbox action.');
  }
  return this.snapshot();
 });}
 async snapshot(){
  if(this.phase!=='READY')return {phase:this.phase,error:this.error,network:'LOCAL_SANDBOX',session:this.session,invoices:[],events:this.events};
  const invoices=[];for(const [id,entry] of this.invoices){const payment=await this.vault.view('get_payment',{invoice_id:id});const expiry=await this.vault.view('invoice_expiry',{invoice_id:id});invoices.push({id,attempt:entry.attempt,...payment,expiresAt:expiry,expired:expiry!==null&&Date.now()>=Number(expiry)});}
  return {phase:this.phase,network:'LOCAL_SANDBOX',session:this.session,vault:this.vault.accountId,merchant:this.merchant.accountId,available:await this.vault.view('available_balance',{}),merchantReceived:(BigInt((await this.merchant.balance()).total.toString())-this.baseline).toString(),invoices,events:this.events};
 }
 async close(){await this.queue;if(this.worker)await this.worker.tearDown();await this.releaseLock?.();this.releaseLock=undefined;}
}
