import assert from 'node:assert/strict';
import {execFile,fork} from 'node:child_process';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {publicKeyBase64,signInvoice,signedInvoiceHash,type ServicePeriod,type SignedInvoice} from '../merchant/invoice.ts';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const exec=promisify(execFile);
const gas={gas:'100000000000000'};

async function runWorker(directory:string,id:string,gate:'before'|'after'|'none',atCheckpoint?:()=>Promise<void>){
 const child=fork(join(cwd,'integration/helpers/weekly-correction-worker.ts'),[directory,id,gate],{
  cwd,stdio:['ignore','ignore','pipe','ipc'],execArgv:['--disable-warning=ExperimentalWarning'],
 });
 let diagnostics='';
 child.stderr!.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-3000);});
 const finished=once(child,'exit');
 const timeout=setTimeout(()=>child.kill('SIGTERM'),90_000);
 try{
  if(atCheckpoint){
   const [message]=await Promise.race([once(child,'message'),finished.then(()=>{throw Error('Worker missed checkpoint. '+diagnostics);})]);
   assert.equal(message,'reserve checkpoint');
   await atCheckpoint();
   child.send('continue');
  }
  const [code,signal]=await finished;
  if(gate==='before')assert.equal(code,0,diagnostics);
  else assert.equal(signal,'SIGKILL',diagnostics);
 }finally{
  clearTimeout(timeout);
  if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await finished;}
 }
}

