import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SandboxDesk} from '../app/sandbox.ts';
import {AgentInbox} from '../agent/inbox.ts';
import {signInvoice,publicKeyBase64} from '../merchant/invoice.ts';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
test('owner pause blocks every native payment entry; executor replacement preserves holds and old credentials lose authority',{timeout:180000},async()=>{
 const d=new SandboxDesk();try{
  await d.start();const replacement=await d.worker.rootAccount.createSubAccount('replacement');
  const invoice={id:'reserved',payee:d.merchant.accountId,asset:'near',amount:'1000'};
  const before=BigInt((await d.merchant.balance()).total.toString());
  const reject=async(actor:any,m:string,a:any,reason:string)=>{const r=await actor.callRaw(d.vault,m,a,{gas:'100000000000000'});assert.equal(r.failed,true);assert.ok(r.receiptFailureMessagesContain(reason),JSON.stringify(r.receiptFailures));};
  await reject(d.owner,'set_executor',{executor:replacement.accountId},'pause before replacing executor');
  await d.owner.call(d.vault,'authorize',{invoice});await d.executor.call(d.vault,'reserve',{invoice,attempt_id:'same-attempt'});
  await d.owner.call(d.vault,'authorize',{invoice:{...invoice,id:'authorized'}});
  await d.owner.call(d.vault,'set_policy',{merchants:[{id:'plain',payee:d.merchant.accountId},{id:'signed',payee:d.merchant.accountId}],per_payment:'1000',daily_limit:'2000',expires_at:String(Date.now()+3600000)});
  const pair=generateKeyPairSync('ed25519'),domain=randomBytes(32).toString('hex');
  await d.owner.call(d.vault,'configure_invoice_auth',{domain});await d.owner.call(d.vault,'set_merchant_key',{merchant_id:'signed',public_key:publicKeyBase64(pair.publicKey)});
  const signed=signInvoice({invoice:{...invoice,id:'signed-new'},merchant_id:'signed',bill_id:'bill',vault:d.vault.accountId,domain,key_version:'1',expires_at:String(Date.now()+600000)},pair.privateKey);
  const budget=await d.vault.view('available_balance',{});
  await reject(d.executor,'set_paused',{paused:true},'owner only');
  await d.owner.call(d.vault,'set_paused',{paused:true});
  await reject(d.executor,'set_paused',{paused:false},'owner only');
  await reject(d.executor,'set_executor',{executor:replacement.accountId},'owner only');
  await reject(d.owner,'set_executor',{executor:d.owner.accountId},'executor must be separate');
  await reject(d.owner,'authorize',{invoice:{...invoice,id:'manual-new'}},'vault payments paused');
  await reject(d.executor,'authorize_by_policy',{invoice:{...invoice,id:'policy-new'},merchant_id:'plain'},'vault payments paused');
  await reject(d.executor,'authorize_signed_invoice',{signed},'vault payments paused');
  await reject(d.executor,'reserve',{invoice:{...invoice,id:'authorized'},attempt_id:'new-attempt'},'vault payments paused');
  await reject(d.executor,'execute',{invoice_id:invoice.id,attempt_id:'same-attempt'},'vault payments paused');
  assert.equal(await d.vault.view('available_balance',{}),budget);assert.equal(await d.vault.view('policy_usage',{}),'0');
  assert.equal(BigInt((await d.merchant.balance()).total.toString()),before);
  await d.owner.call(d.vault,'cancel',{invoice_id:'authorized'}); // Owner remediation stays available.
  await d.owner.call(d.vault,'set_executor',{executor:replacement.accountId});
  await d.owner.call(d.vault,'set_paused',{paused:false});
  for(const [method,args] of [['execute',{invoice_id:invoice.id,attempt_id:'same-attempt'}],['reserve',{invoice,attempt_id:'same-attempt'}],['authorize_by_policy',{invoice:{...invoice,id:'old-policy'},merchant_id:'plain'}],['authorize_signed_invoice',{signed}]] as const)await reject(d.executor,method,args,'executor only');
  assert.equal((await replacement.call(d.vault,'execute',{invoice_id:invoice.id,attempt_id:'same-attempt'},{gas:'100000000000000'})).state,'Settled');
  await replacement.call(d.vault,'execute',{invoice_id:invoice.id,attempt_id:'same-attempt'},{gas:'100000000000000'});
  assert.equal(BigInt((await d.merchant.balance()).total.toString())-before,1000n);assert.equal(await d.vault.view('available_balance',{}),budget);
 }finally{await d.close();}
});
test('owner CLI does not auto-pay at startup; rotation recovers from stale metadata with the same inbox attempt',{timeout:240000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'countersign-controls-'));const d=new SandboxDesk(dir);let closed=false;
 const cli=async(...args:string[])=>{const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:dir,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:60000});return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));};
 try{
  await d.start();const original=d.executor;
  await d.owner.call(d.vault,'set_policy',{merchants:[{id:'local-merchant',payee:d.merchant.accountId}],per_payment:'1000',daily_limit:'2000',expires_at:String(Date.now()+3600000)});
  const invoice={id:'pending-agent',payee:d.merchant.accountId,asset:'near',amount:'1000'};
  const inbox=new AgentInbox(join(dir,'inbox.db'),`${d.session}:${d.vault.accountId}`,{
   async call(m,a){const result=await d.executor.call(d.vault,m,a,{gas:'100000000000000'});if(m==='reserve')throw Error('Stopped after reservation');return result;},view:(m,a)=>d.vault.view(m,a),
  });
  try{inbox.enqueue(invoice,'local-merchant');await assert.rejects(()=>inbox.run(invoice.id,async()=>({name:'request_payment',arguments:{invoice_id:invoice.id}})),/Stopped after reservation/);}finally{inbox.close();}
  // A legacy desk claim would transfer on startup unless administrative CLI recovery is disabled.
  await d.action('authorize',{id:'app-hold',amount:'0.000000000000000000001'});await d.action('reserve',{id:'app-hold'});
  const p:any=await d.vault.view('get_payment',{invoice_id:'app-hold'}),runner=d.runner('app-hold');
  try{runner.db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('app-hold',p.attempt_id,p.commitment,'claimed');}finally{runner.close();}
  const held:any=await d.vault.view('get_payment',{invoice_id:invoice.id});
  await d.close();closed=true;
  assert.equal((await cli('pause')).paused,true);
  const paused=await cli('status');assert.equal(paused.merchantReceived,'0');
  await assert.rejects(()=>cli('run',invoice.id,'--live-model'),/Vault payments paused/);
  const next=await cli('rotate-executor','executor-recovery-1');assert.equal(next.paused,true);
  const account=d.worker.account(next.executor),newBalance=(await account.balance()).total.toString();
  assert.equal((await cli('rotate-executor','executor-recovery-1')).executor,next.executor);
  assert.equal((await account.balance()).total.toString(),newBalance); // No funding again on retry.
  const saved=JSON.parse(readFileSync(join(dir,'desk.json'),'utf8'));saved.executor=original.accountId;writeFileSync(join(dir,'desk.json'),JSON.stringify(saved));
  assert.equal((await cli('status')).controls.executor,next.executor); // Chain, not cached metadata, determines current signer.
  await cli('unpause');
  const denied=await original.callRaw(d.vault,'execute',{invoice_id:invoice.id,attempt_id:held.attempt_id});assert.ok(denied.receiptFailureMessagesContain('executor only'));
  assert.equal((await cli('run',invoice.id,'--live-model')).state,'settled'); // Empty credentials: no new inference.
  assert.equal((await cli('run',invoice.id,'--live-model')).state,'settled');
  const state=await cli('status');assert.equal(state.merchantReceived,'1000');assert.equal(state.usage,'1000');assert.equal(state.available,paused.available);
  const recovered:any=await d.vault.view('get_payment',{invoice_id:invoice.id});assert.equal(recovered.attempt_id,held.attempt_id);
  assert.equal((await d.vault.view('get_payment',{invoice_id:'app-hold'}) as any).state,'Reserved');
 }finally{if(!closed)await d.close();try{process.kill(JSON.parse(readFileSync(join(dir,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}}
});
