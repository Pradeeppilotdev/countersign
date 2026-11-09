import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,fork} from 'node:child_process';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {publicKeyBase64,signInvoice,type ServicePeriod,type SignedInvoice} from '../merchant/invoice.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const exec=promisify(execFile);
const week=7*24*60*60*1000;
const gas={gas:'100000000000000'};

async function crashAfterPayment(directory:string,ids:string[]){
 const worker=fork(join(root,'integration/helpers/weekly-payment-worker.ts'),[directory,...ids],{
  cwd:root,stdio:['ignore','ignore','pipe','ipc'],execArgv:['--disable-warning=ExperimentalWarning'],
 });
 let diagnostics='';
 worker.stderr!.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-4000);});
 try {
  return await new Promise<{winner:string;loser:string;attempt:string;reason:string}>((resolve,reject)=>{
   let accepted:{id:string;attempt:string}|undefined;
   let blocked:{id:string;error:string}|undefined;
   const timer=setTimeout(()=>reject(Error('Payment checkpoint timed out. '+diagnostics)),60000);
   const exited=(code:number|null)=>{clearTimeout(timer);reject(Error(`Payment worker exited at ${code}. ${diagnostics}`));};
   worker.once('exit',exited);
   worker.on('message',(message:any)=>{
    if(message.event==='transfer_accepted')accepted=message;
    if(message.event==='duplicate_blocked')blocked=message;
    if(accepted && blocked){
     clearTimeout(timer);
     worker.removeListener('exit',exited);
     resolve({winner:accepted.id,attempt:accepted.attempt,loser:blocked.id,reason:blocked.error});
    }
   });
  });
 } finally {
  if(worker.exitCode===null && worker.signalCode===null){
   const stopped=once(worker,'exit');
   worker.kill('SIGKILL');
   const [,signal]=await stopped;
   assert.equal(signal,'SIGKILL');
  }
 }
}