test('owner correction and reservation compete for one weekly payment across process death and retries',{timeout:360_000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-correction-'));
 const desk=new SandboxDesk(directory,{recoverOnStart:false});
 const cli=async(args:string[],crashAfterCorrection=false)=>{
  const preload=crashAfterCorrection?['--import','./integration/helpers/crash-after-owner-call.ts']:[];
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning',...preload,'agent/desk.ts',...args],{
   cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,COUNTERSIGN_TEST_OWNER_RECEIPT:'correct_weekly_invoice',NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:60_000,
  });
  return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
 };
 const localAttempt=(id:string)=>{
  const db=new DatabaseSync(join(directory,'inbox.db'),{readOnly:true});
  try{return db.prepare('SELECT attempt_id,state FROM attempts WHERE invoice_id=?').get(id);}finally{db.close();}
 };
 try{
  await desk.start();
  const {owner,executor,vault,merchant}=desk;
  const now=BigInt((await vault.view('policy_snapshot',{})).now);
  const domain=randomBytes(32).toString('hex'),key=generateKeyPairSync('ed25519');
  const merchant_id='coffee-supplier',payee=merchant.accountId;
  const balance=async()=>BigInt((await merchant.balance()).total.toString());
  const available=async()=>BigInt(await vault.view('available_balance',{}));
  const usage=async()=>BigInt(await vault.view('policy_usage',{}));
  const payment=(invoice_id:string)=>vault.view('get_payment',{invoice_id});
  const successor=(original_id:string)=>vault.view('get_weekly_correction',{original_id});
  const claim=(service:ServicePeriod)=>vault.view('get_service_claim',{service});
  const sign=(id:string,amount:string,service:ServicePeriod)=>signInvoice({
   invoice:{id,payee,asset:'near',amount:parseNear(amount)},service,merchant_id,bill_id:'bill-'+id,
   vault:vault.accountId,domain,key_version:'1',expires_at:String(now+1_800_000n),
  },key.privateKey);
  const importBill=async(signed:SignedInvoice)=>{
   const path=join(directory,signed.invoice.id+'.json');
   writeFileSync(path,JSON.stringify(signed),{mode:0o600});
   assert.equal((await cli(['import',path])).state,'queued');
  };
  await owner.call(vault,'set_policy',{merchants:[{id:merchant_id,payee}],per_payment:parseNear('0.04'),daily_limit:parseNear('0.11'),expires_at:String(now+3_600_000n)});
  await owner.call(vault,'configure_invoice_auth',{domain});
  await owner.call(vault,'set_merchant_key',{merchant_id,public_key:publicKeyBase64(key.publicKey)});
  await desk.close();

  for(const correctionFirst of [true,false]){
   const agreement_id=correctionFirst?'correction-first':'reservation-first';
   const service={agreement_id,period_start_ms:String(now-60_000n)};
   await owner.call(vault,'add_weekly_service',{agreement_id,merchant_id,anchor_ms:service.period_start_ms,cap:parseNear('0.04')});
   const original=sign(agreement_id+'-original','0.04',service), replacement=sign(agreement_id+'-corrected','0.03',service);
   const originalId=original.invoice.id,nextId=replacement.invoice.id;
   const winner=correctionFirst?nextId:originalId,amount=BigInt(correctionFirst?replacement.invoice.amount:original.invoice.amount);
   const beforeBalance=await balance(),beforeAvailable=await available(),beforeUsage=await usage();
   await importBill(original);await importBill(replacement);
   const prepared=await cli(['prepare-weekly',originalId]);
   assert.equal(prepared.state,'Authorized');assert.equal(prepared.attempt_id,null);
   assert.equal(await available(),beforeAvailable);assert.equal(await balance(),beforeBalance);
   assert.equal((await cli(['run',nextId])).state,'period_claimed');
   const correct=()=>cli(['correct-weekly',originalId,nextId]);
   if(correctionFirst){
    const request={original_id:originalId,original_payload_hash:signedInvoiceHash(original),replacement};
    const rejected=async(actor:any,args:typeof request,reason:string)=>{
     const receipt=await actor.callRaw(vault,'correct_weekly_invoice',args,gas);
     assert.ok(receipt.failed && receipt.receiptFailureMessagesContain(reason),JSON.stringify(receipt.receiptFailures));
    };
    await rejected(executor,request,'owner only');
    await rejected(owner,{...request,original_payload_hash:signedInvoiceHash({...original,bill_id:'other-bill'})},'original signed bill mismatch');
    await rejected(owner,{...request,replacement:sign(nextId,'0.041',service)},'correction increases amount');
    await rejected(owner,{...request,replacement:sign(nextId,'0.03',{...service,agreement_id:'another'})},'correction changes the service or payee');
    await rejected(owner,{...request,replacement:sign(nextId,'0.03',{...service,period_start_ms:'0'})},'correction changes the service or payee');
    await rejected(owner,{...request,replacement:signInvoice({...replacement,invoice:{...replacement.invoice,payee:executor.accountId}},key.privateKey)},'correction changes the service or payee');
    await rejected(owner,{...request,replacement:signInvoice({...replacement,merchant_id:'other'},key.privateKey)},'correction changes the service or payee');
    await rejected(owner,{...request,replacement:{...replacement,signature:original.signature}},'invalid merchant signature');
    await rejected(owner,{...request,replacement:signInvoice({...replacement,bill_id:original.bill_id},key.privateKey)},'merchant bill already used');
    await rejected(owner,{...request,replacement:sign(nextId,'0.0001',service)},'below policy minimum');
    assert.equal((await payment(originalId)).state,'Authorized');
    assert.equal(await claim(service),originalId);assert.equal(await successor(originalId),null);
    assert.equal(await payment(nextId),null);assert.equal(await usage()-beforeUsage,BigInt(original.invoice.amount));

    await runWorker(directory,originalId,'before',async()=>{
     // The original worker already has a durable attempt but has not submitted reserve.
     // Kill the owner too: both the proposal and the correction must recover from chain state.
     assert.equal(localAttempt(originalId)?.state,'claimed');
     await assert.rejects(()=>cli(['correct-weekly',originalId,nextId],true),(error:any)=>error.signal==='SIGKILL');
     const {invoices}=await cli(['status']);
     assert.equal(invoices.find((row:any)=>row.id===nextId).state,'period_claimed');
     assert.equal((await payment(originalId)).state,'Cancelled');
     assert.equal((await payment(originalId)).attempt_id,null);
     assert.equal((await payment(nextId)).state,'Authorized');
     assert.equal(await claim(service),nextId);assert.equal(await successor(originalId),nextId);
     assert.equal(await usage()-beforeUsage,amount);assert.equal(await available(),beforeAvailable);
    });
    await runWorker(directory,nextId,'none');
    await rejected(owner,{...request,replacement:{...replacement,signature:original.signature}},'correction already bound');
    await rejected(owner,{...request,replacement:sign('different-successor','0.03',service)},'correction already bound');
   }else{
    await runWorker(directory,originalId,'after',async()=>{
     assert.equal((await payment(originalId)).state,'Reserved');
     await assert.rejects(correct,/correction requires a never-reserved bill/i);
     assert.equal(await claim(service),originalId);assert.equal(await successor(originalId),null);
     assert.equal(await payment(nextId),null);assert.equal(beforeAvailable-await available(),amount);
    });
   }

   const settled=await payment(winner),attempt=localAttempt(winner);
   assert.equal(settled.state,'Settled');assert.ok(settled.attempt_id);
   assert.equal(attempt?.state,'claimed');assert.equal(attempt?.attempt_id,settled.attempt_id);
   assert.equal(await balance()-beforeBalance,amount);
   for(let retry=0;retry<2;retry++){
    if(correctionFirst)assert.deepEqual(await correct(),settled);
    else await assert.rejects(correct,/correction requires a never-reserved bill/i);
    assert.equal((await cli(['run',originalId])).state,correctionFirst?'cancelled':'settled');
    assert.equal((await cli(['run',nextId])).state,correctionFirst?'settled':'period_claimed');
   }
   assert.deepEqual(await payment(winner),settled);
   assert.equal(await claim(service),winner);assert.equal(localAttempt(winner)?.state,'settled');
   assert.equal(await balance()-beforeBalance,amount);assert.equal(beforeAvailable-await available(),amount);
   assert.equal(await usage()-beforeUsage,amount);
   if(correctionFirst){
    assert.equal((await payment(originalId)).attempt_id,null);
    assert.equal(localAttempt(originalId)?.state,'cancelled');
   }
   else assert.equal(await payment(nextId),null);
   console.log(`PASS ${agreement_id}: merchant gained ${correctionFirst?'0.03':'0.04'} local test NEAR once; retry added 0.00.`);
  }

  // A separate cancellation before the first reservation is also eligible.
  const service={agreement_id:'cancelled-first',period_start_ms:String(now)};
  await owner.call(vault,'add_weekly_service',{agreement_id:service.agreement_id,merchant_id,anchor_ms:service.period_start_ms,cap:parseNear('0.04')});
  const original=sign('cancelled-original','0.04',service),replacement=sign('equal-correction','0.04',service);
  await importBill(original);await importBill(replacement);
  await cli(['prepare-weekly',original.invoice.id]);
  await cli(['cancel',original.invoice.id]);
  assert.equal((await cli(['correct-weekly',original.invoice.id,replacement.invoice.id])).state,'Authorized');
  assert.equal(await claim(service),replacement.invoice.id);assert.equal(await usage(),BigInt(parseNear('0.11')));
  await cli(['cancel',replacement.invoice.id]);
  await owner.call(vault,'set_merchant_key',{merchant_id,public_key:null});
  assert.equal((await cli(['correct-weekly',original.invoice.id,replacement.invoice.id])).state,'Cancelled');
  assert.equal(await usage(),BigInt(parseNear('0.07')));
 }finally{
  await desk.close();
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
