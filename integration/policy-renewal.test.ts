import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {SandboxDesk} from '../app/sandbox.ts';
import {signInvoice,publicKeyBase64} from '../merchant/invoice.ts';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));

test('owner renewal survives a CLI crash, preserves rules and held quota, and cannot revive old invoices or bills',{timeout:240000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-policy-renewal-')),d=new SandboxDesk(directory,{recoverOnStart:false});
 let closed=false,child:ReturnType<typeof fork>|undefined;
 const cli=async(...args:string[])=>{
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:45000});
  return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
 };
 const reject=async(actor:any,method:string,args:any,reason:string)=>{
  const r=await actor.callRaw(d.vault,method,args,{gas:'100000000000000'});
  assert.equal(r.failed,true);assert.ok(r.receiptFailureMessagesContain(reason),JSON.stringify(r.receiptFailures));
 };
 try{
  await d.start();const initial=BigInt(await d.vault.view('available_balance',{})),merchantBefore=BigInt((await d.merchant.balance()).total.toString());
  const pair=generateKeyPairSync('ed25519'),domain=randomBytes(32).toString('hex');
  await d.owner.call(d.vault,'configure_invoice_auth',{domain});
  const key=await d.owner.call(d.vault,'set_merchant_key',{merchant_id:'signed-merchant',public_key:publicKeyBase64(pair.publicKey)});
  const clock:any=await d.vault.view('policy_snapshot',{});
  const config={merchants:[{id:'local-merchant',payee:d.merchant.accountId},{id:'signed-merchant',payee:d.merchant.accountId}],per_payment:'1000',daily_limit:'1500',min_payment:'7',expires_at:String(BigInt(clock.now)+60000n)};
  const oldPolicy=await d.owner.call(d.vault,'set_policy',config);
  const invoice=(id:string,amount:string)=>({id,payee:d.merchant.accountId,asset:'near',amount});
  const base={invoice:invoice('paid','1000'),merchant_id:'signed-merchant',bill_id:'already-paid',vault:d.vault.accountId,domain,key_version:'1',expires_at:config.expires_at};
  await d.executor.call(d.vault,'authorize_signed_invoice',{signed:signInvoice(base,pair.privateKey)},{gas:'100000000000000'});
  await d.executor.call(d.vault,'reserve',{invoice:base.invoice,attempt_id:'paid'});
  await d.executor.call(d.vault,'execute',{invoice_id:'paid',attempt_id:'paid'},{gas:'100000000000000'});
  for(const [id,amount] of [['held','400'],['expired','100']])await d.executor.call(d.vault,'authorize_by_policy',{invoice:invoice(id,amount),merchant_id:'local-merchant',expires_at:config.expires_at},{gas:'100000000000000'});
  await d.executor.call(d.vault,'reserve',{invoice:invoice('held','400'),attempt_id:'held'});
  const paid=await d.vault.view('get_payment',{invoice_id:'paid'}),auth=await d.vault.view('get_invoice_auth',{invoice_id:'paid'});
  await d.worker.provider.fastForward(200);
  assert.equal(await d.vault.view('policy_usage',{}),'1400'); // Expired, never-reserved 100 is excluded; held 400 remains.
  assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1400n);
  await d.close();closed=true;

  child=fork(join(cwd,'integration/helpers/policy-renewal-worker.ts'),[directory,'renew-once'],{cwd,execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','pipe','ipc']});
  let diagnostics='';child.stderr?.on('data',b=>{diagnostics+=String(b).slice(0,2000);});
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Renewal checkpoint timed out: '+diagnostics)),45000);
   child!.once('message',message=>{clearTimeout(timer);assert.equal(message,'renewal_accepted');resolve();});
   child!.once('exit',code=>{clearTimeout(timer);reject(Error(`Renewal exited before checkpoint: ${code} ${diagnostics}`));});
  });
  await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGKILL');});child=undefined;
  const pending=JSON.parse(readFileSync(join(directory,'policy-renewals/renew-once.json'),'utf8'));
  assert.equal(pending.state,'pending');
  const receipt=await d.vault.view('get_policy_renewal',{renewal_id:'renew-once'});
  assert.equal(receipt.version,'2');
  const recovered=await cli('renew-policy','60','renew-once');
  assert.equal(recovered.state,'confirmed');assert.equal(recovered.policy_active,true);assert.deepEqual(recovered.receipt,receipt);
  assert.equal(recovered.min_payment,'7');assert.equal(recovered.usage,'1400');
  assert.deepEqual(recovered.policy,{...oldPolicy,version:'2',expires_at:pending.request.expires_at});
  assert.deepEqual((await cli('renew-policy','60','renew-once')).policy,recovered.policy);
  assert.deepEqual(await d.vault.view('get_payment',{invoice_id:'paid'}),paid);
  assert.deepEqual(await d.vault.view('get_invoice_auth',{invoice_id:'paid'}),auth);
  assert.deepEqual(await d.vault.view('get_merchant_key',{merchant_id:'signed-merchant'}),key);
  assert.equal(await d.vault.view('get_invoice_domain',{}),domain);
  assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1400n);
  // Contract retry is independently idempotent, including when the CLI's journal is unavailable.
  assert.deepEqual(await d.owner.call(d.vault,'renew_policy',pending.request),recovered.policy);
  await reject(d.executor,'renew_policy',pending.request,'owner only');
  await reject(d.owner,'renew_policy',{...pending.request,expires_at:String(BigInt(pending.request.expires_at)+1n)},'renewal id already bound');
  await reject(d.owner,'renew_policy',{...pending.request,renewal_id:'stale'},'policy changed; renewal must be reviewed');
  await reject(d.executor,'execute',{invoice_id:'held',attempt_id:'held'},'invoice expired');
  await reject(d.executor,'reserve',{invoice:invoice('expired','100'),attempt_id:'late'},'invoice expired');
  const freshSigned=signInvoice({...base,invoice:invoice('renamed-bill','1000'),expires_at:recovered.policy.expires_at},pair.privateKey);
  await reject(d.executor,'authorize_signed_invoice',{signed:freshSigned},'merchant bill already used');
  await d.owner.call(d.vault,'cancel',{invoice_id:'held'});await d.owner.call(d.vault,'cancel',{invoice_id:'held'});
  assert.equal(await d.vault.view('policy_usage',{}),'1000');assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1000n);

  // A new fixture proposal may use only the remaining allowance after renewal.
  await cli('enqueue','after-renewal','0.0000000000000000000005');
  assert.equal((await cli('run','after-renewal')).state,'settled');
  assert.equal((await cli('run','after-renewal')).state,'settled');
  await reject(d.executor,'authorize_by_policy',{invoice:invoice('over-renewed-budget','7'),merchant_id:'local-merchant'},'rolling daily budget exceeded');
  assert.equal(BigInt((await d.merchant.balance()).total.toString())-merchantBefore,1500n);
  assert.equal(await d.vault.view('policy_usage',{}),'1500');

  // Competing owner requests cannot both extend the same policy version.
  const requests=['race-a','race-b'].map((renewal_id,i)=>({renewal_id,expected_version:'2',expires_at:String(BigInt(recovered.policy.expires_at)+BigInt(i+1)*60000n)}));
  const race=await Promise.all(requests.map(r=>d.owner.callRaw(d.vault,'renew_policy',r,{gas:'100000000000000'})));
  assert.equal(race.filter(r=>!r.failed).length,1);assert.ok(race.find(r=>r.failed)!.receiptFailureMessagesContain('policy changed; renewal must be reviewed'));
  assert.equal((await d.vault.view('get_policy',{})).version,'3');
  assert.equal((await cli('renew-policy','60','renew-once')).state,'superseded');
  await d.owner.call(d.vault,'revoke_policy',{});
  await reject(d.owner,'renew_policy',pending.request,'no spending policy');
  assert.equal((await cli('renew-policy','60','renew-once')).state,'superseded');assert.equal(await d.vault.view('get_policy',{}),null);
  assert.equal(await d.vault.view('policy_usage',{}),'1500');
  assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1500n);
  console.log('PASS: crash recovery renews once; rules, signatures, bills and holds survive; new agent payment stays within the original rolling limit.');
 }finally{
  if(child&&child.exitCode===null)await new Promise(r=>{child!.once('exit',r);child!.kill('SIGKILL');});
  if(!closed)await d.close();
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
