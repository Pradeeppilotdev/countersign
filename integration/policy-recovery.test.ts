import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SandboxDesk} from '../app/sandbox.ts';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
test('expired approvals free only unused quota; minimum, pending cap and owner recovery preserve live holds',{timeout:300000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-policy-recovery-')),d=new SandboxDesk(directory);let closed=false;
 const cli=async(...args:string[])=>{const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:45000});return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));};
 try{
  await d.start();const initial=BigInt(await d.vault.view('available_balance',{})),merchantBefore=BigInt((await d.merchant.balance()).total.toString());
  const base={payee:d.merchant.accountId,asset:'near',amount:'1000'},config={merchants:[{id:'local-merchant',payee:base.payee}],per_payment:'1000',daily_limit:'100000',min_payment:'100',expires_at:String(Date.now()+3600000)};
  const auth=(id:string,amount='1000',expires_at?:string)=>d.executor.call(d.vault,'authorize_by_policy',{invoice:{...base,id,amount},merchant_id:'local-merchant',expires_at},{gas:'100000000000000'});
  const reject=async(actor:any,method:string,args:any,reason:string)=>{const r=await actor.callRaw(d.vault,method,args,{gas:'100000000000000'});assert.equal(r.failed,true);assert.ok(r.receiptFailureMessagesContain(reason),JSON.stringify(r.receiptFailures));};
  await d.owner.call(d.vault,'set_policy',config);
  await reject(d.owner,'set_policy',{...config,min_payment:'1001'},'invalid policy minimum');
  await reject(d.executor,'authorize_by_policy',{invoice:{...base,id:'dust',amount:'1'},merchant_id:'local-merchant'},'below policy minimum');
  const expiry=String(Date.now()+30000);
  for(const id of ['expired','reserved','paid'])await auth(id,'1000',expiry);
  for(const id of ['reserved','paid'])await d.executor.call(d.vault,'reserve',{invoice:{...base,id},attempt_id:id});
  await d.executor.call(d.vault,'execute',{invoice_id:'paid',attempt_id:'paid'},{gas:'100000000000000'});
  assert.equal(await d.vault.view('policy_usage',{}),'3000');
  await d.worker.provider.fastForward(100);
  assert.equal(await d.vault.view('policy_usage',{}),'2000');assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-2000n);
  await reject(d.executor,'reserve',{invoice:{...base,id:'expired'},attempt_id:'expired'},'invoice expired');
  await reject(d.executor,'authorize_by_policy',{invoice:{...base,id:'expired'},merchant_id:'local-merchant'},'invoice expired');
  await auth('fresh'); // Persists pruning without removing expired IDs or the reserved charge.
  assert.equal(await d.vault.view('policy_usage',{}),'3000');
  await d.owner.call(d.vault,'set_policy',config);
  await d.owner.call(d.vault,'cancel',{invoice_id:'reserved'});await d.owner.call(d.vault,'cancel',{invoice_id:'reserved'});
  await d.owner.call(d.vault,'cancel',{invoice_id:'fresh'});
  assert.equal(await d.vault.view('policy_usage',{}),'1000');assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1000n);
  for(let n=0;n<16;n++)await auth(`pending-${n}`,'100');
  await auth('pending-0','100'); // Idempotent even when capacity is full.
  await reject(d.executor,'authorize_by_policy',{invoice:{...base,id:'over-pending'},merchant_id:'local-merchant'},'pending policy capacity reached');
  const capacity:any=await d.vault.view('policy_capacity',{});assert.equal(capacity.pending,16);assert.equal(capacity.charges,17);
  await d.executor.call(d.vault,'reserve',{invoice:{...base,id:'pending-0',amount:'100'},attempt_id:'held'});
  await d.owner.call(d.vault,'set_paused',{paused:true});
  await reject(d.executor,'clear_policy_approvals',{},'owner only');
  await d.close();closed=true;
  assert.equal((await cli('capacity')).pending,16);
  const cleared=await cli('clear-approvals');assert.equal(cleared.length,15);assert.ok(!cleared.includes('pending-0'));
  assert.deepEqual(await cli('clear-approvals'),[]);
  assert.equal(await d.vault.view('policy_usage',{}),'1100');assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1100n);
  await reject(d.owner,'cancel',{invoice_id:'pending-0'},'reservation has not expired');
  await d.owner.call(d.vault,'revoke_policy',{});
  await d.owner.call(d.vault,'cancel',{invoice_id:'pending-0'});await d.owner.call(d.vault,'cancel',{invoice_id:'pending-0'});
  assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-1000n);
  await d.owner.call(d.vault,'set_policy',config);await cli('unpause');
  await auth('after-cleanup');await d.executor.call(d.vault,'reserve',{invoice:{...base,id:'after-cleanup'},attempt_id:'after-cleanup'});
  for(let i=0;i<2;i++)await d.executor.call(d.vault,'execute',{invoice_id:'after-cleanup',attempt_id:'after-cleanup'},{gas:'100000000000000'});
  assert.equal(BigInt((await d.merchant.balance()).total.toString())-merchantBefore,2000n);
  // Owner cleanup and reservation are serialized on chain: exactly one wins.
  await auth('race','100');
  const race=await Promise.all([d.executor.callRaw(d.vault,'reserve',{invoice:{...base,id:'race',amount:'100'},attempt_id:'race'}),d.owner.call(d.vault,'clear_policy_approvals',{},{gas:'300000000000000'})]);
  const state:any=await d.vault.view('get_payment',{invoice_id:'race'});
  if(state.state==='Reserved'){assert.equal(race[0].failed,false);assert.ok(!race[1].includes('race'));assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-2100n);await d.owner.call(d.vault,'revoke_policy',{});await d.owner.call(d.vault,'cancel',{invoice_id:'race'});}
  else{assert.equal(state.state,'Cancelled');assert.equal(race[0].failed,true);assert.ok(race[1].includes('race'));}
  assert.equal(BigInt(await d.vault.view('available_balance',{})),initial-2000n);assert.equal(await d.vault.view('policy_usage',{}),'2000');
  await d.owner.call(d.vault,'set_policy',config);
  await cli('enqueue','cli-dust','0.000000000000000000000001');
  await assert.rejects(()=>cli('run','cli-dust'),(error:any)=>{assert.equal(error.stderr.trim(),'Below policy minimum.');assert.ok(!/final_execution_status|node_modules/.test(error.stderr));return true;});
 }finally{if(!closed)await d.close();try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}}
});
