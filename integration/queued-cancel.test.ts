import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {AgentInbox} from '../agent/inbox.ts';
import {commitment} from '../executor/core.ts';
import {publicKeyBase64,signInvoice,signedInvoiceHash} from '../merchant/invoice.ts';

const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));

test('owner cancels a queued signed bill across a crash and late inference; a winning reservation pays once', {timeout:240_000}, async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-queued-cancel-'));
 const desk=new SandboxDesk(directory,{recoverOnStart:false});
 let child:ReturnType<typeof fork>|undefined,inbox:AgentInbox|undefined;
 const cli=async(args:string[],crash?:string)=>{
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning',...(crash?['--import','./integration/helpers/crash-after-owner-call.ts']:[]),'agent/desk.ts',...args],{
   cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:'',COUNTERSIGN_TEST_OWNER_RECEIPT:crash??''},timeout:60_000,
  });
  return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
 };
 const local=(id:string)=>{
  const db=new DatabaseSync(join(directory,'inbox.db'),{readOnly:true});
  try{return {...db.prepare('SELECT state,generation FROM inbox WHERE id=?').get(id)};}finally{db.close();}
 };
 const message=(predicate:(value:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
  const worker=child!,timer=setTimeout(()=>{cleanup();reject(Error('Inference checkpoint timed out'));},45_000);
  const receive=(value:any)=>{if(predicate(value)){cleanup();resolve(value);}};
  const exit=(code:number|null)=>{cleanup();reject(Error('Worker exited before checkpoint: '+code));};
  const error=(e:Error)=>{cleanup();reject(e);};
  function cleanup(){clearTimeout(timer);worker.off('message',receive);worker.off('exit',exit);worker.off('error',error);}
  worker.on('message',receive);worker.once('exit',exit);worker.once('error',error);
 });
 try {
  await desk.start();const {vault,owner,executor,merchant}=desk;
  const identity=desk.session+':'+vault.accountId;
  const key=generateKeyPairSync('ed25519'),domain=randomBytes(32).toString('hex');
  const now=BigInt((await vault.view('policy_snapshot',{})).now),amount=parseNear('0.04');
  await owner.call(vault,'configure_invoice_auth',{domain});
  await owner.call(vault,'set_merchant_key',{merchant_id:'cafe',public_key:publicKeyBase64(key.publicKey)});
  await owner.call(vault,'set_policy',{merchants:[{id:'cafe',payee:merchant.accountId}],per_payment:amount,daily_limit:parseNear('0.08'),expires_at:String(now+7_200_000n)});
  await owner.call(vault,'add_weekly_service',{agreement_id:'weekly-cafe',merchant_id:'cafe',cap:amount,anchor_ms:String(now)});
  const service=await vault.view('current_service_period',{agreement_id:'weekly-cafe'});
  const sign=(id:string,bill_id=id,value=amount)=>signInvoice({invoice:{id,payee:merchant.accountId,asset:'near',amount:value},merchant_id:'cafe',bill_id,
   vault:vault.accountId,domain,key_version:'1',expires_at:String(now+3_600_000n),service},key.privateKey);
  const a=sign('CANCEL-FIRST'),b=sign('RESERVE-FIRST');
  const view=(method:string,args:Record<string,unknown>={})=>vault.view(method,args);
  const payment=(id:string)=>view('get_payment',{invoice_id:id});
  const funds=async()=>({available:await view('available_balance'),usage:await view('policy_usage'),merchant:(await merchant.balance()).total.toString()});
  const before=await funds();
  const reject=async(actor:any,signed:any,reason:string)=>{
   const result=await actor.callRaw(vault,'cancel_signed_invoice',{signed},{gas:'100000000000000'});
   assert.equal(result.failed,true);assert.ok(result.receiptFailureMessagesContain(reason),JSON.stringify(result.receiptFailures));
  };
  inbox=new AgentInbox(join(directory,'inbox.db'),identity,{view,call:async()=>{throw Error('No executor calls during intake or owner cancellation');}});
  await inbox.enqueueSigned(a,vault.accountId);await inbox.enqueueSigned(b,vault.accountId);
  await reject(executor,a,'owner only');
  await reject(owner,{...a,invoice:{...a.invoice,amount:parseNear('0.03')}},'invalid merchant signature');
  assert.equal(await payment(a.invoice.id),null);assert.deepEqual(await funds(),before);
  await desk.close(); // Inference and owner CLI take their own shared vault lock.

  child=fork(join(cwd,'integration/helpers/owner-inference-worker.ts'),[directory,a.invoice.id],{
   cwd,env:{...process.env,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','ignore','ipc'],
  });
  await message(v=>v==='inference');
  await owner.call(vault,'set_paused',{paused:true});
  await assert.rejects(cli(['cancel',a.invoice.id],'cancel,cancel_signed_invoice'),(error:any)=>error.signal==='SIGKILL');
  assert.deepEqual(local(a.invoice.id),{state:'inference_pending',generation:0});
  assert.equal((await payment(a.invoice.id)).state,'Cancelled');
  assert.equal((await payment(a.invoice.id)).attempt_id,null);
  assert.equal((await view('get_invoice_auth',{invoice_id:a.invoice.id})).payload_hash,signedInvoiceHash(a));
  assert.equal(await view('get_service_claim',{service}),null);
  assert.deepEqual(await funds(),before);

  // Let the saved model response arrive before the owner retries. The permanent
  // cancellation must stop it even though the local row missed the first result.
  await owner.call(vault,'set_paused',{paused:false});
  const completed=message(v=>v&&typeof v==='object'),exited=once(child,'exit');
  child.send('complete');assert.equal((await completed).state,'cancelled');await exited;child=undefined;
  for(let n=0;n<2;n++){
   const row=await cli(['cancel',a.invoice.id],'cancel,cancel_signed_invoice');
   assert.equal(row.state,'cancelled');assert.equal(row.generation,1);
  }
  const replay=await executor.callRaw(vault,'authorize_signed_invoice',{signed:a},{gas:'100000000000000'});
  assert.ok(replay.failed&&replay.receiptFailureMessagesContain('invoice cancelled'));
  await reject(owner,sign('CANCEL-ALIAS',a.bill_id),'merchant bill already used');
  assert.equal(await payment('CANCEL-ALIAS'),null);assert.deepEqual(await funds(),before);
  console.log('PASS cancel-first: owner killed after chain cancellation; late inference and retries paid 0.00 and released no allowance. The service week remains available.');

  // Force the other ordering: the first owner read sees no record; by the time
  // its exact cancellation arrives, this same signed bill is already reserved.
  const attempt=createHash('sha256').update(JSON.stringify([identity,b.invoice.id,commitment(b.invoice)])).digest('hex');
  await assert.rejects(inbox.cancel(b.invoice.id,async()=>{throw Error('Unexpected ID-only cancellation');},async signed=>{
   await executor.call(vault,'authorize_signed_invoice',{signed:b},{gas:'100000000000000'});
   await reject(owner,sign(b.invoice.id,'another-bill'),'signed invoice already bound');
   await reject(owner,sign(b.invoice.id,b.bill_id,parseNear('0.03')),'invoice mismatch');
   assert.equal((await payment(b.invoice.id)).state,'Authorized');
   await executor.call(vault,'reserve',{invoice:b.invoice,attempt_id:attempt},{gas:'100000000000000'});
   return owner.call(vault,'cancel_signed_invoice',{signed},{gas:'100000000000000'});
  }),/reservation has not expired/);
  assert.deepEqual(local(b.invoice.id),{state:'queued',generation:0});
  assert.equal((await payment(b.invoice.id)).state,'Reserved');
  assert.equal(await view('policy_usage'),amount);
  assert.equal(await view('available_balance'),String(BigInt(before.available)-BigInt(amount)));
  assert.equal((await funds()).merchant,before.merchant);
  await assert.rejects(cli(['run',b.invoice.id],'execute'),(error:any)=>error.signal==='SIGKILL');
  for(let n=0;n<2;n++)assert.equal((await cli(['run',b.invoice.id,'--live-model'])).state,'settled'); // Saved proposal, no inference credits.
  assert.equal((await payment(b.invoice.id)).attempt_id,attempt);
  assert.equal((await payment(a.invoice.id)).state,'Cancelled');
  assert.equal(BigInt((await funds()).merchant)-BigInt(before.merchant),BigInt(amount));
  assert.equal(await view('policy_usage'),amount);
  assert.equal(await view('get_service_claim',{service}),b.invoice.id);
  await reject(owner,b,'only authorized or expired reserved invoices can be cancelled');
  console.log('PASS reservation-first: cancellation kept the active hold; a crash and retries paid 0.04 local test NEAR once. No second payment or allowance release.');
 } finally {
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  inbox?.close();await desk.close();
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