test('two independently signed bills race for one service week, survive lost acknowledgement, and permit the next week',{timeout:240000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-weekly-'));
 const desk=new SandboxDesk(directory,{recoverOnStart:false});
 const pair=generateKeyPairSync('ed25519');
 const merchant_id='compute-supplier',agreement_id='weekly-compute';
 const domain=randomBytes(32).toString('hex');
 const paymentAmount=parseNear('0.04');
 const cli=async(...args:string[])=>{
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{
   cwd:root,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:60000,
  });
  return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
 };
 const reject=async(actor:any,method:string,args:Record<string,unknown>,reason:string)=>{
  const receipt=await actor.callRaw(desk.vault,method,args,gas);
  assert.ok(receipt.failed && receipt.receiptFailureMessagesContain(reason),JSON.stringify(receipt.receiptFailures));
 };
 const importBill=async(signed:SignedInvoice)=>{
  const file=join(directory,signed.invoice.id+'.json');
  writeFileSync(file,JSON.stringify(signed),{mode:0o600});
  assert.equal((await cli('import',file)).state,'queued');
 };
 let locked=true;
 try {
  await desk.start();
  const vault=desk.vault, owner=desk.owner, executor=desk.executor, payee=desk.merchant.accountId;
  const chainTime=async()=>Number((await vault.view('policy_snapshot',{})).now);
  const balance=async()=>BigInt((await desk.merchant.balance()).total.toString());
  const before=await balance(),initial=BigInt(await vault.view('available_balance',{}));
  const now=await chainTime();
  const config={merchants:[{id:merchant_id,payee},{id:'alias',payee}],per_payment:parseNear('0.1'),daily_limit:parseNear('0.15'),expires_at:String(now+3600000)};
  await owner.call(vault,'set_policy',config);
  await owner.call(vault,'configure_invoice_auth',{domain});
  await owner.call(vault,'set_merchant_key',{merchant_id,public_key:publicKeyBase64(pair.publicKey)});
  const invoice=(id:string,amount=paymentAmount)=>({id,payee,asset:'near',amount});
  const sign=(id:string,bill_id:string,service?:ServicePeriod,amount=paymentAmount)=>signInvoice({
   invoice:invoice(id,amount),merchant_id,bill_id,vault:vault.accountId,domain,key_version:'1',expires_at:String(now+1800000),
   ...(service?{service}:{}),
  },pair.privateKey);
  await owner.call(vault,'authorize',{invoice:invoice('old-manual')});
  await executor.call(vault,'authorize_by_policy',{invoice:invoice('old-alias'),merchant_id:'alias'});
  await executor.call(vault,'reserve',{invoice:invoice('old-alias'),attempt_id:'old-attempt'});

  // Put the real weekly boundary a few minutes ahead so fast-forwarding remains inexpensive.
  const boundary=await chainTime()+240000;
  const anchor_ms=String(boundary-week);
  const service={agreement_id,period_start_ms:anchor_ms};
  const grant={agreement_id,merchant_id,cap:parseNear('0.10'),anchor_ms};
  await reject(executor,'add_weekly_service',grant,'owner only');
  await desk.close();locked=false;
  await cli('weekly-service',agreement_id,merchant_id,'0.10',anchor_ms);
  assert.deepEqual((await cli('service-status',agreement_id)).service,service);
  await reject(owner,'add_weekly_service',{...grant,anchor_ms:String(Number(anchor_ms)+1)},'service agreement already bound');
  await reject(executor,'revoke_weekly_service',{agreement_id},'owner only');
  await reject(owner,'authorize',{invoice:invoice('manual-bypass')},'signed service period required');
  await reject(executor,'reserve',{invoice:invoice('old-manual'),attempt_id:'manual'},'signed service period required');
  await reject(executor,'execute',{invoice_id:'old-alias',attempt_id:'old-attempt'},'signed service period required');
  await owner.call(vault,'set_policy',config);
  await owner.call(vault,'cancel',{invoice_id:'old-alias'});
  await owner.call(vault,'cancel',{invoice_id:'old-manual'});
  await reject(executor,'authorize_by_policy',{invoice:invoice('alias-bypass'),merchant_id:'alias'},'signed service period required');
  const rejectSigned=(signed:SignedInvoice,reason:string)=>reject(executor,'authorize_signed_invoice',{signed},reason);
  await rejectSigned(sign('no-period','legacy'), 'signed service period required');
  await rejectSigned(sign('too-early','future',{agreement_id,period_start_ms:String(boundary)}),'outside current service period');
  await rejectSigned(sign('self-grant','unknown',{...service,agreement_id:'invented'}),'unknown service agreement');
  await rejectSigned(sign('over-cap','over',service,parseNear('0.11')),'service payment cap exceeded');
  await rejectSigned(sign('under-min','small',service,'1'),'below policy minimum');
  const bills=[sign('INV-A','SUPPLIER-801',service),sign('INV-B','SUPPLIER-947',service)];
  await rejectSigned({...bills[0],service:{...service,period_start_ms:String(boundary)}},'invalid merchant signature');
  assert.equal(await vault.view('get_service_claim',{service}),null);
  assert.equal(await vault.view('policy_usage',{}),'0');

  for(const bill of bills)await importBill(bill);
  const {winner,loser,attempt,reason}=await crashAfterPayment(directory,bills.map(b=>b.invoice.id));
  assert.deepEqual([winner,loser].sort(),['INV-A','INV-B']);
  assert.equal(reason,`Service period already claimed by [${winner}].`);
  const db=new DatabaseSync(join(directory,'inbox.db'),{readOnly:true});
  try {
   assert.equal(db.prepare('SELECT state FROM inbox WHERE id=?').get(winner)?.state,'proposal_ready');
   const attempts=db.prepare('SELECT * FROM attempts').all();
   assert.equal(attempts.length,1);
   assert.equal(attempts[0].attempt_id,attempt);
   assert.equal(attempts[0].state,'claimed');
  } finally {db.close();}
  const paid=await vault.view('get_payment',{invoice_id:winner});
  assert.equal(paid.state,'Settled');assert.equal(paid.attempt_id,attempt);
  assert.equal(await vault.view('invoice_expiry',{invoice_id:winner}),String(boundary));
  assert.equal(await vault.view('get_service_claim',{service}),winner);
  assert.equal(await vault.view('get_payment',{invoice_id:loser}),null);

  const policy=await vault.view('get_policy',{});
  await owner.call(vault,'renew_policy',{renewal_id:'renew-during-recovery',expected_version:policy.version,expires_at:String(now+7200000)});
  for(let retry=0;retry<2;retry++){
   assert.equal((await cli('run',winner)).state,'settled');
   assert.equal((await cli('run',loser)).state,'period_claimed');
  }
  await rejectSigned(bills.find(b=>b.invoice.id===loser)!,`service period already claimed by [${winner}]`);
  assert.deepEqual(await vault.view('get_payment',{invoice_id:winner}),paid);
  assert.equal(await balance()-before,BigInt(paymentAmount));
  assert.equal(BigInt(await vault.view('available_balance',{})),initial-BigInt(paymentAmount));
  const usage=await vault.view('policy_usage',{});
  assert.equal(usage,paymentAmount);
  assert.equal(BigInt(policy.daily_limit)-BigInt(usage),BigInt(parseNear('0.11')));
  console.log(`Same week: ${winner} settled; ${loser} identifies ${winner}. After SIGKILL, renewal and retries: merchant +0.04 test NEAR; rolling allowance 0.11 NEAR.`);

  const remaining=boundary-await chainTime();
  if(remaining>0)await desk.worker.provider.fastForward(Math.ceil(remaining/500)+5);
  const next=(await cli('service-status',agreement_id)).service;
  assert.deepEqual(next,{agreement_id,period_start_ms:String(boundary)});
  await rejectSigned(sign('backdate','old-week',service),'outside current service period');
  const third=sign('INV-C','SUPPLIER-995',next);
  await importBill(third);
  assert.equal((await cli('run',third.invoice.id)).state,'settled');
  assert.equal((await cli('service-status',agreement_id)).claimed_by,third.invoice.id);
  assert.equal((await cli('service-status',agreement_id,anchor_ms)).claimed_by,winner);
  assert.equal(await balance()-before,2n*BigInt(paymentAmount));
  assert.equal(BigInt(await vault.view('available_balance',{})),initial-2n*BigInt(paymentAmount));
  assert.equal(await vault.view('policy_usage',{}),parseNear('0.08'));
  await cli('revoke-service',agreement_id);
  assert.equal((await cli('service-status',agreement_id)).service,null);
  assert.equal(await vault.view('get_service_claim',{service}),winner);
  await rejectSigned(sign('after-revocation','revoked',next),'service agreement revoked');
  console.log('Next service week: INV-C paid 0.04 test NEAR. Both weeks retain their original invoice IDs.');
 } finally {
  if(locked)await desk.close();
  try {process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');} catch {}
 }
});
