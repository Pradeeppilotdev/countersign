import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SandboxDesk} from '../app/sandbox.ts';
import {AgentInbox} from '../agent/inbox.ts';
import {renewLocalPolicy} from '../agent/policy-renewal.ts';
import {signInvoice,publicKeyBase64,type SignedInvoice} from '../merchant/invoice.ts';
import {upgradeLocalVault} from '../app/vault-upgrade.ts';
import {digest,localRecords,storageDigest} from '../app/upgrade-state.ts';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
test('saved-vault upgrade preserves full state, blocks interrupted startup and resumes without a second deployment',{timeout:180000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-upgrade-')),desk=new SandboxDesk(directory,{recoverOnStart:false});let closed=false;
 const unsigned=(id:string)=>({id,payee:desk.merchant.accountId,asset:'near',amount:'1000'});
 const leb=(n:number)=>{const b=[];do{const v=n&127;n>>>=7;b.push(v|(n?128:0));}while(n);return Buffer.from(b);};
 const original=readFileSync(join(cwd,'contract/target/wasm32-unknown-unknown/release/countersign.wasm'));
 const label=Buffer.from('countersign-upgrade-regression'),section=Buffer.concat([leb(label.length),label]);
 const target=Buffer.concat([original,Buffer.from([0]),leb(section.length),section]),wasm=join(directory,'candidate.wasm');writeFileSync(wasm,target);
 const child=async(crash=false)=>{const r=await exec(process.execPath,['--disable-warning=ExperimentalWarning','integration/upgrade-child.mjs',directory,wasm,...(crash?['crash']:[])],{cwd,timeout:90000,env:{...process.env,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''}});return JSON.parse(r.stdout);};
 try{
  await desk.start();const domain=randomBytes(32).toString('hex'),keys=generateKeyPairSync('ed25519');
  await desk.owner.call(desk.vault,'set_policy',{merchants:[{id:'plain',payee:desk.merchant.accountId},{id:'signed',payee:desk.merchant.accountId}],per_payment:'1000',daily_limit:'10000',expires_at:String(Date.now()+3600000)});
  await desk.owner.call(desk.vault,'configure_invoice_auth',{domain});await desk.owner.call(desk.vault,'set_merchant_key',{merchant_id:'signed',public_key:publicKeyBase64(keys.publicKey)});
  const renewal=await renewLocalPolicy(desk,'before-upgrade',60);
  assert.equal(renewal.state,'confirmed');
  const signed=signInvoice({invoice:{...unsigned('signed-paid'),amount:'500'},merchant_id:'signed',bill_id:'immutable-bill',vault:desk.vault.accountId,domain,key_version:'1',expires_at:String(Date.now()+600000)},keys.privateKey);
  const openInbox=()=>new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,{call:(m,a)=>desk.executor.call(desk.vault,m,a,{gas:'100000000000000'}),view:(m,a)=>desk.vault.view(m,a)});
  const runBill=async(inbox:AgentInbox,bill:SignedInvoice)=>{
   await inbox.enqueueSigned(bill,desk.vault.accountId);
   return inbox.run(bill.invoice.id,async i=>({name:'request_payment',arguments:{invoice_id:i.id}}));
  };
  const inbox=openInbox();
  try{assert.equal((await runBill(inbox,signed)).state,'settled');inbox.enqueue(unsigned('queued'),'plain');}finally{inbox.close();}
  for(const id of ['orphan-approved','held'])await desk.executor.call(desk.vault,'authorize_by_policy',{invoice:unsigned(id),merchant_id:'plain'});
  await desk.executor.call(desk.vault,'reserve',{invoice:unsigned('held'),attempt_id:'held-attempt'});
  await desk.action('authorize',{id:'ui-approved',amount:'0.001'});
  const service={agreement_id:'compute',period_start_ms:(await desk.vault.view('policy_snapshot',{})).now};
  const grant=await desk.owner.call(desk.vault,'add_weekly_service',{agreement_id:service.agreement_id,merchant_id:'signed',anchor_ms:service.period_start_ms,cap:'500'});
  const weeklyBill=(id:string,bill_id:string)=>signInvoice({...signed,invoice:{...signed.invoice,id},bill_id,service},keys.privateKey);
  const firstBill=weeklyBill('weekly-first','compute-bill-111'),secondBill=weeklyBill('weekly-second','compute-bill-875');
  const beforeUpgrade=openInbox();
  try{assert.equal((await runBill(beforeUpgrade,firstBill)).state,'settled');}finally{beforeUpgrade.close();}
  const route={invoice_id:'dry-approval',origin_asset:'near',destination_asset:'base-usdc',recipient:'0x1111111111111111111111111111111111111111',refund_to:desk.owner.accountId,amount_out:'1',max_amount_in:'2',quoted_amount_in:'1',expires_at:String(Date.now()+60000),quote_hash:'1'.repeat(32),response_hash:'a'.repeat(64)};
  await desk.owner.call(desk.vault,'authorize_route',{route});await desk.owner.call(desk.vault,'set_paused',{paused:true});
  const stopped=signInvoice({...signed,invoice:unsigned('cancelled-before-approval'),bill_id:'never-approved'},keys.privateKey);
  const queued=openInbox();
  try{await queued.enqueueSigned(stopped,desk.vault.accountId);}finally{queued.close();}
  await desk.owner.call(desk.vault,'cancel_signed_invoice',{signed:stopped},{gas:'100000000000000'});
  const stoppedReceipt=await desk.vault.view('get_invoice_auth',{invoice_id:stopped.invoice.id});
  const before=await desk.vault.viewStateRaw(),localBefore=localRecords(directory),merchantBefore=(await desk.merchant.balance()).total.toString();
  const available=await desk.vault.view('available_balance',{}),policy=await desk.vault.view('get_policy',{}),key=await desk.vault.view('get_merchant_key',{merchant_id:'signed'}),bill=await desk.vault.view('get_invoice_auth',{invoice_id:'signed-paid'});
  await desk.close();closed=true;
  // Model a valid older artifact that has the legacy controls and lacks a
  // weekly entry point. Keep the export's byte length and all other methods.
  const stale=Buffer.from(original),method='get_service_claim';
  for(let i=stale.indexOf(method);i!==-1;i=stale.indexOf(method,i+method.length))stale[i]='x'.charCodeAt(0);
  const stalePath=wasm+'.pre-weekly';writeFileSync(stalePath,stale);
  const methods=WebAssembly.Module.exports(new WebAssembly.Module(stale)).map(e=>e.name);
  assert.ok(methods.includes('clear_policy_approvals')&&!methods.includes(method));
  await assert.rejects(()=>upgradeLocalVault(directory,stalePath),/Missing weekly billing method get_service_claim/);
  assert.equal(existsSync(join(directory,'upgrade-pending.json')),false);
  assert.equal(storageDigest(await desk.vault.viewStateRaw()),storageDigest(before));
  await assert.rejects(()=>child(true),(error:any)=>error.signal==='SIGKILL');
  assert.equal(existsSync(join(directory,'upgrade-pending.json')),true);
  const blocked=new SandboxDesk(directory);await assert.rejects(()=>blocked.start(),/upgrade needs verification/);await blocked.close();
  const deploymentKey=await desk.vault.getKey();assert.ok(deploymentKey);
  const access=()=>desk.vault.provider.viewAccessKey(desk.vault.accountId,deploymentKey!.getPublicKey());
  const nonce=(await access()).nonce.toString();
  const result=await child();assert.equal(result.upgraded,false);assert.equal(result.vault,desk.vault.accountId);assert.equal(result.codeHash,digest(target));
  assert.equal((await access()).nonce.toString(),nonce);assert.equal(existsSync(join(directory,'upgrade-pending.json')),false);
  assert.equal(storageDigest(await desk.vault.viewStateRaw()),storageDigest(before));assert.deepEqual(localRecords(directory),localBefore);
  assert.ok(localBefore.files['policy-renewals/before-upgrade.json']);
  assert.deepEqual(await desk.vault.view('get_policy_renewal',{renewal_id:'before-upgrade'}),renewal.receipt);
  console.log('PASS: upgrade retained both the owner renewal journal and the on-chain receipt.');
  assert.deepEqual(result.invoices.map((p:any)=>p.id).sort(),['cancelled-before-approval','held','orphan-approved','signed-paid','ui-approved','weekly-first']);
  assert.equal(result.localRecords['inbox.db'].invoices,4);assert.equal(result.localRecords['inbox.db'].attempts,2);
  assert.equal(result.controls.paused,true);assert.equal(result.capacity.max_pending,16);
  assert.equal(await desk.vault.view('available_balance',{}),available);assert.equal((await desk.merchant.balance()).total.toString(),merchantBefore);
  assert.deepEqual(await desk.vault.view('get_policy',{}),policy);assert.deepEqual(await desk.vault.view('get_merchant_key',{merchant_id:'signed'}),key);assert.deepEqual(await desk.vault.view('get_invoice_auth',{invoice_id:'signed-paid'}),bill);
  assert.ok(await desk.vault.view('get_route',{invoice_id:route.invoice_id}));
  assert.equal(statSync(result.backup).mode&0o777,0o700);assert.equal(statSync(join(result.backup,'previous-contract.wasm')).mode&0o777,0o600);
  assert.equal(digest(readFileSync(join(result.backup,'previous-contract.wasm'))),digest(original));assert.deepEqual(localRecords(join(result.backup,'saved-vault')),localBefore);
  const denied=await desk.executor.callRaw(desk.vault,'clear_policy_approvals',{});assert.ok(denied.receiptFailureMessagesContain('owner only'));
  const cleared=await desk.owner.call(desk.vault,'clear_policy_approvals',{},{gas:'300000000000000'});assert.deepEqual(cleared,['orphan-approved']);assert.equal((await desk.vault.view<any>('get_payment',{invoice_id:'held'})).state,'Reserved');
  await desk.owner.call(desk.vault,'set_paused',{paused:false});
  const paid:any=await desk.vault.view('get_payment',{invoice_id:'signed-paid'});await desk.executor.call(desk.vault,'execute',{invoice_id:paid.invoice.id,attempt_id:paid.attempt_id});
  assert.equal((await desk.merchant.balance()).total.toString(),merchantBefore);
  const replay=signInvoice({...signed,invoice:{...signed.invoice,id:'renamed-bill'}},keys.privateKey);
  const rejected=await desk.executor.callRaw(desk.vault,'authorize_signed_invoice',{signed:replay},{gas:'100000000000000'});assert.ok(rejected.receiptFailureMessagesContain('merchant bill already used'));
  assert.deepEqual(await desk.vault.view('get_weekly_service',{agreement_id:service.agreement_id}),grant);
  assert.equal(await desk.vault.view('get_service_claim',{service}),firstBill.invoice.id);
  const usage=await desk.vault.view('policy_usage',{});
  const recovered=openInbox();
  try{
   assert.equal(recovered.get(stopped.invoice.id).state,'queued'); // The owner died before saving the local result.
   const noOwnerCall=async()=>{throw Error('Cancellation must recover from the retained receipt');};
   assert.equal((await recovered.cancel(stopped.invoice.id,noOwnerCall,noOwnerCall)).state,'cancelled');
   assert.deepEqual(await desk.vault.view('get_invoice_auth',{invoice_id:stopped.invoice.id}),stoppedReceipt);
   assert.deepEqual(recovered.get(firstBill.invoice.id).signed_invoice,firstBill);
   assert.equal((await runBill(recovered,firstBill)).state,'settled');
   const duplicate=await runBill(recovered,secondBill);
   assert.equal(duplicate.state,'period_claimed');assert.equal(duplicate.error,'Service period already claimed by [weekly-first].');
  }finally{recovered.close();}
  assert.equal(await desk.vault.view('get_payment',{invoice_id:secondBill.invoice.id}),null);
  assert.equal(await desk.vault.view('available_balance',{}),available);
  assert.equal(await desk.vault.view('policy_usage',{}),usage);
  assert.equal((await desk.merchant.balance()).total.toString(),merchantBefore);
  // A local-only injected in-flight record must prevent any code deployment,
  // including one omitted from both the UI and inbox. No transfer is submitted.
  const held=(await desk.vault.viewStateRaw()).find((e:any)=>{const k=Buffer.from(e.key,'base64');return k[0]===112&&k.subarray(5).toString()==='held';})!;
  const value=Buffer.from(held.value,'base64');let offset=0;for(let i=0;i<3;i++)offset+=4+value.readUInt32LE(offset);offset+=16;offset+=4+value.readUInt32LE(offset);assert.equal(value[offset],1);value[offset]=2;
  await desk.vault.updateData(held.key,value.toString('base64'));
  await assert.rejects(()=>child(),/In-flight payment must settle/);
  assert.equal((await access()).nonce.toString(),nonce);assert.equal((await desk.vault.view<any>('get_payment',{invoice_id:'held'})).state,'Executing');assert.equal(await desk.vault.view('available_balance',{}),available);
 }finally{if(!closed)await desk.close();try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}}
});
